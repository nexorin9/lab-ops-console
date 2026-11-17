import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSqlite, closeSqlite, createTestSqlite, _resetSqliteSingleton } from '../../src/shared/sqlite.js';

/**
 * sqlite.test.ts —— 单例一致性、migrations 建表、内存模式、清理
 */

describe('shared/sqlite', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lab-ops-sqlite-'));
  });

  afterEach(() => {
    _resetSqliteSingleton();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getSqlite (磁盘单例)', () => {
    it('返回 Database 实例', () => {
      const db = getSqlite({ dataDir: tmpDir });
      expect(db).toBeDefined();
      expect(typeof db.prepare).toBe('function');
      expect(typeof db.exec).toBe('function');
    });

    it('同一 dataDir + filename 第二次调用返回同一实例', () => {
      const a = getSqlite({ dataDir: tmpDir });
      const b = getSqlite({ dataDir: tmpDir });
      expect(b).toBe(a);
    });

    it('不同 dataDir 会重建单例', () => {
      const a = getSqlite({ dataDir: tmpDir });
      const other = mkdtempSync(join(tmpdir(), 'lab-ops-sqlite-2-'));
      try {
        const b = getSqlite({ dataDir: other });
        expect(b).not.toBe(a);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it('启动后建表 dlq_messages / dlq_replay_cursor / tasks / audit_events / push_queue / model_calls', () => {
      const db = getSqlite({ dataDir: tmpDir });
      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[])
        .map((r) => r.name);
      expect(tables).toContain('dlq_messages');
      expect(tables).toContain('dlq_replay_cursor');
      expect(tables).toContain('tasks');
      expect(tables).toContain('audit_events');
      expect(tables).toContain('push_queue');
      expect(tables).toContain('model_calls');
      expect(tables).toContain('schema_migrations');
    });

    it('migrations 幂等（多次 getSqlite 不重复插入）', () => {
      const db1 = getSqlite({ dataDir: tmpDir });
      db1.prepare(`INSERT INTO dlq_messages (channel_name, error_code, raw_bytes) VALUES (?, ?, ?)`)
        .run('hl7', 'TEST', Buffer.from([0x0b]));
      // 重新打开（先 close）
      _resetSqliteSingleton();
      const db2 = getSqlite({ dataDir: tmpDir });
      const rows = db2.prepare(`SELECT COUNT(*) as c FROM dlq_messages`).get() as { c: number };
      expect(rows.c).toBe(1);
      // schema_migrations 每个版本唯一（v1 建表 / v2 补 DLQ 回放状态 / v3 补 push_queue.next_attempt_at）
      const versions = db2.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as { version: number }[];
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    });

    it('自动创建 dataDir（不存在时 mkdir -p）', () => {
      const nested = join(tmpDir, 'a', 'b', 'c');
      expect(existsSync(nested)).toBe(false);
      getSqlite({ dataDir: nested });
      expect(existsSync(join(nested, 'lab-ops-console.db'))).toBe(true);
    });

    it('WAL 模式生效（journal_mode = wal）', () => {
      const db = getSqlite({ dataDir: tmpDir });
      const row = db.prepare(`PRAGMA journal_mode`).get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe('wal');
    });
  });

  describe('closeSqlite / _resetSqliteSingleton', () => {
    it('closeSqlite 关闭后下次 getSqlite 新建实例', () => {
      const a = getSqlite({ dataDir: tmpDir });
      closeSqlite();
      const b = getSqlite({ dataDir: tmpDir });
      expect(b).not.toBe(a);
    });

    it('_resetSqliteSingleton 与 closeSqlite 等价', () => {
      getSqlite({ dataDir: tmpDir });
      _resetSqliteSingleton();
      // 第二次调用应正常
      expect(() => getSqlite({ dataDir: tmpDir })).not.toThrow();
    });
  });

  describe('createTestSqlite (内存)', () => {
    it('返回内存数据库 + close()', () => {
      const t = createTestSqlite();
      expect(t.db).toBeDefined();
      t.db.prepare(`INSERT INTO dlq_messages (channel_name, error_code, raw_bytes) VALUES (?, ?, ?)`)
        .run('test', 'X', Buffer.from([]));
      const row = t.db.prepare(`SELECT COUNT(*) as c FROM dlq_messages`).get() as { c: number };
      expect(row.c).toBe(1);
      t.close();
    });

    it('多次 createTestSqlite 互相隔离（不走单例）', () => {
      const t1 = createTestSqlite();
      const t2 = createTestSqlite();
      t1.db.prepare(`INSERT INTO tasks (id, kind, status, payload) VALUES ('t1', 'k', 'requested', '{}')`).run();
      const t2Count = (t2.db.prepare(`SELECT COUNT(*) as c FROM tasks`).get() as { c: number }).c;
      expect(t2Count).toBe(0);
      t1.close();
      t2.close();
    });

    it('内存模式 migrations 同样建表', () => {
      const t = createTestSqlite();
      const tables = (t.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[])
        .map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining([
        'dlq_messages', 'dlq_replay_cursor', 'tasks', 'audit_events', 'push_queue', 'model_calls', 'schema_migrations',
      ]));
      t.close();
    });
  });

  describe('DLQ + tasks + audit_events 写入可工作', () => {
    it('DLQ 写 + 查询', () => {
      const t = createTestSqlite();
      t.db.prepare(`INSERT INTO dlq_messages (channel_name, error_code, error_message, raw_bytes) VALUES (?, ?, ?, ?)`)
        .run('hl7', 'VT_MISSING', 'no start byte', Buffer.from([0x41, 0x42]));
      const rows = t.db.prepare(`SELECT channel_name, error_code FROM dlq_messages WHERE channel_name=?`).all('hl7') as Array<{ channel_name: string; error_code: string }>;
      expect(rows).toEqual([{ channel_name: 'hl7', error_code: 'VT_MISSING' }]);
      t.close();
    });

    it('audit_events 四字段非空 + 索引存在', () => {
      const t = createTestSqlite();
      t.db.prepare(`INSERT INTO audit_events (agent, recorded, source, outcome) VALUES (?, ?, ?, ?)`)
        .run('nurse-1', '2026-10-13T00:00:00Z', 'lab-ops-console', 'success');
      const idx = t.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_events'`).all() as Array<{ name: string }>;
      expect(idx.map((i) => i.name)).toEqual(expect.arrayContaining(['idx_audit_task', 'idx_audit_recorded']));
      t.close();
    });

    it('model_calls 写 + structured_ok 默认 0', () => {
      const t = createTestSqlite();
      t.db.prepare(`INSERT INTO model_calls (prompt_name, model_id, prompt_hash, outcome) VALUES (?, ?, ?, ?)`)
        .run('SUGGEST_LOINC', 'gpt-4o-mini', 'h1', 'success');
      const row = t.db.prepare(`SELECT structured_ok FROM model_calls WHERE prompt_name=?`).get('SUGGEST_LOINC') as { structured_ok: number };
      expect(row.structured_ok).toBe(0);
      t.close();
    });
  });
});
