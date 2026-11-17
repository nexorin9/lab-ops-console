/**
 * fhir-stub/server.ts —— 本地 FHIR R4 替身服务（仅供测试与本地联调使用）
 *
 * 设计原则：
 * - 与生产端点对齐：PUT/POST/GET /fhir/R4/{type}/{id} + Search /fhir/R4/{type}?xxx=yyy
 * - 带 OAuth2 client-credentials token 端点（/auth/token）+ bearer 校验：
 *   院内网关就是「先换 token 再带 bearer 调 FHIR」，替身要复刻这条，否则测不出凭据问题
 * - 持久化到内存 better-sqlite3（:memory:），与生产库隔离 —— 重启即清空
 * - 仅在测试代码与本地手工验证时启动；产品代码不得依赖 fhir-stub
 * - resource type 白名单：Patient / Practitioner / Observation / DiagnosticReport /
 *   Specimen / Device / Task / AuditEvent
 * - PUT 走 upsert（同 id 再写 = 更新，200），符合 FHIR R4「按 id 幂等更新」语义
 * - 命中 If-None-Exist 且同 accession 已存在 → 返回 200 + 既有 ID（幂等成功，不新建）
 *
 * 启动：
 *   npx tsx fhir-stub/server.ts
 *   FHIR_STUB_PORT=9999 npx tsx fhir-stub/server.ts
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import Database from 'better-sqlite3';

const ALLOWED_TYPES = new Set([
  'Patient', 'Practitioner', 'Observation', 'DiagnosticReport',
  'Specimen', 'Device', 'Task', 'AuditEvent',
]);

const DEFAULT_PORT = Number(process.env.FHIR_STUB_PORT ?? 9999);

export interface FHIRStubServer {
  port: number;
  close(): Promise<void>;
  /** 测试用：签发的 token 是否有效 */
  isTokenValid(token: string): boolean;
}

export function createFhirStubServer(opts: { port?: number; log?: boolean; requireAuth?: boolean } = {}): Promise<FHIRStubServer> {
  return new Promise((resolve, reject) => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS fhir_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        identifier_system TEXT,
        identifier_value TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(resource_type, resource_id)
      );
      CREATE INDEX IF NOT EXISTS idx_fhir_type ON fhir_resources(resource_type);
      CREATE INDEX IF NOT EXISTS idx_fhir_identifier ON fhir_resources(identifier_system, identifier_value);
      -- 一个资源可带多个 identifier（FHIR R4：identifier 是 0..n）
      -- 条件创建（If-None-Exist）与 identifier 检索都按「任一 identifier 命中」语义，
      -- 只索引 identifier[0] 会漏掉后续 identifier（accession 常排在 control-id 之后）
      CREATE TABLE IF NOT EXISTS fhir_identifiers (
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        system TEXT,
        value TEXT,
        PRIMARY KEY (resource_type, resource_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_fhir_identifier_lookup ON fhir_identifiers(resource_type, value);
    `);

    const app: Express = express();
    app.use(express.json({ limit: '10mb', type: ['application/json', 'application/fhir+json', 'application/*+json'] }));
    app.use(express.urlencoded({ extended: false, limit: '1mb' }));

    const log = opts.log === true;
    const requireAuth = opts.requireAuth !== false;
    const validTokens = new Set<string>();
    let tokenCounter = 0;

    const stubLogger = (req: Request, _res: Response, next: NextFunction): void => {
      if (log) {
        process.stdout.write(`[fhir-stub] ${req.method} ${req.path}\n`);
      }
      next();
    };
    app.use(stubLogger);

    // ---- OAuth2 client-credentials token 端点（院内网关同款）----
    app.post('/auth/token', (req: Request, res: Response) => {
      const basic = req.get('Authorization');
      if (!basic || !basic.startsWith('Basic ')) {
        res.status(401).json({ error: 'invalid_client', error_description: '缺少 Basic 凭据' });
        return;
      }
      const grantType = (req.body as { grant_type?: string } | undefined)?.grant_type;
      if (grantType && grantType !== 'client_credentials') {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
      }
      tokenCounter += 1;
      const token = `stub-token-${tokenCounter}`;
      validTokens.add(token);
      res.status(200).json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'system/*.read system/*.write',
      });
    });

    // ---- bearer 校验（复刻院内网关的鉴权边界）----
    const requireBearer = (req: Request, res: Response, next: NextFunction): void => {
      if (!requireAuth) {
        next();
        return;
      }
      const header = req.get('Authorization');
      const token = header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      if (!token || !validTokens.has(token)) {
        res.status(401).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'login', diagnostics: '缺少或无效的 bearer token' }],
        });
        return;
      }
      next();
    };

    const readIdentifiers = (body: Record<string, unknown>): Array<{ system?: string; value?: string }> =>
      Array.isArray(body.identifier)
        ? (body.identifier as unknown[]).filter(
            (e): e is { system?: string; value?: string } => !!e && typeof e === 'object',
          )
        : [];

    /** 资源的主 identifier（第一个）—— 仅用于 fhir_resources 的冗余列 */
    const primaryIdentifier = (body: Record<string, unknown>): { system?: string; value?: string } | undefined =>
      readIdentifiers(body)[0];

    /**
     * 全量重建该资源的 identifier 索引（写路径统一走这里）
     * —— 资源可带多个 identifier，条件创建与检索都按「任一命中」处理
     */
    const syncIdentifiers = (type: string, id: string, body: Record<string, unknown>): void => {
      db.prepare('DELETE FROM fhir_identifiers WHERE resource_type = ? AND resource_id = ?').run(type, id);
      const list = readIdentifiers(body);
      const ins = db.prepare(
        'INSERT INTO fhir_identifiers (resource_type, resource_id, ordinal, system, value) VALUES (?, ?, ?, ?, ?)',
      );
      list.forEach((e, idx) => ins.run(type, id, idx, e.system ?? null, e.value ?? null));
    };

    /**
     * FHIR R4 搜索串解转义（服务端侧独立实现）
     *
     * 这里刻意**不复用** src/fhir/idempotency.ts 的 unescapeSearchValue ——
     * 替身按规范独立实现一遍，写回端的转义与服务端的解转义才能真正互为验证；
     * 共用同一个函数的话，写错转义规则时两边一起错，测试会假绿。
     *
     * 规则：反斜杠后跟的字符按字面量取（\| → |、\, → ,、\$ → $、\\ → \）
     */
    const unescapeFhirSearchValue = (value: string): string =>
      value.replace(/\\(.)/g, '$1');

    /**
     * 解析 If-None-Exist 头里的 identifier 条件
     * 形如 identifier=<system>|<value>
     *
     * value 里的保留字符按 FHIR R4 搜索串规则转义（\| \, \$ \\），这里按同样规则解转义。
     * 也容忍只给 value 的简写（不限 system）
     */
    const parseIfNoneExistIdentifier = (header: string): { system?: string; value: string } | null => {
      const m = header.match(/identifier=([^|]+)\|((?:\\.|[^,\s])+)/);
      if (m) {
        return { system: m[1], value: unescapeFhirSearchValue(m[2]) };
      }
      const plain = header.match(/identifier=([^,\s]+)/);
      if (plain) return { value: unescapeFhirSearchValue(plain[1]) };
      return null;
    };

    // ---- PUT / POST /fhir/R4/{type}/{id}：按 id upsert ----
    const upsertHandler = (req: Request, res: Response): void => {
      const type = req.params.type;
      const id = req.params.id;
      if (!ALLOWED_TYPES.has(type)) {
        res.status(400).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported' }] });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.resourceType && body.resourceType !== type) {
        res.status(400).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'invalid', diagnostics: `body.resourceType=${body.resourceType} 与路径 ${type} 不一致` }],
        });
        return;
      }
      if (body.id && body.id !== id) {
        res.status(400).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'invalid', diagnostics: `body.id=${body.id} 与路径 id=${id} 不一致` }],
        });
        return;
      }
      body.resourceType = type;
      body.id = id;

      // If-None-Exist 幂等：命中同 identifier 的既有资源 → 200 + 既有 ID（不新建）
      // 命中口径 = 该资源「任一 identifier」匹配（不只看 identifier[0]）
      const ifNoneExist = req.get('If-None-Exist');
      if (ifNoneExist) {
        const cond = parseIfNoneExistIdentifier(ifNoneExist);
        if (cond) {
          const existing = (cond.system
            ? db.prepare(
                `SELECT DISTINCT r.resource_id AS resource_id
                   FROM fhir_resources r
                   JOIN fhir_identifiers i
                     ON i.resource_type = r.resource_type AND i.resource_id = r.resource_id
                  WHERE r.resource_type = ? AND i.system = ? AND i.value = ? AND r.resource_id <> ?
                  LIMIT 1`,
              ).get(type, cond.system, cond.value, id)
            : db.prepare(
                `SELECT DISTINCT r.resource_id AS resource_id
                   FROM fhir_resources r
                   JOIN fhir_identifiers i
                     ON i.resource_type = r.resource_type AND i.resource_id = r.resource_id
                  WHERE r.resource_type = ? AND i.value = ? AND r.resource_id <> ?
                  LIMIT 1`,
              ).get(type, cond.value, id)) as { resource_id: string } | undefined;
          if (existing) {
            res.status(200)
              .location(`/fhir/R4/${type}/${encodeURIComponent(existing.resource_id)}`)
              .json({ resourceType: type, id: existing.resource_id });
            return;
          }
        }
      }

      const identifier = primaryIdentifier(body);
      const existingRow = db.prepare(
        'SELECT id FROM fhir_resources WHERE resource_type = ? AND resource_id = ?',
      ).get(type, id) as { id: number } | undefined;

      if (existingRow) {
        db.prepare(
          'UPDATE fhir_resources SET identifier_system = ?, identifier_value = ?, body = ? WHERE resource_type = ? AND resource_id = ?',
        ).run(identifier?.system ?? null, identifier?.value ?? null, JSON.stringify(body), type, id);
        syncIdentifiers(type, id, body);
        res.status(200).location(`/fhir/R4/${type}/${encodeURIComponent(id)}`).json(body);
        return;
      }

      try {
        db.prepare(`
          INSERT INTO fhir_resources (resource_type, resource_id, identifier_system, identifier_value, body)
          VALUES (?, ?, ?, ?, ?)
        `).run(type, id, identifier?.system ?? null, identifier?.value ?? null, JSON.stringify(body));
        syncIdentifiers(type, id, body);
        res.status(201).location(`/fhir/R4/${type}/${encodeURIComponent(id)}`).json(body);
      } catch (err) {
        res.status(409).json({
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'duplicate', diagnostics: (err as Error).message }],
        });
      }
    };

    app.put('/fhir/R4/:type/:id', requireBearer, upsertHandler);
    app.post('/fhir/R4/:type/:id', requireBearer, upsertHandler);

    // POST /fhir/R4/{type}：服务端分配 id
    app.post('/fhir/R4/:type', requireBearer, (req: Request, res: Response) => {
      const type = req.params.type;
      if (!ALLOWED_TYPES.has(type)) {
        res.status(400).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported' }] });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = body.id ?? `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      body.id = id;
      body.resourceType = type;
      const identifier = primaryIdentifier(body);
      try {
        db.prepare(`
          INSERT INTO fhir_resources (resource_type, resource_id, identifier_system, identifier_value, body)
          VALUES (?, ?, ?, ?, ?)
        `).run(type, id, identifier?.system ?? null, identifier?.value ?? null, JSON.stringify(body));
        syncIdentifiers(type, id, body);
        res.status(201).location(`/fhir/R4/${type}/${encodeURIComponent(id)}`).json(body);
      } catch {
        res.status(409).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'duplicate' }] });
      }
    });

    // GET /fhir/R4/{type}/{id}
    app.get('/fhir/R4/:type/:id', requireBearer, (req: Request, res: Response) => {
      const type = req.params.type;
      const id = req.params.id;
      if (!ALLOWED_TYPES.has(type)) {
        res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported' }] });
        return;
      }
      const row = db.prepare('SELECT body FROM fhir_resources WHERE resource_type = ? AND resource_id = ?').get(type, id) as { body: string } | undefined;
      if (!row) {
        res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] });
        return;
      }
      res.status(200).type('application/fhir+json').send(row.body);
    });

    // Search /fhir/R4/{type}?...
    app.get('/fhir/R4/:type', requireBearer, (req: Request, res: Response) => {
      const type = req.params.type;
      if (!ALLOWED_TYPES.has(type)) {
        res.status(404).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported' }] });
        return;
      }
      const conditions: string[] = ['resource_type = ?'];
      const params: unknown[] = [type];
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v !== 'string') continue;
        if (k === '_id') { conditions.push('resource_id = ?'); params.push(v); }
        else if (k === 'patient') { conditions.push("body LIKE ?"); params.push(`%"reference":"Patient/${v}"%`); }
        else if (k === 'identifier') {
            // identifier=system|value（精确）或 identifier=value（不限 system）
            // 命中口径：该资源「任一 identifier」匹配（不只看 identifier[0]）
            // value 按 FHIR 搜索串规则解转义（\| \, \$ \\）
            const pipeIdx = v.indexOf('|');
            if (pipeIdx >= 0) {
              const system = v.slice(0, pipeIdx);
              const value = unescapeFhirSearchValue(v.slice(pipeIdx + 1));
              conditions.push(`EXISTS (SELECT 1 FROM fhir_identifiers i
                WHERE i.resource_type = fhir_resources.resource_type
                  AND i.resource_id = fhir_resources.resource_id
                  AND i.system = ? AND i.value = ?)`);
              params.push(system, value);
            } else {
              const value = unescapeFhirSearchValue(v);
              conditions.push(`EXISTS (SELECT 1 FROM fhir_identifiers i
                WHERE i.resource_type = fhir_resources.resource_type
                  AND i.resource_id = fhir_resources.resource_id
                  AND i.value = ?)`);
              params.push(value);
            }
          }
        else if (k === 'status') { conditions.push("body LIKE ?"); params.push(`%"status":"${v}"%`); }
      }
      const sql = `SELECT body FROM fhir_resources WHERE ${conditions.join(' AND ')} LIMIT 50`;
      const rows = db.prepare(sql).all(...params) as Array<{ body: string }>;
      const bundle = {
        resourceType: 'Bundle',
        type: 'searchset',
        total: rows.length,
        entry: rows.map((r) => JSON.parse(r.body)),
      };
      res.status(200).json(bundle);
    });

    // healthcheck（不鉴权）
    app.get('/healthz', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', stub: true });
    });

    // 精确计数接口（压测 / 规模化验收用）—— search 有 LIMIT 50，不能用 total 判断千级落库
    app.get('/fhir/__count', (_req: Request, res: Response) => {
      const rows = db.prepare(
        'SELECT resource_type, COUNT(*) AS n FROM fhir_resources GROUP BY resource_type ORDER BY resource_type',
      ).all() as Array<{ resource_type: string; n: number }>;
      const counts: Record<string, number> = {};
      let total = 0;
      for (const r of rows) { counts[r.resource_type] = Number(r.n); total += Number(r.n); }
      res.status(200).json({ total, counts });
    });

    // 清空接口（测试用）—— 防止多次 run 累积
    app.delete('/fhir/__reset', (_req: Request, res: Response) => {
      db.exec('DELETE FROM fhir_identifiers; DELETE FROM fhir_resources;');
      res.status(200).json({ status: 'reset' });
    });

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      process.stderr.write(`[fhir-stub] error: ${err.message}\n`);
      res.status(500).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: err.message }] });
    });

    const requestedPort = opts.port ?? DEFAULT_PORT;
    const server = app.listen(requestedPort, '127.0.0.1', () => {
      // 取内核真实分配的端口（与 opts.port=0 的实际 port 不同）
      const actualPort = (server.address() as { port: number }).port;
      resolve({
        port: actualPort,
        isTokenValid: (token: string) => validTokens.has(token),
        close: () => new Promise<void>((r) => {
          server.close(() => {
            db.close();
            r();
          });
        }),
      });
    });
    server.on('error', (err: Error) => reject(err));
  });
}

// 入口（手动启动）：npx tsx fhir-stub/server.ts
const isDirectRun = process.argv[1] && process.argv[1].endsWith('server.ts');
if (isDirectRun) {
  createFhirStubServer({ port: Number(process.env.FHIR_STUB_PORT ?? 9999), log: true })
    .then((s) => {
      process.stdout.write(`[fhir-stub] listening on http://127.0.0.1:${s.port}/fhir/R4\n`);
      process.stdout.write(`[fhir-stub] token endpoint: http://127.0.0.1:${s.port}/auth/token\n`);
    })
    .catch((err: Error) => {
      process.stderr.write(`[fhir-stub] failed: ${err.message}\n`);
      process.exit(1);
    });
}
