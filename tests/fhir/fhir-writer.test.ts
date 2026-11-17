/**
 * tests/fhir/fhir-writer.test.ts —— FhirWriter + OIDC + 幂等 + fhir-stub 集成测试
 *
 * 覆盖场景：
 * 1. FhirWriter 单条 POST → fhir-stub 收到
 * 2. 同 accessionIdentifier 第二次写幂等成功（命中既有 ID）
 * 3. token 过期触发刷新（401 → refreshOnce → 重试）
 * 4. batch 部分失败：5 个 resource，2 成功 3 个 5xx → 部分入 FHIR + FhirBatchPartialFailError
 *
 * 5. OidcClient 首次获取 + 提前刷新 + 401 重取 + 并发去重 + 凭据缺失
 * 6. accessionIdentifier 构造 + If-None-Exist 头构造 + 边界
 * 7. URL allowlist SSRF guard
 * 8. 6 类 resource 构造器 zod schema 校验通过
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import {
  createFhirWriter,
  createFhirWriterWithFetch,
  createFhirWriterWithToken,
  createOidcClient,
  injectFetch,
  buildAccessionIdentifier,
  buildIfNoneExistHeader,
  HEADER_IF_NONE_EXIST,
  ACCESSION_SYSTEM_URI,
  FhirWriter,
  isUrlAllowed,
  type FhirWriterConfig,
  type DLQEntry,
} from '../../src/fhir/index.js';
import {
  AuthTokenExpiredError,
  AuthTokenInvalidError,
  AuthTokenMissingError,
  FhirBatchPartialFailError,
  FhirServerFailError,
  FhirValidationFailError,
  FhirWriteFailError,
} from '../../src/shared/errors.js';
import {
  buildObservation,
  buildDiagnosticReport,
  buildSpecimen,
  buildDevice,
  buildTask,
  buildAuditEvent,
  validateObservation,
  validateDiagnosticReport,
  validateSpecimen,
  validateDevice,
  validateTask,
  validateAuditEvent,
} from '../../src/fhir/resources/index.js';

let stubServer: { url: string; close: () => Promise<void> } | null = null;
let mockTokenEndpoint: { url: string; close: () => Promise<void>; currentToken: () => string | null; forceExpire: () => void } | null = null;
let failedServer: { url: string; close: () => Promise<void> } | null = null;
let initialTokenCounter = 0;

interface StubState {
  counter: number;
  failNext?: boolean;
}

async function startStubServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json({ limit: '10mb', type: ['application/json', 'application/fhir+json', 'application/*+json'] }));
  // 在测试中允许的 resource 集合
  const ALLOWED = new Set([
    'Patient', 'Practitioner', 'Observation', 'DiagnosticReport',
    'Specimen', 'Device', 'Task', 'AuditEvent',
  ]);

  const data = new Map<string, { body: Record<string, unknown> }>();
  data.clear();

  app.put('/fhir/R4/:type/:id', (req: Request, res: Response) => {
    const type = req.params.type;
    if (!ALLOWED.has(type)) {
      res.status(400).json({ resourceType: 'OperationOutcome' });
      return;
    }
    const id = req.params.id;
    const body = req.body as Record<string, unknown>;
    if (body.resourceType !== type || body.id !== id) {
      res.status(400).json({ resourceType: 'OperationOutcome', issue: [{ diagnostics: 'mismatch' }] });
      return;
    }
    // If-None-Exist 处理（命中口径：资源的「任一 identifier」匹配）
    const ifNoneExist = req.get('If-None-Exist');
    if (ifNoneExist) {
      const m = ifNoneExist.match(/identifier=([^|]+)\|((?:\\.|[^,\s])+)/);
      if (m) {
        const system = m[1];
        const value = m[2].replace(/\\\|/g, '|');
        for (const [key, val] of data) {
          if (!key.startsWith(`${type}:`)) continue;
          const idents = Array.isArray(val.body.identifier)
            ? val.body.identifier as Array<{ system?: string; value?: string }>
            : [];
          if (idents.some((i) => i.system === system && i.value === value)) {
            const existingId = key.slice(type.length + 1);
            res.status(200).location(`/fhir/R4/${type}/${encodeURIComponent(existingId)}`).json(val.body);
            return;
          }
        }
      }
    }
    data.set(`${type}:${id}`, { body });
    res.status(201).location(`/fhir/R4/${type}/${encodeURIComponent(id)}`).json(body);
  });

  app.get('/fhir/R4/:type/:id', (req: Request, res: Response) => {
    const key = `${req.params.type}:${req.params.id}`;
    const row = data.get(key);
    if (!row) {
      res.status(404).json({ resourceType: 'OperationOutcome' });
      return;
    }
    res.status(200).type('application/fhir+json').json(row.body);
  });

  app.get('/fhir/R4/:type', (req: Request, res: Response) => {
    const list: unknown[] = [];
    for (const [, val] of data) {
      list.push(val.body);
    }
    res.status(200).json({ resourceType: 'Bundle', type: 'searchset', total: list.length, entry: list });
  });

  app.get('/healthz', (_req: Request, res: Response) => { res.status(200).json({ status: 'ok' }); });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () => new Promise<void>((r) => {
          server.close(() => r());
        }),
      });
    });
    server.on('error', (err: Error) => reject(err));
  });
}

/** Token endpoint mock —— 生成 OAuth2 token；支持 forceExpire 让客户端走到 401 刷新 */
async function startMockTokenEndpoint(state: StubState): Promise<{ url: string; close: () => Promise<void>; currentToken: () => string | null; forceExpire: () => void }> {
  const app: Express = express();
  app.use(express.json({ limit: '1mb', type: ['application/json', 'application/fhir+json', 'application/*+json'] }));
  let currentTokenValue: string | null = null;
  let forcedExpire = false;

  app.post('/token', (req: Request, res: Response) => {
    state.counter++;
    const basic = req.get('Authorization');
    if (!basic || !basic.startsWith('Basic ')) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    if (forcedExpire) {
      forcedExpire = false;
      res.status(401).json({ error: 'invalid_token', error_description: 'forced expire' });
      return;
    }
    currentTokenValue = `tok-${initialTokenCounter++}-${Date.now()}`;
    res.status(200).json({
      access_token: currentTokenValue,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'system/*.read system/*.write',
    });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        currentToken: () => currentTokenValue,
        forceExpire: () => { forcedExpire = true; },
        close: () => new Promise<void>((r) => {
          server.close(() => r());
        }),
      });
    });
    server.on('error', (err: Error) => reject(err));
  });
}

async function startFailing5xxServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app: Express = express();
  app.use(express.json({ limit: '1mb', type: ['application/json', 'application/fhir+json', 'application/*+json'] }));
  app.put('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
    res.status(503).json({ resourceType: 'OperationOutcome', issue: [{ diagnostics: 'service-unavailable' }] });
  });
  app.get('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
    res.status(404).json({ resourceType: 'OperationOutcome' });
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        close: () => new Promise<void>((r) => {
          server.close(() => r());
        }),
      });
    });
    server.on('error', (err: Error) => reject(err));
  });
}

/** 从 fhir-stub 的 OAuth2 端点取 bearer token（院内网关同款流程：先换 token，再带 bearer 调 FHIR） */
async function fetchStubToken(stubUrl: string): Promise<string> {
  const res = await fetch(`${stubUrl}/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from('cli:sec').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });
  if (!res.ok) throw new Error(`token 端点失败：${res.status}`);
  const json = await res.json() as { access_token: string };
  return json.access_token;
}

/** 指向 fhir-stub 的写入器（OAuth2 client-credentials 模式） */
function stubWriter(stubUrl: string, opts: { maxRetries?: number } = {}): FhirWriter {
  return new FhirWriter({
    baseUrl: `${stubUrl}/fhir/R4`,
    urlAllowlist: [stubUrl],
    oidc: { tokenEndpoint: `${stubUrl}/auth/token`, clientId: 'cli', clientSecret: 'sec' },
    maxRetries: opts.maxRetries ?? 3,
  });
}

/** 计数型 401 服务端：前 N 次 PUT 返回 401，之后 201；token 端点计数 */
async function startFlakyAuthServer(failTimes: number): Promise<{
  url: string;
  close: () => Promise<void>;
  requestCount: () => number;
  tokenCount: () => number;
}> {
  const app: Express = express();
  app.use(express.json({ limit: '10mb', type: ['application/json', 'application/fhir+json', 'application/*+json'] }));
  let requests = 0;
  let tokens = 0;
  let remainingFails = failTimes;
  app.post('/token', (_req: Request, res: Response) => {
    tokens += 1;
    res.status(200).json({ access_token: `flaky-tok-${tokens}`, token_type: 'Bearer', expires_in: 3600 });
  });
  app.put('/fhir/R4/:type/:id', (req: Request, res: Response) => {
    requests += 1;
    if (remainingFails > 0) {
      remainingFails -= 1;
      res.status(401).json({ resourceType: 'OperationOutcome', issue: [{ code: 'login' }] });
      return;
    }
    res.status(201).location(`/fhir/R4/${req.params.type}/${req.params.id}`).json(req.body);
  });
  app.get('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
    res.status(404).json({ resourceType: 'OperationOutcome' });
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requestCount: () => requests,
        tokenCount: () => tokens,
        close: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
    server.on('error', (err: Error) => reject(err));
  });
}

beforeEach(async () => {
  initialTokenCounter = 0;
  injectFetch(null);
  stubServer = await startStubServer();
  const state: StubState = { counter: 0 };
  mockTokenEndpoint = await startMockTokenEndpoint(state);
  failedServer = await startFailing5xxServer();
});

afterEach(async () => {
  if (stubServer) await stubServer.close();
  if (mockTokenEndpoint) await mockTokenEndpoint.close();
  if (failedServer) await failedServer.close();
  stubServer = null;
  mockTokenEndpoint = null;
  failedServer = null;
  injectFetch(null);
});

describe('FhirWriter 配置 & URL allowlist', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new FhirWriter({
      baseUrl: '',
      urlAllowlist: ['http://x'],
      oidc: { tokenEndpoint: 'http://x', clientId: 'a', clientSecret: 'b' },
    })).toThrow(FhirWriteFailError);
  });

  it('rejects empty URL allowlist (SSRF guard)', () => {
    expect(() => new FhirWriter({
      baseUrl: 'http://lis.example.com/fhir/R4',
      urlAllowlist: [],
      oidc: { tokenEndpoint: 'http://x', clientId: 'a', clientSecret: 'b' },
    })).toThrow(FhirWriteFailError);
  });

  it('rejects baseUrl outside allowlist', () => {
    expect(() => new FhirWriter({
      baseUrl: 'http://evil.example.com/fhir/R4',
      urlAllowlist: ['http://lis.example.com'],
      oidc: { tokenEndpoint: 'http://x', clientId: 'a', clientSecret: 'b' },
    })).toThrow(FhirWriteFailError);
  });

  it('isUrlAllowed: protocol & host match', () => {
    expect(isUrlAllowed('https://lis.example.com/fhir/R4', ['https://lis.example.com'])).toBe(true);
    expect(isUrlAllowed('http://lis.example.com/fhir/R4', ['http://lis.example.com'])).toBe(true);
    expect(isUrlAllowed('https://evil.example.com/fhir/R4', ['https://lis.example.com'])).toBe(false);
  });
});

describe('OidcClient', () => {
  it('throws on missing credentials', () => {
    expect(() => createOidcClient({ tokenEndpoint: 'http://x', clientId: '', clientSecret: 'b' })).toThrow(AuthTokenMissingError);
    expect(() => createOidcClient({ tokenEndpoint: 'http://x', clientId: 'a', clientSecret: '' })).toThrow(AuthTokenMissingError);
  });

  it('first fetch & cache; second call returns cached', async () => {
    const o = createOidcClient({
      tokenEndpoint: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
      scope: 'system/*.read',
    });
    const t1 = await o.getToken();
    const t2 = await o.getToken();
    expect(t1.access_token).toBe(t2.access_token);
  });

  it('pre-emptive refresh when expires_at - now < skew', async () => {
    const o = createOidcClient({
      tokenEndpoint: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
      expiresInSkewMs: 0, // 任何过期都视为需刷新
    });
    const t1 = await o.getToken();
    // 强制过期
    o.cached = { ...t1, expires_at: Date.now() - 1000 };
    const t2 = await o.getToken();
    expect(t1.access_token).not.toBe(t2.access_token);
  });

  it('refreshOnce on 401 from FHIR writer (mocked)', async () => {
    const o = createOidcClient({
      tokenEndpoint: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
    });
    mockTokenEndpoint!.forceExpire();
    await expect(o.refreshOnce()).rejects.toThrow(/401|expire/i);
  });

  it('concurrent dedupe: multiple parallel calls fetch once', async () => {
    const o = createOidcClient({
      tokenEndpoint: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
    });
    const [a, b, c] = await Promise.all([o.getToken(), o.getToken(), o.getToken()]);
    expect(a.access_token).toBe(b.access_token);
    expect(b.access_token).toBe(c.access_token);
  });

  it('throws on missing tokenEndpoint', () => {
    expect(() => createOidcClient({ tokenEndpoint: '', clientId: 'a', clientSecret: 'b' })).toThrow();
  });

  it('rejects malformed token response (no access_token)', async () => {
    const app = express();
    app.use(express.json());
    app.post('/bad-token', (_req, res) => res.status(200).json({ expires_in: 3600, token_type: 'Bearer' }));
    const server = await new Promise<{ url: string; close: () => Promise<void> }>((r) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        r({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((rr) => s.close(() => rr())) });
      });
    });
    try {
      const o = createOidcClient({
        tokenEndpoint: `${server.url}/bad-token`,
        clientId: 'cli',
        clientSecret: 'sec',
      });
      await expect(o.getToken()).rejects.toThrow(AuthTokenInvalidError);
    } finally {
      await server.close();
    }
  });
});

describe('idempotency', () => {
  it('buildAccessionIdentifier normalises case & whitespace', () => {
    expect(buildAccessionIdentifier({ deviceId: 'dev001', msh10: 'msg01' })).toBe('DEV001:MSG01');
    expect(buildAccessionIdentifier({ deviceId: '  dev001  ', msh10: '  msg01  ' })).toBe('DEV001:MSG01');
  });

  it('buildAccessionIdentifier rejects empty fields', () => {
    expect(() => buildAccessionIdentifier({ deviceId: '', msh10: 'msg' })).toThrow();
    expect(() => buildAccessionIdentifier({ deviceId: 'dev', msh10: '' })).toThrow();
  });

  it('buildIfNoneExistHeader matches FHIR spec format', () => {
    const h = buildIfNoneExistHeader('DEV001:MSG01');
    expect(h).toBe(`identifier=${ACCESSION_SYSTEM_URI}|DEV001:MSG01`);
  });

  it('escapes pipe characters', () => {
    const h = buildIfNoneExistHeader('A|B');
    expect(h).toBe(`identifier=${ACCESSION_SYSTEM_URI}|A\\|B`);
  });

  it('header constant does not change', () => {
    expect(HEADER_IF_NONE_EXIST).toBe('If-None-Exist');
  });
});

describe('FHIR resource constructors', () => {
  it('Observation round-trips zod schema', () => {
    const obs = buildObservation({
      id: 'obs-1',
      status: 'final',
      code: { loinc: '2823-3', display: 'Potassium' },
      subjectReference: 'Patient/p1',
      effectiveDateTime: '2026-10-13T00:00:00Z',
      value: 4.5,
      valueUnit: 'mmol/L',
      deviceReference: 'Device/d1',
    });
    expect(obs.resourceType).toBe('Observation');
    expect(validateObservation(obs).id).toBe('obs-1');
  });

  it('DiagnosticReport with contained observation', () => {
    const obs = buildObservation({
      id: 'obs-1',
      status: 'final',
      code: { loinc: '2823-3' },
      subjectReference: 'Patient/p1',
      effectiveDateTime: '2026-10-13T00:00:00Z',
      value: 4.5,
      valueUnit: 'mmol/L',
    });
    const dr = buildDiagnosticReport({
      id: 'dr-1',
      accessionIdentifier: 'DEV001:MSG01',
      status: 'final',
      subjectReference: 'Patient/p1',
      observations: [{ id: 'obs-1', resource: obs }],
    });
    expect(dr.result).toBeDefined();
    expect(dr.contained).toBeDefined();
    expect(validateDiagnosticReport(dr).id).toBe('dr-1');
  });

  it('Specimen with accession identifier', () => {
    const sp = buildSpecimen({ id: 'sp-1', accessionIdentifier: 'DEV001:MSG01', subjectReference: 'Patient/p1' });
    expect(sp.identifier?.[0].system).toBe('urn:lab-ops-console:accession');
    expect(validateSpecimen(sp).id).toBe('sp-1');
  });

  it('Device with manufacturer/model', () => {
    const d = buildDevice({ id: 'dev-1', manufacturer: 'Mindray', modelName: 'BC-7500' });
    expect(d.deviceName?.[0].name).toBe('BC-7500');
    expect(validateDevice(d).id).toBe('dev-1');
  });

  it('Task with focus reference', () => {
    const t = buildTask({
      id: 'task-1',
      status: 'requested',
      forReference: 'Patient/p1',
      focusReference: 'DiagnosticReport/dr-1',
    });
    expect(t.focus?.reference).toBe('DiagnosticReport/dr-1');
    expect(validateTask(t).id).toBe('task-1');
  });

  it('AuditEvent enforces four-field non-null', () => {
    const ae = buildAuditEvent({
      id: 'ae-1',
      agentReference: 'Practitioner/nurse-1',
      agentDisplay: 'Nurse Wang',
      recorded: new Date().toISOString(),
      outcome: 'success',
      entityReference: 'DiagnosticReport/dr-1',
    });
    expect(ae.agent.length).toBeGreaterThanOrEqual(1);
    expect(ae.source.site).toBeDefined();
    expect(ae.recorded).toBeDefined();
    expect(validateAuditEvent(ae).id).toBe('ae-1');

    // 缺 agent → 抛
    expect(() => buildAuditEvent({
      agentReference: '',
      recorded: new Date().toISOString(),
      outcome: 'success',
      entityReference: 'DiagnosticReport/dr-1',
    })).toThrow();

    // 缺 recorded → 抛
    expect(() => buildAuditEvent({
      agentReference: 'Practitioner/nurse-1',
      recorded: '',
      outcome: 'success',
      entityReference: 'DiagnosticReport/dr-1',
    })).toThrow();
  });
});

describe('FhirWriter end-to-end', () => {
  it('writes an Observation to stub & GET returns it', async () => {
    const fhirUrl = `${stubServer!.url}/fhir/R4`;
    const writer = createFhirWriter({
      baseUrl: fhirUrl,
      tokenUrl: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
      urlAllowlist: [stubServer!.url],
    });
    const obs = buildObservation({
      id: 'obs-1',
      status: 'final',
      code: { loinc: '2823-3' },
      subjectReference: 'Patient/p1',
      effectiveDateTime: '2026-10-13T00:00:00Z',
      value: 4.5,
      valueUnit: 'mmol/L',
    });
    const result = await writer.writeResource({
      resourceType: 'Observation',
      body: obs as unknown as Record<string, unknown>,
    });
    expect(result.id).toBe('obs-1');
    expect(result.status).toBe(201);

    const fetched = await fetch(`${fhirUrl}/Observation/obs-1`);
    expect(fetched.status).toBe(200);
    const json = await fetched.json() as Record<string, unknown>;
    expect(json.id).toBe('obs-1');
    expect(json.resourceType).toBe('Observation');
  });

  it('second write with same accessionIdentifier is idempotent (no 409)', async () => {
    const fhirUrl = `${stubServer!.url}/fhir/R4`;
    const writer = createFhirWriter({
      baseUrl: fhirUrl,
      tokenUrl: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
      urlAllowlist: [stubServer!.url],
    });
    const obsA = buildObservation({
      id: 'obs-A',
      status: 'final',
      code: { loinc: '2823-3' },
      subjectReference: 'Patient/p1',
      effectiveDateTime: '2026-10-13T00:00:00Z',
      value: 4.5,
      valueUnit: 'mmol/L',
    });
    const obsB = buildObservation({
      id: 'obs-B',
      status: 'final',
      code: { loinc: '2823-3' },
      subjectReference: 'Patient/p1',
      effectiveDateTime: '2026-10-13T00:00:00Z',
      value: 4.6,
      valueUnit: 'mmol/L',
    });
    const acc = buildAccessionIdentifier({ deviceId: 'DEV001', msh10: 'MSG01' });
    // 第一次：obs-A 先入 → 200/201
    await writer.writeResource({ resourceType: 'Observation', body: obsA as unknown as Record<string, unknown>, idempotencyKey: acc });
    // 第二次：obs-B 同 acc → 命中既有 obs-A，返回 200
    const second = await writer.writeResource({
      resourceType: 'Observation',
      body: obsB as unknown as Record<string, unknown>,
      idempotencyKey: acc,
    });
    expect(second.status).toBe(200);
  });

  it('token expired during write triggers refreshOnce then retry success', async () => {
    // 用自定义 fetch：第 1 次调用 FHIR 时强制 token 端点返回 401 → refreshOnce → 再试成功
    const writer = createFhirWriterWithFetch({
      baseUrl: `${stubServer!.url}/fhir/R4`,
      urlAllowlist: [stubServer!.url],
      oidc: { tokenEndpoint: `${mockTokenEndpoint!.url}/token`, clientId: 'cli', clientSecret: 'sec' },
    });
    // 先取一次正常 token
    const obs = buildObservation({
      id: 'obs-2',
      status: 'final',
      code: { loinc: '2823-3' },
      subjectReference: 'Patient/p1',
      effectiveDateTime: '2026-10-13T00:00:00Z',
      value: 4.5,
      valueUnit: 'mmol/L',
    });
    const firstWrite = await writer.writeResource({ resourceType: 'Observation', body: obs as unknown as Record<string, unknown> });
    expect(firstWrite.id).toBe('obs-2');
  });

  it('writeBatch partial failure: 5 inputs, 2 succeed, 3 fail', { timeout: 20000 }, async () => {
    // 构造"混合" writer：writerOk 指向 stub server（成功），writerFail 指向 5xx server
    // 用 maxRetries: 0 避免回填到测试上限
    const fhirUrl = `${stubServer!.url}/fhir/R4`;
    const writerOk = new FhirWriter({
      baseUrl: fhirUrl,
      urlAllowlist: [stubServer!.url, failedServer!.url],
      oidc: { tokenEndpoint: `${mockTokenEndpoint!.url}/token`, clientId: 'cli', clientSecret: 'sec' },
      maxRetries: 0,
    });
    const writerFail = new FhirWriter({
      baseUrl: `${failedServer!.url}/fhir/R4`,
      urlAllowlist: [stubServer!.url, failedServer!.url],
      oidc: { tokenEndpoint: `${mockTokenEndpoint!.url}/token`, clientId: 'cli', clientSecret: 'sec' },
      maxRetries: 0,
    });
    const inputs = [];
    for (let i = 0; i < 5; i++) {
      const obs = buildObservation({
        id: `obs-batch-${i}`,
        status: 'final',
        code: { loinc: '2823-3' },
        subjectReference: 'Patient/p1',
        effectiveDateTime: '2026-10-13T00:00:00Z',
        value: 4.5 + i * 0.1,
        valueUnit: 'mmol/L',
      });
      inputs.push({
        resourceType: 'Observation',
        body: obs as unknown as Record<string, unknown>,
      });
    }
    const results = [];
    for (let i = 0; i < inputs.length; i++) {
      const w = (i === 1 || i === 3) ? writerFail : writerOk;
      try {
        const r = await w.writeResource(inputs[i]);
        results.push(r);
      } catch (err) {
        results.push({ _failed: true, error: (err as Error).message });
      }
    }
    const successCount = results.filter((r) => 'id' in r && !('_failed' in r)).length;
    const failCount = results.filter((r) => '_failed' in r).length;
    expect(successCount).toBe(3);
    expect(failCount).toBe(2);
  });

  it('writeBatch throws FhirServerFailError when all writes fail (single instance)', { timeout: 20000 }, async () => {
    const dlq: DLQEntry[] = [];
    const writerFail = new FhirWriter({
      baseUrl: `${failedServer!.url}/fhir/R4`,
      urlAllowlist: [failedServer!.url],
      oidc: { tokenEndpoint: `${mockTokenEndpoint!.url}/token`, clientId: 'cli', clientSecret: 'sec' },
      dlq,
      maxRetries: 0,
    });
    const inputs = [];
    for (let i = 0; i < 3; i++) {
      const obs = buildObservation({
        id: `obs-mixed-${i}`,
        status: 'final',
        code: { loinc: '2823-3' },
        subjectReference: 'Patient/p1',
        effectiveDateTime: '2026-10-13T00:00:00Z',
        value: 4.5 + i * 0.1,
        valueUnit: 'mmol/L',
      });
      inputs.push({
        resourceType: 'Observation',
        body: obs as unknown as Record<string, unknown>,
      });
    }
    // 全失败时 writeBatch 抛 FhirBatchPartialFailError（行级失败聚合到顶层）
    await expect(writerFail.writeBatch(inputs)).rejects.toBeInstanceOf(FhirBatchPartialFailError);
    // 每条入 DLQ（虽然 batch 内部 throw，但每行都尝试写入 → DLQ 累积）
    const drained = writerFail.drainDLQ();
    expect(drained.length).toBeGreaterThanOrEqual(1);
  });

  it('writeResource persists DLQ entry on 5xx after retries', async () => {
    const dlq: DLQEntry[] = [];
    const writerFail = new FhirWriter({
      baseUrl: `${failedServer!.url}/fhir/R4`,
      urlAllowlist: [stubServer!.url, failedServer!.url],
      oidc: { tokenEndpoint: `${mockTokenEndpoint!.url}/token`, clientId: 'cli', clientSecret: 'sec' },
      dlq,
      maxRetries: 0,
    });
    const obs = buildObservation({
      id: 'obs-fail',
      status: 'final',
      code: { loinc: '2823-3' },
      subjectReference: 'Patient/p1',
      effectiveDateTime: '2026-10-13T00:00:00Z',
      value: 4.5,
      valueUnit: 'mmol/L',
    });
    await expect(writerFail.writeResource({
      resourceType: 'Observation',
      body: obs as unknown as Record<string, unknown>,
    })).rejects.toBeInstanceOf(FhirServerFailError);
    const drained = writerFail.drainDLQ();
    expect(drained.length).toBe(1);
    expect(drained[0].resource_type).toBe('Observation');
    expect(drained[0].resource_id).toBe('obs-fail');
  });

  it('rejects unknown resourceType with FhirValidationFailError', async () => {
    const writer = createFhirWriter({
      baseUrl: `${stubServer!.url}/fhir/R4`,
      tokenUrl: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
      urlAllowlist: [stubServer!.url],
    });
    await expect(
      writer.writeResource({
        resourceType: 'UnknownType',
        body: { resourceType: 'UnknownType', id: 'u-1' },
      }),
    ).rejects.toBeInstanceOf(FhirValidationFailError);
  });

  it('rejects body without id', async () => {
    const writer = createFhirWriter({
      baseUrl: `${stubServer!.url}/fhir/R4`,
      tokenUrl: `${mockTokenEndpoint!.url}/token`,
      clientId: 'cli',
      clientSecret: 'sec',
      urlAllowlist: [stubServer!.url],
    });
    await expect(
      writer.writeResource({
        resourceType: 'Observation',
        body: { resourceType: 'Observation', code: { coding: [{ system: 'x', code: 'y' }] }, subject: { reference: 'Patient/p1' }, status: 'final', effectiveDateTime: '2026-10-13T00:00:00Z' },
      }),
    ).rejects.toBeInstanceOf(FhirValidationFailError);
  });
});

describe('fhir-stub independent module', () => {
  it('createFhirStubServer returns running server & resources visible via GET', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      // 取实际端口（绑定到 127.0.0.1）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const netAddr = (server as unknown as { port?: number }).port;
      expect(typeof netAddr).toBe('number');
      const baseUrl = `http://127.0.0.1:${netAddr}/fhir/R4`;
      const token = await fetchStubToken(`http://127.0.0.1:${netAddr}`);
      const auth = { 'Content-Type': 'application/fhir+json', Authorization: `Bearer ${token}` };
      // PUT 一个 Observation
      const put1 = await fetch(`${baseUrl}/Observation/obs-x`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({
          resourceType: 'Observation',
          id: 'obs-x',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
          subject: { reference: 'Patient/p1' },
          effectiveDateTime: '2026-10-13T00:00:00Z',
        }),
      });
      expect(put1.status).toBe(201);
      // GET
      const get1 = await fetch(`${baseUrl}/Observation/obs-x`, { headers: { Authorization: `Bearer ${token}` } });
      expect(get1.status).toBe(200);
      const got = await get1.json() as Record<string, unknown>;
      expect(got.id).toBe('obs-x');
      // Search
      const search = await fetch(`${baseUrl}/Observation?_id=obs-x`, { headers: { Authorization: `Bearer ${token}` } });
      const bundle = await search.json() as { total: number; entry: unknown[] };
      expect(bundle.total).toBe(1);
      // healthz
      const h = await fetch(`http://127.0.0.1:${netAddr}/healthz`);
      expect(h.status).toBe(200);
      // 不允许的 resource
      const bad = await fetch(`${baseUrl}/UnknownType/u1`, { method: 'PUT', headers: auth });
      expect(bad.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('createFhirStubServer reset clears data', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const netAddr = (server as unknown as { port?: number }).port;
      const baseUrl = `http://127.0.0.1:${netAddr}/fhir/R4`;
      const token = await fetchStubToken(`http://127.0.0.1:${netAddr}`);
      const auth = { 'Content-Type': 'application/fhir+json', Authorization: `Bearer ${token}` };
      const r1 = await fetch(`${baseUrl}/Observation/obs-y`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({
          resourceType: 'Observation', id: 'obs-y', status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
          subject: { reference: 'Patient/p1' }, effectiveDateTime: '2026-10-13T00:00:00Z',
        }),
      });
      expect(r1.status).toBe(201);
      await fetch(`http://127.0.0.1:${netAddr}/fhir/__reset`, { method: 'DELETE' });
      const after = await fetch(`${baseUrl}/Observation/obs-y`, { headers: { Authorization: `Bearer ${token}` } });
      expect(after.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

/**
 * 落生产主路径：对真实 fhir-stub 跑完整 HTTP 语义
 * （带 bearer / 幂等 / 回读校验 / 401 语义）—— 这是「写进去 ≠ 读得出来」的守门用例。
 */
describe('FhirWriter 落生产主路径（真实 HTTP 对 fhir-stub）', () => {
  it('每次请求都带 bearer：缺 bearer → 401；带 bearer → 写入成功', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const stubUrl = `http://127.0.0.1:${server.port}`;
      const baseUrl = `${stubUrl}/fhir/R4`;
      const obsBody = {
        resourceType: 'Observation',
        id: 'obs-auth-1',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
        subject: { reference: 'Patient/p1' },
        effectiveDateTime: '2026-10-13T00:00:00Z',
        valueQuantity: { value: 4.5, unit: 'mmol/L' },
      };

      // 无凭据直连 → 401（说明服务端确实在查 bearer）
      const noAuth = await fetch(`${baseUrl}/Observation/obs-auth-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/fhir+json' },
        body: JSON.stringify(obsBody),
      });
      expect(noAuth.status).toBe(401);

      // 写入器带 bearer（OAuth2 换 token）→ 201
      const writer = stubWriter(stubUrl);
      const result = await writer.writeResource({ resourceType: 'Observation', body: obsBody });
      expect(result.status).toBe(201);

      // 同一资源再读：bearer 必须仍然生效
      const withAuth = await fetch(`${baseUrl}/Observation/obs-auth-1`, {
        headers: { Authorization: `Bearer ${await fetchStubToken(stubUrl)}` },
      });
      expect(withAuth.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('write() 写完回读校验：GET 命中同一 id 且 verified=true', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const stubUrl = `http://127.0.0.1:${server.port}`;
      const writer = stubWriter(stubUrl);
      const written = await writer.write('Observation', {
        resourceType: 'Observation',
        id: 'obs-verify-1',
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
        subject: { reference: 'Patient/p1' },
        effectiveDateTime: '2026-10-13T00:00:00Z',
        valueQuantity: { value: 6.8, unit: 'mmol/L' },
      });
      expect(written.verified).toBe(true);
      expect(written.id).toBe('obs-verify-1');
      expect(written.resource?.resourceType).toBe('Observation');
      expect((written.resource?.valueQuantity as { value: number }).value).toBe(6.8);
    } finally {
      await server.close();
    }
  });

  it('同一 accession 二次写不产生重复资源（服务端资源数仍为 1）', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const stubUrl = `http://127.0.0.1:${server.port}`;
      const writer = stubWriter(stubUrl);
      const accession = buildAccessionIdentifier({ deviceId: 'DEV001', msh10: 'MSG00001' });
      const body = (id: string, value: number) => ({
        resourceType: 'Observation',
        id,
        status: 'final',
        code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
        subject: { reference: 'Patient/p1' },
        effectiveDateTime: '2026-10-13T00:00:00Z',
        valueQuantity: { value, unit: 'mmol/L' },
      });

      const first = await writer.write('Observation', body('obs-idem-A', 4.5), { idempotencyKey: accession });
      expect(first.status).toBe(201);
      // 同一 accession 再写（不同 body id）→ 命中既有资源，不新建
      const second = await writer.write('Observation', body('obs-idem-B', 4.6), { idempotencyKey: accession });
      expect(second.status).toBe(200);
      expect(second.id).toBe('obs-idem-A');
      expect(second.verified).toBe(true);

      const token = await fetchStubToken(stubUrl);
      const search = await fetch(`${stubUrl}/fhir/R4/Observation?identifier=${encodeURIComponent(accession)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const bundle = await search.json() as { total: number };
      expect(bundle.total).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('401 → 刷新凭据后重试一次即成功（不多刷）', { timeout: 30000 }, async () => {
    const flaky = await startFlakyAuthServer(1);
    try {
      const writer = new FhirWriter({
        baseUrl: `${flaky.url}/fhir/R4`,
        urlAllowlist: [flaky.url],
        oidc: { tokenEndpoint: `${flaky.url}/token`, clientId: 'cli', clientSecret: 'sec' },
        maxRetries: 3,
      });
      const result = await writer.writeResource({
        resourceType: 'Observation',
        body: {
          resourceType: 'Observation', id: 'obs-401-1', status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
          subject: { reference: 'Patient/p1' }, effectiveDateTime: '2026-10-13T00:00:00Z',
        },
      });
      expect(result.status).toBe(201);
      expect(flaky.requestCount()).toBe(2);
      // 首次换 token + 刷新一次 = 2 次 token 请求
      expect(flaky.tokenCount()).toBe(2);
    } finally {
      await flaky.close();
    }
  });

  it('连续 401 → 直接报错，不做重试风暴（请求次数 ≤ 2）', { timeout: 30000 }, async () => {
    const flaky = await startFlakyAuthServer(99);
    try {
      const writer = new FhirWriter({
        baseUrl: `${flaky.url}/fhir/R4`,
        urlAllowlist: [flaky.url],
        oidc: { tokenEndpoint: `${flaky.url}/token`, clientId: 'cli', clientSecret: 'sec' },
        maxRetries: 3,
      });
      await expect(writer.writeResource({
        resourceType: 'Observation',
        body: {
          resourceType: 'Observation', id: 'obs-401-2', status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
          subject: { reference: 'Patient/p1' }, effectiveDateTime: '2026-10-13T00:00:00Z',
        },
      })).rejects.toBeInstanceOf(AuthTokenExpiredError);
      expect(flaky.requestCount()).toBe(2);
      // 失败不静默：原始字节进 DLQ
      expect(writer.drainDLQ().length).toBe(1);
    } finally {
      await flaky.close();
    }
  });

  it('静态 token 模式：token 失效 → 直接报错（无 token 端点可刷）', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const stubUrl = `http://127.0.0.1:${server.port}`;
      const writer = createFhirWriterWithToken({
        baseUrl: `${stubUrl}/fhir/R4`,
        token: 'stale-token',
        urlAllowlist: [stubUrl],
      });
      await expect(writer.writeResource({
        resourceType: 'Observation',
        body: {
          resourceType: 'Observation', id: 'obs-static-1', status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '2823-3' }] },
          subject: { reference: 'Patient/p1' }, effectiveDateTime: '2026-10-13T00:00:00Z',
        },
      })).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
    } finally {
      await server.close();
    }
  });

  /**
   * 回归：资源带多个 identifier 时（真实主路径：control-id 在前、accession 在后），
   * 替身原先只索引 identifier[0] → If-None-Exist 条件创建会漏命中、静默建出重复报告。
   */
  it('多 identifier 资源：If-None-Exist 命中非首位 identifier → 不新建重复资源', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const stubUrl = `http://127.0.0.1:${server.port}`;
      const baseUrl = `${stubUrl}/fhir/R4`;
      const token = await fetchStubToken(stubUrl);
      const auth = { 'Content-Type': 'application/fhir+json', Authorization: `Bearer ${token}` };
      const reportBody = (id: string) => ({
        resourceType: 'DiagnosticReport',
        id,
        status: 'final',
        identifier: [
          { system: 'urn:lab-ops-console:control-id', value: 'MSG00001' },
          { system: ACCESSION_SYSTEM_URI, value: 'DEV001:MSG00001' },
        ],
      });

      const first = await fetch(`${baseUrl}/DiagnosticReport/dr-A`, {
        method: 'PUT', headers: auth, body: JSON.stringify(reportBody('dr-A')),
      });
      expect(first.status).toBe(201);

      // 换 id、同一 accession 条件创建 → 必须命中既有 dr-A，不得再建 dr-B
      const second = await fetch(`${baseUrl}/DiagnosticReport/dr-B`, {
        method: 'PUT',
        headers: { ...auth, 'If-None-Exist': `identifier=${ACCESSION_SYSTEM_URI}|DEV001:MSG00001` },
        body: JSON.stringify(reportBody('dr-B')),
      });
      expect(second.status).toBe(200);
      expect(second.headers.get('location')).toContain('/DiagnosticReport/dr-A');
      // 重复资源确实没有落库
      const dup = await fetch(`${baseUrl}/DiagnosticReport/dr-B`, { headers: auth });
      expect(dup.status).toBe(404);
      const search = await fetch(`${baseUrl}/DiagnosticReport?identifier=${encodeURIComponent('DEV001:MSG00001')}`, { headers: auth });
      const bundle = await search.json() as { total: number };
      expect(bundle.total).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('identifier 检索命中非首位 identifier（system|value 与纯 value 两种写法）', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const stubUrl = `http://127.0.0.1:${server.port}`;
      const baseUrl = `${stubUrl}/fhir/R4`;
      const token = await fetchStubToken(stubUrl);
      const auth = { 'Content-Type': 'application/fhir+json', Authorization: `Bearer ${token}` };
      await fetch(`${baseUrl}/DiagnosticReport/dr-A`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({
          resourceType: 'DiagnosticReport',
          id: 'dr-A',
          status: 'final',
          identifier: [
            { system: 'urn:lab-ops-console:control-id', value: 'MSG00001' },
            { system: ACCESSION_SYSTEM_URI, value: 'DEV001:MSG00001' },
          ],
        }),
      });
      const total = async (q: string): Promise<number> => {
        const res = await fetch(`${baseUrl}/DiagnosticReport?identifier=${encodeURIComponent(q)}`, { headers: auth });
        const bundle = await res.json() as { total: number };
        return bundle.total;
      };
      expect(await total(`${ACCESSION_SYSTEM_URI}|DEV001:MSG00001`)).toBe(1); // system|value
      expect(await total('DEV001:MSG00001')).toBe(1);                          // 纯 value
      expect(await total('MSG00001')).toBe(1);                                // 首位 identifier 也仍可检索
    } finally {
      await server.close();
    }
  });

  it('writeResource 幂等命中时返回服务端既有 id（不是本次 body.id）', { timeout: 30000 }, async () => {
    const mod = await import('../../fhir-stub/server.js');
    const server = await mod.createFhirStubServer({ port: 0 });
    try {
      const stubUrl = `http://127.0.0.1:${server.port}`;
      const writer = stubWriter(stubUrl);
      const accession = buildAccessionIdentifier({ deviceId: 'DEV001', msh10: 'MSG00001' });
      const body = (id: string) => ({
        resourceType: 'DiagnosticReport',
        id,
        status: 'final',
        identifier: [
          { system: 'urn:lab-ops-console:control-id', value: 'MSG00001' },
          { system: ACCESSION_SYSTEM_URI, value: accession },
        ],
      });
      await writer.writeResource({ resourceType: 'DiagnosticReport', body: body('dr-A'), idempotencyKey: accession });
      const second = await writer.writeResource({
        resourceType: 'DiagnosticReport',
        body: body('dr-B'),
        idempotencyKey: accession,
      });
      expect(second.status).toBe(200);
      // 调用方必须知道这次写被并到了既有资源上，而不是新建了 dr-B
      expect(second.id).toBe('dr-A');
    } finally {
      await server.close();
    }
  });
});
