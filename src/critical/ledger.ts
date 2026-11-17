/**
 * 审计链查询 + 飞检倒查 + 闭环台账强校验导出
 *
 * 台账不是「把表导出成 CSV」：导出前逐行强校验 AuditEvent 四字段（agent / recorded /
 * source / outcome）齐备，缺任一字段就拒绝出表并列出缺失的 taskId —— 月底补录台账
 * 这件事必须在系统里被挡住，而不是靠医务科人工核对。
 */

import { ExportFieldMissingError } from '../shared/errors.js';
import { hashPatientId } from './NotificationDispatcher.js';
import type { CriticalAuditRow, CriticalStore, CriticalTaskRow } from './store.js';

export interface AuditChainEvent {
  seq: number;
  step: string;
  taskId: string;
  agent: string;
  recorded: string;
  source: string;
  outcome: string;
  reason: string | null;
  relatedResource: string;
  context: Record<string, unknown> | null;
}

export interface LedgerRow {
  task_id: string;
  /** 哈希患者标识（不落真名） */
  patient_hash: string;
  test_code: string;
  value: string;
  unit: string;
  severity: string;
  detected_at: string;
  received_at: string;
  resolved_at: string;
  resolution_note: string;
  status: string;
  audit_ref: string;
  audit_count: number;
}

export interface LedgerRange {
  from: string;
  to: string;
}

/** denied 原因分类（飞检倒查口径） */
export const DENIED_REASONS = [
  'invalid_transition',
  'duplicate_ack',
  'state_mismatch',
  'missing_audit',
  'unauthorized_role',
] as const;
export type DeniedReason = (typeof DENIED_REASONS)[number];

/** 审计 reason → 链路步骤名 */
const STEP_BY_REASON: Record<string, string> = {
  task_created: '检出',
  acknowledged: '接收',
  treatment_started: '处置中',
  resolved: '处置完成',
  model_fallback: '模型降级',
  candidate_accepted: '采纳候选',
  candidate_ignored: '忽略候选',
  escalated: '升级',
  push: '推送',
  redelivered: '补推',
};

/** 把一条审计行映射成链路事件（拒绝事件也进链） */
export function toChainEvent(row: CriticalAuditRow, seq: number, focus: string): AuditChainEvent {
  const raw = row.reason ?? 'unknown';
  let step = STEP_BY_REASON[raw] ?? '状态变更';
  if (row.outcome === 'denied') step = `拒绝（${raw}）`;
  if (row.outcome === 'partial') step = `降级（${raw}）`;
  let context: Record<string, unknown> | null = null;
  if (row.context) {
    try { context = JSON.parse(row.context) as Record<string, unknown>; } catch { context = null; }
  }
  return {
    seq,
    step,
    taskId: row.task_id,
    agent: row.agent,
    recorded: row.recorded,
    source: row.source,
    outcome: row.outcome,
    reason: row.reason,
    relatedResource: focus,
    context,
  };
}

/** 按时间序还原一条 Task 从检出到关闭的完整轨迹 */
export async function buildAuditChain(store: CriticalStore, taskId: string): Promise<AuditChainEvent[]> {
  const task = await store.getTask(taskId);
  const focus = task?.focus_diagnostic_id ?? '';
  const rows = await store.queryAuditChain(taskId);
  return rows.map((row, i) => toChainEvent(row, i + 1, focus));
}

/** 四字段齐备校验（空串也算缺失） */
export function auditFieldsComplete(row: CriticalAuditRow): boolean {
  return [row.agent, row.recorded, row.source, row.outcome]
    .every((v) => typeof v === 'string' && v.trim().length > 0);
}

function timestampFromChain(chain: AuditChainEvent[], step: string): string {
  return chain.find((e) => e.step === step)?.recorded ?? '';
}

/**
 * 构建台账 —— 导出前逐行强校验；缺字段抛 ExportFieldMissingError 并列出 taskId。
 * 患者标识统一哈希化输出，绝不落真名。
 */
export async function buildLedger(store: CriticalStore, range: LedgerRange): Promise<LedgerRow[]> {
  const tasks = (await store.listAll(10_000)).filter(
    (t) => t.created_at >= range.from && t.created_at <= range.to,
  );
  const rows: LedgerRow[] = [];
  const missing: string[] = [];

  for (const task of tasks) {
    const chain = await buildAuditChain(store, task.id);
    if (chain.length === 0) {
      missing.push(task.id);
      continue;
    }
    const rawAudits = await store.queryAuditChain(task.id);
    if (!rawAudits.every(auditFieldsComplete)) {
      missing.push(task.id);
      continue;
    }
    rows.push(ledgerRowFrom(task, chain));
  }

  if (missing.length > 0) {
    throw new ExportFieldMissingError(
      `台账导出被拒：${missing.length} 条 Task 的 AuditEvent 四字段不齐备`,
      { missingTaskIds: missing, range },
    );
  }
  return rows;
}

/** 从任务 + 链路构造一行台账（纯函数，便于单测直接断言） */
export function ledgerRowFrom(task: CriticalTaskRow, chain: AuditChainEvent[]): LedgerRow {
  const resolveEvent = [...chain].reverse().find((e) => e.step === '处置完成' || e.step === '接收');
  const note = (resolveEvent?.context?.note as string | undefined)
    ?? (resolveEvent?.context?.resolution_note as string | undefined)
    ?? '';
  return {
    task_id: task.id,
    // 台账是导出文件，绝不能把原始患者号带出去；已经是哈希形态的也再过一次哈希，
    // 避免出现「pid:PAT-RAW-001」这种看似脱敏、实则明文的做法。
    patient_hash: hashPatientId(task.patient_id),
    test_code: task.focus_observation_code,
    value: '',
    unit: '',
    severity: task.priority === 'stat' ? 'critical' : 'high',
    detected_at: task.created_at,
    received_at: timestampFromChain(chain, '接收'),
    resolved_at: timestampFromChain(chain, '处置完成'),
    resolution_note: note,
    status: task.status,
    audit_ref: `critical_audit_events:${task.id}`,
    audit_count: chain.length,
  };
}

/** 台账 → CSV（逗号 / 引号 / 换行转义） */
export function ledgerToCsv(rows: LedgerRow[]): string {
  const headers: Array<keyof LedgerRow> = [
    'task_id', 'patient_hash', 'test_code', 'value', 'unit', 'severity',
    'detected_at', 'received_at', 'resolved_at', 'resolution_note', 'status', 'audit_ref', 'audit_count',
  ];
  const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(',')),
  ].join('\n') + '\n';
}

/** 按 5 类原因倒查被拒审计 */
export async function queryDeniedByReason(
  store: CriticalStore,
  range: LedgerRange,
): Promise<Record<DeniedReason, CriticalAuditRow[]>> {
  const result = Object.fromEntries(DENIED_REASONS.map((r) => [r, [] as CriticalAuditRow[]])) as
    Record<DeniedReason, CriticalAuditRow[]>;
  for (const row of await store.queryDeniedAudits(range, 10_000)) {
    const reason = (row.reason ?? 'unknown') as DeniedReason;
    if (DENIED_REASONS.includes(reason)) result[reason].push(row);
  }
  return result;
}
