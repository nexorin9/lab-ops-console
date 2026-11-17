/**
 * T27 · 危急值并发与幂等压测（≥3 条）
 *
 * 1. 120 个并发 Task 互不串扰（患者与检验项不互串）
 * 2. 同一危急值并发推送 20 次只产生 1 个 Task
 * 3. 并发 ack 同一 Task 仅 1 次成功推进，其余记为重复确认拒绝并可倒查
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CriticalStore } from '../../src/critical/store.js';
import { TaskStateMachine } from '../../src/critical/Task-state-machine.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let store: CriticalStore;
let sm: TaskStateMachine;
let baseline = '';

const AGENT = { practitionerId: 'PR-LOAD-001', display: '压测执行者', role: 'nurse' as const };
const nowIso = () => new Date().toISOString();

beforeAll(() => {
  db = createTestSqlite().db;
  store = new CriticalStore(db);
  sm = new TaskStateMachine(store, 'critical-concurrency-test');
});
afterAll(() => {
  if (baseline) process.stdout.write(`${baseline}\n`);
  db.close();
});

describe('T27 · 并发与幂等', () => {
  it('120 个并发 Task 字段无串扰（患者与检验项一一对应），全部落库', async () => {
    const started = Date.now();
    await Promise.all(Array.from({ length: 120 }, (_, i) => sm.createTask({
      patientId: `pid:patient-${String(i).padStart(3, '0')}`,
      focusDiagnosticId: `DR-CONC-${String(i).padStart(3, '0')}`,
      focusObservationCode: i % 2 === 0 ? 'K' : 'NA',
      priority: 'stat',
      reasonText: `并发用例 ${i}`,
      agent: AGENT,
      now: nowIso(),
    })));
    const elapsedMs = Date.now() - started;
    const rows = db.prepare(`SELECT id, patient_id, focus_diagnostic_id, focus_observation_code FROM critical_tasks`).all() as Array<{
      id: string; patient_id: string; focus_diagnostic_id: string; focus_observation_code: string;
    }>;
    expect(rows).toHaveLength(120);
    for (const row of rows) {
      const i = Number(row.focus_diagnostic_id.replace('DR-CONC-', ''));
      expect(row.patient_id).toBe(`pid:patient-${String(i).padStart(3, '0')}`);
      expect(row.focus_observation_code).toBe(i % 2 === 0 ? 'K' : 'NA');
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(120);
    baseline = `BASELINE T27：120 并发 Task 创建耗时 ${elapsedMs}ms，落库 120/120，字段零串扰。`;
  }, 60_000);

  it('同一危急值并发推送 20 次只产生 1 个 Task', async () => {
    const before = store.countTasks();
    const results = await Promise.all(Array.from({ length: 20 }, () => sm.createTask({
      patientId: 'pid:patient-dup',
      focusDiagnosticId: 'DR-DUP-001',
      focusObservationCode: 'K',
      priority: 'stat',
      agent: AGENT,
      now: nowIso(),
    })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(store.countTasks()).toBe(before + 1);
    const chain = await store.queryAuditChain(results[0]!.id);
    expect(chain.filter((a) => a.reason === 'task_created')).toHaveLength(1);
  }, 30_000);

  it('并发 ack 10 次仅 1 次成功推进，9 条 duplicate_ack denied 审计可查', async () => {
    const task = await sm.createTask({
      patientId: 'pid:patient-ack',
      focusDiagnosticId: 'DR-ACK-001',
      focusObservationCode: 'GLU',
      agent: AGENT,
      now: nowIso(),
    });
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => sm.transition({
      taskId: task.id,
      fromState: 'requested',
      toState: 'received',
      agent: { ...AGENT, practitionerId: `PR-ACK-${i}` },
      now: nowIso(),
    })));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(9);
    expect((await store.getTask(task.id))?.status).toBe('received');

    const chain = await store.queryAuditChain(task.id);
    const denied = chain.filter((a) => a.outcome === 'denied' && a.reason === 'duplicate_ack');
    expect(denied).toHaveLength(9);
    expect(denied.every((a) => a.agent && a.recorded && a.source && a.outcome)).toBe(true);
    const byReason = db.prepare(`SELECT reason, COUNT(*) AS n FROM critical_audit_events WHERE task_id = ? AND outcome='denied' GROUP BY reason`).all(task.id) as Array<{ reason: string; n: number }>;
    expect(byReason).toEqual([{ reason: 'duplicate_ack', n: 9 }]);
    baseline += ` 并发 ack 10 次仅 1 次成功推进，9 条 duplicate_ack denied 审计可查。`;
  }, 30_000);
});
