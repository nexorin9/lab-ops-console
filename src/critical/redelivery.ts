/**
 * critical.redelivery —— 断网兜底通知的定时补推 worker
 *
 * 责任边界（spec §8 / task T28）：
 * - 网络恢复后按退避序列重试 pending 记录，避免一次性风暴；
 * - 成功标 delivered 并回写 synced_at；失败累加 retry_count 并推后 next_attempt_at；
 * - 超过 maxRetries 转 manual_required（不丢、不静默放弃），留人工队列；
 * - **幂等**：同一次 runOnce 内同一 task_id 只向护士站发一次；已 delivered 的行不再取；
 *   手动重推对同一 task 也复用同一套去重，重复点「补推」不会让护士站收到两条同一危急值；
 * - 每次 runOnce 的结果回写 push_queue 并经 onComplete 回调交给网关广播「已补推」事件。
 */

import type { Database as DB } from 'better-sqlite3';
import type { CriticalPushPayload, NotificationDispatcher } from './NotificationDispatcher.js';
import { getSqlite } from '../shared/sqlite.js';

export interface RedeliveryOptions {
  dispatcher: NotificationDispatcher;
  /** SQLite 注入（默认单例；测试传内存库） */
  db?: DB;
  /** 每次最多取多少条（默认 100） */
  batchSize?: number;
  /** 退避序列（毫秒），按 retry_count 索引，超出取最后一项 */
  backoffMs?: number[];
  /** 超过此重试次数转人工（默认 8） */
  maxRetries?: number;
  /** ISO 时间基准（测试注入） */
  now?: () => string;
  /** 每次 runOnce 完成后回调（网关用于 broadcast） */
  onComplete?: (result: RedeliveryResult) => void;
}

export interface RedeliveryResult {
  scanned: number;
  delivered: number;
  failed: number;
  manualRequired: number;
  at: string;
}

const DEFAULT_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000];
const DEFAULT_MAX_RETRIES = 8;

function addMs(iso: string, ms: number): string {
  const t = Date.parse(iso);
  return new Date((Number.isNaN(t) ? Date.now() : t) + ms).toISOString();
}

export class RedeliveryWorker {
  private readonly dispatcher: NotificationDispatcher;
  private readonly db: DB | null;
  private readonly batchSize: number;
  private readonly backoffMs: number[];
  private readonly maxRetries: number;
  private readonly now: () => string;
  private readonly onComplete?: (result: RedeliveryResult) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RedeliveryOptions) {
    this.dispatcher = options.dispatcher;
    this.db = options.db ?? null;
    this.batchSize = options.batchSize ?? 100;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onComplete = options.onComplete;
  }

  private getDb(): DB {
    return this.db ?? getSqlite();
  }

  /**
   * 取一批到期的 pending 记录并补推。
   * 幂等保障：① 只取 status='pending' 且（未设 next_attempt_at 或已到期）的行；
   * ② 同一 batch 内同一 task_id 只发一次，重复行直接标 delivered 不再外发；
   * ③ 已 delivered / manual_required 的行不会再次被取。
   */
  async runOnce(): Promise<RedeliveryResult> {
    const nowIso = this.now();
    const db = this.getDb();
    const rows = db.prepare(
      `SELECT id, task_id, payload FROM push_queue
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id ASC LIMIT ?`,
    ).all(nowIso, this.batchSize) as Array<{ id: number; task_id: string; payload: string }>;

    const result: RedeliveryResult = {
      scanned: rows.length,
      delivered: 0,
      failed: 0,
      manualRequired: 0,
      at: nowIso,
    };

    const deliveredTaskIds = new Set<string>();

    for (const row of rows) {
      // 同 batch 内同 task 已成功发送：跳过外发，直接标 delivered，避免护士站收到两条
      if (deliveredTaskIds.has(row.task_id)) {
        db.prepare(`UPDATE push_queue SET status = 'delivered', synced_at = ? WHERE id = ?`)
          .run(nowIso, row.id);
        result.delivered++;
        continue;
      }

      let payload: CriticalPushPayload;
      try {
        payload = JSON.parse(row.payload) as CriticalPushPayload;
      } catch {
        // 损坏的 payload：转人工，不静默丢弃
        db.prepare(`UPDATE push_queue SET status = 'manual_required', retry_count = retry_count + 1, last_error = ? WHERE id = ?`)
          .run('payload_unparseable', row.id);
        result.manualRequired++;
        continue;
      }

      // 补推本身不允许再次入队，否则失败会把队列越补越长
      const r = await this.dispatcher.deliver(row.task_id, payload, { enqueueOnFailure: false });
      const retryCount = (db.prepare(`SELECT retry_count FROM push_queue WHERE id = ?`).get(row.id) as { retry_count: number }).retry_count;
      const nextCount = retryCount + 1;
      const errText = r.attempts.map((a) => a.error ?? '').filter(Boolean).join('; ');

      if (r.ok) {
        deliveredTaskIds.add(row.task_id);
        db.prepare(`UPDATE push_queue SET status = 'delivered', synced_at = ? WHERE id = ?`)
          .run(nowIso, row.id);
        result.delivered++;
      } else if (nextCount >= this.maxRetries) {
        db.prepare(`UPDATE push_queue SET status = 'manual_required', retry_count = ?, last_error = ? WHERE id = ?`)
          .run(nextCount, errText, row.id);
        result.manualRequired++;
      } else {
        const backoff = this.backoffMs[Math.min(nextCount, this.backoffMs.length - 1)]!;
        db.prepare(`UPDATE push_queue SET status = 'pending', retry_count = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`)
          .run(nextCount, addMs(nowIso, backoff), errText, row.id);
        result.failed++;
      }
    }

    this.onComplete?.(result);
    return result;
  }

  /** 手动强制补推某 task 的 pending / manual_required 记录（无视退避时钟） */
  async forceRedeliverTask(taskId: string): Promise<RedeliveryResult> {
    const db = this.getDb();
    const nowIso = this.now();
    db.prepare(`UPDATE push_queue SET next_attempt_at = NULL WHERE task_id = ? AND status IN ('pending','manual_required')`)
      .run(taskId);
    return this.runOnce();
  }

  /** 启动定时补推循环（网关装配时调用；返回停止函数） */
  startLoop(intervalMs = 5_000): () => void {
    if (this.timer) return () => this.stopLoop();
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        // 单轮异常不应拖垮整个进程；错误由 dispatcher 日志兜底
        void err;
      });
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return () => this.stopLoop();
  }

  stopLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
