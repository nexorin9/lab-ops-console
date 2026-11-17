/**
 * scripts/verify-fhir-t7.ts —— T7 真进程核验（真实 HTTP，不打 mock）
 *
 * 验证 FhirWriter 生产级出站路径在**真实进程 + 真实 HTTP**下成立：
 * 1. OAuth2 client-credentials 换 token（凭据从环境变量读，代码里不硬编码）
 * 2. 幂等：同一 accession 写两次 → 服务端资源数不变，第二次命中既有 id
 * 3. 保留字符幂等键：标本号带 | 与 , → 服务端解转义后仍命中同一资源
 * 4. 5xx 退避耗尽 → 原始字节进 SQLite DLQ，可还原出这条 Observation
 * 5. 4xx 不重试 + 原始字节仍留底
 * 6. batch 部分失败 → 聚合错误带行号 / 错误码 / 资源 id
 *
 * 用法：
 *   npx tsx scripts/verify-fhir-t7.ts
 * 退出码 0 = 全部通过；非 0 = 有断言没过
 */

import { createFhirStubServer } from '../fhir-stub/server.js';
import { FhirWriter } from '../src/fhir/FhirWriter.js';
import {
  buildAccessionIdentifier,
  buildIfNoneExistHeader,
  escapeSearchValue,
  ACCESSION_SYSTEM_URI,
} from '../src/fhir/idempotency.js';
import { createTestSqlite } from '../src/shared/sqlite.js';
import { DLQ } from '../src/channels/DLQ.js';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'OK  ' : 'FAIL'} ${name} — ${detail}\n`);
}

function obsBody(id: string, value = 4.5): Record<string, unknown> {
  return {
    resourceType: 'Observation',
    id,
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
    subject: { reference: 'Patient/p1' },
    effectiveDateTime: '2026-10-13T00:00:00Z',
    valueQuantity: { value, unit: 'mmol/L' },
  };
}

async function fetchToken(base: string): Promise<string> {
  const res = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from('cli:sec').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });
  const json = await res.json() as { access_token: string };
  return json.access_token;
}

/** 起一个恒定返回指定状态码的端点 */
async function startStatusServer(status: number): Promise<{ url: string; close: () => Promise<void>; count: () => number }> {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  let requests = 0;
  app.put('/fhir/R4/:type/:id', (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    requests += 1;
    res.status(status).json({ resourceType: 'OperationOutcome' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        count: () => requests,
        close: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
  });
}

async function main(): Promise<void> {
  // ---------- 真实 FHIR 替身（真实 HTTP + 真实 OAuth2 token 端点）----------
  const stub = await createFhirStubServer({ port: 0 });
  const base = `http://127.0.0.1:${stub.port}`;

  // 凭据从环境变量读（模拟院内网关下发的 client-credentials）
  process.env.T7_OAUTH_TOKEN_URL = `${base}/auth/token`;
  process.env.T7_OAUTH_CLIENT_ID = 'cli';
  process.env.T7_OAUTH_CLIENT_SECRET = 'sec';

  const { createFhirWriterFromEnv } = await import('../src/fhir/FhirWriter.js');
  const writer = createFhirWriterFromEnv({
    prefix: 'T7',
    baseUrl: `${base}/fhir/R4`,
    urlAllowlist: [base],
  });
  check('OAuth2 凭据从 env 读', true, 'createFhirWriterFromEnv(prefix=T7) 构造成功');

  try {
    // ---------- 2. 幂等：同一 accession 二次写 ----------
    const accession = buildAccessionIdentifier({ deviceId: 'DEV001', msh10: 'MSG00001' });
    const first = await writer.write('Observation', obsBody('obs-A', 4.5), { idempotencyKey: accession });
    const second = await writer.write('Observation', obsBody('obs-B', 4.6), { idempotencyKey: accession });
    check(
      '幂等：同一 accession 二次写命中既有资源',
      first.status === 201 && second.status === 200 && second.id === 'obs-A',
      `first=${first.status}/${first.id} second=${second.status}/${second.id}`,
    );

    const token = await fetchToken(base);
    const countObs = async (q: string): Promise<number> => {
      const res = await fetch(`${base}/fhir/R4/Observation?identifier=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const bundle = await res.json() as { total: number };
      return bundle.total;
    };
    const totalByAccession = await countObs(`${ACCESSION_SYSTEM_URI}|${escapeSearchValue(accession)}`);
    check('幂等：服务端资源数不变', totalByAccession === 1, `?identifier= 检索 total=${totalByAccession}`);

    // ---------- 3. 保留字符幂等键 ----------
    const tricky = 'DEV001|SPEC,X';
    const tFirst = await writer.write('Observation', obsBody('obs-pipe-A'), { idempotencyKey: tricky });
    const tSecond = await writer.write('Observation', obsBody('obs-pipe-B'), { idempotencyKey: tricky });
    const trickyTotal = await countObs(`${ACCESSION_SYSTEM_URI}|${escapeSearchValue(tricky)}`);
    check(
      '保留字符幂等键：| 与 , 不被服务端误解析',
      tFirst.status === 201 && tSecond.status === 200 && tSecond.id === 'obs-pipe-A' && trickyTotal === 1,
      `first=${tFirst.status} second=${tSecond.status}/${tSecond.id} total=${trickyTotal}`,
    );
    check(
      'If-None-Exist 头按 FHIR 格式转义',
      buildIfNoneExistHeader(tricky) === `identifier=${ACCESSION_SYSTEM_URI}|DEV001\\|SPEC\\,X`,
      buildIfNoneExistHeader(tricky),
    );

    // ---------- 4. 5xx → 退避耗尽 → DLQ（真实 SQLite）----------
    const srv5xx = await startStatusServer(503);
    const sqlite = createTestSqlite();
    const dlq = new DLQ(sqlite.db);
    const writer5xx = new FhirWriter({
      baseUrl: `${srv5xx.url}/fhir/R4`,
      urlAllowlist: [srv5xx.url],
      staticToken: 'placeholder-token',
      maxRetries: 1,
      dlqSink: dlq,
      dlqChannelName: 'fhir-write',
    });
    let fivexxErr = '';
    try {
      await writer5xx.writeResource({ resourceType: 'Observation', body: obsBody('obs-5xx') });
    } catch (err) {
      fivexxErr = (err as Error).message;
    }
    const dlqRows = dlq.list({ channelName: 'fhir-write' });
    const restored = dlqRows.length > 0
      ? JSON.parse(dlqRows[0]!.raw_bytes.toString('utf-8')) as Record<string, unknown>
      : {};
    check(
      '5xx 退避耗尽 → 原始字节进 DLQ 且可还原',
      fivexxErr.includes('5xx') && dlqRows.length === 1 && restored.id === 'obs-5xx',
      `err="${fivexxErr.slice(0, 40)}..." dlqRows=${dlqRows.length} restoredId=${restored.id}`,
    );
    await srv5xx.close();
    sqlite.close();

    // ---------- 5. 4xx 不重试 + 仍留底 ----------
    const srv4xx = await startStatusServer(400);
    const sqlite4 = createTestSqlite();
    const dlq4 = new DLQ(sqlite4.db);
    const writer4xx = new FhirWriter({
      baseUrl: `${srv4xx.url}/fhir/R4`,
      urlAllowlist: [srv4xx.url],
      staticToken: 'placeholder-token',
      maxRetries: 3,
      dlqSink: dlq4,
      dlqChannelName: 'fhir-write',
    });
    let fourxxErr = '';
    try {
      await writer4xx.writeResource({ resourceType: 'Observation', body: obsBody('obs-4xx') });
    } catch (err) {
      fourxxErr = (err as Error).message;
    }
    const dlq4Rows = dlq4.list({ channelName: 'fhir-write' });
    check(
      '4xx 不重试（只打一次）且原始字节仍留底',
      srv4xx.count() === 1 && fourxxErr.includes('400') && dlq4Rows.length === 1,
      `requests=${srv4xx.count()} err="${fourxxErr.slice(0, 30)}..." dlqRows=${dlq4Rows.length}`,
    );
    await srv4xx.close();
    sqlite4.close();

    // ---------- 6. batch 部分失败 → 聚合错误带行号 ----------
    const srvBatch = await startStatusServer(500);
    const writerBatch = new FhirWriter({
      baseUrl: `${srvBatch.url}/fhir/R4`,
      urlAllowlist: [srvBatch.url],
      staticToken: 'placeholder-token',
      maxRetries: 0,
    });
    let batchCtx: Record<string, unknown> = {};
    try {
      await writerBatch.writeBatch([
        { resourceType: 'Observation', body: obsBody('obs-b0') },
        { resourceType: 'Observation', body: obsBody('obs-b1') },
      ]);
    } catch (err) {
      batchCtx = (err as { context?: Record<string, unknown> }).context ?? {};
    }
    const failedIndexes = (batchCtx.failedIndexes as number[] | undefined) ?? [];
    const failures = (batchCtx.failures as Array<{ index: number; id: string; errorCode: string }> | undefined) ?? [];
    check(
      'batch 失败聚合错误带行号 / 错误码 / 资源 id',
      failedIndexes.length === 2 && failures[0]?.id === 'obs-b0' && failures[0]?.errorCode === 'FHIR_SERVER_FAIL',
      `failedIndexes=${JSON.stringify(failedIndexes)} first=${JSON.stringify(failures[0])}`,
    );
    await srvBatch.close();
  } finally {
    await stub.close();
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\nTOTAL=${results.length} PASSED=${results.length - failed.length} FAILED=${failed.length}\n`);
  process.stdout.write(failed.length === 0 ? 'RESULT=PASS\n' : 'RESULT=FAIL\n');
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err: Error) => {
  process.stderr.write(`verify-fhir-t7 failed: ${err.message}\n`);
  process.exit(1);
});
