/**
 * scripts/verify-main-path.ts —— 主干手工验收脚本（字节 → 解析 → FHIR 写入 → GET 命中）
 *
 * 这是「仪器报文进来到院内 FHIR 端点可查」的一次性可核对演练：
 *   1) 起 HL7 接入端口（模拟工控机上的仪器端口）
 *   2) 用真实 TCP socket 推一帧脱敏 ORU^R01（钾 / 钠 / 氯三项）
 *   3) 解析 → 写 Device / Specimen / Observation / DiagnosticReport
 *   4) 回读校验（写进去必须读得出来）
 *   5) 打印一条可直接复制的 curl 命令，人工核对 FHIR 端点里的报告
 *
 * 用法（两个终端）：
 *   # 终端 1：起院内 FHIR 端点替身（真实 OAuth2 token 端点 + FHIR R4 REST）
 *   FHIR_STUB_PORT=9999 npx tsx fhir-stub/server.ts
 *   # 终端 2：跑主干演练
 *   npx tsx scripts/verify-main-path.ts
 *
 * 退出码：0 = 全链路通；1 = 失败（并打印失败原因）
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hl7Server } from '../src/channels/Hl7Server.js';
import { parseOruR01 } from '../src/parser/oru-r01.js';
import { publishParserResult } from '../src/fhir/result-publisher.js';
import { FhirWriter } from '../src/fhir/FhirWriter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../tests/fixtures/oru-r01-k-nacl.txt');

const FHIR_BASE_URL = process.env.FHIR_BASE_URL ?? 'http://127.0.0.1:9999/fhir/R4';
const FHIR_TOKEN_URL = process.env.FHIR_TOKEN_URL ?? 'http://127.0.0.1:9999/auth/token';
const FHIR_CLIENT_ID = process.env.FHIR_CLIENT_ID ?? 'cli';
const FHIR_CLIENT_SECRET = process.env.FHIR_CLIENT_SECRET ?? 'sec';
const DEVICE_LISTEN_PORT = Number(process.env.DEVICE_LISTEN_PORT ?? 2575);
const DEVICE_ENCODING = process.env.DEVICE_ENCODING ?? 'utf-8';

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function fetchToken(): Promise<string> {
  const res = await fetch(FHIR_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${FHIR_CLIENT_ID}:${FHIR_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });
  if (!res.ok) throw new Error(`token 端点失败：${res.status}`);
  const json = await res.json() as { access_token: string };
  return json.access_token;
}

async function main(): Promise<void> {
  const allowlistOrigin = new URL(FHIR_BASE_URL).origin;
  const writer = new FhirWriter({
    baseUrl: FHIR_BASE_URL,
    urlAllowlist: [allowlistOrigin],
    oidc: { tokenEndpoint: FHIR_TOKEN_URL, clientId: FHIR_CLIENT_ID, clientSecret: FHIR_CLIENT_SECRET },
  });

  // ---- 起仪器接入端口 ----
  const hl7 = new Hl7Server('verify-hl7', { encoding: DEVICE_ENCODING });
  const port = await hl7.start(DEVICE_LISTEN_PORT);
  log(`[1/5] HL7 接入端口已监听 127.0.0.1:${port}（编码 ${DEVICE_ENCODING}）`);

  let publishPromise: Promise<Awaited<ReturnType<typeof publishParserResult>>> | null = null;
  hl7.on('message', (payload: { message: import('../src/channels/Hl7Connection.js').Hl7Message }) => {
    publishPromise = (async () => {
      const parsed = await parseOruR01(payload.message, { deviceId: 'DEV001', deviceManufacturer: 'LIS' });
      return publishParserResult(writer, parsed, { deviceId: 'DEV001' });
    })();
  });
  const errors: string[] = [];
  hl7.on('error', (err: Error) => errors.push(err.message));

  // ---- 推一帧真实报文 ----
  const frame = fs.readFileSync(FIXTURE);
  const socket = net.createConnection({ port, host: '127.0.0.1' });
  const acks: string[] = [];
  socket.on('data', (buf: Buffer) => acks.push(buf.toString('utf-8')));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.write(Buffer.concat([Buffer.from([0x0b]), frame, Buffer.from([0x1c, 0x0d])]));
  log(`[2/5] 已推入 1 帧 ORU^R01（${frame.length} 字节，含钾/钠/氯三项）`);

  // ---- 等写入完成 ----
  const deadline = Date.now() + 15_000;
  while (!publishPromise && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!publishPromise) {
    throw new Error(`未收到报文（通道错误：${errors.join('; ') || '无'}）`);
  }
  const published = await publishPromise;
  log(`[3/5] 解析完成：${published.observationIds.length} 条 Observation + 1 份 DiagnosticReport`);
  log(`      accessionIdentifier = ${published.accessionIdentifier}`);
  log(`      report id          = ${published.diagnosticReportId}`);
  log(`      回读校验           = ${published.verified ? '通过（写进去且读得出来）' : '未通过'}`);

  // ---- 取 token 并给出可复制的 curl ----
  const token = await fetchToken();
  log('[4/5] 已向院内网关换取 bearer token（OAuth2 client-credentials）');
  log('[5/5] 复制下面这条命令，人工核对 FHIR 端点里的报告：');
  log('');
  log(`curl -sS -H "Authorization: Bearer ${token}" \\`);
  log(`  "${FHIR_BASE_URL}/DiagnosticReport/${published.diagnosticReportId}"`);
  log('');

  // ---- 就地回读一次，证明报告里有 Observation 引用 ----
  const reportRes = await fetch(`${FHIR_BASE_URL}/DiagnosticReport/${published.diagnosticReportId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const report = await reportRes.json() as {
    result?: Array<{ reference: string }>;
    contained?: unknown[];
  };
  const refs = (report.result ?? []).map((r) => r.reference);
  log(`回读报告 HTTP ${reportRes.status}；Observation 引用 ${refs.length} 条：${refs.join(', ')}`);
  log(`仪器 ACK：${acks.join('').includes('MSA|AA') ? 'MSA|AA（已接受）' : acks.join('').slice(0, 80)}`);

  socket.destroy();
  await hl7.stop({ forceDrainTimeoutMs: 200 });

  if (reportRes.status !== 200 || refs.length === 0 || !published.verified) {
    throw new Error('回读校验未通过：FHIR 端点里没拿到带 Observation 引用的报告');
  }
  log('');
  log('主干演练通过：字节 → 解析 → FHIR 写入 → GET 命中');
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    process.stderr.write(`主干演练失败：${err.message}\n`);
    process.exit(1);
  });
