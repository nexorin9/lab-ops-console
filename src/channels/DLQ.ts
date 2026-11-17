/**
 * DLQ —— 死信队列（Dead Letter Queue）
 *
 * 设计原则：
 * - SQLite dlq_messages 表（migration v1 建表 + v2 补重放状态）
 * - 入队：enqueue(rawBytes, channelName, errorCode, errorMessage)
 * - 查询：list({channelName?, errorCode?, replayStatus?}) —— 面板 / 排障用
 * - 回放：replay(limit, handler) —— 按 id 顺序回放，同一条不重复回放
 * - 清理：purgeOlderThan(days=30) —— 保留期到期的死信清掉
 * - 入队失败抛 DlqEnqueueError（不静默吞错）
 * - 字段：channel_name / error_code / error_message / raw_bytes(BLOB 字节精确)
 *        / raw_bytes_base64(Base64 镜像，供导出与人工核对) / received_at
 *        / replay_status(pending|replayed|failed) / replay_count / last_replayed_at
 *
 * 「失败不静默改数据」：任何解析失败 / 写入失败的原始字节都留底，
 * 可按序回放、可导出核对，不允许悄悄丢掉。
 */

import { type Database as DB } from 'better-sqlite3';
import { getSqlite } from '../shared/sqlite.js';
import { DlqEnqueueError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';

export type DlqReplayStatus = 'pending' | 'replayed' | 'failed';

export interface DlqEntry {
  id: number;
  channel_name: string;
  error_code: string;
  error_message: string | null;
  /** 原始字节（BLOB）—— 回放时逐字节还原 */
  raw_bytes: Buffer;
  /** 原始字节的 Base64 镜像 —— 导出 / 人工核对用 */
  raw_bytes_base64: string;
  received_at: string;
  retry_count: number;
  replay_status: DlqReplayStatus;
  replay_count: number;
  last_replayed_at: string | null;
  last_error: string | null;
}

export interface DlqEnqueueInput {
  channelName: string;
  errorCode: string;
  errorMessage?: string;
  rawBytes: Buffer | Uint8Array;
}

export interface DlqQueryOpts {
  channelName?: string;
  errorCode?: string;
  limit?: number;
  sinceIso?: string;
  /** 按重放状态过滤（默认不过滤） */
  replayStatus?: DlqReplayStatus;
  /** 排序方向（'asc' = id 升序，回放/导出用；'desc' = 最新在前，面板用） */
  order?: 'asc' | 'desc';
}

/** 回放处理函数 —— 返回即视为回放成功（抛错视为失败，条目留待下次） */
export type DlqReplayHandler = (entry: DlqEntry) => void | Promise<void>;

export interface DlqReplayResult {
  /** 回放成功的条目 */
  replayed: DlqEntry[];
  /** 回放失败的条目（保留 pending 状态，等下次或人工处理） */
  failed: Array<{ entry: DlqEntry; error: string }>;
  /** 本次实际取出的条目数 */
  scanned: number;
}

export interface DlqPurgeResult {
  /** 删除条数 */
  deleted: number;
  /** 删除的最早 / 最晚 received_at */
  oldest: string | null;
  newest: string | null;
}

const log = createLogger('channels.DLQ');

const REPLAY_STATUSES: DlqReplayStatus[] = ['pending', 'replayed', 'failed'];

/**
 * DLQ 单例：内部持有 better-sqlite3 句柄（默认来自 getSqlite 单例）。
 * 测试可注入 db。
 */
export class DLQ {
  private db: DB;

  constructor(db?: DB) {
    this.db = db ?? getSqlite();
  }

  /**
   * 入队一条死信 —— 原始字节 + 错误码 + 错误信息 + 通道名。
   * 入队失败抛 DlqEnqueueError（不静默吞错）。
   */
  enqueue(input: DlqEnqueueInput): DlqEntry {
    const buf = Buffer.isBuffer(input.rawBytes)
      ? input.rawBytes
      : Buffer.from(input.rawBytes);
    try {
      const stmt = this.db.prepare(
        `INSERT INTO dlq_messages
           (channel_name, error_code, error_message, raw_bytes, raw_bytes_base64, received_at, replay_status)
         VALUES (?, ?, ?, ?, ?, datetime('now'), 'pending')`,
      );
      const result = stmt.run(
        input.channelName,
        input.errorCode,
        input.errorMessage ?? null,
        buf,
        buf.toString('base64'),
      );
      const id = Number(result.lastInsertRowid);
      log.warn(
        {
          channelName: input.channelName,
          errorCode: input.errorCode,
          rawLength: buf.length,
          dlqId: id,
        },
        'DLQ entry enqueued',
      );
      const row = this.db
        .prepare(`SELECT * FROM dlq_messages WHERE id = ?`)
        .get(id) as DlqEntry;
      return normalizeEntry(row);
    } catch (err) {
      throw new DlqEnqueueError(
        `DLQ 入队失败：${(err as Error).message ?? err}`,
        { channelName: input.channelName, errorCode: input.errorCode },
        err,
      );
    }
  }

  /**
   * 查询 DLQ 记录（运维面板 / 排障用）。
   * 默认按 id 倒序（最新在前）；order:'asc' 时按 id 升序（回放 / 导出用）。
   */
  list(opts: DlqQueryOpts = {}): DlqEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.channelName) {
      where.push('channel_name = ?');
      params.push(opts.channelName);
    }
    if (opts.errorCode) {
      where.push('error_code = ?');
      params.push(opts.errorCode);
    }
    if (opts.sinceIso) {
      where.push('received_at >= ?');
      params.push(opts.sinceIso);
    }
    if (opts.replayStatus) {
      where.push('replay_status = ?');
      params.push(opts.replayStatus);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    params.push(limit);
    const order = opts.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM dlq_messages ${whereSql} ORDER BY id ${order} LIMIT ?`,
      )
      .all(...params) as DlqEntry[];
    return rows.map(normalizeEntry);
  }

  /** query —— list 的兼容别名（保留既有调用方） */
  query(opts: DlqQueryOpts = {}): DlqEntry[] {
    return this.list(opts);
  }

  /**
   * 顺序回放 —— 按 id 升序取 pending 条目交给 handler 处理。
   * - 不重复：只有 replay_status='pending' 的条目会被取出；成功后置 'replayed'，
   *   再次 replay 不会把同一条再交给 handler
   * - 顺序：严格按 id 升序处理（先进先出），与入队顺序一致
   * - 失败不丢：handler 抛错 → 记 last_error + replay_count+1，状态保持 pending，
   *   等下一次回放或人工介入
   */
  async replay(
    limit: number,
    handler: DlqReplayHandler,
    opts: { channelName?: string } = {},
  ): Promise<DlqReplayResult> {
    const candidates = this.list({
      channelName: opts.channelName,
      replayStatus: 'pending',
      order: 'asc',
      limit,
    });

    const replayed: DlqEntry[] = [];
    const failed: Array<{ entry: DlqEntry; error: string }> = [];

    for (const entry of candidates) {
      try {
        await handler(entry);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        this.db
          .prepare(
            `UPDATE dlq_messages
                SET replay_count = replay_count + 1, last_error = ?
              WHERE id = ?`,
          )
          .run(message, entry.id);
        log.warn(
          { channelName: entry.channel_name, dlqId: entry.id, error: message },
          'DLQ replay failed（条目保留待下次回放）',
        );
        failed.push({ entry, error: message });
        continue;
      }

      this.db
        .prepare(
          `UPDATE dlq_messages
              SET replay_status = 'replayed',
                  replay_count = replay_count + 1,
                  last_replayed_at = datetime('now'),
                  last_error = NULL
            WHERE id = ?`,
        )
        .run(entry.id);
      this.advanceCursor(entry.channel_name, entry.id);
      replayed.push({ ...entry, replay_status: 'replayed' });
    }

    log.info(
      { scanned: candidates.length, replayed: replayed.length, failed: failed.length },
      'DLQ replay finished',
    );
    return { replayed, failed, scanned: candidates.length };
  }

  /**
   * 清理保留期到期的死信 —— 默认 30 天。
   * 返回删除条数与时间区间（可核对「删了什么」）。
   */
  purgeOlderThan(days = 30): DlqPurgeResult {
    const bounds = this.db
      .prepare(
        `SELECT MIN(received_at) AS oldest, MAX(received_at) AS newest
           FROM dlq_messages
          WHERE received_at < datetime('now', ?)`,
      )
      .get(`-${days} days`) as { oldest: string | null; newest: string | null };
    const result = this.db
      .prepare(`DELETE FROM dlq_messages WHERE received_at < datetime('now', ?)`)
      .run(`-${days} days`);
    const deleted = Number(result.changes ?? 0);
    log.info({ days, deleted }, 'DLQ purged');
    return { deleted, oldest: bounds?.oldest ?? null, newest: bounds?.newest ?? null };
  }

  /** 计数（按通道 / 错误码分组） */
  countByChannel(): { channel_name: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT channel_name, COUNT(*) as count FROM dlq_messages GROUP BY channel_name`,
      )
      .all() as { channel_name: string; count: number }[];
  }

  /** 运行摘要：待回放 / 已回放 / 失败 条数 */
  stats(): { pending: number; replayed: number; failed: number; total: number } {
    const row = this.db
      .prepare(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN replay_status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN replay_status = 'replayed' THEN 1 ELSE 0 END) AS replayed,
            SUM(CASE WHEN replay_status = 'failed' THEN 1 ELSE 0 END) AS failed
          FROM dlq_messages`,
      )
      .get() as { total: number; pending: number | null; replayed: number | null; failed: number | null };
    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      replayed: Number(row?.replayed ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  /** 回放游标 —— 每通道最后回放到的 id（便于断点续跑与核对） */
  getReplayCursor(channelName: string): { channel_name: string; last_replayed_id: number; updated_at: string } | null {
    const row = this.db
      .prepare(`SELECT * FROM dlq_replay_cursor WHERE channel_name = ?`)
      .get(channelName) as { channel_name: string; last_replayed_id: number; updated_at: string } | undefined;
    return row ?? null;
  }

  /** 推进回放游标 */
  private advanceCursor(channelName: string, replayedId: number): void {
    this.db
      .prepare(
        `INSERT INTO dlq_replay_cursor (channel_name, last_replayed_id, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(channel_name) DO UPDATE SET
           last_replayed_id = MAX(last_replayed_id, excluded.last_replayed_id),
           updated_at = datetime('now')`,
      )
      .run(channelName, replayedId);
  }

  /** 清空（仅用于测试） */
  clear(): void {
    this.db.prepare(`DELETE FROM dlq_messages`).run();
    this.db.prepare(`DELETE FROM dlq_replay_cursor`).run();
  }
}

/** 行 → DlqEntry —— BLOB 回 Buffer，Base64 镜像补齐（旧行可能没有该列） */
function normalizeEntry(row: DlqEntry): DlqEntry {
  const raw = Buffer.isBuffer(row.raw_bytes)
    ? row.raw_bytes
    : Buffer.from((row.raw_bytes as unknown as Uint8Array) ?? []);
  const status = REPLAY_STATUSES.includes(row.replay_status as DlqReplayStatus)
    ? (row.replay_status as DlqReplayStatus)
    : 'pending';
  return {
    ...row,
    raw_bytes: raw,
    raw_bytes_base64: row.raw_bytes_base64 ?? raw.toString('base64'),
    replay_status: status,
    replay_count: Number(row.replay_count ?? 0),
    last_replayed_at: row.last_replayed_at ?? null,
    last_error: row.last_error ?? null,
  };
}

/** 全局 DLQ 单例工厂（懒加载） */
let _instance: DLQ | null = null;
export function getDLQ(): DLQ {
  if (!_instance) _instance = new DLQ();
  return _instance;
}

/** DlqQueue —— DLQ 的业务别名（任务书里的类名），同一实现 */
export const DlqQueue = DLQ;
export type DlqQueue = DLQ;

/** 用于测试 —— 重置单例 */
export function _resetDLQSingleton(): void {
  _instance = null;
}
