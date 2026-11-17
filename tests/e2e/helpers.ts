/**
 * e2e 测试夹具 —— 起真实 fhir-stub + 真实 TCP 通道 + 真实 HTTP/WS 网关。
 * 不打业务 mock：唯一的替身是院内 FHIR 端点（spec §7 明确允许的本地替身）。
 */

import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFhirStubServer, type FHIRStubServer } from '../../fhir-stub/server.js';
import { createFhirWriter, type FhirWriter } from '../../src/fhir/FhirWriter.js';
import { createLabOpsApp, type LabOpsApp } from '../../src/index.js';

export interface Harness {
  app: LabOpsApp;
  stub: FHIRStubServer;
  writer: FhirWriter;
  stubBase: string;
  stubPort: number;
  tmpDir: string;
  auditDir: string;
  httpPort: number;
  devicePort: number;
  stop(): Promise<void>;
}

export async function startHarness(opts: { startChannels?: boolean; wallboardToken?: string; auditDir?: string } = {}): Promise<Harness> {
  const stub = await createFhirStubServer({ port: 0 });
  const stubBase = `http://127.0.0.1:${stub.port}`;
  const writer = createFhirWriter({
    baseUrl: `${stubBase}/fhir/R4`,
    tokenUrl: `${stubBase}/auth/token`,
    clientId: 'cli',
    clientSecret: 'sec',
    urlAllowlist: [stubBase],
  });
  const tmpDir = mkdtempSync(join(tmpdir(), 'lab-e2e-'));
  const auditDir = opts.auditDir ?? join(tmpDir, 'audit');
  const app = await createLabOpsApp({
    dataDir: tmpDir,
    devicePort: 0,
    httpPort: 0,
    startChannels: opts.startChannels ?? true,
    fhirWriter: writer,
    modelConfig: {
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'unreachable-test-key',
      model: 'unreachable-model',
      timeoutMs: 150,
    },
    auditDir,
    ...(opts.wallboardToken ? { wallboardToken: opts.wallboardToken } : {}),
  });
  await app.start();
  return {
    app, stub, writer, stubBase, stubPort: stub.port, tmpDir, auditDir,
    httpPort: app.httpPort,
    devicePort: app.devicePort,
    async stop() {
      await app.stop();
      await stub.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** 脱敏构造的危急值 ORU^R01（血钾 6.8 mmol/L + HH 危急标记） */
export function makeCriticalFrame(controlId: string, patientId = 'PAT-HASH-001'): string {
  return [
    `MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261108093000||ORU^R01^ORU_R01|${controlId}|P|2.5`,
    `PID|1||${patientId}^^^Hospital-A^MR||脱敏患者||19800101|U`,
    'PV1|1|O|ICU^101^1',
    `OBR|1|ORD${controlId}|FIL${controlId}|CHEM^生化^L|||20261108092500`,
    'OBX|1|NM|K^钾^L|1|6.8|mmol/L|3.5-5.5|HH|||F',
    'OBX|2|NM|NA^钠^L|1|140|mmol/L|135-145|N|||F',
  ].join('\r');
}

/** 经真实 TCP 端口推一帧 HL7（VT ... FS CR），确定性等到 ACK 帧结束符或连接关闭 */
export async function pushTcpFrame(port: number, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let acks = '';
    socket.on('data', (buf: Buffer) => { acks += buf.toString('utf-8'); });
    socket.on('error', reject);
    socket.on('close', () => { resolve(acks); });
    socket.on('connect', () => {
      socket.write(Buffer.concat([
        Buffer.from([0x0b]),
        Buffer.from(frame, 'utf-8'),
        Buffer.from([0x1c, 0x0d]),
      ]));
      // 等到收到 ACK 帧结束符（FS 0x1c）或连接关闭，最长 2s；避免全量并行时 120ms 偶发漏收
      const deadline = Date.now() + 2000;
      const timer = setInterval(() => {
        if (acks.includes('\x1c') || Date.now() > deadline) {
          clearInterval(timer);
          socket.end();
          resolve(acks);
        }
      }, 20);
    });
  });
}

/** 轮询等待条件成立（真实 TCP 通道是事件驱动，业务处理异步完成） */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）${last ? `：${String(last)}` : ''}`);
}

export async function api(port: number, path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

export const postJson = (body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
