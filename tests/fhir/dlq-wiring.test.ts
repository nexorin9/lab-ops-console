/**
 * tests/fhir/dlq-wiring.test.ts —— 出站写失败 → 持久化死信队列（任务书 T4 接线）
 *
 * 场景：
 * 1. FHIR 端点持续 5xx → 重试耗尽 → 资源原始字节进 dlq_messages 表（不只留在内存缓冲）
 * 2. 进 DLQ 的条目带错误码与原始字节，可回放
 * 3. 写入成功时不产生死信（不误报）
 * 4. DLQ 落盘异常不掩盖原始错误（错误码仍是对外的那个）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FhirWriter } from '../../src/fhir/FhirWriter.js';
import { buildObservation } from '../../src/fhir/resources/index.js';
import { DLQ } from '../../src/channels/DLQ.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import { FhirServerFailError } from '../../src/shared/errors.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let dlq: DLQ;

beforeEach(() => {
  const t = createTestSqlite();
  db = t.db;
  dlq = new DLQ(db);
});

afterEach(() => {
  db.close();
});

/** 造一个恒定返回指定状态码的 fetch 替身 */
function stubFetch(status: number, body = 'upstream boom'): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => body,
      json: async () => ({}),
    })) as unknown as typeof fetch;
}

function observation(id: string): Record<string, unknown> {
  return buildObservation({
    id,
    status: 'final',
    code: { loinc: '2823-3' },
    subjectReference: 'Patient/p1',
    effectiveDateTime: '2026-10-13T00:00:00Z',
    value: 4.5,
    valueUnit: 'mmol/L',
  }) as unknown as Record<string, unknown>;
}

describe('FhirWriter · 写失败落持久化 DLQ', () => {
  it('5xx 重试耗尽 → 资源原始字节进 dlq_messages 表', async () => {
    const writer = new FhirWriter({
      baseUrl: 'https://lis.example-hospital.internal/fhir/R4',
      urlAllowlist: ['https://lis.example-hospital.internal'],
      staticToken: 'placeholder-token',
      fetchImpl: stubFetch(500),
      maxRetries: 0,
      dlqSink: dlq,
      dlqChannelName: 'fhir-write',
    });

    await expect(
      writer.writeResource({ resourceType: 'Observation', body: observation('obs-dlq-1') }),
    ).rejects.toBeInstanceOf(FhirServerFailError);

    const rows = dlq.list({ channelName: 'fhir-write' });
    expect(rows).toHaveLength(1);
    expect(rows[0].error_code).toBe('FHIR_SERVER_FAIL');
    // 原始字节留底（可回放可核对）：里面能读回这条 Observation
    const body = JSON.parse(rows[0].raw_bytes.toString('utf-8')) as Record<string, unknown>;
    expect(body.resourceType).toBe('Observation');
    expect(body.id).toBe('obs-dlq-1');
    // 新入队的死信是待回放状态
    expect(rows[0].replay_status).toBe('pending');
  });

  it('写入成功 → 不产生死信（不误报）', async () => {
    const writer = new FhirWriter({
      baseUrl: 'https://lis.example-hospital.internal/fhir/R4',
      urlAllowlist: ['https://lis.example-hospital.internal'],
      staticToken: 'placeholder-token',
      fetchImpl: stubFetch(200),
      maxRetries: 0,
      dlqSink: dlq,
    });

    await writer.writeResource({ resourceType: 'Observation', body: observation('obs-ok-1') });
    expect(dlq.list()).toHaveLength(0);
  });

  it('DLQ 落盘抛错 → 不掩盖原始错误（调用方仍拿到 FHIR_SERVER_FAIL）', async () => {
    const brokenSink = {
      enqueue(): unknown {
        throw new Error('sqlite 写盘失败');
      },
    };
    const writer = new FhirWriter({
      baseUrl: 'https://lis.example-hospital.internal/fhir/R4',
      urlAllowlist: ['https://lis.example-hospital.internal'],
      staticToken: 'placeholder-token',
      fetchImpl: stubFetch(500),
      maxRetries: 0,
      dlqSink: brokenSink,
    });

    await expect(
      writer.writeResource({ resourceType: 'Observation', body: observation('obs-dlq-2') }),
    ).rejects.toBeInstanceOf(FhirServerFailError);
  });
});
