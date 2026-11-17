/**
 * T8 主干核验脚本 —— 危急值判定 + Task 状态机（真实进程、真实 SQLite）
 *
 * 覆盖现场五条路径：
 * ① HL7 仪器危急标记（OBX.8=HH）→ severity=critical
 * ② ASTM 仪器危急标记（4R.7=HH）→ severity=critical（不是 medium）
 * ③ 同一检验项 5 分钟窗口内合并 → 严重度取更高的一条，值与分级一致
 * ④ 报告缺 subject → 按标本号兜底，不同标本不共用去重键
 * ⑤ 状态机：建单 → 接单 → 处置完成，四类非法转换全部拒绝并留 denied 审计
 *
 * 用法：npx tsx scripts/verify-critical-t8.ts
 */

import Database from 'better-sqlite3';
import {
  detect,
  TaskStateMachine,
  CriticalStore,
  type CriticalDetection,
} from '../src/critical/index.js';
import type { ParserResult } from '../src/parser/fhir-types.js';

const lines: string[] = [];
const log = (msg: string): void => {
  lines.push(msg);
  console.log(msg);
};

const failures: string[] = [];
function check(name: string, ok: boolean, actual: unknown, expected: unknown): void {
  if (!ok) failures.push(`${name}: 实际 ${String(actual)}，期望 ${String(expected)}`);
  log(`${ok ? 'PASS' : 'FAIL'} ${name} → ${String(actual)}`);
}

function makeResult(patient: string | null, flags: ParserResult['criticalFlags'], accession = 'dev1:ctrl-001'): ParserResult {
  const result: ParserResult = {
    observations: [],
    diagnosticReport: {
      resourceType: 'DiagnosticReport',
      id: 'dr-verify-001',
      status: 'final',
      code: { coding: [{ code: 'K', display: '钾' }], text: '钾' },
      subject: patient ? { reference: `Patient/${patient}`, type: 'Patient' } : undefined,
      effectiveDateTime: '2026-10-13T08:00:00Z',
      issued: '2026-10-13T08:00:00Z',
      result: [],
    },
    specimen: {
      resourceType: 'Specimen',
      id: 'spec-verify-001',
      identifier: [{ system: 'urn:lab-ops-console:accession', value: accession }],
      accessionIdentifier: { system: 'urn:lab-ops-console:accession', value: accession },
      receivedTime: '2026-10-13T08:00:00Z',
    },
    specimens: [],
    device: { resourceType: 'Device', id: 'dev1' },
    fieldAttribution: [],
    criticalFlags: flags,
  };
  return result;
}

const NOW = 1000 * 60 * 1000;

// ---------- ① HL7 OBX.8=HH ----------
const hl7 = detect(makeResult('P-1001', [{
  observationId: 'obs-hl7-1', testCode: 'K', testDisplay: '钾', value: '6.8', unit: 'mmol/L',
  reason: 'abnormal_flag', detail: 'OBX.8=HH 标记为危急（K=6.8mmol/L）',
}]), { now: NOW });
log(`HL7_SEVERITY=${hl7.severity}`);
check('HL7 OBX.8=HH 判为危急', hl7.severity === 'critical', hl7.severity, 'critical');

// ---------- ② ASTM 4R.7=HH ----------
const astm = detect(makeResult('P-1002', [{
  observationId: 'obs-astm-1', testCode: 'K', testDisplay: '钾', value: '6.8', unit: 'mmol/L',
  reason: 'abnormal_flag', detail: 'ASTM 4R.7=HH 标记为危急（K=6.8mmol/L）',
}]), { now: NOW });
log(`ASTM_SEVERITY=${astm.severity}`);
check('ASTM 4R.7=HH 判为危急', astm.severity === 'critical', astm.severity, 'critical');

// ---------- ③ 合并时值跟随严重度 ----------
const merged = detect(makeResult('P-1003', [
  { observationId: 'obs-old', testCode: 'CL', testDisplay: '氯', value: '120', unit: 'mmol/L', reason: 'threshold_exceeded', detail: 'CL=120 > 110' },
  { observationId: 'obs-new', testCode: 'CL', testDisplay: '氯', value: '128', unit: 'mmol/L', reason: 'abnormal_flag', detail: 'OBX.8=HH 标记为危急（CL=128mmol/L）' },
]), { now: NOW });
log(`MERGED_COUNT=${merged.flags.length} MERGED_SEVERITY=${merged.flags[0].severity} MERGED_VALUE=${merged.flags[0].value}`);
check('同一检验项合并为一条', merged.flags.length === 1, merged.flags.length, 1);
check('合并后严重度取更高的一侧', merged.flags[0].severity === 'critical', merged.flags[0].severity, 'critical');
check('合并后数值与分级一致', merged.flags[0].value === '128', merged.flags[0].value, '128');

// ---------- ④ 缺 subject 按标本号兜底 ----------
const noSubjectA = detect(makeResult(null, [{
  observationId: 'obs-a', testCode: 'K', testDisplay: '钾', value: '6.8',
  reason: 'abnormal_flag', detail: 'OBX.8=HH 危急（K=6.8）',
}], 'dev1:ctrl-A'), { now: NOW });
const noSubjectB = detect(makeResult(null, [{
  observationId: 'obs-b', testCode: 'K', testDisplay: '钾', value: '7.9',
  reason: 'abnormal_flag', detail: 'OBX.8=HH 危急（K=7.9）',
}], 'dev1:ctrl-B'), { now: NOW });
log(`NOSUBJECT_A=${noSubjectA.flags[0].patientId} NOSUBJECT_B=${noSubjectB.flags[0].patientId}`);
check('缺 subject 时按标本号兜底', noSubjectA.flags[0].patientId === 'accession:dev1:ctrl-A', noSubjectA.flags[0].patientId, 'accession:dev1:ctrl-A');
check('不同标本不共用去重键', noSubjectA.flags[0].dedupeKey !== noSubjectB.flags[0].dedupeKey, 'different', 'different');

// ---------- ⑤ 状态机主路径 + 四类非法转换 ----------
const db = new Database(':memory:');
const store = CriticalStore.withDb(db);
const sm = new TaskStateMachine(store, 'lab-ops-console');

const task = await sm.createTask({
  patientId: 'P-1004',
  focusDiagnosticId: 'dr-verify-002',
  focusObservationCode: 'K',
  agent: { practitionerId: 'system', role: 'system' },
  now: '2026-10-13T08:00:00Z',
});
log(`TASK_CREATED=${task.id} STATUS=${task.status}`);

// 主路径：接单（自适应起始态 requested → received）→ 处置完成
const acked = await sm.acknowledge({ taskId: task.id, agent: { practitionerId: 'nurse-001', role: 'nurse' }, now: '2026-10-13T08:01:00Z' });
check('接单后状态为 received', acked.task.status === 'received', acked.task.status, 'received');
const resolved = await sm.resolve({ taskId: task.id, agent: { practitionerId: 'doc-001', role: 'doctor' }, resolutionNote: '已通知病房复测', now: '2026-10-13T08:10:00Z' });
check('处置后状态为 completed', resolved.task.status === 'completed', resolved.task.status, 'completed');

// 非法转换 ①：跳步 completed
const t2 = await sm.createTask({
  patientId: 'P-1005', focusDiagnosticId: 'dr-verify-003', focusObservationCode: 'NA',
  agent: { practitionerId: 'system', role: 'system' },
});
let denied = '';
try {
  await sm.transition({ taskId: t2.id, fromState: 'requested', toState: 'completed', agent: { practitionerId: 'doc-001', role: 'doctor' } });
} catch (e) {
  denied = (e as Error).message;
}
check('跳步 completed 被拒', denied.length > 0, denied || '未拒绝', '抛错');

// 非法转换 ②：重复 ack
await sm.ackOnly({ taskId: t2.id, agent: { practitionerId: 'nurse-001', role: 'nurse' } });
denied = '';
try {
  await sm.ackOnly({ taskId: t2.id, agent: { practitionerId: 'nurse-002', role: 'nurse' } });
} catch (e) {
  denied = (e as Error).message;
}
check('重复 ack 被拒', denied.length > 0, denied || '未拒绝', '抛错');

// 非法转换 ③：状态不符
denied = '';
try {
  await sm.transition({ taskId: t2.id, fromState: 'completed', toState: 'completed', agent: { practitionerId: 'doc-001', role: 'doctor' } });
} catch (e) {
  denied = (e as Error).message;
}
check('状态不符被拒', denied.length > 0, denied || '未拒绝', '抛错');

// 非法转换 ④：AuditEvent 字段缺失
denied = '';
try {
  await sm.transition({ taskId: t2.id, fromState: 'received', toState: 'in-progress', agent: { practitionerId: '', role: 'nurse' } });
} catch (e) {
  denied = (e as Error).message;
}
check('缺审计字段被拒', denied.length > 0, denied || '未拒绝', '抛错');

// denied 审计可倒查
const deniedAudits = await store.queryDeniedAudits({ from: '2026-01-01T00:00:00Z', to: '2026-12-31T23:59:59Z' });
const reasons = [...new Set(deniedAudits.map((a) => a.reason))].sort();
log(`DENIED_COUNT=${deniedAudits.length} DENIED_REASONS=${reasons.join(',')}`);
check('denied 审计留痕可供飞检倒查', deniedAudits.length >= 3, deniedAudits.length, '>=3');

// 审计链可按时间还原
const chain = await store.queryAuditChain(task.id);
log(`AUDIT_CHAIN=${chain.map((a) => `${a.outcome}:${a.reason ?? ''}`).join(' → ')}`);
check('主链路审计齐全', chain.length === 3, chain.length, 3);

// 并发互斥：同一 Task 并发 ack 只成功一次
const t3 = await sm.createTask({
  patientId: 'P-1006', focusDiagnosticId: 'dr-verify-004', focusObservationCode: 'GLU',
  agent: { practitionerId: 'system', role: 'system' },
});
const settled = await Promise.allSettled(
  Array.from({ length: 10 }, (_, i) => sm.ackOnly({ taskId: t3.id, agent: { practitionerId: `nurse-${i}`, role: 'nurse' } })),
);
const ok = settled.filter((r) => r.status === 'fulfilled').length;
const ko = settled.filter((r) => r.status === 'rejected').length;
log(`CONCURRENT_ACK_OK=${ok} CONCURRENT_ACK_REJECTED=${ko}`);
check('并发 ack 只成功一次', ok === 1 && ko === 9, `${ok}/${ko}`, '1/9');

// 常驻进程不残留互斥键
const inFlight = (sm as unknown as { inFlight: Map<string, unknown> }).inFlight;
log(`INFLIGHT_RESIDUAL=${inFlight.size}`);
check('互斥键已清理（无内存泄漏）', inFlight.size === 0, inFlight.size, 0);

db.close();

log(`FAILURES=${failures.length}`);
if (failures.length > 0) {
  for (const f of failures) log(`FAILURE ${f}`);
  log('RESULT=FAIL');
  process.exit(1);
}
log('RESULT=PASS');
