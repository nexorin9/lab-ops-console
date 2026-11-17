/**
 * T24 · 危急值升级与超时策略
 *
 * Task 停留在「已接收」超过 5 分钟未推进 → 升级通知科主任；
 * 超过 15 分钟仍未处置 → 升级通知医务科。
 * 每次升级写 escalation_events（级别 / 目标角色 / 触发时间 / 是否已被响应）并在面板标红。
 *
 * 计时口径：**按收到时间（received_at）而不是创建时间**。夜班交班常见的情况是
 * 任务创建在 22:00、护士 23:50 才点「已接收」，若按创建时间算会立刻误判为超时升级。
 * 因此状态机在 requested → received 时写入 received_at，本模块只认它。
 */

import type { Database as DB } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import type { CriticalStore } from './store.js';

const log = createLogger('critical.escalation');

export type EscalationLevel = 'dept_head' | 'medical_affairs';

export interface EscalationPolicy {
  /** 收到后多久升科主任（默认 5 分钟） */
  deptHeadAfterMs: number;
  /** 收到后多久升医务科（默认 15 分钟） */
  medicalAffairsAfterMs: number;
}

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  deptHeadAfterMs: 5 * 60 * 1000,
  medicalAffairsAfterMs: 15 * 60 * 1000,
};

export interface EscalationEventRow {
  id: number;
  task_id: string;
  level: EscalationLevel;
  target_role: string | null;
  created_at: string;
  notified_at: string | null;
  reason: string | null;
  responded: number;
  /** 默认 CHECK 允许的历史别名，读出时归一到 dept_head */
}

export interface EscalationNotification {
  taskId: string;
  level: EscalationLevel;
  targetRole: string;
  elapsedMs: number;
  receivedAt: string;
  at: string;
}

export interface EscalationScanResult {
  scanned: number;
  created: number;
  skipped: number;
  notifications: EscalationNotification[];
}

export interface EscalationWorkerOptions {
  policy?: Partial<EscalationPolicy>;
  now?: () => number;
  onNotify?: (n: EscalationNotification) => void;
  /** 运行摘要打点（可选） */
  summary?: { record(event: string, count?: number): void };
}

const LEVEL_TARGET: Record<EscalationLevel, string> = {
  dept_head: '科主任',
  medical_affairs: '医务科',
};

/** 增量补列：老库 escalation_events 只有 level/created_at/notified_at/reason */
function ensureSchema(db: DB): void {
  const cols = db.prepare(`PRAGMA table_info(escalation_events)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'target_role')) db.exec(`ALTER TABLE escalation_events ADD COLUMN target_role TEXT`);
  if (!cols.some((c) => c.name === 'responded')) db.exec(`ALTER TABLE escalation_events ADD COLUMN responded INTEGER NOT NULL DEFAULT 0`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_escalation_task_level ON escalation_events(task_id, level)`);
}

export class EscalationWorker {
  private readonly store: CriticalStore;
  private readonly db: DB;
  private readonly policy: EscalationPolicy;
  private readonly now: () => number;
  private readonly onNotify?: (n: EscalationNotification) => void;
  private readonly summary?: { record(event: string, count?: number): void };
  private timer: NodeJS.Timeout | null = null;

  constructor(store: CriticalStore, opts: EscalationWorkerOptions = {}) {
    this.store = store;
    this.db = store.rawDb;
    this.policy = { ...DEFAULT_ESCALATION_POLICY, ...(opts.policy ?? {}) };
    this.now = opts.now ?? Date.now;
    this.onNotify = opts.onNotify;
    this.summary = opts.summary;
    ensureSchema(this.db);
  }

  listEvents(taskId?: string): EscalationEventRow[] {
    return taskId
      ? this.db.prepare(`SELECT * FROM escalation_events WHERE task_id = ? ORDER BY id ASC`).all(taskId) as EscalationEventRow[]
      : this.db.prepare(`SELECT * FROM escalation_events ORDER BY id ASC`).all() as EscalationEventRow[];
  }

  /** 标记某条升级已被响应（面板上有人接了升级通知） */
  markResponded(taskId: string, level: EscalationLevel): boolean {
    const r = this.db.prepare(
      `UPDATE escalation_events SET responded = 1, notified_at = COALESCE(notified_at, datetime('now'))
         WHERE task_id = ? AND level = ?`,
    ).run(taskId, level);
    return r.changes > 0;
  }

  /** 单 Task 的停留时长（按收到时间；无 received_at 时明确标注回退口径） */
  dwellMs(taskId: string, at: number = this.now()): { elapsedMs: number; receivedAt: string; timingSource: 'received_at' | 'updated_at' } | null {
    const row = this.db.prepare(`SELECT received_at, updated_at, created_at FROM critical_tasks WHERE id = ?`)
      .get(taskId) as { received_at: string | null; updated_at: string; created_at: string } | undefined;
    if (!row) return null;
    const receivedAt = row.received_at ?? row.updated_at;
    return {
      elapsedMs: Math.max(0, at - new Date(receivedAt).getTime()),
      receivedAt,
      timingSource: row.received_at ? 'received_at' : 'updated_at',
    };
  }

  /** 一次扫描：按收到时间判定应升级的级别，同 Task 同级别不重复写 */
  scan(at: number = this.now()): EscalationScanResult {
    const tasks = this.db.prepare(
      `SELECT id, status, received_at, updated_at, created_at
         FROM critical_tasks
        WHERE status IN ('received','in-progress')
        ORDER BY COALESCE(received_at, updated_at) ASC`,
    ).all() as Array<{ id: string; status: string; received_at: string | null; updated_at: string; created_at: string }>;

    const result: EscalationScanResult = { scanned: tasks.length, created: 0, skipped: 0, notifications: [] };
    const isoNow = new Date(at).toISOString();

    for (const task of tasks) {
      const receivedAt = task.received_at ?? task.updated_at;
      const receivedMs = new Date(receivedAt).getTime();
      if (!Number.isFinite(receivedMs)) { result.skipped += 1; continue; }
      const elapsedMs = Math.max(0, at - receivedMs);

      const due: EscalationLevel[] = [];
      if (elapsedMs >= this.policy.medicalAffairsAfterMs) due.push('medical_affairs');
      if (elapsedMs >= this.policy.deptHeadAfterMs) due.push('dept_head');

      for (const level of due) {
        const existing = this.db.prepare(
          `SELECT id FROM escalation_events WHERE task_id = ? AND level = ? LIMIT 1`,
        ).get(task.id, level);
        if (existing) { result.skipped += 1; continue; }

        const reason = `按收到时间计时：已停留 ${Math.round(elapsedMs / 60000)} 分钟（${task.received_at ? 'received_at' : 'updated_at 回退口径'}），状态 ${task.status}`;
        try {
          this.db.prepare(
            `INSERT INTO escalation_events (task_id, level, created_at, notified_at, reason, target_role, responded)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
          ).run(task.id, level, isoNow, isoNow, reason, LEVEL_TARGET[level]);
        } catch (err) {
          // 老库 CHECK 只允许 department_head 时，写历史别名并在读出时归一
          if (level === 'dept_head') {
            this.db.prepare(
              `INSERT INTO escalation_events (task_id, level, created_at, notified_at, reason, target_role, responded)
               VALUES (?, 'department_head', ?, ?, ?, ?, 0)`,
            ).run(task.id, isoNow, isoNow, reason, LEVEL_TARGET[level]);
          } else {
            log.error({ taskId: task.id, err: (err as Error).message }, '升级事件写库失败');
            continue;
          }
        }

        // 升级留审计（飞检可倒查「什么时候升级给了谁」）
        void this.store.writeAudit({
          task_id: task.id,
          agent: 'system:escalation',
          agent_display: '升级链',
          recorded: isoNow,
          source: 'critical.escalation',
          outcome: 'success',
          reason: `escalation_${level}`,
          context: { level, targetRole: LEVEL_TARGET[level], elapsedMs, receivedAt },
          dedupeKey: `escalation:${task.id}:${level}`,
        }).catch((err) => log.error({ taskId: task.id, err: (err as Error).message }, '升级审计写入失败'));

        const n: EscalationNotification = {
          taskId: task.id, level, targetRole: LEVEL_TARGET[level], elapsedMs, receivedAt, at: isoNow,
        };
        result.created += 1;
        result.notifications.push(n);
        this.summary?.record('critical');
        this.onNotify?.(n);
        log.warn({ taskId: task.id, level, elapsedMs }, '危急值超时升级');
      }
    }
    return result;
  }

  /** 定时扫描（面板 / 常驻进程用）；stopLoop() 清理 */
  startLoop(intervalMs: number): void {
    this.stopLoop();
    const timer = setInterval(() => { this.scan(); }, Math.max(50, intervalMs));
    timer.unref?.();
    this.timer = timer;
  }

  stopLoop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
