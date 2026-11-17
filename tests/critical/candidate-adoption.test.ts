/**
 * T33 · 候选接收人人工采纳闭环验收
 * - candidatesFor 透出进程内候选缓存
 * - accept 写 success 审计（candidate_accepted）+ Task.owner 回写 FHIR
 * - ignore 写 success 审计（candidate_ignored），不回写 owner
 * - 非法 index 抛错
 * - list_critical_values 快照携带 value/unit/testDisplay/severity（面板渲染依赖）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getCriticalTools,
  type ToolContext,
  type FhirWritePort,
} from '../../src/critical/tools/index.js';
import { CriticalStore, TaskStateMachine, CandidateAdoption } from '../../src/critical/index.js';
import type { Candidate } from '../../src/ai/types.js';

let db: Database.Database;
let store: CriticalStore;
let machine: TaskStateMachine;
let writer: FakeWriter;
let ctx: ToolContext;
const NOW = '2026-11-08T09:00:00.000Z';

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

const CANDIDATES: Candidate[] = [
  { role: '主治医生', practitionerId: 'doc-01', confidence: 0.92, reason: '值班表中的血钾危急值负责人', source: 'rule' },
  { role: '住院医', practitionerId: 'doc-02', confidence: 0.61, reason: '同组二线', source: 'model', lowConfidence: true },
];

beforeEach(() => {
  db = new Database(':memory:');
  store = CriticalStore.withDb(db);
  machine = new TaskStateMachine(store);
  writer = new FakeWriter();
  ctx = { store, stateMachine: machine, writer, source: 'lab-ops-console', now: () => NOW };
});

afterEach(() => db.close());

async function seedTask(id: string) {
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
    focus_value: '6.8',
    focus_unit: 'mmol/L',
    focus_test_code: 'K',
    focus_test_display: '血钾',
    focus_severity: 'critical',
  });
}

describe('T33 · candidatesFor', () => {
  it('透出进程内候选缓存，缺则空数组', async () => {
    await seedTask('task-a');
    const map = new Map<string, Candidate[]>([['task-a', CANDIDATES]]);
    const adoption = new CandidateAdoption({ candidates: map, store, stateMachine: machine, source: 'lab-ops-console', now: () => NOW });
    expect(await adoption.candidatesFor('task-a')).toHaveLength(2);
    expect(await adoption.candidatesFor('task-no-such')).toEqual([]);
  });
});

describe('T33 · accept（采纳）', () => {
  it('accept 写 candidate_accepted 审计并回写 Task.owner 到 FHIR', async () => {
    await seedTask('task-a');
    const map = new Map<string, Candidate[]>([['task-a', CANDIDATES]]);
    const adoption = new CandidateAdoption({ candidates: map, store, stateMachine: machine, writer, source: 'lab-ops-console', now: () => NOW });
    const res = await adoption.accept('task-a', { index: 0 });
    expect(res.ok).toBe(true);
    expect((res.accepted as { practitionerId: string }).practitionerId).toBe('doc-01');
    expect((res as { ownerWritten: boolean }).ownerWritten).toBe(true);

    const chain = await store.queryAuditChain('task-a');
    const accepted = chain.find((a) => a.reason === 'candidate_accepted');
    expect(accepted).toBeTruthy();
    expect(accepted!.outcome).toBe('success');
    expect(accepted!.agent).toBe('doc-01');
    expect(JSON.parse(accepted!.context ?? '{}').confidence).toBe(0.92);

    // FHIR Task.owner = Practitioner/doc-01
    expect(writer.task('task-a')?.owner?.reference).toBe('Practitioner/doc-01');
  });

  it('accept 低置信度候选也照常采纳并保留 lowConfidence 标记', async () => {
    await seedTask('task-a');
    const map = new Map<string, Candidate[]>([['task-a', CANDIDATES]]);
    const adoption = new CandidateAdoption({ candidates: map, store, stateMachine: machine, writer, source: 'lab-ops-console', now: () => NOW });
    const res = await adoption.accept('task-a', { index: 1 });
    expect((res.accepted as { lowConfidence: boolean }).lowConfidence).toBe(true);
    expect(writer.task('task-a')?.owner?.reference).toBe('Practitioner/doc-02');
  });

  it('accept 缺 writer 时仍写审计、ownerWritten=false 且不抛错', async () => {
    await seedTask('task-a');
    const map = new Map<string, Candidate[]>([['task-a', CANDIDATES]]);
    const adoption = new CandidateAdoption({ candidates: map, store, stateMachine: machine, source: 'lab-ops-console', now: () => NOW });
    const res = await adoption.accept('task-a', { index: 0 });
    expect((res as { ownerWritten: boolean }).ownerWritten).toBe(false);
    expect((await store.queryAuditChain('task-a')).some((a) => a.reason === 'candidate_accepted')).toBe(true);
  });

  it('非法 index 抛错且不留采纳审计', async () => {
    await seedTask('task-a');
    const map = new Map<string, Candidate[]>([['task-a', CANDIDATES]]);
    const adoption = new CandidateAdoption({ candidates: map, store, stateMachine: machine, source: 'lab-ops-console', now: () => NOW });
    await expect(adoption.accept('task-a', { index: 9 })).rejects.toThrow(/候选不存在/);
    await expect(adoption.accept('task-a', { index: -1 })).rejects.toThrow(/候选不存在/);
    expect((await store.queryAuditChain('task-a')).some((a) => a.reason === 'candidate_accepted')).toBe(false);
  });
});

describe('T33 · ignore（忽略）', () => {
  it('ignore 写 candidate_ignored 审计且不回写 FHIR owner', async () => {
    await seedTask('task-a');
    const map = new Map<string, Candidate[]>([['task-a', CANDIDATES]]);
    const adoption = new CandidateAdoption({ candidates: map, store, stateMachine: machine, writer, source: 'lab-ops-console', now: () => NOW });
    const res = await adoption.ignore('task-a', { index: 1 });
    expect(res.ok).toBe(true);
    const chain = await store.queryAuditChain('task-a');
    expect(chain.some((a) => a.reason === 'candidate_ignored')).toBe(true);
    // 忽略不应触发 owner 回写
    expect(writer.task('task-a')).toBeUndefined();
  });
});

describe('T31 · list_critical_values 快照携带展示字段', () => {
  it('返回 value/unit/testDisplay/severity/patientHash，便于面板渲染数值', async () => {
    await seedTask('task-a');
    const tools = getCriticalTools();
    const out = await tools.call('list_critical_values', {}, ctx) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(out.tasks).toHaveLength(1);
    const t = out.tasks[0]!;
    expect(t.value).toBe('6.8');
    expect(t.unit).toBe('mmol/L');
    expect(t.testDisplay).toBe('血钾');
    expect(t.testCode).toBe('K');
    expect(t.severity).toBe('critical');
    expect(t.patientHash).toBe('pid-abc123');
    expect(t.detectedAt).toBe(NOW);
  });
});
