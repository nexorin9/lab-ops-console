/**
 * T21 · 批写行级隔离 + 待上传队列顺序回放（≥6 条）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeBatch, type BatchWriteRow, type FhirWriterLike } from '../../src/fhir/batch.js';
import { OutboxQueue, type OutboxRow } from '../../src/fhir/outbox.js';
import { FhirWriter } from '../../src/fhir/FhirWriter.js';
import { FhirServerFailError } from '../../src/shared/errors.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
const loops: OutboxQueue[] = [];

beforeEach(() => { db = createTestSqlite().db; });
afterEach(() => {
  for (const q of loops) q.stopReplayLoop();
  loops.length = 0;
  db.close();
});

function makeRow(i: number): BatchWriteRow {
  return {
    resourceType: 'Observation',
    body: {
      resourceType: 'Observation', id: `obs-${i}`, status: 'final',
      identifier: [{ system: 'urn:lab-ops-console:accession', value: `ACC-${i}` }],
      code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
      subject: { reference: 'Patient/p-001' },
      effectiveDateTime: '2026-11-08T10:00:00Z',
      valueQuantity: { value: 4.5, unit: 'mmol/L' },
    },
    accessionIdentifier: `ACC-${i}`,
  };
}

function writerFailingOn(failingRows: number[]): FhirWriterLike & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    writeResource: async (input) => {
      const id = String(input.body.id ?? '');
      const i = Number(id.replace('obs-', ''));
      if (failingRows.includes(i)) {
        throw new FhirServerFailError(`第 ${i} 行服务端 5xx`, { row: i });
      }
      written.push(id);
      return { id, status: 201 };
    },
  };
}

describe('T21 · writeBatch 行级隔离', () => {
  it('10 行批写中 2 行 5xx → 其余 8 行全部落库，失败不影响同批', async () => {
    const writer = writerFailingOn([3, 7]);
    const outbox = new OutboxQueue(db);
    const r = await writeBatch(writer, Array.from({ length: 10 }, (_, i) => makeRow(i)), { outbox });
    expect(r.total).toBe(10);
    expect(r.succeeded).toBe(8);
    expect(r.failed).toBe(2);
    expect(writer.written).toHaveLength(8);
    expect(writer.written).not.toContain('obs-3');
    expect(writer.written).not.toContain('obs-7');
  });

  it('聚合错误精确含行号 / 错误码 / 资源 id', async () => {
    const r = await writeBatch(writerFailingOn([2, 5]), Array.from({ length: 6 }, (_, i) => makeRow(i)));
    expect(r.error).not.toBeNull();
    expect(r.error?.code).toBe('FHIR_BATCH_PARTIAL_FAIL');
    expect(r.failures.map((f) => f.row)).toEqual([2, 5]);
    expect(r.failures[0]!.errorCode).toBe('FHIR_SERVER_FAIL');
    expect(r.failures[0]!.resourceId).toBe('obs-2');
    expect(r.error?.context).toMatchObject({ total: 6, succeeded: 4, failed: 2 });
    expect(r.error?.message).toContain('2, 5');
  });

  it('throwOnPartial=true 时抛出聚合错误，false 时返回结果对象', async () => {
    const rows = [makeRow(0), makeRow(1)];
    await expect(writeBatch(writerFailingOn([1]), rows, { throwOnPartial: true }))
      .rejects.toMatchObject({ code: 'FHIR_BATCH_PARTIAL_FAIL' });
    const r = await writeBatch(writerFailingOn([1]), rows, { throwOnPartial: false });
    expect(r.failed).toBe(1);
  });

  it('部分失败行全部进 outbox 且可查原始 payload', async () => {
    const outbox = new OutboxQueue(db);
    const r = await writeBatch(writerFailingOn([3, 7]), Array.from({ length: 10 }, (_, i) => makeRow(i)), { outbox });
    expect(r.failures.every((f) => f.outboxSeq !== null)).toBe(true);
    const pending = outbox.pending();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.accession_identifier)).toEqual(['ACC-3', 'ACC-7']);
    expect(pending[0]!.error_code).toBe('FHIR_SERVER_FAIL');
    expect(JSON.parse(pending[0]!.payload).id).toBe('obs-3');
    expect(outbox.stats()).toMatchObject({ total: 2, pending: 2 });
  });
});

describe('T21 · OutboxQueue 顺序回放与幂等', () => {
  it('回放顺序与写入顺序一致（严格按 seq 升序）', async () => {
    const outbox = new OutboxQueue(db);
    const rows = [makeRow(9), makeRow(2), makeRow(5), makeRow(1)];
    for (const row of rows) outbox.enqueue({ accessionIdentifier: row.accessionIdentifier!, resourceType: row.resourceType, body: row.body, errorCode: 'FHIR_SERVER_FAIL' });
    const seen: string[] = [];
    const result = await outbox.replay((r: OutboxRow) => { seen.push(r.accession_identifier); });
    expect(result.scanned).toBe(4);
    expect(result.replayed).toBe(4);
    expect(seen).toEqual(['ACC-9', 'ACC-2', 'ACC-5', 'ACC-1']);
    expect(result.order).toEqual(outbox.list().map((r) => r.seq));
    expect(outbox.pending()).toHaveLength(0);
    expect(outbox.stats().replayed).toBe(4);
  });

  it('服务端已存在的资源重放跳过并标 already_present，不重复创建', async () => {
    const existing = new Set(['ACC-2']);
    const outbox = new OutboxQueue(db, { exists: (acc) => existing.has(acc) });
    for (const i of [1, 2, 3]) {
      outbox.enqueue({ accessionIdentifier: `ACC-${i}`, resourceType: 'Observation', body: { id: `obs-${i}` }, errorCode: 'FHIR_SERVER_FAIL' });
    }
    const seen: string[] = [];
    const result = await outbox.replay((r) => { seen.push(r.accession_identifier); });
    expect(result.alreadyPresent).toBe(1);
    expect(result.replayed).toBe(2);
    expect(seen).toEqual(['ACC-1', 'ACC-3']);
    expect(outbox.list('already_present')).toHaveLength(1);
    expect(outbox.stats().pending).toBe(0);
  });

  it('重放超上限转 manual_required 且记录不丢', async () => {
    const outbox = new OutboxQueue(db, { maxReplays: 1 });
    outbox.enqueue({ accessionIdentifier: 'ACC-ERR', resourceType: 'Observation', body: { id: 'obs-err' }, errorCode: 'FHIR_SERVER_FAIL' });
    const result = await outbox.replay(() => { throw new Error('端点仍不可达'); });
    expect(result.manualRequired).toBe(1);
    const rows = outbox.list('manual_required');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retry_count).toBe(1);
    expect(rows[0]!.accession_identifier).toBe('ACC-ERR');
    expect(outbox.stats().total).toBe(1); // 记录保留，不删除
  });

  it('后台回放器按间隔定时按序重放，stopReplayLoop 后停止', async () => {
    const outbox = new OutboxQueue(db);
    loops.push(outbox);
    outbox.enqueue({ accessionIdentifier: 'ACC-T', resourceType: 'Observation', body: { id: 'obs-t' }, errorCode: 'FHIR_SERVER_FAIL' });
    const seen: string[] = [];
    outbox.startReplayLoop(20, (r) => { seen.push(r.accession_identifier); });
    await new Promise((r) => setTimeout(r, 90));
    outbox.stopReplayLoop();
    expect(seen).toEqual(['ACC-T']);
    expect(outbox.stats().replayed).toBe(1);
  });
});

describe('T21 · FhirWriter 失败路径接线', () => {
  it('写失败时资源自动落 outbox（不丢原始 payload）', async () => {
    const outbox = new OutboxQueue(db);
    const fakeFetch = (async () => ({
      status: 503, ok: false,
      headers: { get: () => null }, text: async () => '{"error":"unavailable"}', json: async () => ({}),
    })) as unknown as typeof fetch;
    const writer = new FhirWriter({
      baseUrl: 'http://127.0.0.1:9999/fhir/R4',
      staticToken: 'test-token',
      urlAllowlist: ['http://127.0.0.1:9999'],
      fetchImpl: fakeFetch,
      maxRetries: 0,
      outboxSink: outbox,
    });
    await expect(writer.writeResource({ resourceType: 'Observation', body: makeRow(42).body })).rejects.toBeTruthy();
    const rows = outbox.pending();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accession_identifier).toBe('ACC-42');
    expect(JSON.parse(rows[0]!.payload).id).toBe('obs-42');
  });
});
