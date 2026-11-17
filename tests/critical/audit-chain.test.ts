/**
 * T26 · 审计链查询与飞检倒查 + 台账强校验导出（≥8 条）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CriticalStore } from '../../src/critical/store.js';
import {
  buildAuditChain,
  buildLedger,
  ledgerToCsv,
  ledgerRowFrom,
  toChainEvent,
  auditFieldsComplete,
  queryDeniedByReason,
  DENIED_REASONS,
} from '../../src/critical/ledger.js';
import { ExportFieldMissingError } from '../../src/shared/errors.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let store: CriticalStore;

const RANGE = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T23:59:59.000Z' };

function task(id: string, createdAt = '2026-11-08T10:00:00.000Z', status = 'completed'): void {
  db.prepare(`INSERT INTO critical_tasks
      (id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, reason_text, created_at, updated_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, 'PAT-RAW-001', status, `DR-${id}`, 'K', 'urgent', null,
    createdAt, createdAt, createdAt,
  );
}

function audit(
  taskId: string,
  opts: {
    agent?: string; recorded?: string; source?: string; outcome?: string;
    reason?: string; context?: string;
  } = {},
): void {
  db.prepare(`INSERT INTO critical_audit_events
      (task_id, agent, agent_display, recorded, source, outcome, reason, context)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    taskId,
    opts.agent ?? 'PR-001',
    null,
    opts.recorded ?? '2026-11-08T10:01:00.000Z',
    opts.source ?? 'critical.state-machine',
    opts.outcome ?? 'success',
    opts.reason ?? 'task_created',
    opts.context ?? null,
  );
}

beforeEach(() => {
  db = createTestSqlite().db;
  store = new CriticalStore(db);
});
afterEach(() => db.close());

describe('T26 · 审计链按时间序还原', () => {
  it('按时间序还原检出 → 接收 → 处置完成，且拒绝事件也进链', async () => {
    task('t1');
    audit('t1', { recorded: '2026-11-08T10:00:00.000Z', reason: 'task_created' });
    audit('t1', { recorded: '2026-11-08T10:02:00.000Z', reason: 'acknowledged' });
    audit('t1', { recorded: '2026-11-08T10:03:00.000Z', reason: 'duplicate_ack', outcome: 'denied' });
    audit('t1', { recorded: '2026-11-08T10:05:00.000Z', reason: 'resolved', context: JSON.stringify({ note: '已安排透析' }) });
    const chain = await buildAuditChain(store, 't1');
    expect(chain.map((e) => e.step)).toEqual(['检出', '接收', '拒绝（duplicate_ack）', '处置完成']);
    expect(chain.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(chain[3]!.context?.note).toBe('已安排透析');
    expect(chain.every((e) => e.agent && e.recorded && e.source && e.outcome)).toBe(true);
  });

  it('四字段校验把空串 / 空白视为缺失', () => {
    expect(auditFieldsComplete({ agent: 'a', recorded: 'r', source: 's', outcome: 'success' } as never)).toBe(true);
    expect(auditFieldsComplete({ agent: '', recorded: 'r', source: 's', outcome: 'success' } as never)).toBe(false);
    expect(auditFieldsComplete({ agent: 'a', recorded: '  ', source: 's', outcome: 'success' } as never)).toBe(false);
    expect(auditFieldsComplete({ agent: 'a', recorded: 'r', source: '', outcome: 'success' } as never)).toBe(false);
  });

  it('台账行患者标识哈希化，四字段与链路步骤时间对齐', async () => {
    task('t2');
    audit('t2', { recorded: '2026-11-08T10:00:00.000Z', reason: 'task_created' });
    audit('t2', { recorded: '2026-11-08T10:02:00.000Z', reason: 'acknowledged' });
    const chain = await buildAuditChain(store, 't2');
    const row = ledgerRowFrom((await store.getTask('t2'))!, chain);
    expect(row.patient_hash).toMatch(/^pid:[a-f0-9]{16}$/);
    expect(row.patient_hash).not.toContain('PAT-RAW-001');
    expect(row.received_at).toBe('2026-11-08T10:02:00.000Z');
    expect(row.audit_count).toBe(2);
    expect(row.test_code).toBe('K');
  });

  it('toChainEvent 把 unknown reason 与 partial / denied 分档显示', () => {
    const base = { id: 1, task_id: 'x', agent: 'a', agent_display: null, recorded: 'r', source: 's', outcome: 'partial', reason: 'weird', context: '{bad json' };
    expect(toChainEvent(base as never, 7, 'DR-x').step).toBe('降级（weird）');
    expect(toChainEvent({ ...base, outcome: 'denied' } as never, 1, 'DR-x').context).toBeNull();
  });
});

describe('T26 · 台账导出强校验', () => {
  it('缺 agent 的审计行 → 导出被拒且错误列出缺失 taskId', async () => {
    task('t3');
    audit('t3', { agent: '' });
    await expect(buildLedger(store, RANGE)).rejects.toBeInstanceOf(ExportFieldMissingError);
    try { await buildLedger(store, RANGE); } catch (err) {
      const e = err as ExportFieldMissingError;
      expect(e.code).toBe('EXPORT_FIELD_MISSING');
      expect(e.context.missingTaskIds).toContain('t3');
    }
  });

  it('agent / recorded / source 任一为空都拒绝出表；outcome 空值由四字段校验覆盖', async () => {
    // outcome 在表上有 CHECK 值域约束，写不进空串；由 auditFieldsComplete 纯函数覆盖该分支
    expect(auditFieldsComplete({ agent: 'a', recorded: 'r', source: 's', outcome: '' } as never)).toBe(false);
    for (const field of ['agent', 'recorded', 'source'] as const) {
      const id = `missing-${field}`;
      task(id);
      audit(id, { [field]: '' });
    }
    try { await buildLedger(store, RANGE); throw new Error('不应导出成功'); }
    catch (err) {
      expect(err).toBeInstanceOf(ExportFieldMissingError);
      const ids = (err as ExportFieldMissingError).context.missingTaskIds as string[];
      expect(ids).toContain('missing-agent');
      expect(ids).toContain('missing-recorded');
      expect(ids).toContain('missing-source');
    }
  });

  it('完全没有审计链的 Task 也被拒绝且列入 missingTaskIds', async () => {
    task('t4');
    try { await buildLedger(store, RANGE); throw new Error('不应导出成功'); }
    catch (err) {
      expect((err as ExportFieldMissingError).context.missingTaskIds).toContain('t4');
    }
  });

  it('四字段齐全时导出行数与区间内任务数一致，且 CSV 含表头与转义', async () => {
    task('a1', '2026-11-08T10:00:00.000Z');
    task('a2', '2026-11-09T10:00:00.000Z');
    audit('a1', { reason: 'task_created' });
    audit('a2', { reason: 'task_created' });
    task('outside', '2026-12-01T10:00:00.000Z'); // 区间外，无审计也不该影响导出
    const rows = await buildLedger(store, RANGE);
    expect(rows).toHaveLength(2);
    const csv = ledgerToCsv(rows);
    expect(csv.split('\n')[0]).toContain('task_id');
    expect(csv).toContain('"a1"');
    expect(csv).toMatch(/pid:[a-f0-9]{16}/);
    expect(csv).not.toContain('PAT-RAW-001');
    const withQuote = ledgerToCsv([{ ...rows[0]!, resolution_note: '护士说"已处置"\n换行' }]);
    expect(withQuote).toContain('""已处置""');
  });

  it('区间过滤只取范围内 Task（含边界）', async () => {
    task('edge-in', '2026-11-01T00:00:00.000Z');
    task('too-early', '2026-10-31T23:59:59.000Z');
    task('too-late', '2026-12-01T00:00:00.000Z');
    audit('edge-in'); audit('too-early'); audit('too-late');
    const rows = await buildLedger(store, RANGE);
    expect(rows.map((r) => r.task_id)).toEqual(['edge-in']);
  });
});

describe('T26 · denied 五类原因飞检倒查', () => {
  it('denied 事件按 5 类原因分别倒查，计数与注入一致', async () => {
    expect(DENIED_REASONS).toHaveLength(5);
    task('d1');
    audit('d1', { outcome: 'denied', reason: 'invalid_transition', recorded: '2026-11-08T10:01:00.000Z' });
    audit('d1', { outcome: 'denied', reason: 'duplicate_ack', recorded: '2026-11-08T10:02:00.000Z' });
    audit('d1', { outcome: 'denied', reason: 'duplicate_ack', recorded: '2026-11-08T10:03:00.000Z' });
    audit('d1', { outcome: 'denied', reason: 'state_mismatch', recorded: '2026-11-08T10:04:00.000Z' });
    audit('d1', { outcome: 'denied', reason: 'missing_audit', recorded: '2026-11-08T10:05:00.000Z' });
    audit('d1', { outcome: 'denied', reason: 'unauthorized_role', recorded: '2026-11-08T10:06:00.000Z' });
    audit('d1', { outcome: 'denied', reason: 'unknown_reason', recorded: '2026-11-08T10:07:00.000Z' });
    audit('d1', { outcome: 'success', reason: 'resolved', recorded: '2026-11-08T10:08:00.000Z' });

    const byReason = await queryDeniedByReason(store, RANGE);
    expect(byReason.invalid_transition).toHaveLength(1);
    expect(byReason.duplicate_ack).toHaveLength(2);
    expect(byReason.state_mismatch).toHaveLength(1);
    expect(byReason.missing_audit).toHaveLength(1);
    expect(byReason.unauthorized_role).toHaveLength(1);
    expect(byReason.duplicate_ack.every((r) => r.outcome === 'denied')).toBe(true);
  });

  it('倒查按时间区间过滤，区间外的 denied 不进入结果', async () => {
    task('d2');
    audit('d2', { outcome: 'denied', reason: 'duplicate_ack', recorded: '2026-10-01T10:00:00.000Z' });
    audit('d2', { outcome: 'denied', reason: 'duplicate_ack', recorded: '2026-11-08T10:00:00.000Z' });
    const byReason = await queryDeniedByReason(store, RANGE);
    expect(byReason.duplicate_ack).toHaveLength(1);
  });
});
