/**
 * tests/e2e/byte-to-fhir.test.ts —— 主干端到端：字节 → 解析 → FHIR 写入 → GET 命中
 *
 * 这条用例是「主干第 2 段」的验收：全链路都是真的，不打 mock
 * - 真实 TCP socket 连 Hl7Server（工控机上仪器推报文的那条路径）
 * - 真实 GBK 字节帧（tests/fixtures/oru-r01-k-nacl.txt，仪器报文用 GBK 是国内常态）
 * - 真实 HTTP：OAuth2 client-credentials 换 token → PUT FHIR 资源 → GET 回读校验
 * - 断言：报告可读 + Observation 引用齐全 + 每条 Observation / Specimen / Device 可 GET 命中
 */

import { describe, it, expect } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { fileURLToPath } from 'node:url';
import { createFhirStubServer } from '../../fhir-stub/server.js';
import { Hl7Server } from '../../src/channels/Hl7Server.js';
import { parseOruR01 } from '../../src/parser/oru-r01.js';
import { publishParserResult, type PublishResult } from '../../src/fhir/result-publisher.js';
import { FhirWriter } from '../../src/fhir/FhirWriter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../fixtures/oru-r01-k-nacl.txt');

/** 取 bearer token（院内网关同款：先换 token，再带 bearer 调 FHIR） */
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

describe('主干端到端：字节 → 解析 → FHIR 写入 → GET 命中', () => {
  it('真实 TCP 报文经解析后写入院内 FHIR 端点且可回读命中', { timeout: 30000 }, async () => {
    // ---- 1. 起院内 FHIR 端点替身（真实 HTTP + 真实 token 端点）----
    const stub = await createFhirStubServer({ port: 0 });
    const stubBase = `http://127.0.0.1:${stub.port}`;
    const writer = new FhirWriter({
      baseUrl: `${stubBase}/fhir/R4`,
      urlAllowlist: [stubBase],
      oidc: { tokenEndpoint: `${stubBase}/auth/token`, clientId: 'cli', clientSecret: 'sec' },
    });

    // ---- 2. 起仪器接入端口（真实 TCP；报文按仪器实际编码解码）----
    const hl7 = new Hl7Server('e2e-hl7', { encoding: 'utf-8' });
    const port = await hl7.start(0);

    let publishPromise: Promise<PublishResult> | null = null;
    hl7.on('message', (payload: { message: import('../../src/channels/Hl7Connection.js').Hl7Message }) => {
      const { message } = payload;
      publishPromise = (async () => {
        const parsed = await parseOruR01(message, { deviceId: 'DEV001', deviceManufacturer: 'LIS' });
        return publishParserResult(writer, parsed, { deviceId: 'DEV001' });
      })();
    });
    const errors: string[] = [];
    hl7.on('error', (err: Error) => errors.push(err.message));

    // ---- 3. 仪器推一帧真实报文 ----
    const frame = fs.readFileSync(FIXTURE);
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    const acks: string[] = [];
    socket.on('data', (buf: Buffer) => acks.push(buf.toString('utf-8')));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    socket.write(Buffer.concat([Buffer.from([0x0b]), frame, Buffer.from([0x1c, 0x0d])]));

    // ---- 4. 等写入完成 ----
    const deadline = Date.now() + 10_000;
    while (!publishPromise && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(publishPromise, `未收到报文（errors=${errors.join('; ')}）`).not.toBeNull();
    const published = await (publishPromise as unknown as Promise<PublishResult>);
    const token = await fetchToken(stubBase);

    try {
      // 写入结果：3 条 Observation + 1 份报告，回读校验通过
      expect(published.verified).toBe(true);
      expect(published.accessionIdentifier).toBe('DEV001:MSG00001');
      expect(published.observationIds).toHaveLength(3);
      expect(published.diagnosticReportId).toBe('dr-MSG00001');
      expect(published.written).toBe(6); // Device + Specimen + 3 Observation + 1 Report

      // 仪器回 ACK（AA）
      expect(acks.join('')).toContain('MSA|AA');

      // 报告可 GET 命中，且 Observation 引用齐全
      const reportRes = await fetch(`${stubBase}/fhir/R4/DiagnosticReport/dr-MSG00001`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(reportRes.status).toBe(200);
      const report = await reportRes.json() as {
        resourceType: string;
        result?: Array<{ reference: string }>;
        contained?: unknown[];
        identifier?: Array<{ system: string; value: string }>;
      };
      expect(report.resourceType).toBe('DiagnosticReport');
      expect(report.result).toHaveLength(3);
      expect(report.contained).toHaveLength(3);
      expect(report.result?.map((r) => r.reference)).toEqual([
        'Observation/obs-MSG00001-1-1',
        'Observation/obs-MSG00001-2-1',
        'Observation/obs-MSG00001-3-1',
      ]);
      // 幂等键落在报告 identifier 上（accessionIdentifier = <设备ID>:<MSH.10>）
      expect(report.identifier?.some((i) => i.value === 'DEV001:MSG00001')).toBe(true);

      // 每条 Observation 都能单独 GET 命中（值 / 单位 / LOINC 都在）
      const obsRes = await fetch(`${stubBase}/fhir/R4/Observation/obs-MSG00001-1-1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(obsRes.status).toBe(200);
      const obs = await obsRes.json() as {
        valueQuantity?: { value: number; unit: string };
        code?: { coding?: Array<{ code?: string }> };
        subject?: { reference?: string };
      };
      expect(obs.valueQuantity?.value).toBe(4.5);
      expect(obs.valueQuantity?.unit).toBe('mmol/L');
      expect(obs.code?.coding?.[0]?.code).toBe('2823-3');
      expect(obs.subject?.reference).toBe('Patient/P12345');

      // 标本可 GET 命中，accessionIdentifier 是幂等锚点
      const specimenRes = await fetch(`${stubBase}/fhir/R4/Specimen/spec-MSG00001`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(specimenRes.status).toBe(200);
      const specimen = await specimenRes.json() as {
        accessionIdentifier?: { value: string };
        subject?: { reference?: string };
      };
      expect(specimen.accessionIdentifier?.value).toBe('DEV001:MSG00001');
      expect(specimen.subject?.reference).toBe('Patient/P12345');

      // 仪器资源可 GET 命中
      const deviceRes = await fetch(`${stubBase}/fhir/R4/Device/DEV001`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(deviceRes.status).toBe(200);
    } finally {
      socket.destroy();
      await hl7.stop({ forceDrainTimeoutMs: 100 });
      await stub.close();
    }
  });

  it('同一份标本重推：资源数不增（按 id upsert 幂等）', { timeout: 30000 }, async () => {
    const stub = await createFhirStubServer({ port: 0 });
    const stubBase = `http://127.0.0.1:${stub.port}`;
    const writer = new FhirWriter({
      baseUrl: `${stubBase}/fhir/R4`,
      urlAllowlist: [stubBase],
      oidc: { tokenEndpoint: `${stubBase}/auth/token`, clientId: 'cli', clientSecret: 'sec' },
    });
    const hl7 = new Hl7Server('e2e-hl7-idem', { encoding: 'utf-8' });
    const port = await hl7.start(0);

    const publishPromises: Array<Promise<PublishResult>> = [];
    hl7.on('message', (payload: { message: import('../../src/channels/Hl7Connection.js').Hl7Message }) => {
      publishPromises.push((async () => {
        const parsed = await parseOruR01(payload.message, { deviceId: 'DEV001' });
        return publishParserResult(writer, parsed, { deviceId: 'DEV001' });
      })());
    });

    const frame = fs.readFileSync(FIXTURE);
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    const push = (): void => {
      socket.write(Buffer.concat([Buffer.from([0x0b]), frame, Buffer.from([0x1c, 0x0d])]));
    };

    try {
      push();
      await new Promise((r) => setTimeout(r, 400));
      push(); // 仪器重发同一份标本
      await new Promise((r) => setTimeout(r, 400));
      expect(publishPromises.length).toBeGreaterThanOrEqual(2);
      await Promise.all(publishPromises);

      const token = await fetchToken(stubBase);
      const search = async (type: string): Promise<number> => {
        const res = await fetch(`${stubBase}/fhir/R4/${type}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const bundle = await res.json() as { total: number };
        return bundle.total;
      };
      expect(await search('Observation')).toBe(3);
      expect(await search('DiagnosticReport')).toBe(1);
      expect(await search('Specimen')).toBe(1);
    } finally {
      socket.destroy();
      await hl7.stop({ forceDrainTimeoutMs: 100 });
      await stub.close();
    }
  });

  it('GBK 报文：中文检验项名正确解码后写进 FHIR（国内仪器常态）', { timeout: 30000 }, async () => {
    const stub = await createFhirStubServer({ port: 0 });
    const stubBase = `http://127.0.0.1:${stub.port}`;
    const writer = new FhirWriter({
      baseUrl: `${stubBase}/fhir/R4`,
      urlAllowlist: [stubBase],
      oidc: { tokenEndpoint: `${stubBase}/auth/token`, clientId: 'cli', clientSecret: 'sec' },
    });
    const hl7 = new Hl7Server('e2e-hl7-gbk', { encoding: 'gbk' });
    const port = await hl7.start(0);

    let publishPromise: Promise<PublishResult> | null = null;
    hl7.on('message', (payload: { message: import('../../src/channels/Hl7Connection.js').Hl7Message }) => {
      publishPromise = (async () => {
        const parsed = await parseOruR01(payload.message, { deviceId: 'DEV001' });
        return publishParserResult(writer, parsed, { deviceId: 'DEV001' });
      })();
    });

    // 同一份报文按 GBK 编码（仪器侧发出的字节）
    const gbkFrame = iconv.encode(fs.readFileSync(FIXTURE, 'utf-8'), 'gbk');
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    socket.write(Buffer.concat([Buffer.from([0x0b]), gbkFrame, Buffer.from([0x1c, 0x0d])]));

    try {
      const deadline = Date.now() + 10_000;
      while (!publishPromise && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(publishPromise).not.toBeNull();
      const published = await (publishPromise as unknown as Promise<PublishResult>);
      expect(published.verified).toBe(true);

      const token = await fetchToken(stubBase);
      const res = await fetch(`${stubBase}/fhir/R4/Observation/obs-MSG00001-1-1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const obs = await res.json() as { code?: { text?: string } };
      // 中文检验项名必须原样落库，不能是乱码
      expect(obs.code?.text).toBe('钾');
    } finally {
      socket.destroy();
      await hl7.stop({ forceDrainTimeoutMs: 100 });
      await stub.close();
    }
  });
});
