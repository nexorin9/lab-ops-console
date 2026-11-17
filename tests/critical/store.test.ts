/**
 * T9 · CriticalStore 持久化底座验收
 *
 * 逐条锁死：focus 幂等 / 六值状态 CHECK / 四值 outcome CHECK / 审计链时间序 /
 * denied 部分索引倒查 / 患者维度列表 / 重复写不产生重复审计。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CriticalStore, TASK_STATES } from '../../src/critical/index.js';

let db: Database.Database;
let store: CriticalStore;

const NOW = '2026-11-08T09:00:00.000Z';

function makeTask(id: string, overrides: Partial<Parameters<CriticalStore['createTask']>[0]> = {}) {
  return {
    id,
    patient_id: 'hash-patient-001',
    status: 'requested',
    focus_diagnostic_id: 'DiagnosticReport/dr-001',
    focus_observation_code: 'K',
    priority: 'urgent',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function audit(overrides: Partial<Parameters<CriticalStore['writeAudit']>[0]> = {}) {
  return {
    task_id: 'task-001',
    agent: 'Practitioner/nurse-a',
    recorded: NOW,
    source: 'lab-ops-console',
    outcome: 'success' as const,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  store = CriticalStore.withDb(db);
});

afterEach(() => db.close());

describe('T9 · critical_tasks 三表与约束', () => {
  it('同一 focus 二次 createTask 后 critical_tasks 行数仍为 1', async () => {
    const first = await store.createTask(makeTask('task-001'));
    const second = await store.createTask(makeTask('task-002'));
    expect(second.id).toBe(first.id);
    expect(store.countTasks()).toBe(1);
    expect((await store.findTaskByFocus('DiagnosticReport/dr-001', 'K'))?.id).toBe('task-001');
  });

  it('status 六值 CHECK：合法值全通过，第七值直接抛错', async () => {
    for (const status of TASK_STATES) {
      await store.createTask(makeTask(`task-${status}`, {
        status,
        focus_diagnostic_id: `DiagnosticReport/dr-${status}`,
      }));
    }
    expect(store.countTasks()).toBe(6);
    expect(() => db.prepare(`INSERT INTO critical_tasks
      (id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, created_at, updated_at)
      VALUES ('bad','p','unknown','dr','K','urgent','${NOW}','${NOW}')`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('outcome 四值 CHECK：非法 outcome 被 SQLite 拒绝', () => {
    expect(() => db.prepare(`INSERT INTO critical_audit_events
      (task_id, agent, recorded, source, outcome) VALUES ('t','a','${NOW}','s','bogus')`).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it('审计链按 recorded 升序可还原完整处置轨迹', async () => {
    await store.createTask(makeTask('task-001'));
    await store.writeAudit(audit({ recorded: '2026-11-08T09:03:00.000Z', reason: 'resolved' }));
    await store.writeAudit(audit({ recorded: '2026-11-08T09:01:00.000Z', reason: 'acknowledged' }));
    await store.writeAudit(audit({ recorded: '2026-11-08T09:00:00.000Z', reason: 'task_created' }));
    const chain = await store.queryAuditChain('task-001');
    expect(chain.map((r) => r.reason)).toEqual(['task_created', 'acknowledged', 'resolved']);
    for (const row of chain) {
      expect(row.agent).toBeTruthy();
      expect(row.recorded).toBeTruthy();
      expect(row.source).toBeTruthy();
      expect(row.outcome).toBeTruthy();
    }
  });

  it('denied 部分索引可查出被拒审计，并能按 reason 分类', async () => {
    const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_critical_audit_denied'`)
      .all() as Array<{ name: string; sql: string | null }>;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.sql).toContain("outcome = 'denied'");

    await store.writeAudit(audit({ outcome: 'denied', reason: 'invalid_transition' }));
    await store.writeAudit(audit({ outcome: 'denied', reason: 'duplicate_ack' }));
    await store.writeAudit(audit({ outcome: 'success', reason: 'acknowledged' }));

    const denied = await store.queryDeniedAudits({ from: '2026-01-01', to: '2027-01-01' });
    expect(denied).toHaveLength(2);
    expect(denied.map((r) => r.reason).sort()).toEqual(['duplicate_ack', 'invalid_transition']);
    // 断言查询规划器确实走部分索引，而不是全表扫描
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM critical_audit_events
      INDEXED BY idx_critical_audit_denied WHERE outcome='denied'`).all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toContain('idx_critical_audit_denied');
  });

  it('患者维度列表按 updated_at 倒序且只返回该患者', async () => {
    await store.createTask(makeTask('task-001', { patient_id: 'p-a', updated_at: NOW }));
    await store.createTask(makeTask('task-002', {
      patient_id: 'p-a', focus_observation_code: 'NA', updated_at: '2026-11-08T10:00:00.000Z',
    }));
    await store.createTask(makeTask('task-003', {
      patient_id: 'p-b', focus_diagnostic_id: 'DiagnosticReport/dr-002',
    }));
    const rows = await store.listByPatient('p-a');
    expect(rows.map((r) => r.id)).toEqual(['task-002', 'task-001']);
    expect((await store.listByStatus('requested')).length).toBe(3);
  });

  it('同一 dedupeKey 重复写审计只落一条（通道重放不产生重复留痕）', async () => {
    const input = audit({ dedupeKey: 'task-001:received:nurse-a' });
    const first = await store.writeAudit(input);
    const second = await store.writeAudit(input);
    expect(second.id).toBe(first.id);
    expect((await store.queryAuditChain('task-001')).length).toBe(1);
    // 不同 dedupeKey 仍可写第二条
    await store.writeAudit(audit({ dedupeKey: 'task-001:completed:doctor-b', reason: 'resolved' }));
    expect((await store.queryAuditChain('task-001')).length).toBe(2);
  });
});
