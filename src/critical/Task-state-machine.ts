/**
 * critical.Task-state-machine —— 危急值 Task 服务端状态机校验
 *
 * 状态机定义：
 *   requested → received → in-progress → completed
 *                ↘ cancelled
 *                ↘ rejected (拒绝接单)
 *
 * 拒绝 4 类非法转换：
 *   ① 跳步 completed（requested → completed 跳过中间状态）
 *   ② 同一 Task 多次 ack（收到过又来收单 → duplicate_ack）
 *   ③ 状态不符（client 声明的 fromState 与库里实际状态不一致 → state_mismatch）
 *   ④ AuditEvent 字段缺失（agent / recorded / source / outcome 任一缺失或取值非法）
 *
 * 设计原则：
 * - 服务端权威：不允许 client 端跳过服务端校验
 * - 每次 transition 必写 AuditEvent（含 denied）；不允许裸 transition
 * - mutex 串行化同一 Task 的 transition（防并发 race）
 */

import { randomUUID } from 'node:crypto';
import {
  TaskInvalidTransitionError,
  AuditFieldMissingError,
} from '../shared/errors.js';
import type { CriticalStore, CriticalTaskRow, CriticalAuditRow } from './store.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('critical.state-machine');

/** 任务状态集合 */
export const TASK_STATES = ['requested', 'received', 'in-progress', 'completed', 'cancelled', 'rejected'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** AuditEvent outcome */
export const AUDIT_OUTCOMES = ['success', 'denied', 'partial', 'fallback_rules'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Agent 角色（FHIR agent.who.type → 业务侧语义） */
export type AgentRole = 'practitioner' | 'nurse' | 'doctor' | 'system' | 'unknown';

/** transition 入参 */
export interface TransitionInput {
  taskId: string;
  fromState: TaskState;
  toState: TaskState;
  agent: {
    practitionerId: string;
    display?: string;
    role?: AgentRole;
  };
  reason?: string;
  note?: string;
  /** 附加上下文（写入 audit_events.context） */
  context?: Record<string, unknown>;
  /** 系统当前时间（测试可注入） */
  now?: string;
}

/** transition 返回 */
export interface TransitionResult {
  ok: boolean;
  audit: CriticalAuditRow;
  task: CriticalTaskRow;
}

/** AuditEvent 四字段 —— 强制非空 */
export interface AuditFields {
  agent: { practitionerId: string; display?: string; role?: AgentRole };
  recorded: string;
  source: string;
  outcome: AuditOutcome;
  reason?: string;
  context?: Record<string, unknown>;
}

/** 合法转换图 —— 严格白名单 */
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  requested: ['received'], // 接单即收单（requested → received 是主路径第一步）
  received: ['in-progress', 'completed', 'cancelled', 'rejected'],
  'in-progress': ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  rejected: [],
};

/**
 * 校验 AuditEvent 四字段 —— 任一缺失抛 AuditFieldMissingError
 */
export function validateAuditFields(fields: AuditFields): void {
  if (!fields.agent || !fields.agent.practitionerId) {
    throw new AuditFieldMissingError('AuditEvent.agent.practitionerId 缺失', { field: 'agent' });
  }
  if (!fields.recorded) {
    throw new AuditFieldMissingError('AuditEvent.recorded 缺失', { field: 'recorded' });
  }
  if (!fields.source) {
    throw new AuditFieldMissingError('AuditEvent.source 缺失', { field: 'source' });
  }
  if (!fields.outcome) {
    throw new AuditFieldMissingError('AuditEvent.outcome 缺失', { field: 'outcome' });
  }
  if (!AUDIT_OUTCOMES.includes(fields.outcome)) {
    // 值域校验前置：否则会一路落到 SQLite CHECK 约束，抛裸 SqliteError，
    // 调用方分不清「字段写错」还是「库出问题」。
    throw new AuditFieldMissingError(
      `AuditEvent.outcome 取值非法：${String(fields.outcome)}（允许 ${AUDIT_OUTCOMES.join(' / ')}）`,
      { field: 'outcome', outcome: fields.outcome },
    );
  }
}

/**
 * 校验转换合法性 —— 非法时抛 TaskInvalidTransitionError
 *
 * 4 类非法转换拒绝：
 * ① 跳步 completed（requested → completed 跳过中间状态）
 * ② 同一 Task 多次 ack（received → received 重复 → 视为非法）
 * ③ 重复转换（任何不在 VALID_TRANSITIONS 白名单的）
 * ④ 已终态转换（completed / cancelled / rejected 不能再转换）
 */
export function validateTransition(fromState: TaskState, toState: TaskState): void {
  // 拒绝 ③：任何不在白名单的转换（含 requested → completed 跳步）
  const allowed = VALID_TRANSITIONS[fromState] ?? [];
  if (!allowed.includes(toState)) {
    throw new TaskInvalidTransitionError(
      `非法转换：${fromState} → ${toState}`,
      { fromState, toState, allowed },
    );
  }
}

/** Task 状态机（服务端权威） */
export class TaskStateMachine {
  /** 进程内 mutex（防并发 transition race） */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: CriticalStore,
    private readonly source: string = 'lab-ops-console',
  ) {}

  /** 串行化同一 taskId 的 transition（Promise 链式） */
  private async withMutex<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inFlight.get(taskId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    // 必须把链式 promise 存成变量再比较：`prev.then(...)` 每次都会新建 promise，
    // 直接比较永远不相等 → key 永不清理 → 常驻进程里 inFlight 无限增长（内存泄漏）。
    const chained = prev.then(() => next);
    this.inFlight.set(taskId, chained);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // 仅当自己仍是队尾时清理 key，避免覆盖后续排队任务
      if (this.inFlight.get(taskId) === chained) {
        this.inFlight.delete(taskId);
      }
    }
  }

  /**
   * 创建 Task（requested 起点）
   * 入参：focusDiagnosticId + focusObservationCode → 唯一性去重
   */
  async createTask(input: {
    patientId: string;
    focusDiagnosticId: string;
    focusObservationCode: string;
    priority?: 'routine' | 'urgent' | 'asap' | 'stat';
    reasonText?: string;
    /** T31 · 展示用快照字段（与 broadcast critical.detected 同源） */
    value?: string | null;
    unit?: string | null;
    testCode?: string | null;
    testDisplay?: string | null;
    severity?: string | null;
    agent: { practitionerId: string; display?: string; role?: AgentRole };
    now?: string;
  }): Promise<CriticalTaskRow> {
    const recorded = input.now ?? new Date().toISOString();
    validateAuditFields({
      agent: input.agent,
      recorded,
      source: this.source,
      outcome: 'success',
    });

    return this.withMutex(`create:${input.focusDiagnosticId}:${input.focusObservationCode}`, async () => {
      const existing = await this.store.findTaskByFocus(input.focusDiagnosticId, input.focusObservationCode);
      if (existing) {
        log.debug({ taskId: existing.id, focus: input.focusDiagnosticId }, 'task already exists, dedup');
        return existing;
      }

      const taskId = `task-${randomUUID()}`;
      const task = await this.store.createTask({
        id: taskId,
        patient_id: input.patientId,
        status: 'requested',
        focus_diagnostic_id: input.focusDiagnosticId,
        focus_observation_code: input.focusObservationCode,
        priority: input.priority ?? 'urgent',
        reason_text: input.reasonText,
        created_at: recorded,
        updated_at: recorded,
        focus_value: input.value ?? null,
        focus_unit: input.unit ?? null,
        focus_test_code: input.testCode ?? null,
        focus_test_display: input.testDisplay ?? null,
        focus_severity: input.severity ?? null,
      });

      await this.store.writeAudit({
        task_id: taskId,
        agent: input.agent.practitionerId,
        agent_display: input.agent.display,
        recorded,
        source: this.source,
        outcome: 'success',
        reason: 'task_created',
        context: { patient_id: input.patientId, focus_diagnostic_id: input.focusDiagnosticId, focus_observation_code: input.focusObservationCode },
      });

      log.info({ taskId, patientId: input.patientId, focus: input.focusObservationCode }, 'task created');
      return task;
    });
  }

  /**
   * 状态转换主入口
   * 4 类非法转换全部抛 TaskInvalidTransitionError + 写 denied AuditEvent
   */
  async transition(input: TransitionInput): Promise<TransitionResult> {
    const recorded = input.now ?? new Date().toISOString();
    validateAuditFields({
      agent: input.agent,
      recorded,
      source: this.source,
      outcome: 'success',
    });

    return this.withMutex(input.taskId, async () => {
      const task = await this.store.getTask(input.taskId);
      if (!task) {
        throw new TaskInvalidTransitionError('Task 不存在', { taskId: input.taskId });
      }

      // 校验 fromState 与 DB 一致（client 端不可谎报）
      if (task.status !== input.fromState) {
        // 重复 ack 单独归类：库里已是 received 而调用方又来收单 → duplicate_ack，
        // 与普通的状态不符区分开，飞检倒查时能分清「重复确认」与「状态错乱」
        const isDuplicateAck = input.toState === 'received' && task.status === 'received';
        await this.store.writeAudit({
          task_id: input.taskId,
          agent: input.agent.practitionerId,
          agent_display: input.agent.display,
          recorded,
          source: this.source,
          outcome: 'denied',
          reason: isDuplicateAck ? 'duplicate_ack' : 'state_mismatch',
          context: { expected: input.fromState, actual: task.status, attempted: input.toState },
        });
        throw new TaskInvalidTransitionError(
          isDuplicateAck
            ? 'Task 已被 ack，不可重复'
            : `Task 当前状态 ${task.status} 与声明的 fromState ${input.fromState} 不一致`,
          { taskId: input.taskId, expected: input.fromState, actual: task.status },
        );
      }

      // 拒绝 ①/②/③：白名单校验
      try {
        validateTransition(input.fromState, input.toState);
      } catch (err) {
        // 拒绝 ④：AuditEvent 字段缺失（在 validateAuditFields 已前置校验，这里只处理非法转换）
        await this.store.writeAudit({
          task_id: input.taskId,
          agent: input.agent.practitionerId,
          agent_display: input.agent.display,
          recorded,
          source: this.source,
          outcome: 'denied',
          reason: 'invalid_transition',
          context: { fromState: input.fromState, toState: input.toState, note: input.note },
        });
        throw err;
      }

      // 校验通过：更新 task 状态
      const updated = await this.store.updateTaskStatus(input.taskId, input.toState, recorded);

      // 写 success AuditEvent
      const audit = await this.store.writeAudit({
        task_id: input.taskId,
        agent: input.agent.practitionerId,
        agent_display: input.agent.display,
        recorded,
        source: this.source,
        outcome: 'success',
        reason: input.reason ?? `transition_${input.fromState}_to_${input.toState}`,
        context: { fromState: input.fromState, toState: input.toState, note: input.note, ...input.context },
      });

      log.info({ taskId: input.taskId, fromState: input.fromState, toState: input.toState, agent: input.agent.practitionerId }, 'task transition');

      return { ok: true, audit, task: updated };
    });
  }

  /**
   * 显式 acknowledge —— 接单（自适应起始态）
   *
   * 起始态不同，落点也不同：
   *   requested → received     （刚检出，护士接单即收单）
   *   received  → in-progress  （已收单，本次确认 = 开始处置）
   * 其它状态（in-progress / completed / cancelled / rejected）→ 走通用校验，
   * 落下 denied 审计（in-progress 不可回退、终态不可复活）。
   */
  async acknowledge(input: { taskId: string; agent: TransitionInput['agent']; note?: string; now?: string }): Promise<TransitionResult> {
    const task = await this.store.getTask(input.taskId);
    if (!task) throw new TaskInvalidTransitionError('Task 不存在', { taskId: input.taskId });

    if (task.status === 'requested') {
      return this.transition({
        taskId: input.taskId,
        fromState: 'requested',
        toState: 'received',
        agent: input.agent,
        reason: 'acknowledged',
        note: input.note,
        now: input.now,
      });
    }
    if (task.status === 'received') {
      return this.transition({
        taskId: input.taskId,
        fromState: 'received',
        toState: 'in-progress', // 已收单 → 开始处置
        agent: input.agent,
        reason: 'acknowledged',
        note: input.note,
        now: input.now,
      });
    }
    // 其它状态：交给通用校验拒绝并留 denied 审计
    return this.transition({
      taskId: input.taskId,
      fromState: task.status as TaskState,
      toState: 'received',
      agent: input.agent,
      reason: 'acknowledged',
      note: input.note,
      now: input.now,
    });
  }

  /**
   * 显式 ack only（requested → received）
   * 只收单、不推进到 in-progress；护士在面板上点「已接收」走这条
   */
  async ackOnly(input: { taskId: string; agent: TransitionInput['agent']; note?: string; now?: string }): Promise<TransitionResult> {
    return this.transition({
      taskId: input.taskId,
      fromState: 'requested',
      toState: 'received',
      agent: input.agent,
      reason: 'acknowledged',
      note: input.note,
      now: input.now,
    });
  }

  /** resolve —— received/in-progress → completed（医生处置完成） */
  async resolve(input: { taskId: string; agent: TransitionInput['agent']; resolutionNote: string; now?: string }): Promise<TransitionResult> {
    // 自适应 fromState：先查 DB 当前状态，支持 received → completed 与 in-progress → completed
    const task = await this.store.getTask(input.taskId);
    if (!task) throw new TaskInvalidTransitionError('Task 不存在', { taskId: input.taskId });
    if (task.status === 'received' || task.status === 'in-progress') {
      return this.transition({
        taskId: input.taskId,
        fromState: task.status,
        toState: 'completed',
        agent: input.agent,
        reason: 'resolved',
        note: input.resolutionNote,
        now: input.now,
      });
    }
    // 其它状态（requested / completed / cancelled / rejected）一律拒绝
    throw new TaskInvalidTransitionError(
      `Task 当前状态 ${task.status} 不能 resolve（仅 received / in-progress 可 resolve）`,
      { taskId: input.taskId, currentState: task.status },
    );
  }

  /** 列出所有非法转换的用例（供测试与文档） */
  static illegalTransitions(): Array<{ from: TaskState; to: TaskState; reason: string }> {
    return [
      { from: 'requested', to: 'completed', reason: '跳步 completed（跳过 received / in-progress）' },
      { from: 'received', to: 'received', reason: '同一 Task 多次 ack（重复 received）' },
      { from: 'completed', to: 'received', reason: '已终态不能转换' },
      { from: 'cancelled', to: 'in-progress', reason: '已终态不能转换' },
      { from: 'in-progress', to: 'received', reason: 'in-progress 不可回退 received' },
      { from: 'requested', to: 'rejected', reason: 'requested 不可直达 rejected（必须先 received）' },
    ];
  }
}