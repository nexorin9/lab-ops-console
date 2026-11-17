/**
 * Express + ws 同端口网关 —— 面板、大屏、运营接口、实时广播共用一张 HTTP 服务面。
 *
 * 端点：
 *   GET  /healthz                      健康检查
 *   GET  /api/channels                 通道状态（心跳 / 累计帧数 / 最近错误码）
 *   POST /api/channels/:id/reload      单通道热重载
 *   GET  /api/critical                 未完成危急值
 *   POST /api/critical/:id/ack         护士已接收
 *   POST /api/critical/:id/resolve     医生已处置
 *   GET  /api/critical/:id/audit       审计链（飞检倒查）
 *   GET  /api/ledger                   闭环台账（强校验，缺审计字段拒绝出表）
 *   GET  /api/summary                  运行摘要
 *   GET  /api/fhir-debug               FHIR 资源回读调试
 *   POST /api/push/redeliver           人工触发通知补推
 *   POST /api/candidates/:id/accept    采纳模型候选接收人
 *   POST /api/candidates/:id/ignore    忽略模型候选接收人
 *   GET  /critical                     护士站大屏（独立口令）
 *   GET  /                             信息科面板
 *
 * WS 路径 /ws：设备心跳 / 最近样本 / 危急值亮屏 / 已补推 / 断线恢复。
 */

import express, { type Express, type Request, type Response } from 'express';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CriticalStore } from '../critical/store.js';
import type { TaskStateMachine } from '../critical/Task-state-machine.js';
import type { NotificationDispatcher } from '../critical/NotificationDispatcher.js';
import type { CriticalToolRegistry, FhirWritePort, ToolContext } from '../critical/tools/index.js';
import { buildAuditChain, buildLedger, ledgerToCsv, queryDeniedByReason } from '../critical/ledger.js';
import { isBaseError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('gateway.server');

export interface ChannelStatusView {
  id: string;
  type?: string;
  status: string;
  port?: number;
  lastHeartbeatAt?: string | null;
  frameCount?: number;
  lastErrorCode?: string | null;
}

export interface SupervisorLike {
  status(): ChannelStatusView[] | Promise<ChannelStatusView[]>;
  reload(channelId: string): Promise<unknown> | unknown;
}

export interface SummaryLike {
  snapshot(): unknown;
}

export interface RedeliveryLike {
  runOnce(): Promise<unknown> | unknown;
}

export interface CandidateAdoptionLike {
  accept(taskId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  ignore(taskId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  candidatesFor(taskId: string): Promise<unknown[]>;
}

export interface GatewayDeps {
  store: CriticalStore;
  stateMachine: TaskStateMachine;
  tools: CriticalToolRegistry;
  dispatcher: NotificationDispatcher;
  writer?: FhirWritePort;
  supervisor?: SupervisorLike;
  summary?: SummaryLike;
  redelivery?: RedeliveryLike;
  candidateAdoption?: CandidateAdoptionLike;
  wallboardToken?: string;
  staticDir?: string;
  /** UTC 基准时间（测试注入） */
  now?: () => string;
}

export interface GatewayHandle {
  app: Express;
  server: HttpServer;
  wss: WebSocketServer;
  port: number;
  start(port?: number): Promise<number>;
  close(): Promise<void>;
  broadcast(type: string, payload: Record<string, unknown>): number;
  toolContext(): ToolContext;
  /** 延迟绑定（装配期才有 supervisor / 补推 worker / 候选采纳等可选依赖） */
  bind(partial: Partial<GatewayDeps>): void;
}

/** 解析静态资源目录：优先 dist/gateway/static（构建产物），其次源码目录 */
export function resolveStaticDir(explicit?: string): string {
  if (explicit) return explicit;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, 'static'),
    resolve(process.cwd(), 'dist/gateway/static'),
    resolve(process.cwd(), 'src/gateway/static'),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

function monthRange(month?: string, now: () => string = () => new Date().toISOString()): { from: string; to: string } {
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number) as [number, number];
    const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    const to = new Date(Date.UTC(y, m, 1) - 1).toISOString();
    return { from, to };
  }
  const d = new Date(now());
  return {
    from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(),
    to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1).toISOString(),
  };
}

export function createGatewayServer(deps: GatewayDeps): GatewayHandle {
  const app: Express = express();
  app.use(express.json({ limit: '2mb' }));
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const staticDir = resolveStaticDir(deps.staticDir);
  // 可延迟绑定的可选依赖（装配顺序：先起网关，再挂 supervisor / 补推 / 候选采纳）
  const refs = {
    supervisor: deps.supervisor,
    summary: deps.summary,
    redelivery: deps.redelivery,
    candidateAdoption: deps.candidateAdoption,
  };

  const toolContext = (): ToolContext => ({
    store: deps.store,
    stateMachine: deps.stateMachine,
    ...(deps.writer ? { writer: deps.writer } : {}),
    source: 'lab-ops-console',
    ...(deps.now ? { now: deps.now } : {}),
  });

  const broadcast = (type: string, payload: Record<string, unknown>): number => {
    const data = JSON.stringify({ type, ts: deps.now?.() ?? new Date().toISOString(), ...payload });
    let sent = 0;
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      try { client.send(data); sent++; } catch { /* 单个客户端失败不影响广播 */ }
    }
    return sent;
  };

  wss.on('connection', (socket: WebSocket) => {
    socket.send(JSON.stringify({ type: 'connection.ready', ts: new Date().toISOString() }));
  });

  // 让派发器的 WS 通道指向本网关（同端口，不引第二套服务）
  deps.dispatcher.setWsServer({ clients: wss.clients });

  const fail = (res: Response, err: unknown): void => {
    const code = isBaseError(err) ? err.code : 'GATEWAY_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    const status = /INVALID_TRANSITION|AUDIT_FIELD_MISSING|EXPORT_FIELD_MISSING|VALIDATION/.test(code) ? 400 : 502;
    res.status(status).json({ ok: false, error: code, message, context: isBaseError(err) ? err.context : undefined });
  };

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'lab-ops-console', ts: deps.now?.() ?? new Date().toISOString() });
  });

  app.get('/api/channels', async (_req, res) => {
    try {
      const channels = refs.supervisor ? await refs.supervisor.status() : [];
      res.status(200).json({ ok: true, channels });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/channels/:id/reload', async (req, res) => {
    try {
      if (!refs.supervisor) { res.status(503).json({ ok: false, error: 'SUPERVISOR_NOT_BOUND' }); return; }
      const result = await refs.supervisor.reload(req.params.id);
      broadcast('channel.reloaded', { channelId: req.params.id });
      res.status(200).json({ ok: true, result });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/critical', async (req, res) => {
    try {
      const input: Record<string, unknown> = {};
      if (typeof req.query.status === 'string') input.status = req.query.status;
      if (typeof req.query.patient_id === 'string') input.patient_id = req.query.patient_id;
      const result = await deps.tools.call('list_critical_values', input, toolContext());
      res.status(200).json(result);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/critical/:id/ack', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await deps.tools.call('acknowledge_critical_value', {
        task_id: req.params.id,
        practitioner_id: body.practitioner_id ?? 'unknown-practitioner',
        role: body.role ?? 'nurse',
      }, toolContext());
      broadcast('critical.updated', { taskId: req.params.id, status: 'received' });
      res.status(200).json(result);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/critical/:id/resolve', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await deps.tools.call('resolve_critical_value', {
        task_id: req.params.id,
        practitioner_id: body.practitioner_id ?? 'unknown-practitioner',
        resolution_note: body.resolution_note ?? '',
      }, toolContext());
      broadcast('critical.resolved', { taskId: req.params.id, status: 'completed' });
      res.status(200).json(result);
    } catch (err) { fail(res, err); }
  });

  app.get('/api/critical/:id/audit', async (req, res) => {
    try {
      const chain = await buildAuditChain(deps.store, req.params.id);
      res.status(200).json({ ok: true, task_id: req.params.id, chain });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/ledger', async (req, res) => {
    try {
      const range = monthRange(typeof req.query.month === 'string' ? req.query.month : undefined, deps.now);
      const rows = await buildLedger(deps.store, range);
      if (req.query.format === 'csv') {
        res.status(200).type('text/csv; charset=utf-8').send(ledgerToCsv(rows));
      } else {
        res.status(200).json({ ok: true, range, count: rows.length, rows });
      }
    } catch (err) { fail(res, err); }
  });

  app.get('/api/denied', async (req, res) => {
    try {
      const range = monthRange(typeof req.query.month === 'string' ? req.query.month : undefined, deps.now);
      res.status(200).json({ ok: true, by_reason: await queryDeniedByReason(deps.store, range) });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/summary', (_req, res) => {
    res.status(200).json({ ok: true, summary: refs.summary?.snapshot() ?? {} });
  });

  app.get('/api/fhir-debug', async (req, res) => {
    try {
      if (!deps.writer) { res.status(503).json({ ok: false, error: 'FHIR_WRITER_NOT_BOUND' }); return; }
      const type = String(req.query.type ?? 'DiagnosticReport');
      const id = String(req.query.id ?? '');
      const resource = id ? await deps.writer.read(type, id) : null;
      res.status(200).json({ ok: true, resourceType: type, id, resource });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/push/redeliver', async (_req, res) => {
    try {
      if (!refs.redelivery) { res.status(503).json({ ok: false, error: 'REDELIVERY_NOT_BOUND' }); return; }
      const result = await refs.redelivery.runOnce();
      broadcast('push.redelivered', result as unknown as Record<string, unknown>);
      res.status(200).json({ ok: true, ...(result as Record<string, unknown>) });
    } catch (err) { fail(res, err); }
  });

  app.get('/api/candidates/:id', async (req, res) => {
    try {
      if (!refs.candidateAdoption) { res.status(503).json({ ok: false, error: 'CANDIDATES_NOT_BOUND' }); return; }
      res.status(200).json({ ok: true, candidates: await refs.candidateAdoption.candidatesFor(req.params.id) });
    } catch (err) { fail(res, err); }
  });

  app.post('/api/candidates/:id/accept', async (req, res) => {
    try {
      if (!refs.candidateAdoption) { res.status(503).json({ ok: false, error: 'CANDIDATES_NOT_BOUND' }); return; }
      const result = await refs.candidateAdoption.accept(req.params.id, (req.body ?? {}) as Record<string, unknown>);
      broadcast('candidate.accepted', { taskId: req.params.id });
      res.status(200).json(result);
    } catch (err) { fail(res, err); }
  });

  app.post('/api/candidates/:id/ignore', async (req, res) => {
    try {
      if (!refs.candidateAdoption) { res.status(503).json({ ok: false, error: 'CANDIDATES_NOT_BOUND' }); return; }
      const result = await refs.candidateAdoption.ignore(req.params.id, (req.body ?? {}) as Record<string, unknown>);
      res.status(200).json(result);
    } catch (err) { fail(res, err); }
  });

  // 静态面板与护士站大屏（大屏走独立口令）
  const wallboardGuard = (req: Request, res: Response, next: () => void): void => {
    const expected = deps.wallboardToken;
    if (!expected) { next(); return; }
    const provided = (typeof req.query.token === 'string' ? req.query.token : '') || String(req.get('x-wallboard-token') ?? '');
    if (provided !== expected) {
      res.status(401).json({ ok: false, error: 'WALLBOARD_UNAUTHORIZED', message: '护士站大屏口令不正确' });
      return;
    }
    next();
  };

  app.get('/critical', wallboardGuard, (_req, res) => {
    const file = join(staticDir, 'wallboard.html');
    res.status(200).type('html').send(existsSync(file) ? readStatic(file) : '<h1>护士站大屏加载中</h1>');
  });
  app.get('/critical.html', wallboardGuard, (_req, res) => {
    const file = join(staticDir, 'wallboard.html');
    res.status(200).type('html').send(existsSync(file) ? readStatic(file) : '<h1>护士站大屏加载中</h1>');
  });
  app.get('/panel.html', (_req, res) => {
    const file = join(staticDir, 'panel.html');
    res.status(200).type('html').send(existsSync(file) ? readStatic(file) : '<h1>面板加载中</h1>');
  });
  app.get('/', (_req, res) => {
    const file = join(staticDir, 'index.html');
    res.status(200).type('html').send(existsSync(file) ? readStatic(file) : '<h1>检验仪器接入与危急值闭环系统</h1>');
  });
  app.use(express.static(staticDir));

  let port = 0;
  return {
    app,
    server,
    wss,
    get port() { return port; },
    start(requested = 3000): Promise<number> {
      return new Promise((resolveStart, reject) => {
        server.once('error', reject);
        server.listen(requested, '127.0.0.1', () => {
          server.off('error', reject);
          const addr = server.address();
          port = typeof addr === 'object' && addr ? addr.port : requested;
          log.info({ port, staticDir }, 'gateway listening');
          resolveStart(port);
        });
      });
    },
    async close(): Promise<void> {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
    broadcast,
    toolContext,
    bind(partial: Partial<GatewayDeps>): void {
      if (partial.supervisor) refs.supervisor = partial.supervisor;
      if (partial.summary) refs.summary = partial.summary;
      if (partial.redelivery) refs.redelivery = partial.redelivery;
      if (partial.candidateAdoption) refs.candidateAdoption = partial.candidateAdoption;
      if (partial.writer && !deps.writer) deps.writer = partial.writer;
    },
  };
}

function readStatic(path: string): string {
  return readFileSync(path, 'utf-8');
}
