import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from 'better-sqlite3';
import { RedeliveryWorker } from '../../src/critical/redelivery.js';
import { NotificationDispatcher, type WsClientLike, type CriticalPushPayload } from '../../src/critical/NotificationDispatcher.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';

function makePayload(taskId: string): CriticalPushPayload {
  return {
    type: 'critical.detected',
    taskId,
    patientId: `pid:${taskId}`,
    patientHash: `pid:${taskId}`,
    status: 'requested',
    priority: 'urgent',
    reason: '血钾危急',
    updatedAt: '2026-11-08T00:00:00.000Z',
    severity: 'critical',
    testCode: 'K',
    testDisplay: '血钾',
    value: '6.8',
    unit: 'mmol/L',
    detectedAt: '2026-11-08T00:00:00.000Z',
    actionUrl: `/critical?task=${encodeURIComponent(taskId)}`,
    ts: '2026-11-08T00:00:00.000Z',
  };
}

/** 受控 WS 客户端集合 */
class WsHub {
  clients: WsClientLike[] = [];
  sent: string[] = [];
  add(readyState = 1): WsClientLike {
    const c: WsClientLike = {
      readyState,
      send: (data: string) => { this.sent.push(data); },
    };
    this.clients.push(c);
    return c;
  }
}

describe('T28 · RedeliveryWorker', () => {
  let t: { db: Database; close: () => void };
  beforeEach(() => { t = createTestSqlite(); });
  afterEach(() => t.close());

  function insertPending(taskId: string, opts: { retryCount?: number; nextAttemptAt?: string | null } = {}): void {
    t.db.prepare(`INSERT INTO push_queue (task_id, channel, payload, status, retry_count, next_attempt_at)
      VALUES (?, 'ws_then_webhook', ?, 'pending', ?, ?)`)
      .run(taskId, JSON.stringify(makePayload(taskId)), opts.retryCount ?? 0, opts.nextAttemptAt ?? null);
  }

  function statusOf(taskId: string): string {
    return (t.db.prepare(`SELECT status FROM push_queue WHERE task_id = ?`).get(taskId) as { status: string }).status;
  }

  it('网络恢复后 pending 记录被补推并标 delivered', async () => {
    const hub = new WsHub();
    hub.add(1);
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    const worker = new RedeliveryWorker({ dispatcher, db: t.db });
    insertPending('task-A');
    const r = await worker.runOnce();
    expect(r.scanned).toBe(1);
    expect(r.delivered).toBe(1);
    expect(statusOf('task-A')).toBe('delivered');
    expect(hub.sent.length).toBe(1);
  });

  it('退避期内（next_attempt_at 在未来）的记录被跳过，不重推', async () => {
    const hub = new WsHub();
    hub.add(1);
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    const now = () => '2026-11-08T00:00:00.000Z';
    const worker = new RedeliveryWorker({ dispatcher, db: t.db, now });
    insertPending('task-B', { nextAttemptAt: '2026-11-08T00:10:00.000Z' });
    const r = await worker.runOnce();
    expect(r.scanned).toBe(0); // 退避期内不被取出
    expect(r.delivered).toBe(0);
    expect(hub.sent.length).toBe(0); // 未外发
    expect(statusOf('task-B')).toBe('pending'); // 仍待推，未丢
  });

  it('超过 maxRetries 转 manual_required，记录不丢', async () => {
    const hub = new WsHub(); // 无 OPEN 客户端 → 全部失败
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    const worker = new RedeliveryWorker({ dispatcher, db: t.db, maxRetries: 3, backoffMs: [0, 0, 0, 0] });
    insertPending('task-C', { retryCount: 3 }); // 下一轮 nextCount=4 >= 3 → 人工
    const r = await worker.runOnce();
    expect(r.manualRequired).toBe(1);
    expect(r.failed).toBe(0);
    expect(statusOf('task-C')).toBe('manual_required');
  });

  it('退避期内失败仅累加 retry_count 并推后 next_attempt_at，不转人工', async () => {
    const hub = new WsHub(); // 失败
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    const now = () => '2026-11-08T00:00:00.000Z';
    const worker = new RedeliveryWorker({ dispatcher, db: t.db, maxRetries: 8, backoffMs: [5_000], now });
    insertPending('task-D', { retryCount: 0 });
    const r = await worker.runOnce();
    expect(r.failed).toBe(1);
    expect(statusOf('task-D')).toBe('pending');
    const row = t.db.prepare(`SELECT retry_count, next_attempt_at FROM push_queue WHERE task_id = ?`).get('task-D') as { retry_count: number; next_attempt_at: string | null };
    expect(row.retry_count).toBe(1);
    expect(row.next_attempt_at).toBe('2026-11-08T00:00:05.000Z'); // 退避 5s
  });

  it('幂等：同一次 runOnce 内同 task 多行只外发一次', async () => {
    const hub = new WsHub();
    hub.add(1);
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    const worker = new RedeliveryWorker({ dispatcher, db: t.db });
    insertPending('task-E');
    insertPending('task-E'); // 重复入队（异常场景）
    const r = await worker.runOnce();
    expect(r.delivered).toBe(2); // 两行都标 delivered
    expect(hub.sent.length).toBe(1); // 但护士站只收到一条
  });

  it('幂等：已 delivered 的行不会被再次补推', async () => {
    const hub = new WsHub();
    hub.add(1);
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    const worker = new RedeliveryWorker({ dispatcher, db: t.db });
    insertPending('task-F');
    await worker.runOnce();
    hub.sent.length = 0; // 清空发送记录
    const r2 = await worker.runOnce();
    expect(r2.delivered).toBe(0); // 没有待推
    expect(hub.sent.length).toBe(0);
  });

  it('手动强制补推无视退避并立即重派', async () => {
    const hub = new WsHub();
    hub.add(1);
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    const worker = new RedeliveryWorker({ dispatcher, db: t.db });
    insertPending('task-G', { nextAttemptAt: '2099-01-01T00:00:00.000Z' });
    const r = await worker.forceRedeliverTask('task-G');
    expect(r.delivered).toBe(1);
    expect(statusOf('task-G')).toBe('delivered');
    expect(hub.sent.length).toBe(1);
  });

  it('runOnce 完成后触发 onComplete 回调（供网关广播已补推事件）', async () => {
    const hub = new WsHub();
    hub.add(1);
    const dispatcher = new NotificationDispatcher({ db: t.db, wsServer: hub, enqueueOnFailure: false });
    let captured: unknown = null;
    const worker = new RedeliveryWorker({ dispatcher, db: t.db, onComplete: (res) => { captured = res; } });
    insertPending('task-H');
    await worker.runOnce();
    expect(captured).not.toBeNull();
    expect((captured as { delivered: number }).delivered).toBe(1);
  });
});
