/**
 * T21 · 本地待上传队列（OutboxQueue）
 *
 * FHIR 写失败（含契约不通过）的资源先落本地 SQLite 待上传表，恢复后按 seq 顺序回放：
 * 绝不乱序、绝不重复。回放前用 accessionIdentifier 查服务端是否已存在，
 * 已存在则跳过并标 already_present（幂等靠业务键而不是靠「我记得我发过」）。
 * 重放超上限转 manual_required 人工队列，记录不丢。
 */

import type { Database as DB } from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';

const log = createLogger('fhir.outbox');

export type OutboxStatus = 'pending' | 'replayed' | 'already_present' | 'manual_required' | 'failed';

export interface OutboxRow {
  seq: number;
  accession_identifier: string;
  resource_type: string;
  resource_id: string | null;
  payload: string;
  error_code: string;
  error_message: string | null;
  status: OutboxStatus;
  retry_count: number;
  created_at: string;
  last_attempt_at: string | null;
}

export interface OutboxEnqueueInput {
  accessionIdentifier: string;
  resourceType: string;
  resourceId?: string;
  body: Record<string, unknown>;
  errorCode: string;
  errorMessage?: string;
}

export interface OutboxSink {
  enqueue(input: OutboxEnqueueInput): number;
}

export interface OutboxReplayResult {
  scanned: number;
  replayed: number;
  alreadyPresent: number;
  failed: number;
  manualRequired: number;
  /** 本次实际交给 handler 的 seq 顺序（用于断言与写入顺序一致） */
  order: number[];
  errors: Array<{ seq: number; message: string }>;
}

export interface OutboxOptions {
  /** 单条最大重放次数，超限转 manual_required */
  maxReplays?: number;
  /** 服务端幂等查询：同 accessionIdentifier 是否已存在 */
  exists?: (accessionIdentifier: string) => boolean | Promise<boolean>;
}

export const OUTBOX_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS fhir_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    accession_identifier TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    payload TEXT NOT NULL,
    error_code TEXT NOT NULL,
    error_message TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','replayed','already_present','manual_required','failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_attempt_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON fhir_outbox(status, seq)`,
];

/** 从 FHIR 资源 body 里取 accessionIdentifier（没有则用资源 id） */
export function extractAccession(body: Record<string, unknown>): string {
  const identifiers = Array.isArray(body.identifier) ? body.identifier as Array<{ system?: string; value?: string }> : [];
  const hit = identifiers.find((i) => i?.system === 'urn:lab-ops-console:accession' && i?.value);
  if (hit?.value) return hit.value;
  const anyValue = identifiers.find((i) => i?.value)?.value;
  if (anyValue) return anyValue;
  return typeof body.id === 'string' ? body.id : 'unknown';
}

export class OutboxQueue implements OutboxSink {
  private readonly db: DB;
  private readonly maxReplays: number;
  private readonly exists?: (accessionIdentifier: string) => boolean | Promise<boolean>;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: DB, opts: OutboxOptions = {}) {
    this.db = db;
    this.maxReplays = opts.maxReplays ?? 3;
    this.exists = opts.exists;
    db.transaction(() => { for (const sql of OUTBOX_MIGRATIONS) db.exec(sql); })();
  }

  enqueue(input: OutboxEnqueueInput): number {
    const result = this.db.prepare(
      `INSERT INTO fhir_outbox
         (accession_identifier, resource_type, resource_id, payload, error_code, error_message, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      input.accessionIdentifier,
      input.resourceType,
      input.resourceId ?? null,
      JSON.stringify(input.body),
      input.errorCode,
      input.errorMessage ?? null,
    );
    const seq = Number(result.lastInsertRowid);
    log.warn({ seq, resourceType: input.resourceType, errorCode: input.errorCode }, 'FHIR 资源进入本地待上传队列');
    return seq;
  }

  /** 待回放条目，严格按 seq 升序 */
  pending(limit = 100): OutboxRow[] {
    return this.db.prepare(
      `SELECT * FROM fhir_outbox WHERE status = 'pending' ORDER BY seq ASC LIMIT ?`,
    ).all(limit) as OutboxRow[];
  }

  list(status?: OutboxStatus): OutboxRow[] {
    return status
      ? this.db.prepare(`SELECT * FROM fhir_outbox WHERE status = ? ORDER BY seq ASC`).all(status) as OutboxRow[]
      : this.db.prepare(`SELECT * FROM fhir_outbox ORDER BY seq ASC`).all() as OutboxRow[];
  }

  stats(): Record<OutboxStatus | 'total', number> {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM fhir_outbox GROUP BY status`).all() as Array<{ status: OutboxStatus; n: number }>;
    const out: Record<OutboxStatus | 'total', number> = {
      total: 0, pending: 0, replayed: 0, already_present: 0, manual_required: 0, failed: 0,
    };
    for (const r of rows) { out[r.status] = Number(r.n); out.total += Number(r.n); }
    return out;
  }

  private mark(seq: number, status: OutboxStatus, retryIncrement = 0): void {
    this.db.prepare(
      `UPDATE fhir_outbox SET status = ?, retry_count = retry_count + ?, last_attempt_at = datetime('now') WHERE seq = ?`,
    ).run(status, retryIncrement, seq);
  }

  /**
   * 按 seq 顺序回放。handler 返回即视为写入成功；抛错则累加 retry_count，
   * 超过 maxReplays 转人工队列（记录保留，不删除）。
   */
  async replay(
    handler: (row: OutboxRow) => void | Promise<void>,
    limit = 100,
  ): Promise<OutboxReplayResult> {
    const rows = this.pending(limit);
    const result: OutboxReplayResult = {
      scanned: rows.length, replayed: 0, alreadyPresent: 0, failed: 0, manualRequired: 0, order: [], errors: [],
    };
    for (const row of rows) {
      // 幂等：重放前查服务端，已存在直接跳过
      if (this.exists && await this.exists(row.accession_identifier)) {
        this.mark(row.seq, 'already_present');
        result.alreadyPresent += 1;
        continue;
      }
      result.order.push(row.seq);
      try {
        await handler(row);
        this.mark(row.seq, 'replayed');
        result.replayed += 1;
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        result.failed += 1;
        result.errors.push({ seq: row.seq, message });
        const nextRetry = row.retry_count + 1;
        if (nextRetry >= this.maxReplays) {
          this.mark(row.seq, 'manual_required', 1);
          result.manualRequired += 1;
          log.warn({ seq: row.seq, retries: nextRetry }, '待上传条目重放超限，转人工队列');
        } else {
          this.mark(row.seq, 'failed', 1);
        }
      }
    }
    return result;
  }

  /** 后台回放器：按可配间隔定时按序重放；stop() 清理定时器 */
  startReplayLoop(intervalMs: number, handler: (row: OutboxRow) => void | Promise<void>): void {
    this.stopReplayLoop();
    const timer = setInterval(() => { void this.replay(handler); }, Math.max(10, intervalMs));
    timer.unref?.();
    this.timer = timer;
  }

  stopReplayLoop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
