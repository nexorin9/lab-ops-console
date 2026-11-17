import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { startHarness, api, postJson, type Harness } from './helpers.js';
import { getSqlite } from '../../src/shared/sqlite.js';

describe('T28 · 网关补推端点与已补推广播', () => {
  let h: Harness;
  const messages: any[] = [];

  beforeAll(async () => {
    h = await startHarness({ startChannels: false });
  });
  afterAll(async () => { await h.stop(); });

  it('POST /api/push/redeliver 补推 pending 并经 WS 广播「已补推」事件', async () => {
    // 1) 直接落一条 pending 推送记录（模拟断网期间堆积）
    //    复用 harness 的 getSqlite 单例（同一 tmpDir 路径），worker 可见
    const dbb = getSqlite({ dataDir: h.tmpDir });
    dbb.prepare(`INSERT INTO push_queue (task_id, channel, payload, status)
      VALUES (?, 'ws_then_webhook', ?, 'pending')`).run('e2e-redeliver-1',
      JSON.stringify({
        type: 'critical.detected', taskId: 'e2e-redeliver-1',
        patientId: 'pid:e2e', patientHash: 'pid:e2e', status: 'requested', priority: 'urgent',
        reason: '血钾危急', updatedAt: '2026-11-08T00:00:00.000Z', severity: 'critical',
        testCode: 'K', testDisplay: '血钾', value: '6.8', unit: 'mmol/L',
        detectedAt: '2026-11-08T00:00:00.000Z', actionUrl: '/critical?task=e2e-redeliver-1', ts: '2026-11-08T00:00:00.000Z',
      }));

    // 2) 真实 WS 客户端连接网关，监听广播
    const ws = new WebSocket(`ws://127.0.0.1:${h.httpPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.on('message', (data: Buffer) => {
      try { messages.push(JSON.parse(data.toString('utf-8'))); } catch { /* ignore */ }
    });

    // 3) 触发补推
    const r = await api(h.httpPort, '/api/push/redeliver', postJson({}));
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.delivered).toBe(1);

    // 4) 等待 WS 收到「已补推」广播（push.redelivered）
    const got = await new Promise<any>((resolve) => {
      const t = setInterval(() => {
        const hit = messages.find((m) => m.type === 'push.redelivered' && m.delivered === 1);
        if (hit) { clearInterval(t); resolve(hit); }
      }, 30);
      setTimeout(() => { clearInterval(t); resolve(null); }, 4000);
    });
    expect(got).not.toBeNull();
    expect(got.delivered).toBe(1);

    // 5) 同一危急值真正送达护士站（WS 收到 critical.detected 载荷）
    const delivered = messages.find((m) => m.type === 'critical.detected' && m.taskId === 'e2e-redeliver-1');
    expect(delivered).toBeTruthy();

    // 6) push_queue 已标 delivered，不再重复补推
    const status = (dbb.prepare(`SELECT status FROM push_queue WHERE task_id = ?`).get('e2e-redeliver-1') as { status: string }).status;
    expect(status).toBe('delivered');

    ws.close();
  });
});
