/**
 * critical.CandidateAdoption —— T33 模型候选接收人的人工采纳闭环（核心差异化②）
 *
 * 面板（T31/T32）已能呈现模型/规则给出的「候选接收人」；本模块负责把护士/医生在面板上的
 * 「采纳 / 忽略」动作落成可审计、可回写的业务事件：
 *
 * - candidatesFor(taskId)：面板并行拉取每个未完成危急值的候选列表（来自 index.ts 的内存候选缓存，
 *   模型不可达时该缓存本身就是规则兜底结果，故永远非空或显式空）。
 * - accept(taskId, { index })：采纳第 index 个候选 —— 写一条 success AuditEvent（reason=candidate_accepted），
 *   并把 Task.owner 回写到 FHIR（经 writeTaskAndAudit，ownerReference = Practitioner/<practitionerId>）。
 * - ignore(taskId, { index })：忽略某候选 —— 同样写一条审计（reason=candidate_ignored），便于飞检倒查
 *   「为何系统建议了 X 而科室最终没派给 X」。
 *
 * 设计原则：
 * - 采纳/忽略都强制留审计，且四字段（agent/recorded/source/outcome）齐备，绝不静默。
 * - FHIR 回写失败不吞：writer 抛错会沿网关 fail() 落到 502，调用方能感知，不会「采纳成功但院内没记」。
 * - 候选缓存是 index.ts 进程内 Map，与网关同进程，故此处直接读同一引用，无额外 RPC。
 */

import type { CriticalStore, CriticalTaskRow } from './store.js';
import type { TaskStateMachine } from './Task-state-machine.js';
import type { Candidate } from '../ai/types.js';
import {
  writeTaskAndAudit,
  practitionerRef,
  type FhirWritePort,
  type ToolContext,
} from './tools/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('critical.candidate-adoption');

export interface CandidateAdoptionOptions {
  /** 进程内候选缓存（与 index.ts 同一引用；键 = taskId，值 = 候选接收人列表） */
  candidates: Map<string, Candidate[]>;
  store: CriticalStore;
  stateMachine: TaskStateMachine;
  /** FHIR 写出端口（缺则跳过回写，仅留本地审计，不报错） */
  writer?: FhirWritePort;
  source?: string;
  now?: () => string;
}

/**
 * 与网关 CandidateAdoptionLike 结构兼容的实现。
 * 三个方法的签名严格对齐 server.ts 的 CandidateAdoptionLike，便于 gateway.bind 注入。
 */
export class CandidateAdoption {
  private readonly candidates: Map<string, Candidate[]>;
  private readonly store: CriticalStore;
  private readonly stateMachine: TaskStateMachine;
  private readonly writer?: FhirWritePort;
  private readonly source: string;
  private readonly now: () => string;

  constructor(opts: CandidateAdoptionOptions) {
    this.candidates = opts.candidates;
    this.store = opts.store;
    this.stateMachine = opts.stateMachine;
    this.writer = opts.writer;
    this.source = opts.source ?? 'lab-ops-console';
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** 列出某危急值的候选接收人（面板并行拉取用） */
  async candidatesFor(taskId: string): Promise<Candidate[]> {
    return this.candidates.get(taskId) ?? [];
  }

  /** 采纳第 index 个候选：写审计 + Task.owner 回写 FHIR */
  async accept(taskId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const index = Number(input.index);
    const candidate = this.resolveCandidate(taskId, index);
    const task = await this.requireTask(taskId);
    const recorded = this.now();

    await this.store.writeAudit({
      task_id: taskId,
      agent: candidate.practitionerId,
      agent_display: candidate.role,
      recorded,
      source: this.source,
      outcome: 'success',
      reason: 'candidate_accepted',
      context: {
        role: candidate.role,
        practitionerId: candidate.practitionerId,
        confidence: candidate.confidence,
        source: candidate.source,
        lowConfidence: candidate.lowConfidence ?? false,
      },
    });

    // Task.owner 回写 FHIR（缺 writer 时仅留本地审计，不阻断采纳动作）
    let ownerWritten = false;
    if (this.writer) {
      const ctx: ToolContext = {
        store: this.store,
        stateMachine: this.stateMachine,
        writer: this.writer,
        source: this.source,
        now: this.now,
      };
      const result = await writeTaskAndAudit(ctx, task, {
        agent: candidate.practitionerId,
        action: 'candidate_accepted',
        outcome: 'success',
        ownerRef: practitionerRef(candidate.practitionerId),
        notes: [
          {
            text: `采纳接收人建议：${candidate.role}（${candidate.practitionerId}）· 来源 ${candidate.source} · 置信 ${candidate.confidence}`,
            time: recorded,
          },
        ],
      });
      ownerWritten = result.taskWritten;
    }

    log.info({ taskId, practitionerId: candidate.practitionerId, ownerWritten }, '候选接收人已采纳');
    return {
      ok: true,
      taskId,
      ownerWritten,
      accepted: {
        role: candidate.role,
        practitionerId: candidate.practitionerId,
        confidence: candidate.confidence,
        source: candidate.source,
        lowConfidence: candidate.lowConfidence ?? false,
      },
    };
  }

  /** 忽略第 index 个候选：仅留审计，不回写 */
  async ignore(taskId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const index = Number(input.index);
    const candidate = this.resolveCandidate(taskId, index);
    const recorded = this.now();

    await this.store.writeAudit({
      task_id: taskId,
      agent: candidate.practitionerId,
      agent_display: candidate.role,
      recorded,
      source: this.source,
      outcome: 'success',
      reason: 'candidate_ignored',
      context: {
        role: candidate.role,
        practitionerId: candidate.practitionerId,
        confidence: candidate.confidence,
        source: candidate.source,
        lowConfidence: candidate.lowConfidence ?? false,
      },
    });

    log.info({ taskId, practitionerId: candidate.practitionerId }, '候选接收人已忽略');
    return {
      ok: true,
      taskId,
      ignored: {
        role: candidate.role,
        practitionerId: candidate.practitionerId,
        confidence: candidate.confidence,
        source: candidate.source,
      },
    };
  }

  private resolveCandidate(taskId: string, index: number): Candidate {
    const list = this.candidates.get(taskId);
    if (!list || !Number.isInteger(index) || index < 0 || index >= list.length) {
      throw new Error(`候选不存在：task=${taskId} index=${index}`);
    }
    return list[index]!;
  }

  private async requireTask(taskId: string): Promise<CriticalTaskRow> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task 不存在: ${taskId}`);
    return task;
  }
}
