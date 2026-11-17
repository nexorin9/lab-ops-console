/**
 * T11 · 三个危急值 tool 验收（结构化入参 + 状态推进 + 审计四字段 + FHIR 回写）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getCriticalTools,
  type ToolContext,
  type FhirWritePort,
} from '../../src/critical/tools/index.js';
import { CriticalStore, TaskStateMachine } from '../../src/critical/index.js';

let db: Database.Database;
let store: CriticalStore;
let machine: TaskStateMachine;
let ctx: ToolContext;
let writer: FakeWriter;

class FakeWriter implements FhirWritePort {
  readonly resources = new Map<string, Record<string, unknown>>();
  async writeResource(input: { resourceType: string; body: Record<string, unknown> }) {
    const id = String(input.body.id ?? 'unknown');
    this.resources.set(`${input.resourceType}/${id}`, JSON.parse(JSON.stringify(input.body)) as Record<string, unknown>);
    return { id };
  }
  async read(resourceType: string, id: string) {
    return this.resources.get(`${resourceType}/${id}`) ?? null;
  }
  task(id: string) {
    return this.resources.get(`Task/${id}`) as { status?: string; owner?: { reference?: string } } | undefined;
  }
}

const NOW = '2026-11-08T09:00:00.000Z';

async function seedTask(id: string, overrides: Record<string, unknown> = {}) {
  return store.createTask({
    id,
    patient_id: 'pid-abc123',
    status: 'requested',
    focus_diagnostic_id: 'DiagnosticReport/dr-001',
    focus_observation_code: 'K',
    priority: 'stat',
    reason_text: '血钾 6.8 mmol/L',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  store = CriticalStore.withDb(db);
  machine = new TaskStateMachine(store);
  writer = new FakeWriter();
  writer.resources.set('DiagnosticReport/dr-001', {
    resourceType: 'DiagnosticReport',
    id: 'dr-001',
    status: 'final',
    code: { text: '电解质' },
    subject: { reference: 'Patient/pid-abc123' },
    issued: NOW,
    note: [{ text: '仪器原始提示：血钾危急', time: NOW }],
  });
  ctx = { store, stateMachine: machine, writer, source: 'lab-ops-console', now: () => NOW };
});

afterEach(() => db.close());

describe('T11 · list_critical_values', () => {
  it('默认只列未完成 Task，支持 status 过滤', async () => {
    await seedTask('task-a');
    await seedTask('task-b', { status: 'completed', focus_observation_code: 'NA', id: 'task-b' });
    const tools = getCriticalTools();
    const all = await tools.call('list_critical_values', {}, ctx);
    expect(all.count).toBe(1);
    expect((all.tasks as Array<{ task_id: string }>)[0]!.task_id).toBe('task-a');
    const completed = await tools.call('list_critical_values', { status: 'completed' }, ctx);
    expect(completed.count).toBe(1);
  });

  it('按患者与时间区间过滤', async () => {
    await seedTask('task-a');
    await seedTask('task-b', {
      id: 'task-b', patient_id: 'pid-other', focus_diagnostic_id: 'DiagnosticReport/dr-002',
      created_at: '2026-10-01T00:00:00.000Z',
    });
    const tools = getCriticalTools();
    const byPatient = await tools.call('list_critical_values', { patient_id: 'pid-abc123' }, ctx);
    expect(byPatient.count).toBe(1);
    const byRange = await tools.call('list_critical_values', {
      time_range: { from: '2026-11-01', to: '2026-11-30' },
    }, ctx);
    expect(byRange.count).toBe(1);
  });
});

describe('T11 · acknowledge_critical_value', () => {
  it('ack 成功：status=received 且 AuditEvent 四字段齐全', async () => {
    await seedTask('task-a');
    const r = await getCriticalTools().call('acknowledge_critical_value', {
      task_id: 'task-a', practitioner_id: 'nurse-01', role: 'nurse',
    }, ctx);
    expect(r.status).toBe('received');
    const audit = r.audit as Record<string, string>;
    expect(audit.agent).toBeTruthy();
    expect(audit.recorded).toBeTruthy();
    expect(audit.source).toBeTruthy();
    expect(audit.outcome).toBe('success');
    const chain = await store.queryAuditChain('task-a');
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain.every((a) => a.agent && a.recorded && a.source && a.outcome)).toBe(true);
  });

  it('ack 回写 FHIR Task 状态为 received 且带 owner', async () => {
    await seedTask('task-a');
    await getCriticalTools().call('acknowledge_critical_value', {
      task_id: 'task-a', practitioner_id: 'nurse-01', role: 'nurse',
    }, ctx);
    expect(writer.task('task-a')?.status).toBe('received');
    expect(writer.task('task-a')?.owner?.reference).toBe('Practitioner/nurse-01');
    const audits = [...writer.resources.keys()].filter((k) => k.startsWith('AuditEvent/'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it('重复 ack 被拒并留 denied 审计，状态不回退', async () => {
    await seedTask('task-a');
    const tools = getCriticalTools();
    await tools.call('acknowledge_critical_value', { task_id: 'task-a', practitioner_id: 'n-1', role: 'nurse' }, ctx);
    await expect(tools.call('acknowledge_critical_value', {
      task_id: 'task-a', practitioner_id: 'n-2', role: 'nurse',
    }, ctx)).rejects.toThrow();
    expect((await store.getTask('task-a'))!.status).toBe('received');
    const denied = (await store.queryAuditChain('task-a')).filter((a) => a.outcome === 'denied');
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });

  it('缺 practitioner_id 被 zod 拒绝，不推进状态且写 denied', async () => {
    await seedTask('task-a');
    await expect(getCriticalTools().call('acknowledge_critical_value', {
      task_id: 'task-a', role: 'nurse',
    }, ctx)).rejects.toThrow(/入参校验失败/);
    expect((await store.getTask('task-a'))!.status).toBe('requested');
    expect((await store.queryDeniedAudits({ from: '2020', to: '2030' })).length).toBeGreaterThanOrEqual(1);
  });

  it('缺 AuditEvent 字段（source 为空）被拒并写 denied，不推进状态', async () => {
    await seedTask('task-a');
    const broken: ToolContext = { ...ctx, stateMachine: new TaskStateMachine(store, '') };
    await expect(getCriticalTools().call('acknowledge_critical_value', {
      task_id: 'task-a', practitioner_id: 'n-1', role: 'nurse',
    }, broken)).rejects.toThrow();
    expect((await store.getTask('task-a'))!.status).toBe('requested');
  });
});

describe('T11 · resolve_critical_value', () => {
  it('resolve 严格走完 received → in-progress → completed 三态', async () => {
    await seedTask('task-a');
    const tools = getCriticalTools();
    await tools.call('acknowledge_critical_value', { task_id: 'task-a', practitioner_id: 'n-1', role: 'nurse' }, ctx);
    const r = await tools.call('resolve_critical_value', {
      task_id: 'task-a', practitioner_id: 'doc-1', resolution_note: '已安排透析',
    }, ctx);
    expect(r.status).toBe('completed');
    const chain = await store.queryAuditChain('task-a');
    expect(chain.filter((a) => a.outcome === 'success').map((a) => a.reason))
      .toEqual(expect.arrayContaining(['acknowledged', 'treatment_started', 'resolved']));
    expect(writer.task('task-a')?.status).toBe('completed');
  });

  it('DiagnosticReport.note 累加处置备注（保留原有 note）', async () => {
    await seedTask('task-a');
    const tools = getCriticalTools();
    await tools.call('acknowledge_critical_value', { task_id: 'task-a', practitioner_id: 'n-1', role: 'nurse' }, ctx);
    const r = await tools.call('resolve_critical_value', {
      task_id: 'task-a', practitioner_id: 'doc-1', resolution_note: '已安排透析',
    }, ctx);
    expect(r.notes).toEqual(['仪器原始提示：血钾危急', '已安排透析']);
    const report = writer.resources.get('DiagnosticReport/dr-001') as { note: Array<{ text: string }> };
    expect(report.note.map((n) => n.text)).toEqual(['仪器原始提示：血钾危急', '已安排透析']);
  });

  it('缺处置备注被拒；requested 直接 resolve（跳步）被拒', async () => {
    await seedTask('task-a');
    const tools = getCriticalTools();
    await expect(tools.call('resolve_critical_value', {
      task_id: 'task-a', practitioner_id: 'doc-1', resolution_note: '',
    }, ctx)).rejects.toThrow(/入参校验失败/);
    await expect(tools.call('resolve_critical_value', {
      task_id: 'task-a', practitioner_id: 'doc-1', resolution_note: '直接关闭',
    }, ctx)).rejects.toThrow();
    expect((await store.getTask('task-a'))!.status).toBe('requested');
  });
});
