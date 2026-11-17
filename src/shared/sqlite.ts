/**
 * SQLite 单例（better-sqlite3）+ 启动时跑 migrations 建表
 *
 * 设计原则：
 * - 单例：进程内 getSqlite() 返回同一个 Database 实例
 * - 路径：$DATA_DIR/lab-ops-console.db（默认 ./data/lab-ops-console.db）
 * - 启动 migrations 建表：dlq_messages / tasks / audit_events / push_queue / model_calls
 *   （注：critical_tasks / critical_audit_events / escalation_events / audit_outbox 由 T7/T21/T37 单独加）
 * - migration v2（T4）：dlq_messages 增补 raw_bytes_base64 / replay_status / replay_count /
 *   last_replayed_at / last_error，并建 dlq_replay_cursor（每通道回放游标）
 * - 线程安全：better-sqlite3 本身是同步、单线程使用，无 race
 * - 测试替换：createTestSqlite(path=':memory:') 给集成测试用
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let instance: DB | null = null;
let instancePath: string | null = null;

/** 默认数据目录 */
const DEFAULT_DATA_DIR = './data';
const DB_FILENAME = 'lab-ops-console.db';

/**
 * migrations —— 启动时按顺序执行。每条 DDL 是幂等的（IF NOT EXISTS）。
 * 这里只放 T2 范围内的表（dlq_messages / tasks / audit_events / push_queue / model_calls）。
 * 后续 task（T7 危急值 / T21 升级 / T29 audit 深度 / T37 outbox）会扩展 critical_tasks /
 * critical_audit_events / escalation_events / audit_outbox 等表。
 */
const MIGRATIONS: { version: number; sql: string[] }[] = [
  {
    version: 1,
    sql: [
      `CREATE TABLE IF NOT EXISTS dlq_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_name TEXT NOT NULL,
        error_code TEXT NOT NULL,
        error_message TEXT,
        raw_bytes BLOB NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        retry_count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE INDEX IF NOT EXISTS idx_dlq_channel ON dlq_messages(channel_name)`,
      `CREATE INDEX IF NOT EXISTS idx_dlq_received ON dlq_messages(received_at)`,

      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        focus TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)`,

      `CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        agent TEXT NOT NULL,
        recorded TEXT NOT NULL,
        source TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_events(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_recorded ON audit_events(recorded)`,

      `CREATE TABLE IF NOT EXISTS push_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        synced_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_push_status ON push_queue(status)`,
      `CREATE INDEX IF NOT EXISTS idx_push_task ON push_queue(task_id)`,

      `CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt_name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        response_hash TEXT,
        latency_ms INTEGER,
        outcome TEXT NOT NULL,
        structured_ok INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        context TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_prompt ON model_calls(prompt_name)`,
      `CREATE INDEX IF NOT EXISTS idx_model_calls_created ON model_calls(created_at)`,
    ],
  },
  {
    // T4 —— DLQ 可回放：原始字节 Base64 镜像 + 重放状态 + 回放游标
    version: 2,
    sql: [
      `ALTER TABLE dlq_messages ADD COLUMN raw_bytes_base64 TEXT`,
      `ALTER TABLE dlq_messages ADD COLUMN replay_status TEXT NOT NULL DEFAULT 'pending'`,
      `ALTER TABLE dlq_messages ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE dlq_messages ADD COLUMN last_replayed_at TEXT`,
      `ALTER TABLE dlq_messages ADD COLUMN last_error TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_dlq_replay_status ON dlq_messages(replay_status, id)`,
      `CREATE TABLE IF NOT EXISTS dlq_replay_cursor (
        channel_name TEXT PRIMARY KEY,
        last_replayed_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ],
  },
  {
    // T28 —— 补推退避：push_queue 增加 next_attempt_at（到期前不重推）
    version: 3,
    sql: [
      `ALTER TABLE push_queue ADD COLUMN next_attempt_at TEXT`,
    ],
  },
];

function runMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set<number>(
    (db.prepare(`SELECT version FROM schema_migrations`).all() as { version: number }[])
      .map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      for (const sql of m.sql) db.exec(sql);
      db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(m.version);
    })();
  }
}

/**
 * 取得 SQLite 单例。首次调用时按 dataDir 创建并跑 migrations。
 * - dataDir 默认 ./data/
 * - 测试可传 ':memory:' 走内存模式（注意：每次调用都新建实例）
 */
export function getSqlite(opts: { dataDir?: string; filename?: string } = {}): DB {
  if (opts.dataDir === ':memory:') {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
  }
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const filename = opts.filename ?? DB_FILENAME;
  const targetPath = resolve(dataDir, filename);
  if (instance && instancePath === targetPath) return instance;
  if (instance) instance.close();
  mkdirSync(dirname(targetPath), { recursive: true });
  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  instance = db;
  instancePath = targetPath;
  return db;
}

/**
 * 关闭单例 —— 用于测试清理或 graceful shutdown
 */
export function closeSqlite(): void {
  if (instance) {
    instance.close();
    instance = null;
    instancePath = null;
  }
}

/**
 * 测试用：创建独立内存 sqlite（不走单例）
 * 返回值附带 close() 便于清理
 */
export function createTestSqlite(): { db: DB; close: () => void } {
  const db = new Database(':memory:');
  runMigrations(db);
  return {
    db,
    close: () => db.close(),
  };
}

/**
 * 用于测试 / graceful shutdown 重置单例
 */
export function _resetSqliteSingleton(): void {
  closeSqlite();
}
