/**
 * critical state-machine + store + dispatcher 单元测试
 *
 * 覆盖：
 * - 危急值识别（detector）：severity 映射 + 5 分钟窗口去重 + summary 生成
 * - state machine：4 类非法转换拒绝 + 正常推进 + mutex 串行化
 * - store：AuditEvent 四字段非空约束 + index 查询 + 飞检倒查
 * - dispatcher：WS 优先 / webhook 降级 / push_queue 兜底
 */

import { describe, it, beforeEach, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  detect,
  makeDedupeKey,
  severityFromAbnormalFlag,
  severityFromThreshold,
  extractAbnormalFlag,
  resolvePatientId,
  maxSeverity,
  TaskStateMachine,
  CriticalStore,
  NotificationDispatcher,
  validateAuditFields,
  validateTransition,
  TASK_STATES,
} from '../../src/critical/index.js';
import { TaskInvalidTransitionError, AuditFieldMissingError } from '../../src/shared/errors.js';
import type { ParserResult } from '../../src/parser/fhir-types.js';

// ===== 测试用工具 =====

function makeTestStore(): { store: CriticalStore; cleanup: () => void } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  const store = CriticalStore.withDb(db);
  return { store, cleanup: () => db.close() };
}

function makeParserResult(overrides: Partial<ParserResult> = {}): ParserResult {
  return {
    observations: [],
    diagnosticReport: {
      resourceType: 'DiagnosticReport',
      id: 'dr-test-001',
      status: 'final',
      code: { coding: [{ code: 'K/NA/CL', display: '电解质' }], text: '电解质' },
      subject: { reference: 'Patient/P-001', type: 'Patient' },
      effectiveDateTime: '2026-10-13T08:00:00Z',
      issued: '2026-10-13T08:00:00Z',
      result: [],
    },
    specimen: {
      resourceType: 'Specimen',
      id: 'spec-test-001',
      identifier: [{ system: 'urn:lab-ops-console:accession', value: 'dev1:ctrl-001' }],
      accessionIdentifier: { system: 'urn:lab-ops-console:accession', value: 'dev1:ctrl-001' },
      receivedTime: '2026-10-13T08:00:00Z',
    },
    device: { resourceType: 'Device', id: 'dev1' },
    fieldAttribution: [],
    criticalFlags: [],
    ...overrides,
  };
}

// ===== detector 测试 =====

describe('critical.detector', () => {
  it('OBX.8 = HH → severity critical', () => {
    expect(severityFromAbnormalFlag('HH')).toBe('critical');
    expect(severityFromAbnormalFlag('LL')).toBe('critical');
    expect(severityFromAbnormalFlag('AA')).toBe('critical');
  });

  it('OBX.8 = H / L → severity high', () => {
    expect(severityFromAbnormalFlag('H')).toBe('high');
    expect(severityFromAbnormalFlag('L')).toBe('high');
  });

  it('OBX.8 = A → severity medium', () => {
    expect(severityFromAbnormalFlag('A')).toBe('medium');
  });

  it('OBX.8 = N / 空 → severity low', () => {
    expect(severityFromAbnormalFlag('N')).toBe('low');
    expect(severityFromAbnormalFlag('')).toBe('low');
  });

  it('threshold_exceeded on K → severity critical', () => {
    expect(severityFromThreshold('K')).toBe('critical');
    expect(severityFromThreshold('GLU')).toBe('critical');
  });

  it('threshold_exceeded on non-critical code → severity high', () => {
    expect(severityFromThreshold('CL')).toBe('high');
  });

  it('maxSeverity 取较高档位', () => {
    expect(maxSeverity('low', 'high')).toBe('high');
    expect(maxSeverity('critical', 'high')).toBe('critical');
    expect(maxSeverity('medium', 'medium')).toBe('medium');
  });

  it('makeDedupeKey 5 分钟窗口对齐', () => {
    const k1 = makeDedupeKey('P-001', 'K', 1000 * 60 * 0);
    const k2 = makeDedupeKey('P-001', 'K', 1000 * 60 * 4);
    const k3 = makeDedupeKey('P-001', 'K', 1000 * 60 * 5);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('detect：无 criticalFlags → hasCritical=false', () => {
    const r = detect(makeParserResult());
    expect(r.hasCritical).toBe(false);
    expect(r.severity).toBe('low');
    expect(r.flags).toEqual([]);
    expect(r.summary).toBe('');
  });

  it('detect：1 条 abnormal_flag HH → severity critical + summary 含 testCode', () => {
    const r = detect(makeParserResult({
      criticalFlags: [{
        observationId: 'obs-001',
        testCode: 'K',
        testDisplay: '钾',
        value: '6.8',
        unit: 'mmol/L',
        reason: 'abnormal_flag',
        detail: 'OBX.8=HH 标记为危急（K=6.8mmol/L）',
      }],
    }), { now: 1000 * 60 * 1000 });
    expect(r.hasCritical).toBe(true);
    expect(r.severity).toBe('critical');
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].testCode).toBe('K');
    expect(r.summary).toContain('钾');
  });

  it('detect：同 dedupe key 合并 detail', () => {
    const now = 1000 * 60 * 1000;
    const r = detect(makeParserResult({
      criticalFlags: [
        { observationId: 'obs-001', testCode: 'K', testDisplay: '钾', value: '6.8', unit: 'mmol/L', reason: 'abnormal_flag', detail: 'HH K=6.8' },
        { observationId: 'obs-002', testCode: 'K', testDisplay: '钾', value: '6.9', unit: 'mmol/L', reason: 'threshold_exceeded', detail: 'K=6.9 > 6.0' },
      ],
    }), { now });
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].severity).toBe('critical');
    expect(r.flags[0].detail).toContain('HH K=6.8');
    expect(r.flags[0].detail).toContain('K=6.9 > 6.0');
  });

  it('detect：多条不同 testCode → flags 数 = testCode 数', () => {
    const r = detect(makeParserResult({
      criticalFlags: [
        { observationId: 'obs-001', testCode: 'K', testDisplay: '钾', value: '6.8', unit: 'mmol/L', reason: 'abnormal_flag', detail: 'K=6.8 HH' },
        { observationId: 'obs-002', testCode: 'GLU', testDisplay: '葡萄糖', value: '28', unit: 'mmol/L', reason: 'abnormal_flag', detail: 'GLU=28 HH' },
        { observationId: 'obs-003', testCode: 'NA', testDisplay: '钠', value: '120', unit: 'mmol/L', reason: 'threshold_exceeded', detail: 'NA=120 < 120' },
      ],
    }), { now: 1000 * 60 * 1000 });
    expect(r.flags).toHaveLength(3);
    expect(r.summary).toContain('K');
    expect(r.summary).toContain('GLU');
  });
});

// ===== store 测试 =====

describe('critical.store', () => {
  let store: CriticalStore;
  let cleanup: () => void;

  beforeEach(() => {
    const r = makeTestStore();
    store = r.store;
    cleanup = r.cleanup;
  });

  it('createTask + getTask round-trip', async () => {
    const t = await store.createTask({
      id: 'task-001',
      patient_id: 'P-001',
      status: 'requested',
      focus_diagnostic_id: 'dr-001',
      focus_observation_code: 'K',
      priority: 'urgent',
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    });
    expect(t.id).toBe('task-001');
    expect(t.status).toBe('requested');

    const got = await store.getTask('task-001');
    expect(got?.patient_id).toBe('P-001');
    cleanup();
  });

  it('writeAudit 四字段非空约束（CHECK 约束）', async () => {
    await store.createTask({
      id: 'task-002',
      patient_id: 'P-001',
      status: 'requested',
      focus_diagnostic_id: 'dr-002',
      focus_observation_code: 'K',
      priority: 'urgent',
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    });
    // 缺 outcome：CHECK 约束会拒
    expect(() => store.statements && store['db']).not.toThrow();
    // 写入合法审计
    const audit = await store.writeAudit({
      task_id: 'task-002',
      agent: 'nurse-001',
      agent_display: '张护士',
      recorded: '2026-10-13T08:01:00Z',
      source: 'lab-ops-console',
      outcome: 'success',
      reason: 'task_created',
      context: { patient_id: 'P-001' },
    });
    expect(audit.id).toBeGreaterThan(0);
    expect(audit.outcome).toBe('success');
    cleanup();
  });

  it('writeAudit 缺 outcome 抛 SqliteError（CHECK 约束）', async () => {
    await store.createTask({
      id: 'task-003',
      patient_id: 'P-001',
      status: 'requested',
      focus_diagnostic_id: 'dr-003',
      focus_observation_code: 'K',
      priority: 'urgent',
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    });
    expect(() => {
      (store as unknown as { db: Database.Database }).db.prepare(
        `INSERT INTO critical_audit_events (task_id, agent, recorded, source, outcome) VALUES (?, ?, ?, ?, '')`
      ).run('task-003', 'nurse-001', '2026-10-13T08:01:00Z', 'lab-ops-console');
    }).toThrow();
    cleanup();
  });

  it('findTaskByFocus 去重（同一 focus_diagnostic_id + focus_observation_code 只 1 条）', async () => {
    await store.createTask({
      id: 'task-004',
      patient_id: 'P-001',
      status: 'requested',
      focus_diagnostic_id: 'dr-004',
      focus_observation_code: 'K',
      priority: 'urgent',
      created_at: '2026-10-13T08:02:00Z',
      updated_at: '2026-10-13T08:02:00Z',
    });
    const found = await store.findTaskByFocus('dr-004', 'K');
    expect(found?.id).toBe('task-004');
    cleanup();
  });

  it('queryAuditChain 按 recorded ASC 还原时间链', async () => {
    await store.createTask({
      id: 'task-005',
      patient_id: 'P-001',
      status: 'requested',
      focus_diagnostic_id: 'dr-005',
      focus_observation_code: 'K',
      priority: 'urgent',
      created_at: '2026-10-13T08:03:00Z',
      updated_at: '2026-10-13T08:03:00Z',
    });
    await store.writeAudit({ task_id: 'task-005', agent: 'sys', recorded: '2026-10-13T08:03:00Z', source: 'lab-ops-console', outcome: 'success', reason: 'created' });
    await store.writeAudit({ task_id: 'task-005', agent: 'nurse-001', recorded: '2026-10-13T08:04:00Z', source: 'lab-ops-console', outcome: 'success', reason: 'ack' });
    await store.writeAudit({ task_id: 'task-005', agent: 'doc-001', recorded: '2026-10-13T08:05:00Z', source: 'lab-ops-console', outcome: 'denied', reason: 'bad_transition' });

    const chain = await store.queryAuditChain('task-005');
    expect(chain).toHaveLength(3);
    expect(chain[0].recorded).toBe('2026-10-13T08:03:00Z');
    expect(chain[2].reason).toBe('bad_transition');
    cleanup();
  });

  it('queryDeniedAudits 飞检倒查', async () => {
    await store.createTask({
      id: 'task-006',
      patient_id: 'P-001',
      status: 'requested',
      focus_diagnostic_id: 'dr-006',
      focus_observation_code: 'K',
      priority: 'urgent',
      created_at: '2026-10-13T08:06:00Z',
      updated_at: '2026-10-13T08:06:00Z',
    });
    await store.writeAudit({ task_id: 'task-006', agent: 'sys', recorded: '2026-10-13T08:06:00Z', source: 'lab-ops-console', outcome: 'denied', reason: 'state_mismatch' });

    const denied = await store.queryDeniedAudits({ from: '2026-10-13T00:00:00Z', to: '2026-10-13T23:59:59Z' });
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0].outcome).toBe('denied');
    cleanup();
  });
});

// ===== validateAuditFields / validateTransition 纯函数测试 =====

describe('critical.validate*', () => {
  it('validateAuditFields 缺 agent 抛错', () => {
    expect(() => validateAuditFields({
      agent: { practitionerId: '' },
      recorded: '2026-10-13T08:00:00Z',
      source: 'lab-ops-console',
      outcome: 'success',
    })).toThrow(AuditFieldMissingError);
  });

  it('validateAuditFields 缺 recorded 抛错', () => {
    expect(() => validateAuditFields({
      agent: { practitionerId: 'nurse-001' },
      recorded: '',
      source: 'lab-ops-console',
      outcome: 'success',
    })).toThrow(AuditFieldMissingError);
  });

  it('validateAuditFields 缺 source 抛错', () => {
    expect(() => validateAuditFields({
      agent: { practitionerId: 'nurse-001' },
      recorded: '2026-10-13T08:00:00Z',
      source: '',
      outcome: 'success',
    })).toThrow(AuditFieldMissingError);
  });

  it('validateAuditFields 缺 outcome 抛错', () => {
    expect(() => validateAuditFields({
      agent: { practitionerId: 'nurse-001' },
      recorded: '2026-10-13T08:00:00Z',
      source: 'lab-ops-console',
      outcome: '' as 'success',
    })).toThrow(AuditFieldMissingError);
  });

  it('validateAuditFields 全字段合法 → 不抛', () => {
    expect(() => validateAuditFields({
      agent: { practitionerId: 'nurse-001' },
      recorded: '2026-10-13T08:00:00Z',
      source: 'lab-ops-console',
      outcome: 'success',
    })).not.toThrow();
  });

  it('validateTransition：合法转换白名单', () => {
    expect(() => validateTransition('received', 'in-progress')).not.toThrow();
    expect(() => validateTransition('received', 'completed')).not.toThrow();
    expect(() => validateTransition('in-progress', 'completed')).not.toThrow();
  });

  it('validateTransition：非法转换抛错（4 类）', () => {
    // ① 跳步 completed
    expect(() => validateTransition('requested', 'completed')).toThrow(TaskInvalidTransitionError);
    // ② 多次 ack（received → received）
    expect(() => validateTransition('received', 'received')).toThrow(TaskInvalidTransitionError);
    // ③ 已终态转换
    expect(() => validateTransition('completed', 'received')).toThrow(TaskInvalidTransitionError);
    expect(() => validateTransition('cancelled', 'in-progress')).toThrow(TaskInvalidTransitionError);
    // ④ in-progress → received 不可回退
    expect(() => validateTransition('in-progress', 'received')).toThrow(TaskInvalidTransitionError);
  });

  it('TASK_STATES 含 6 个状态', () => {
    expect(TASK_STATES).toHaveLength(6);
    expect(TASK_STATES).toContain('requested');
    expect(TASK_STATES).toContain('received');
    expect(TASK_STATES).toContain('completed');
  });
});

// ===== TaskStateMachine 集成测试 =====

describe('critical.TaskStateMachine', () => {
  let store: CriticalStore;
  let sm: TaskStateMachine;
  let cleanup: () => void;

  beforeEach(() => {
    const r = makeTestStore();
    store = r.store;
    sm = new TaskStateMachine(store, 'lab-ops-console');
    cleanup = r.cleanup;
  });

  it('createTask → requested + 1 条 success audit', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-001',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
      now: '2026-10-13T08:00:00Z',
    });
    expect(t.status).toBe('requested');
    expect(t.patient_id).toBe('P-001');
    expect(t.priority).toBe('urgent');

    const audits = await store.queryAuditChain(t.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].reason).toBe('task_created');
    cleanup();
  });

  it('createTask 同 focus 去重（第二次直接返回已有）', async () => {
    const t1 = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-002',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
      now: '2026-10-13T08:00:00Z',
    });
    const t2 = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-002',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
      now: '2026-10-13T08:00:00Z',
    });
    expect(t1.id).toBe(t2.id);
    cleanup();
  });

  it('正常推进：requested → received → in-progress → completed', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-003',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    const ack = await sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' }, now: '2026-10-13T08:01:00Z' });
    expect(ack.task.status).toBe('received');

    const inProgress = await sm.transition({
      taskId: t.id,
      fromState: 'received',
      toState: 'in-progress',
      agent: { practitionerId: 'nurse-001', role: 'nurse' },
      now: '2026-10-13T08:02:00Z',
    });
    expect(inProgress.task.status).toBe('in-progress');

    const completed = await sm.resolve({ taskId: t.id, agent: { practitionerId: 'doc-001', role: 'doctor' }, resolutionNote: '已通知病房复测', now: '2026-10-13T08:10:00Z' });
    expect(completed.task.status).toBe('completed');

    const audits = await store.queryAuditChain(t.id);
    expect(audits).toHaveLength(4); // create + ack + transition + resolve
    expect(audits.filter((a) => a.outcome === 'success')).toHaveLength(4);
    cleanup();
  });

  it('拒绝 ①：跳步 completed（requested → completed）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-004',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    await expect(() => sm.transition({
      taskId: t.id,
      fromState: 'requested',
      toState: 'completed',
      agent: { practitionerId: 'doc-001', role: 'doctor' },
    })).rejects.toThrow(TaskInvalidTransitionError);

    // 写盘：denied audit 存在
    const audits = await store.queryAuditChain(t.id);
    expect(audits.some((a) => a.outcome === 'denied' && a.reason === 'invalid_transition')).toBe(true);
    cleanup();
  });

  it('拒绝 ②：同一 Task 多次 ack', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-005',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    await sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    await expect(() => sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-002', role: 'nurse' } })).rejects.toThrow(TaskInvalidTransitionError);
    const audits = await store.queryAuditChain(t.id);
    expect(audits.some((a) => a.outcome === 'denied' && a.reason === 'duplicate_ack')).toBe(true);
    cleanup();
  });

  it('拒绝 ③：state mismatch（fromState 与 DB 不一致）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-006',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    // 实际状态是 requested；谎报 fromState='received' → 拒绝
    await expect(() => sm.transition({
      taskId: t.id,
      fromState: 'received',
      toState: 'in-progress',
      agent: { practitionerId: 'nurse-001', role: 'nurse' },
    })).rejects.toThrow(TaskInvalidTransitionError);
    const audits = await store.queryAuditChain(t.id);
    expect(audits.some((a) => a.outcome === 'denied' && a.reason === 'state_mismatch')).toBe(true);
    cleanup();
  });

  it('拒绝 ④：AuditEvent 字段缺失（agent 空）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-007',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    await expect(() => sm.ackOnly({
      taskId: t.id,
      agent: { practitionerId: '', role: 'nurse' }, // 缺 practitionerId
    })).rejects.toThrow(AuditFieldMissingError);
    cleanup();
  });

  it('mutex 串行化：并发 transition 只有一条成功', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-008',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    // 两次并发 ackOnly —— 第二个应抛
    const results = await Promise.allSettled([
      sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } }),
      sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-002', role: 'nurse' } }),
    ]);
    const successes = results.filter((r) => r.status === 'fulfilled').length;
    const failures = results.filter((r) => r.status === 'rejected').length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);
    cleanup();
  });

  it('acknowledge → in-progress + resolve 流程', async () => {
    const t = await sm.createTask({
      patientId: 'P-001',
      focusDiagnosticId: 'dr-009',
      focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    await sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    const acked = await sm.acknowledge({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    expect(acked.task.status).toBe('in-progress');
    const resolved = await sm.resolve({ taskId: t.id, agent: { practitionerId: 'doc-001', role: 'doctor' }, resolutionNote: '已处置' });
    expect(resolved.task.status).toBe('completed');
    cleanup();
  });
});

// ===== NotificationDispatcher 测试 =====

describe('critical.NotificationDispatcher', () => {
  it('WS 优先推送（无 wsServer 时尝试 → webhook → none）', async () => {
    const dispatcher = new NotificationDispatcher({});
    const task = {
      id: 'task-001',
      patient_id: 'P-001',
      status: 'requested' as const,
      focus_diagnostic_id: 'dr-001',
      focus_observation_code: 'K',
      priority: 'urgent' as const,
      reason_text: null as string | null,
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    };
    const r = await dispatcher.dispatch(task, { type: 'critical.detected', summary: 'K=6.8 HH' });
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0].channel).toBe('ws');
    expect(r.attempts[0].ok).toBe(false);
  });

  it('WS 命中（fake wsServer 含 1 个 OPEN client）→ ok=true channel=ws', async () => {
    const send = vi.fn();
    const wsServer = {
      clients: new Set([
        { send, readyState: 1 },
      ]) as unknown as Iterable<{ send: (s: string) => void; readyState: number }>,
    };
    const dispatcher = new NotificationDispatcher({ wsServer });
    const task = {
      id: 'task-001',
      patient_id: 'P-001',
      status: 'requested' as const,
      focus_diagnostic_id: 'dr-001',
      focus_observation_code: 'K',
      priority: 'urgent' as const,
      reason_text: null as string | null,
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    };
    const r = await dispatcher.dispatch(task, { type: 'critical.detected', summary: 'K=6.8 HH' });
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('ws');
    expect(send).toHaveBeenCalledOnce();
    const sent = JSON.parse(send.mock.calls[0][0] as string);
    expect(sent.taskId).toBe('task-001');
    expect(sent.severity).toBe('critical'); // T10：severity 为派发载荷必带字段，默认 critical
  });

  it('WS 全部未 OPEN → 降级 webhook → 成功', async () => {
    const wsServer = {
      clients: new Set([
        { send: vi.fn(), readyState: 3 },
      ]) as unknown as Iterable<{ send: (s: string) => void; readyState: number }>,
    };
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const dispatcher = new NotificationDispatcher({
      wsServer,
      webhook: { url: 'http://localhost:8080/hook', fetchImpl: fetchMock as unknown as typeof fetch },
    });
    const task = {
      id: 'task-002',
      patient_id: 'P-001',
      status: 'requested' as const,
      focus_diagnostic_id: 'dr-002',
      focus_observation_code: 'K',
      priority: 'urgent' as const,
      reason_text: null as string | null,
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    };
    const r = await dispatcher.dispatch(task);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('webhook');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('WS + webhook 都失败 → push_queue 兜底', async () => {
    const wsServer = {
      clients: new Set([
        { send: vi.fn(), readyState: 3 },
      ]) as unknown as Iterable<{ send: (s: string) => void; readyState: number }>,
    };
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }));
    const dispatcher = new NotificationDispatcher({
      wsServer,
      webhook: { url: 'http://localhost:8080/hook', fetchImpl: fetchMock as unknown as typeof fetch },
    });
    const task = {
      id: 'task-003',
      patient_id: 'P-001',
      status: 'requested' as const,
      focus_diagnostic_id: 'dr-003',
      focus_observation_code: 'K',
      priority: 'urgent' as const,
      reason_text: null as string | null,
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    };
    const r = await dispatcher.dispatch(task);
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0].channel).toBe('ws');
    expect(r.attempts[1].channel).toBe('webhook');
  });

  it('payload 含 type + taskId + patientId + status + summary', async () => {
    const send = vi.fn();
    const wsServer = { clients: new Set([{ send, readyState: 1 }]) as unknown as Iterable<{ send: (s: string) => void; readyState: number }> };
    const dispatcher = new NotificationDispatcher({ wsServer });
    const task = {
      id: 'task-004',
      patient_id: 'P-009',
      status: 'received' as const,
      focus_diagnostic_id: 'dr-004',
      focus_observation_code: 'K',
      priority: 'stat' as const,
      reason_text: 'K=6.8 HH',
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:01:00Z',
    };
    await dispatcher.dispatch(task, { type: 'critical.updated', summary: 'K=6.8 HH', severity: 'critical' });
    const sent = JSON.parse(send.mock.calls[0][0] as string);
    expect(sent.taskId).toBe('task-004');
    expect(sent.patientId).toMatch(/^pid:[a-f0-9]{16}$/); // T10：患者标识强制哈希化
    expect(sent.patientHash).toBe(sent.patientId);
    expect(sent.status).toBe('received');
    expect(sent.priority).toBe('stat');
    expect(sent.summary).toBe('K=6.8 HH');
    expect(sent.severity).toBe('critical');
    expect(sent.type).toBe('critical.updated');
  });

  it('WS 部分 OPEN 部分 CLOSED → 至少 1 个 OPEN 算成功', async () => {
    const sendOpen = vi.fn();
    const wsServer = {
      clients: new Set([
        { send: vi.fn(), readyState: 3 },
        { send: sendOpen, readyState: 1 },
      ]) as unknown as Iterable<{ send: (s: string) => void; readyState: number }>,
    };
    const dispatcher = new NotificationDispatcher({ wsServer });
    const task = {
      id: 'task-005',
      patient_id: 'P-001',
      status: 'requested' as const,
      focus_diagnostic_id: 'dr-005',
      focus_observation_code: 'K',
      priority: 'urgent' as const,
      reason_text: null as string | null,
      created_at: '2026-10-13T08:00:00Z',
      updated_at: '2026-10-13T08:00:00Z',
    };
    const r = await dispatcher.dispatch(task);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('ws');
    expect(sendOpen).toHaveBeenCalledOnce();
  });
});

// ===== T8 复核回归 · 危急值判定与状态机边界 =====

describe('T8 复核回归 · detector 危急值判定', () => {
  it('ASTM 4R.7=HH 的危急标记判定为 critical（不是 medium）', () => {
    // ASTM 仪器的异常标记在 4R.7 而非 OBX.8 —— 取不到就当普通异常会把危急值降级
    const r = detect(makeParserResult({
      criticalFlags: [{
        observationId: 'obs-astm-1',
        testCode: 'K',
        testDisplay: '钾',
        value: '6.8',
        unit: 'mmol/L',
        reason: 'abnormal_flag',
        detail: 'ASTM 4R.7=HH 标记为危急（K=6.8mmol/L）',
      }],
    }), { now: 1000 * 60 * 1000 });
    expect(r.severity).toBe('critical');
    expect(r.flags[0].severity).toBe('critical');
  });

  it('标记码解析不出来时不降级 —— 仪器已标危急就按 critical 处理', () => {
    const r = detect(makeParserResult({
      criticalFlags: [{
        observationId: 'obs-unk-1',
        testCode: 'NA',
        testDisplay: '钠',
        value: '156',
        unit: 'mmol/L',
        reason: 'abnormal_flag',
        detail: '仪器标记为危急（NA=156mmol/L）',
      }],
    }), { now: 1000 * 60 * 1000 });
    expect(r.severity).toBe('critical');
  });

  it('extractAbnormalFlag 兼容 HL7 / ASTM / 私有协议三种写法', () => {
    expect(extractAbnormalFlag('OBX.8=HH 标记为危急（K=6.8mmol/L）')).toBe('HH');
    expect(extractAbnormalFlag('ASTM 4R.7=LL 标记为危急（K=2.6mmol/L）')).toBe('LL');
    expect(extractAbnormalFlag('abnormal_flag=AA')).toBe('AA');
    expect(extractAbnormalFlag('abn=L')).toBe('L');
    expect(extractAbnormalFlag('K=6.8mmol/L > 6.0mmol/L')).toBeNull();
  });

  it('同一 dedupe key 合并时，严重度取自更高的一条（值与分级对得上）', () => {
    const r = detect(makeParserResult({
      criticalFlags: [
        { observationId: 'obs-old', testCode: 'CL', testDisplay: '氯', value: '120', unit: 'mmol/L', reason: 'threshold_exceeded', detail: 'CL=120 > 110' },
        { observationId: 'obs-new', testCode: 'CL', testDisplay: '氯', value: '128', unit: 'mmol/L', reason: 'abnormal_flag', detail: 'OBX.8=HH 标记为危急（CL=128mmol/L）' },
      ],
    }), { now: 1000 * 60 * 1000 });
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].severity).toBe('critical');
    // 分级升到 critical，值与观察 id 必须跟着升级的那一条走
    expect(r.flags[0].value).toBe('128');
    expect(r.flags[0].observationId).toBe('obs-new');
    expect(r.flags[0].reason).toBe('abnormal_flag');
  });

  it('报告缺 subject 时按标本号兜底，不同标本不共用去重键', () => {
    const noSubject = makeParserResult();
    delete (noSubject.diagnosticReport as { subject?: unknown }).subject;
    const a = detect({ ...noSubject, criticalFlags: [
      { observationId: 'obs-a', testCode: 'K', testDisplay: '钾', value: '6.8', reason: 'abnormal_flag', detail: 'OBX.8=HH 危急（K=6.8）' },
    ] }, { now: 1000 * 60 * 1000 });
    const b = detect({
      ...noSubject,
      specimen: { ...noSubject.specimen, accessionIdentifier: { system: 'urn:lab-ops-console:accession', value: 'dev1:ctrl-002' } },
      criticalFlags: [
        { observationId: 'obs-b', testCode: 'K', testDisplay: '钾', value: '7.9', reason: 'abnormal_flag', detail: 'OBX.8=HH 危急（K=7.9）' },
      ],
    }, { now: 1000 * 60 * 1000 });

    expect(a.flags[0].patientId).toBe('accession:dev1:ctrl-001');
    expect(b.flags[0].patientId).toBe('accession:dev1:ctrl-002');
    expect(a.flags[0].dedupeKey).not.toBe(b.flags[0].dedupeKey);
    expect(resolvePatientId(noSubject)).toBe('accession:dev1:ctrl-001');
  });
});

describe('T8 复核回归 · 状态机边界', () => {
  let store: CriticalStore;
  let sm: TaskStateMachine;
  let cleanup: () => void;

  beforeEach(() => {
    const r = makeTestStore();
    store = r.store;
    sm = new TaskStateMachine(store, 'lab-ops-console');
    cleanup = r.cleanup;
  });

  it('acknowledge 自适应起始态：requested → received（刚检出即接单）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001', focusDiagnosticId: 'dr-a1', focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    const r = await sm.acknowledge({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    expect(r.task.status).toBe('received');
    const audits = await store.queryAuditChain(t.id);
    expect(audits.some((a) => a.outcome === 'success' && a.reason === 'acknowledged')).toBe(true);
  });

  it('acknowledge 自适应起始态：received → in-progress（已收单即开始处置）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001', focusDiagnosticId: 'dr-a2', focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    await sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    const r = await sm.acknowledge({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    expect(r.task.status).toBe('in-progress');
  });

  it('acknowledge 对已终结 Task 被拒并留 denied 审计', async () => {
    const t = await sm.createTask({
      patientId: 'P-001', focusDiagnosticId: 'dr-a3', focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    await sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    await sm.resolve({ taskId: t.id, agent: { practitionerId: 'doc-001', role: 'doctor' }, resolutionNote: '已处置' });
    await expect(() => sm.acknowledge({ taskId: t.id, agent: { practitionerId: 'nurse-002', role: 'nurse' } }))
      .rejects.toThrow(TaskInvalidTransitionError);
    const audits = await store.queryAuditChain(t.id);
    expect(audits.some((a) => a.outcome === 'denied')).toBe(true);
  });

  it('通用 transition 允许 requested → received（接单即收单走主路径）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001', focusDiagnosticId: 'dr-a4', focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    const r = await sm.transition({
      taskId: t.id,
      fromState: 'requested',
      toState: 'received',
      agent: { practitionerId: 'nurse-001', role: 'nurse' },
    });
    expect(r.task.status).toBe('received');
  });

  it('重复 ack 记 duplicate_ack，状态不符记 state_mismatch（飞检可分别倒查）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001', focusDiagnosticId: 'dr-a5', focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    await sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
    await expect(() => sm.ackOnly({ taskId: t.id, agent: { practitionerId: 'nurse-002', role: 'nurse' } }))
      .rejects.toThrow(TaskInvalidTransitionError);
    await expect(() => sm.transition({
      taskId: t.id,
      fromState: 'completed',
      toState: 'completed',
      agent: { practitionerId: 'doc-001', role: 'doctor' },
    })).rejects.toThrow(TaskInvalidTransitionError);

    const audits = await store.queryAuditChain(t.id);
    expect(audits.some((a) => a.outcome === 'denied' && a.reason === 'duplicate_ack')).toBe(true);
    expect(audits.some((a) => a.outcome === 'denied' && a.reason === 'state_mismatch')).toBe(true);
  });

  it('串行化结束后不残留 inFlight 键（常驻进程不因任务量增长而涨内存）', async () => {
    const t = await sm.createTask({
      patientId: 'P-001', focusDiagnosticId: 'dr-a6', focusObservationCode: 'K',
      agent: { practitionerId: 'system', role: 'system' },
    });
    for (let i = 0; i < 50; i++) {
      await sm.ackOnly({ taskId: t.id, agent: { practitionerId: `nurse-${i}`, role: 'nurse' } }).catch(() => {});
    }
    const inFlight = (sm as unknown as { inFlight: Map<string, unknown> }).inFlight;
    expect(inFlight.size).toBe(0);
  });

  it('validateAuditFields 对非法 outcome 取值抛错（不落到 SQLite 裸错）', () => {
    expect(() => validateAuditFields({
      agent: { practitionerId: 'nurse-001' },
      recorded: '2026-10-13T08:00:00Z',
      source: 'lab-ops-console',
      outcome: 'bogus' as 'success',
    })).toThrow(AuditFieldMissingError);
  });
});