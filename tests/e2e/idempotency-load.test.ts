/**
 * T22 · 幂等与重复推送压测（真实 HTTP + 真实 FHIR 替身，不打业务 mock）
 *
 * 1. 同一 accessionIdentifier 串行写 100 次 → 服务端资源数恒为 1
 * 2. 50 路并发写同一 accession → 资源数仍为 1，且「成功写入 201」与「已存在 200」可区分
 * 3. 1000 个不同 accession 全量落库 → 资源数 1000，逐条 GET 可命中
 * 4. 输出 1000 条写入耗时与吞吐基线（BASELINE 行，写入 progress.txt）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFhirStubServer, type FHIRStubServer } from '../../fhir-stub/server.js';
import { createFhirWriterWithToken, type FhirWriter } from '../../src/fhir/FhirWriter.js';

let stub: FHIRStubServer;
let base: string;
let writer: FhirWriter;
let baseline = '';

beforeAll(async () => {
  stub = await createFhirStubServer({ port: 0, requireAuth: false });
  base = `http://127.0.0.1:${stub.port}`;
  writer = createFhirWriterWithToken({
    baseUrl: `${base}/fhir/R4`,
    token: 'load-test-token',
    urlAllowlist: [base],
    maxRetries: 0,
    requestTimeoutMs: 10_000,
  });
});

afterAll(async () => {
  if (baseline) process.stdout.write(`${baseline}\n`);
  await stub.close();
});

async function reset(): Promise<void> {
  await fetch(`${base}/fhir/__reset`, { method: 'DELETE' });
}

async function observationCount(): Promise<number> {
  const res = await fetch(`${base}/fhir/__count`);
  const json = await res.json() as { counts: Record<string, number> };
  return json.counts.Observation ?? 0;
}

function observation(id: string, accession: string): Record<string, unknown> {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '2823-3', display: ' Potassium' }] },
    subject: { reference: 'Patient/PAT-HASH-001' },
    effectiveDateTime: '2026-11-08T09:30:00Z',
    valueQuantity: { value: 6.8, unit: 'mmol/L' },
    identifier: [{ system: 'urn:lab-ops-console:accession', value: accession }],
  };
}

describe('T22 · 幂等与容量压测', () => {
  it('同一 accessionIdentifier 串行写 100 次（每次不同资源 id）→ 服务端只保留 1 个资源', async () => {
    await reset();
    const accession = 'DEV001:IDEMPOTENT-001';
    const statuses: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const r = await writer.writeResource({
        resourceType: 'Observation',
        body: observation(`obs-repeat-${i}`, accession),
        idempotencyKey: accession,
      });
      statuses.push(r.status);
    }
    expect(await observationCount()).toBe(1);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(99);
  }, 60_000);

  it('50 路并发写同一 accession → 资源数仍为 1，且 201 / 200 语义可区分', async () => {
    await reset();
    const accession = 'DEV001:CONCURRENT-001';
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => writer.writeResource({
        resourceType: 'Observation',
        body: observation(`obs-concurrent-${i}`, accession),
        idempotencyKey: accession,
      })),
    );
    expect(await observationCount()).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    // 全部响应都指向同一个既有资源 id
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  }, 60_000);

  it('1000 个不同 accession 全量落库 → 资源数 1000 且逐条 GET 可命中；输出吞吐基线', async () => {
    await reset();
    const started = Date.now();
    for (let i = 0; i < 1000; i += 1) {
      const accession = `DEV001:CAP-${String(i).padStart(4, '0')}`;
      await writer.writeResource({
        resourceType: 'Observation',
        body: observation(`obs-cap-${i}`, accession),
        idempotencyKey: accession,
      });
    }
    const elapsedMs = Date.now() - started;
    const throughput = Math.round((1000 / elapsedMs) * 1000 * 10) / 10;
    expect(await observationCount()).toBe(1000);

    // 逐条 GET 命中（真实 HTTP，不用内存计数代替）
    let hits = 0;
    for (let i = 0; i < 1000; i += 1) {
      const res = await fetch(`${base}/fhir/R4/Observation/obs-cap-${i}`);
      if (res.status === 200) hits += 1;
    }
    expect(hits).toBe(1000);
    baseline = `BASELINE T22：1000 条不同 accession Observation 写入耗时 ${elapsedMs}ms，吞吐 ${throughput} 条/秒；逐条 GET 命中 ${hits}/1000；重复推送 100 次（含 50 路并发）资源数恒为 1。`;
    expect(elapsedMs).toBeGreaterThan(0);
  }, 180_000);
});
