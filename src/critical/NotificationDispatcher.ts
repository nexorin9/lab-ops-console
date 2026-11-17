/**
 * critical.NotificationDispatcher —— 危急值推送三级派发
 *
 * WS 优先（仅 readyState=1 的连接）→ webhook 降级（NOTIFY_WEBHOOK_URL + 5s 超时 + 2xx）→
 * push_queue 兜底（sqlite status='pending' 待补推）。全程记录尝试轨迹，供复盘与飞检。
 *
 * 责任边界（spec §8）：派发内容只含**哈希患者标识**、检验项、危急值与单位、severity、
 * 检出时间与处置入口；不落姓名、身份证、住院号等可识别明细。
 *
 * 依赖注入：wsServer / webhook.fetchImpl / db 均可注入，便于无网络、无 ws 的单测。
 */

import { createHash } from 'node:crypto';
import type { Database as DB } from 'better-sqlite3';
import type { CriticalTaskRow } from './store.js';
import type { Severity } from './detector.js';
import { createLogger } from '../shared/logger.js';
import { getSqlite } from '../shared/sqlite.js';

const log = createLogger('critical.dispatcher');

/** WS 客户端集合（gateway server 注入；key = clientId） */
export type WsClientLike = { send: (data: string) => void; readyState: number };
export type WsServerLike = { clients: Iterable<WsClientLike> };

export interface WebhookOptions {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DispatcherOptions {
  wsServer?: WsServerLike;
  webhook?: WebhookOptions;
  /** 推送失败是否落 push_queue（默认 true） */
  enqueueOnFailure?: boolean;
  /** SQLite 注入（默认单例；测试传内存库） */
  db?: DB;
}

/** 推送结果 */
export interface DispatchResult {
  ok: boolean;
  channel: 'ws' | 'webhook' | 'none';
  attempts: Array<{ channel: 'ws' | 'webhook'; ok: boolean; error?: string }>;
  /** 三级都不可用时入 push_queue 待补推 */
  queued?: boolean;
}

/**
 * 派发载荷 —— 只允许哈希标识与检验事实，不允许患者可识别明细。
 * patientId 字段本身即哈希值（pid:<sha256 前 16 位>），不是院内患者号。
 */
export interface CriticalPushPayload {
  type: 'critical.detected' | 'critical.updated' | 'critical.resolved';
  taskId: string;
  /** 哈希患者标识（sha256 前 16 位），不落真名 / 身份证 / 住院号 */
  patientId: string;
  patientHash: string;
  status: string;
  priority: string;
  reason: string | null;
  updatedAt: string;
  /** 大屏亮红框标签 */
  severity?: Severity;
  /** 检验项（脱敏后的项目码 / 名称） */
  testCode?: string;
  testDisplay?: string;
  /** 危急值与单位 */
  value?: string;
  unit?: string;
  /** 检出时间 */
  detectedAt?: string;
  /** 处置入口（面板路径，不含患者标识） */
  actionUrl?: string;
  /** 一句话描述（来自 detector） */
  summary?: string;
  ts: string;
}

/** 载荷里禁止出现的键（防止后续有人顺手把姓名塞进推送） */
export const FORBIDDEN_PAYLOAD_KEYS = [
  'patientName', 'name', 'idCard', 'idNumber', 'ssn', '身份证', '姓名', 'patientRawId',
] as const;

/** 患者标识哈希化 —— 只输出不可逆短摘要，供大屏区分不同患者 */
export function hashPatientId(raw: string): string {
  return `pid:${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
}

/**
 * 构造派发载荷并强制脱敏：患者标识一律哈希化，
 * 任何被列入 FORBIDDEN_PAYLOAD_KEYS 的键都不得出现在最终载荷里。
 */
export function buildDispatchPayload(
  task: CriticalTaskRow,
  extra: Partial<CriticalPushPayload> = {},
): CriticalPushPayload {
  const hash = hashPatientId(task.patient_id);
  const payload: CriticalPushPayload = {
    type: 'critical.detected',
    taskId: task.id,
    patientId: hash,
    patientHash: hash,
    status: task.status,
    priority: task.priority,
    reason: task.reason_text,
    updatedAt: task.updated_at,
    detectedAt: task.created_at,
    severity: 'critical',
    actionUrl: `/critical?task=${encodeURIComponent(task.id)}`,
    ts: new Date().toISOString(),
    ...extra,
  };
  // extra 可以补充检验事实，但不能覆盖成可识别明细，也不能引入禁用键
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    delete (payload as unknown as Record<string, unknown>)[key];
  }
  payload.patientId = hash;
  payload.patientHash = hash;
  return payload;
}

/** 断言载荷不含患者可识别明细（供测试与网关出口自检） */
export function assertNoPii(payload: CriticalPushPayload): void {
  const json = JSON.stringify(payload);
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (key in payload) throw new Error(`派发载荷含禁用字段 ${key}`);
  }
  if (!payload.patientId.startsWith('pid:')) throw new Error('患者标识未哈希化');
  if (/[\u4e00-\u9fa5]{2,}/.test(payload.patientId)) throw new Error('患者标识含中文真名');
  if (json.includes('身份证') || json.includes('idCard')) throw new Error('载荷含身份证字段');
}

export class NotificationDispatcher {
  private wsServer?: WsServerLike;
  private readonly webhook?: WebhookOptions;
  private readonly enqueueOnFailure: boolean;
  private readonly db: DB | null;

  constructor(options: DispatcherOptions = {}) {
    this.wsServer = options.wsServer;
    this.webhook = options.webhook;
    this.enqueueOnFailure = options.enqueueOnFailure ?? true;
    this.db = options.db ?? null;
  }

  /** 注入 wsServer（网关装配时调用） */
  setWsServer(ws: WsServerLike): void {
    this.wsServer = ws;
  }

  private getDb(): DB {
    return this.db ?? getSqlite();
  }

  /** 主派发入口 —— WS → webhook → push_queue */
  async dispatch(task: CriticalTaskRow, payloadExtra: Partial<CriticalPushPayload> = {}): Promise<DispatchResult> {
    const payload = buildDispatchPayload(task, payloadExtra);
    assertNoPii(payload);
    return this.deliver(task.id, payload);
  }

  /** 发送一条已构造好的载荷（补推 worker 复用同一条派发链） */
  async deliver(
    taskId: string,
    payload: CriticalPushPayload,
    opts: { enqueueOnFailure?: boolean } = {},
  ): Promise<DispatchResult> {
    assertNoPii(payload);
    const enqueueOnFailure = opts.enqueueOnFailure ?? this.enqueueOnFailure;
    const result: DispatchResult = { ok: false, channel: 'none', attempts: [] };

    // 1) WS 优先
    const wsOk = await this.tryWebSocket(payload);
    result.attempts.push({ channel: 'ws', ok: wsOk.ok, error: wsOk.error });
    if (wsOk.ok) {
      result.ok = true;
      result.channel = 'ws';
      log.info({ taskId, channel: 'ws' }, 'critical pushed via WS');
      return result;
    }

    // 2) webhook 降级
    if (this.webhook) {
      const whOk = await this.tryWebhook(payload);
      result.attempts.push({ channel: 'webhook', ok: whOk.ok, error: whOk.error });
      if (whOk.ok) {
        result.ok = true;
        result.channel = 'webhook';
        log.info({ taskId, channel: 'webhook' }, 'critical pushed via webhook');
        return result;
      }
    }

    // 3) push_queue 兜底（断网期间不丢，恢复后按序补推）
    if (enqueueOnFailure) {
      this.enqueuePushQueue(taskId, payload);
      result.queued = true;
    }
    log.warn({ taskId, attempts: result.attempts }, 'critical push failed; queued');
    return result;
  }

  /** 尝试 WS 推送（仅 OPEN 连接；部分 CLOSED 时仍算部分送达） */
  private async tryWebSocket(payload: CriticalPushPayload): Promise<{ ok: boolean; error?: string }> {
    if (!this.wsServer) return { ok: false, error: 'ws_server_not_bound' };
    const data = JSON.stringify(payload);
    let sent = 0;
    let lastError: string | undefined;
    for (const client of this.wsServer.clients) {
      if (client.readyState !== 1) {
        lastError = `client_ready_state=${client.readyState}`;
        continue;
      }
      try {
        client.send(data);
        sent++;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (sent > 0) return { ok: true };
    return { ok: false, error: lastError ?? 'no_ws_clients' };
  }

  /** 尝试 webhook 推送（AbortController 5s 超时，2xx 算成功） */
  private async tryWebhook(payload: CriticalPushPayload): Promise<{ ok: boolean; error?: string }> {
    if (!this.webhook) return { ok: false, error: 'webhook_not_configured' };
    const f = this.webhook.fetchImpl ?? fetch;
    const timeoutMs = this.webhook.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await f(this.webhook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (r.status >= 200 && r.status < 300) return { ok: true };
      return { ok: false, error: `webhook_status_${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** push_queue 入队（兜底，status='pending'） */
  private enqueuePushQueue(taskId: string, payload: CriticalPushPayload): void {
    try {
      this.getDb().prepare(`INSERT INTO push_queue (task_id, channel, payload, status, retry_count)
        VALUES (?, ?, ?, 'pending', 0)`).run(taskId, 'ws_then_webhook', JSON.stringify(payload));
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), taskId }, 'push_queue enqueue failed');
    }
  }

  /**
   * T10 补推路径：网络恢复后按 id 顺序取出 pending 记录重派发，
   * 成功标 delivered（写 synced_at），失败累加 retry_count 并保留 pending。
   * T28 的 RedeliveryWorker 在此之上加退避与人工队列。
   */
  async replayPending(limit = 100): Promise<{ delivered: number; failed: number }> {
    const rows = this.getDb().prepare(`SELECT id, task_id, payload FROM push_queue
      WHERE status = 'pending' ORDER BY id ASC LIMIT ?`).all(limit) as Array<{
        id: number; task_id: string; payload: string;
      }>;
    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      let payload: CriticalPushPayload;
      try {
        payload = JSON.parse(row.payload) as CriticalPushPayload;
      } catch {
        failed++;
        continue;
      }
      // 补推本身不允许再次入队，否则一次失败会把队列越补越长。
      const r = await this.deliver(row.task_id, payload, { enqueueOnFailure: false });
      if (r.ok) {
        this.getDb().prepare(`UPDATE push_queue SET status = 'delivered', synced_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), row.id);
        delivered++;
      } else {
        this.getDb().prepare(`UPDATE push_queue SET retry_count = retry_count + 1, last_error = ? WHERE id = ?`)
          .run(r.attempts.map((a) => a.error ?? '').filter(Boolean).join('; '), row.id);
        failed++;
      }
    }
    return { delivered, failed };
  }
}

/** 单例 dispatcher（懒初始化） */
let _dispatcher: NotificationDispatcher | null = null;
export function getDispatcher(): NotificationDispatcher {
  if (!_dispatcher) _dispatcher = new NotificationDispatcher();
  return _dispatcher;
}
export function _resetDispatcherForTest(): void {
  _dispatcher = null;
}
