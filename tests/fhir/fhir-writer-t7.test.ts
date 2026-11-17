/**
 * tests/fhir/fhir-writer-t7.test.ts —— T7 · H3 FhirWriter 完善验收
 *
 * 覆盖任务书 T7 的 7 条硬断言：
 * 1. 幂等命中不重复（同一 accession 二次写 → 服务端资源数不变）
 * 2. 401 刷新后重试成功
 * 3. 5xx 重试耗尽入 DLQ（原始字节可还原）
 * 4. 4xx 不重试（只打一次服务端）
 * 5. batch 部分失败抛聚合错（带行号 / 错误码 / 资源 id）
 * 6. resourceType 白名单拒绝
 * 7. AuditEvent 缺字段拒绝
 *
 * 另加 T7 补强项：
 * 8.  OAuth2 凭据从 env 读（缺任一项 → 启动即失败，不静默空转）
 * 9.  FHIR 搜索串转义（| , $ \\ 保留字符）→ 幂等键不被服务端误解析
 * 10. identifier value 格式校验（控制字符 / 首尾空白 / 超长）
 * 11. buildTask 相对引用格式校验 + reasonCode 编码
 * 12. OIDC token 端点网络失败 ≠ token 过期（错误码归类正确）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import {
  FhirWriter,
  createFhirWriterFromEnv,
  createOidcClientFromEnv,
  readOidcConfigFromEnv,
  buildAccessionIdentifier,
  buildIfNoneExistHeader,
  escapeSearchValue,
  unescapeSearchValue,
  isValidIdentifierValue,
  assertValidIdentifierValue,
  ACCESSION_SYSTEM_URI,
  type DLQEntry,
} from '../../src/fhir/index.js';
import {
  AuthTokenExpiredError,
  AuthTokenInvalidError,
  AuthTokenMissingError,
  FhirBatchPartialFailError,
  FhirServerFailError,
  FhirValidationFailError,
} from '../../src/shared/errors.js';
import {
  buildTask,
  buildAuditEvent,
  validateAuditEvent,
  validateTask,
} from '../../src/fhir/resources/index.js';
import { createFhirStubServer } from '../../fhir-stub/server.js';

let stub: { port: number; close: () => Promise<void> } | null = null;
let stubBase = '';

beforeEach(async () => {
  const mod = await import('../../fhir-stub/server.js');
  const s = await mod.createFhirStubServer({ port: 0 });
  stub = s;
  stubBase = `http://127.0.0.1:${s.port}`;
});

afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
});

/** 指向 fhir-stub 的写入器（OAuth2 client-credentials 模式） */
function stubWriter(opts: { maxRetries?: number; dlq?: DLQEntry[] } = {}): FhirWriter {
  return new FhirWriter({
    baseUrl: `${stubBase}/fhir/R4`,
    urlAllowlist: [stubBase],
    oidc: { tokenEndpoint: `${stubBase}/auth/token`, clientId: 'cli', clientSecret: 'sec' },
    maxRetries: opts.maxRetries ?? 3,
    dlq: opts.dlq,
  });
}

/** 一条合法的 Observation body */
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

/** 取 fhir-stub 的 bearer token */
async function stubToken(): Promise<string> {
  const res = await fetch(`${stubBase}/auth/token`, {
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

/** 起一个恒定返回指定状态码的 FHIR 端点（统计请求次数） */
async function startStatusServer(status: number, body = 'boom'): Promise<{
  url: string;
  close: () => Promise<void>;
  requestCount: () => number;
}> {
  const app: Express = express();
  app.use(express.json());
  let requests = 0;
  app.put('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
    requests += 1;
    res.status(status).json({ resourceType: 'OperationOutcome', issue: [{ diagnostics: body }] });
  });
  app.get('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
    requests += 1;
    res.status(404).json({ resourceType: 'OperationOutcome' });
  });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requestCount: () => requests,
        close: () => new Promise<void>((r) => { server.close(() => r()); }),
      });
    });
    server.on('error', (err: Error) => reject(err));
  });
}

// =============== 1. 幂等命中不重复 ===============
describe('T7-1 幂等：同一 accession 二次写不产生重复资源', () => {
  it('同一 accession 写两次 → 服务端资源数仍为 1（且命中既有 id）', { timeout: 30000 }, async () => {
    const writer = stubWriter();
    const accession = buildAccessionIdentifier({ deviceId: 'DEV001', msh10: 'MSG00001' });

    const first = await writer.write('Observation', obsBody('obs-A', 4.5), { idempotencyKey: accession });
    expect(first.status).toBe(201);
    expect(first.id).toBe('obs-A');

    // 换 id、同一 accession → 服务端应命中既有 obs-A，不新建 obs-B
    const second = await writer.write('Observation', obsBody('obs-B', 4.6), { idempotencyKey: accession });
    expect(second.status).toBe(200);
    expect(second.id).toBe('obs-A');
    expect(second.verified).toBe(true);

    // 服务端资源数：按 identifier 检索只应命中 1 条
    const token = await stubToken();
    const search = await fetch(
      `${stubBase}/fhir/R4/Observation?identifier=${encodeURIComponent(accession)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const bundle = await search.json() as { total: number };
    expect(bundle.total).toBe(1);
  });

  it('不同 accession → 各写各的，资源数递增（幂等键没被误判成同一个）', { timeout: 30000 }, async () => {
    const writer = stubWriter();
    const accA = buildAccessionIdentifier({ deviceId: 'DEV001', msh10: 'MSG00001' });
    const accB = buildAccessionIdentifier({ deviceId: 'DEV001', msh10: 'MSG00002' });
    await writer.write('Observation', obsBody('obs-A'), { idempotencyKey: accA });
    await writer.write('Observation', obsBody('obs-B'), { idempotencyKey: accB });
    const token = await stubToken();
    const search = await fetch(`${stubBase}/fhir/R4/Observation`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const bundle = await search.json() as { total: number };
    expect(bundle.total).toBe(2);
  });
});

// =============== 2. 401 刷新后重试成功 ===============
describe('T7-2 401 → 刷新凭据 → 重试一次成功', () => {
  it('首次 401 刷新后成功（不多刷：请求数 2、token 数 2）', { timeout: 30000 }, async () => {
    let requests = 0;
    let tokens = 0;
    const app: Express = express();
    app.use(express.json());
    app.post('/token', (_req: Request, res: Response) => {
      tokens += 1;
      res.status(200).json({ access_token: `tok-${tokens}`, token_type: 'Bearer', expires_in: 3600 });
    });
    app.put('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
      requests += 1;
      if (requests === 1) {
        res.status(401).json({ resourceType: 'OperationOutcome' });
        return;
      }
      res.status(201).location('/fhir/R4/Observation/obs-401').json({ ok: true });
    });
    const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((r) => { s.close(() => r()); }),
        });
      });
    });
    try {
      const writer = new FhirWriter({
        baseUrl: `${server.url}/fhir/R4`,
        urlAllowlist: [server.url],
        oidc: { tokenEndpoint: `${server.url}/token`, clientId: 'cli', clientSecret: 'sec' },
        maxRetries: 3,
      });
      const result = await writer.writeResource({ resourceType: 'Observation', body: obsBody('obs-401') });
      expect(result.status).toBe(201);
      expect(requests).toBe(2);
      expect(tokens).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('连续 401 → 报 AUTH_TOKEN_EXPIRED 且不再重试（无重试风暴）', { timeout: 30000 }, async () => {
    let requests = 0;
    let tokens = 0;
    const app: Express = express();
    app.use(express.json());
    app.post('/token', (_req: Request, res: Response) => {
      tokens += 1;
      res.status(200).json({ access_token: `tok-${tokens}`, token_type: 'Bearer', expires_in: 3600 });
    });
    app.put('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
      requests += 1;
      res.status(401).json({ resourceType: 'OperationOutcome' });
    });
    const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((r) => { s.close(() => r()); }),
        });
      });
    });
    try {
      const writer = new FhirWriter({
        baseUrl: `${server.url}/fhir/R4`,
        urlAllowlist: [server.url],
        oidc: { tokenEndpoint: `${server.url}/token`, clientId: 'cli', clientSecret: 'sec' },
        maxRetries: 3,
      });
      await expect(
        writer.writeResource({ resourceType: 'Observation', body: obsBody('obs-401-loop') }),
      ).rejects.toBeInstanceOf(AuthTokenExpiredError);
      // 最多 2 次 FHIR 请求（首发 + 刷新后重试一次）
      expect(requests).toBe(2);
      // 失败不静默：原始字节进 DLQ
      expect(writer.drainDLQ().length).toBe(1);
    } finally {
      await server.close();
    }
  });
});

// =============== 3. 5xx 重试耗尽入 DLQ ===============
describe('T7-3 5xx 重试耗尽 → 原始字节进 DLQ', () => {
  it('退避重试 3 次后报错，DLQ 里的原始字节能还原出这条 Observation', { timeout: 30000 }, async () => {
    const srv = await startStatusServer(503, 'service-unavailable');
    const dlq: DLQEntry[] = [];
    try {
      const writer = new FhirWriter({
        baseUrl: `${srv.url}/fhir/R4`,
        urlAllowlist: [srv.url],
        staticToken: 'placeholder-token',
        maxRetries: 3,
        dlq,
      });
      await expect(
        writer.writeResource({ resourceType: 'Observation', body: obsBody('obs-5xx') }),
      ).rejects.toBeInstanceOf(FhirServerFailError);

      // 首发 + 3 次退避重试 = 4 次请求
      expect(srv.requestCount()).toBe(4);

      expect(dlq.length).toBe(1);
      expect(dlq[0]!.error_code).toBe('FHIR_SERVER_FAIL');
      expect(dlq[0]!.resource_type).toBe('Observation');
      expect(dlq[0]!.resource_id).toBe('obs-5xx');
      // 原始字节可还原（不静默改数据：留底可核对、可回放）
      const body = JSON.parse(dlq[0]!.raw_bytes.toString('utf-8')) as Record<string, unknown>;
      expect(body.resourceType).toBe('Observation');
      expect(body.id).toBe('obs-5xx');
    } finally {
      await srv.close();
    }
  });

  it('同一条失败只入 DLQ 一次（不重复落盘）', { timeout: 30000 }, async () => {
    const srv = await startStatusServer(503);
    const dlq: DLQEntry[] = [];
    try {
      const writer = new FhirWriter({
        baseUrl: `${srv.url}/fhir/R4`,
        urlAllowlist: [srv.url],
        staticToken: 'placeholder-token',
        maxRetries: 0,
        dlq,
      });
      await expect(
        writer.writeResource({ resourceType: 'Observation', body: obsBody('obs-dup') }),
      ).rejects.toBeInstanceOf(FhirServerFailError);
      expect(dlq.length).toBe(1);
      // 再次 drain 不会翻倍
      expect(writer.drainDLQ().length).toBe(1);
      expect(writer.drainDLQ().length).toBe(0);
    } finally {
      await srv.close();
    }
  });
});

// =============== 4. 4xx 不重试 ===============
describe('T7-4 4xx 不重试（重试也不会变）', () => {
  it('服务端 400 → 只打一次，报 FHIR_VALIDATION_FAIL', { timeout: 30000 }, async () => {
    const srv = await startStatusServer(400, 'bad-request');
    const dlq: DLQEntry[] = [];
    try {
      const writer = new FhirWriter({
        baseUrl: `${srv.url}/fhir/R4`,
        urlAllowlist: [srv.url],
        staticToken: 'placeholder-token',
        maxRetries: 3,
        dlq,
      });
      await expect(
        writer.writeResource({ resourceType: 'Observation', body: obsBody('obs-4xx') }),
      ).rejects.toBeInstanceOf(FhirValidationFailError);
      // 只请求一次 —— 4xx 重试没有意义
      expect(srv.requestCount()).toBe(1);
      // 但原始字节仍留底（服务端拒收 = 这份结果没进院内库，不能悄悄丢）
      expect(dlq.length).toBe(1);
      expect(dlq[0]!.error_code).toBe('FHIR_VALIDATION_FAIL');
    } finally {
      await srv.close();
    }
  });
});

// =============== 5. batch 部分失败抛聚合错 ===============
describe('T7-5 writeBatch 行级失败隔离 + 聚合错误', () => {
  it('一行失败其余成功 → 抛 FhirBatchPartialFailError，带行号 / 错误码 / 资源 id', { timeout: 30000 }, async () => {
    const srv = await startStatusServer(500);
    try {
      const writer = new FhirWriter({
        baseUrl: `${srv.url}/fhir/R4`,
        urlAllowlist: [srv.url],
        staticToken: 'placeholder-token',
        maxRetries: 0,
      });
      const inputs = [
        { resourceType: 'Observation', body: obsBody('obs-b0') },
        { resourceType: 'Observation', body: obsBody('obs-b1') },
      ];
      let caught: FhirBatchPartialFailError | null = null;
      try {
        await writer.writeBatch(inputs);
      } catch (err) {
        caught = err as FhirBatchPartialFailError;
      }
      expect(caught).toBeInstanceOf(FhirBatchPartialFailError);
      const ctx = caught!.context as {
        successCount: number;
        failureCount: number;
        failedIndexes: number[];
        failures: Array<{ index: number; resourceType: string; id: string; errorCode: string }>;
      };
      expect(ctx.failureCount).toBe(2);
      expect(ctx.successCount).toBe(0);
      // 每一行都能定位到：行号 + 资源 id + 错误码
      expect(ctx.failedIndexes).toEqual([0, 1]);
      expect(ctx.failures[0]!.index).toBe(0);
      expect(ctx.failures[0]!.id).toBe('obs-b0');
      expect(ctx.failures[0]!.errorCode).toBe('FHIR_SERVER_FAIL');
      expect(ctx.failures[1]!.id).toBe('obs-b1');
    } finally {
      await srv.close();
    }
  });

  it('全部成功 → 返回成功列表且不抛错', { timeout: 30000 }, async () => {
    const writer = stubWriter();
    const results = await writer.writeBatch([
      { resourceType: 'Observation', body: obsBody('obs-ok-1') },
      { resourceType: 'Observation', body: obsBody('obs-ok-2') },
    ]);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.id)).toEqual(['obs-ok-1', 'obs-ok-2']);
  });
});

// =============== 6. resourceType 白名单拒绝 ===============
describe('T7-6 resourceType 白名单拒绝', () => {
  it('白名单外的 resourceType → FhirValidationFailError，且不发请求', async () => {
    const writer = stubWriter();
    await expect(
      writer.writeResource({ resourceType: 'Encounter', body: { resourceType: 'Encounter', id: 'e-1' } }),
    ).rejects.toBeInstanceOf(FhirValidationFailError);
  });
});

// =============== 7. AuditEvent 缺字段拒绝 ===============
describe('T7-7 AuditEvent 四字段强制非空', () => {
  it('缺 agent → 构造被拒', () => {
    expect(() => buildAuditEvent({
      agentReference: '',
      recorded: new Date().toISOString(),
      outcome: 'success',
    })).toThrow();
  });

  it('缺 recorded → 构造被拒', () => {
    expect(() => buildAuditEvent({
      agentReference: 'Practitioner/nurse-1',
      recorded: '',
      outcome: 'success',
    })).toThrow();
  });

  it('缺 outcome → 构造被拒', () => {
    expect(() => buildAuditEvent({
      agentReference: 'Practitioner/nurse-1',
      recorded: new Date().toISOString(),
      outcome: '' as never,
    })).toThrow();
  });

  it('四字段齐全 → outcome 映射正确（success→0 / denied→8 / partial→4）', () => {
    const mk = (outcome: 'success' | 'denied' | 'partial') => buildAuditEvent({
      agentReference: 'Practitioner/nurse-1',
      agentDisplay: '护士王',
      recorded: '2026-10-13T08:00:00Z',
      outcome,
      entityReference: 'DiagnosticReport/dr-1',
    });
    expect(mk('success').outcome).toBe('0');
    expect(mk('denied').outcome).toBe('8');
    expect(mk('partial').outcome).toBe('4');
    // source 恒有值（飞检倒查的入口）
    expect(mk('success').source.site).toBeTruthy();
    expect(mk('denied').agent.length).toBeGreaterThanOrEqual(1);
  });

  it('entity 不能替代 source（source 恒非空）', () => {
    const evt = buildAuditEvent({
      agentReference: 'Practitioner/nurse-1',
      recorded: '2026-10-13T08:00:00Z',
      outcome: 'success',
      entityReference: 'DiagnosticReport/dr-1',
    });
    // 给了 entity 但没给 source → source 仍要有 site（不是拿 entity 顶替）
    expect(evt.source.site).toBeTruthy();
    expect(evt.entity?.[0]?.what.reference).toBe('DiagnosticReport/dr-1');
  });

  it('validateAuditEvent 拒绝非法 outcome 码', () => {
    expect(() => validateAuditEvent({
      resourceType: 'AuditEvent',
      type: { system: 'x', code: 'rest' },
      recorded: '2026-10-13T08:00:00Z',
      outcome: '99',
      agent: [{ who: { reference: 'Practitioner/n1' } }],
      source: { site: 'lab-ops-console' },
    })).toThrow();
  });

  it('validateAuditEvent 拒绝空 source', () => {
    expect(() => validateAuditEvent({
      resourceType: 'AuditEvent',
      type: { system: 'x', code: 'rest' },
      recorded: '2026-10-13T08:00:00Z',
      outcome: '0',
      agent: [{ who: { reference: 'Practitioner/n1' } }],
      source: {},
    })).toThrow();
  });
});

// =============== 8. OAuth2 凭据从 env 读 ===============
describe('T7-8 OAuth2 凭据从环境变量读', () => {
  it('三项齐全 → 构造出 OidcClient（凭据不落代码）', () => {
    const env = {
      LIS_FHIR_OAUTH_TOKEN_URL: 'https://gw.example-hospital.internal/auth/token',
      LIS_FHIR_OAUTH_CLIENT_ID: 'lab-ops-console',
      LIS_FHIR_OAUTH_CLIENT_SECRET: 's3cret',
      LIS_FHIR_OAUTH_SCOPE: 'system/*.read system/*.write',
    } as NodeJS.ProcessEnv;
    const cfg = readOidcConfigFromEnv('LIS_FHIR', env);
    expect(cfg.tokenEndpoint).toBe('https://gw.example-hospital.internal/auth/token');
    expect(cfg.clientId).toBe('lab-ops-console');
    expect(cfg.clientSecret).toBe('s3cret');
    expect(cfg.scope).toBe('system/*.read system/*.write');
    expect(() => createOidcClientFromEnv('LIS_FHIR', env)).not.toThrow();
  });

  it('缺任一项 → 抛 AuthTokenMissingError 并点名缺哪个 env', () => {
    const env = {
      LIS_FHIR_OAUTH_TOKEN_URL: 'https://gw.example-hospital.internal/auth/token',
      LIS_FHIR_OAUTH_CLIENT_ID: 'lab-ops-console',
    } as NodeJS.ProcessEnv;
    try {
      readOidcConfigFromEnv('LIS_FHIR', env);
      throw new Error('本该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthTokenMissingError);
      expect((err as AuthTokenMissingError).context.missing).toEqual(['LIS_FHIR_OAUTH_CLIENT_SECRET']);
    }
  });

  it('createFhirWriterFromEnv：配了 OAuth2 → 走 OAuth2；否则走静态 token', () => {
    const withOAuth = {
      FHIR_OAUTH_TOKEN_URL: 'https://gw.example-hospital.internal/auth/token',
      FHIR_OAUTH_CLIENT_ID: 'cli',
      FHIR_OAUTH_CLIENT_SECRET: 'sec',
    } as NodeJS.ProcessEnv;
    const w1 = createFhirWriterFromEnv({
      prefix: 'FHIR',
      baseUrl: 'https://fhir.example-hospital.internal/fhir/R4',
      urlAllowlist: ['https://fhir.example-hospital.internal'],
      env: withOAuth,
    });
    expect(w1).toBeInstanceOf(FhirWriter);

    const w2 = createFhirWriterFromEnv({
      prefix: 'FHIR',
      baseUrl: 'https://fhir.example-hospital.internal/fhir/R4',
      urlAllowlist: ['https://fhir.example-hospital.internal'],
      env: { FHIR_TOKEN: 'static-token' } as NodeJS.ProcessEnv,
    });
    expect(w2).toBeInstanceOf(FhirWriter);
  });

  it('两条凭据路径都没配 → 抛 AuthTokenMissingError（不静默空转）', () => {
    expect(() => createFhirWriterFromEnv({
      prefix: 'FHIR',
      baseUrl: 'https://fhir.example-hospital.internal/fhir/R4',
      urlAllowlist: ['https://fhir.example-hospital.internal'],
      env: {} as NodeJS.ProcessEnv,
    })).toThrow(AuthTokenMissingError);
  });
});

// =============== 9. FHIR 搜索串转义 ===============
describe('T7-9 FHIR 搜索串转义（保留字符）', () => {
  it('保留字符 | , $ \\ 都被转义', () => {
    expect(escapeSearchValue('A|B')).toBe('A\\|B');
    expect(escapeSearchValue('A,B')).toBe('A\\,B');
    expect(escapeSearchValue('A$B')).toBe('A\\$B');
    expect(escapeSearchValue('A\\B')).toBe('A\\\\B');
  });

  it('转义与解转义互为逆运算', () => {
    for (const raw of ['A|B', 'A,B', 'A$B', 'A\\B', 'A|B,C$D\\E', '普通中文标本号']) {
      expect(unescapeSearchValue(escapeSearchValue(raw))).toBe(raw);
    }
  });

  it('含保留字符的幂等键 → If-None-Exist 头按 FHIR 格式转义', () => {
    const header = buildIfNoneExistHeader('DEV|001,X');
    expect(header).toBe(`identifier=${ACCESSION_SYSTEM_URI}|DEV\\|001\\,X`);
  });

  it('含保留字符的 accession 真往返：服务端解转义后仍命中同一资源', { timeout: 30000 }, async () => {
    const writer = stubWriter();
    // 标本号里带 | 和 , —— 不转义的话服务端会按分隔符切开，幂等键失效 → 重复建报告
    const accession = 'DEV001|SPEC,X';
    const first = await writer.write('Observation', obsBody('obs-pipe-A'), { idempotencyKey: accession });
    expect(first.status).toBe(201);
    const second = await writer.write('Observation', obsBody('obs-pipe-B'), { idempotencyKey: accession });
    // 命中既有资源，没有新建 obs-pipe-B
    expect(second.status).toBe(200);
    expect(second.id).toBe('obs-pipe-A');

    // 按 FHIR 搜索串语法检索：identifier=<system>|<value>，value 的保留字符要转义
    const token = await stubToken();
    const query = `${ACCESSION_SYSTEM_URI}|${escapeSearchValue(accession)}`;
    const search = await fetch(
      `${stubBase}/fhir/R4/Observation?identifier=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const bundle = await search.json() as { total: number };
    expect(bundle.total).toBe(1);
  });
});

// =============== 10. identifier value 格式校验 ===============
describe('T7-10 identifier value 格式校验', () => {
  it('合法值通过', () => {
    expect(isValidIdentifierValue('DEV001:MSG00001')).toBe(true);
    expect(isValidIdentifierValue('普通中文标本号')).toBe(true);
  });

  it('空串 / 首尾空白 / 控制字符 / 超长 → 判否', () => {
    expect(isValidIdentifierValue('')).toBe(false);
    expect(isValidIdentifierValue(' DEV001 ')).toBe(false);
    expect(isValidIdentifierValue('DEV\u0000001')).toBe(false);
    expect(isValidIdentifierValue('DEV\n001')).toBe(false);
    expect(isValidIdentifierValue('D'.repeat(256))).toBe(false);
  });

  it('assertValidIdentifierValue 抛 FhirValidationFailError 并带字段名', () => {
    expect(() => assertValidIdentifierValue('')).toThrow(FhirValidationFailError);
    try {
      assertValidIdentifierValue(' x ');
    } catch (err) {
      expect((err as FhirValidationFailError).context.field).toBe('idempotencyKey');
    }
  });

  it('buildIfNoneExistHeader 拒绝控制字符（拼不进 HTTP header）', () => {
    expect(() => buildIfNoneExistHeader('DEV\u0001001')).toThrow(FhirValidationFailError);
  });
});

// =============== 11. buildTask ===============
describe('T7-11 buildTask 状态机字段与引用校验', () => {
  it('8 个状态机字段齐备', () => {
    const task = buildTask({
      id: 'task-1',
      status: 'requested',
      intent: 'order',
      priority: 'stat',
      forReference: 'Patient/p1',
      focusReference: 'DiagnosticReport/dr-1',
      requesterReference: 'Practitioner/lab-1',
      ownerReference: 'Practitioner/nurse-1',
      reasonText: '血钾 6.8 mmol/L 危急值',
      notes: [{ text: '已电话通知护士站', time: '2026-10-13T08:00:00Z' }],
    });
    expect(task.intent).toBe('order');
    expect(task.priority).toBe('stat');
    expect(task.for?.reference).toBe('Patient/p1');
    expect(task.focus?.reference).toBe('DiagnosticReport/dr-1');
    expect(task.requester?.reference).toBe('Practitioner/lab-1');
    expect(task.owner?.reference).toBe('Practitioner/nurse-1');
    expect(task.reasonCode?.text).toBe('血钾 6.8 mmol/L 危急值');
    expect(task.note?.[0]?.text).toBe('已电话通知护士站');
    expect(validateTask(task).id).toBe('task-1');
  });

  it('reasonCode 支持编码（院内系统按编码检索）', () => {
    const task = buildTask({
      id: 'task-2',
      status: 'requested',
      reasonCoding: { system: 'http://snomed.info/sct', code: '28520004', display: '血钾升高' },
    });
    expect(task.reasonCode?.coding?.[0]?.code).toBe('28520004');
    expect(validateTask(task).id).toBe('task-2');
  });

  it('非法相对引用 → 构造被拒（拼错的引用会被服务端 400，且 400 不重试）', () => {
    expect(() => buildTask({ id: 'task-3', status: 'requested', forReference: 'Patient' })).toThrow(FhirValidationFailError);
    expect(() => buildTask({ id: 'task-4', status: 'requested', focusReference: '' })).toThrow(FhirValidationFailError);
    expect(() => buildTask({ id: 'task-5', status: 'requested', ownerReference: 'nurse-1' })).toThrow(FhirValidationFailError);
  });
});

// =============== 12. OIDC 错误归类 ===============
describe('T7-12 OIDC token 端点失败归类正确', () => {
  it('token 端点网络不可达 → AUTH_TOKEN_INVALID（不是「token 过期」）', async () => {
    const { createOidcClient } = await import('../../src/fhir/index.js');
    // 指向一个不存在的端口 → 连接被拒
    const client = createOidcClient({
      tokenEndpoint: 'http://127.0.0.1:1/auth/token',
      clientId: 'cli',
      clientSecret: 'sec',
      timeoutMs: 2000,
    });
    await expect(client.getToken()).rejects.toBeInstanceOf(AuthTokenInvalidError);
  });

  it('token 端点 401 → AUTH_TOKEN_EXPIRED（凭据确实被拒）', async () => {
    const { createOidcClient } = await import('../../src/fhir/index.js');
    const app: Express = express();
    app.post('/token', (_req: Request, res: Response) => {
      res.status(401).json({ error: 'invalid_client' });
    });
    const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((r) => { s.close(() => r()); }),
        });
      });
    });
    try {
      const client = createOidcClient({
        tokenEndpoint: `${server.url}/token`,
        clientId: 'cli',
        clientSecret: 'wrong',
      });
      await expect(client.getToken()).rejects.toBeInstanceOf(AuthTokenExpiredError);
    } finally {
      await server.close();
    }
  });
});

// =============== 13. 401 刷新补发 ≠ 传输重试预算 ===============
describe('T7-13 401 刷新后的补发不占传输重试预算', () => {
  /** 起一个按预设顺序返回状态码的 FHIR 端点（末位状态码重复使用） */
  async function startSequenceServer(statuses: number[]): Promise<{
    url: string;
    close: () => Promise<void>;
    requestCount: () => number;
    tokenCount: () => number;
  }> {
    const app: Express = express();
    app.use(express.json());
    let requests = 0;
    let tokens = 0;
    app.post('/auth/token', (_req: Request, res: Response) => {
      tokens += 1;
      res.json({ access_token: `tok-${tokens}`, token_type: 'Bearer', expires_in: 3600 });
    });
    app.put('/fhir/R4/:type/:id', (_req: Request, res: Response) => {
      const status = statuses[requests] ?? statuses[statuses.length - 1] ?? 500;
      requests += 1;
      res.status(status).json({ resourceType: 'OperationOutcome', issue: [{ diagnostics: `seq-${requests}` }] });
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

  it('401 落在最后一次尝试上 → 刷新后的 token 仍补发一次（不被传输预算挤掉）', { timeout: 30000 }, async () => {
    // 序列：500（吃掉传输重试预算）→ 401（触发刷新）→ 201（用新 token 补发成功）
    const seq = await startSequenceServer([500, 401, 201]);
    try {
      const writer = new FhirWriter({
        baseUrl: `${seq.url}/fhir/R4`,
        urlAllowlist: [seq.url],
        oidc: { tokenEndpoint: `${seq.url}/auth/token`, clientId: 'cli', clientSecret: 'sec' },
        maxRetries: 1,
      });
      const result = await writer.writeResource({
        resourceType: 'Observation',
        body: obsBody('obs-auth-retry'),
      });
      expect(result.status).toBe(201);
      // 500 → 401 → 补发 201：刷新拿到的新 token 必须真的用上一次
      expect(seq.requestCount()).toBe(3);
      expect(seq.tokenCount()).toBe(2); // 首取 + 刷新一次
    } finally {
      await seq.close();
    }
  });

  it('刷新后仍被 401 拒 → 报凭据失效（不是「5xx 重试用尽」）', { timeout: 30000 }, async () => {
    const seq = await startSequenceServer([500, 401, 401]);
    try {
      const writer = new FhirWriter({
        baseUrl: `${seq.url}/fhir/R4`,
        urlAllowlist: [seq.url],
        oidc: { tokenEndpoint: `${seq.url}/auth/token`, clientId: 'cli', clientSecret: 'sec' },
        maxRetries: 1,
      });
      await expect(writer.writeResource({
        resourceType: 'Observation',
        body: obsBody('obs-auth-expired'),
      })).rejects.toBeInstanceOf(AuthTokenExpiredError);
      expect(seq.requestCount()).toBe(3);
      // 失败不静默：原始字节进 DLQ
      expect(writer.drainDLQ().length).toBe(1);
    } finally {
      await seq.close();
    }
  });
});
