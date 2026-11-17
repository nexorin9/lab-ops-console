/**
 * T10 · NotificationDispatcher 三级降级验收
 *
 * WS 优先 → webhook 降级 → push_queue 兜底；载荷脱敏；补推按序回写状态。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database as DB } from 'better-sqlite3';
import {
  NotificationDispatcher,
  buildDispatchPayload,
  hashPatientId,
  assertNoPii,
  type WsClientLike,
  type CriticalPushPayload,
} from '../../src/critical/index.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { CriticalTaskRow } from '../../src/critical/store.js';

let db: DB;
let close: () => void;

const task: CriticalTaskRow = {
  id: 'task-critical-001',
  patient_id: 'P12345',
  status: 'requested',
  focus_diagnostic_id: 'DiagnosticReport/dr-001',
  focus_observation_code: 'K',
  priority: 'stat',
  reason_text: '血钾 6.8 mmol/L',
  created_at: '2026-11-08T09:00:00.000Z',
  updated_at: '2026-11-08T09:00:00.000Z',
};

function client(readyState = 1): WsClientLike & { sent: string[] } {
  const sent: string[] = [];
  return { readyState, sent, send: (d: string) => { sent.push(d); } };
}

function fakeFetch(status = 204) {
  return vi.fn(async () => ({ status, ok: status >= 200 && status < 300 })) as unknown as typeof fetch;
}

const extras: Partial<CriticalPushPayload> = {
  testCode: 'K',
  testDisplay: '血钾',
  value: '6.8',
  unit: 'mmol/L',
  severity: 'critical',
};

beforeEach(() => {
  const t = createTestSqlite();
  db = t.db;
  close = t.close;
});

afterEach(() => close());

describe('T10 · 三级派发', () => {
  it('WS 命中：readyState=1 的连接收到危急值，且不尝试 webhook', async () => {
    const c = client(1);
    const dispatcher = new NotificationDispatcher({ db, wsServer: { clients: [c] } });
    const r = await dispatcher.dispatch(task, extras);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('ws');
    expect(r.attempts).toHaveLength(1);
    expect(c.sent).toHaveLength(1);
    expect(JSON.parse(c.sent[0]!).taskId).toBe(task.id);
  });

  it('WS 未绑定 → 降级 webhook 且 2xx 判成功', async () => {
    const f = fakeFetch(204);
    const dispatcher = new NotificationDispatcher({
      db, webhook: { url: 'http://127.0.0.1:9/hook', fetchImpl: f },
    });
    const r = await dispatcher.dispatch(task, extras);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('webhook');
    expect(r.attempts.map((a) => a.channel)).toEqual(['ws', 'webhook']);
    expect(f).toHaveBeenCalledOnce();
  });

  it('WS 全 CLOSED → 降级 webhook；非 2xx 继续兜底', async () => {
    const f = fakeFetch(503);
    const dispatcher = new NotificationDispatcher({
      db, wsServer: { clients: [client(3), client(2)] },
      webhook: { url: 'http://127.0.0.1:9/hook', fetchImpl: f },
    });
    const r = await dispatcher.dispatch(task, extras);
    expect(r.ok).toBe(false);
    expect(r.attempts[0]).toMatchObject({ channel: 'ws', ok: false });
    expect(r.attempts[1]).toMatchObject({ channel: 'webhook', ok: false });
  });

  it('三级全失败入 push_queue，出现 status=pending 行', async () => {
    const f = fakeFetch(500);
    const dispatcher = new NotificationDispatcher({
      db, wsServer: { clients: [] },
      webhook: { url: 'http://127.0.0.1:9/hook', fetchImpl: f },
    });
    const r = await dispatcher.dispatch(task, extras);
    expect(r.ok).toBe(false);
    expect(r.queued).toBe(true);
    const rows = db.prepare('SELECT task_id, status, channel FROM push_queue').all() as Array<{
      task_id: string; status: string; channel: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: task.id, status: 'pending' });
  });

  it('派发载荷字段齐全且不含患者真名 / 原始患者号', () => {
    const payload = buildDispatchPayload(task, extras);
    expect(payload.patientId).toBe(hashPatientId(task.patient_id));
    expect(payload.patientHash.startsWith('pid:')).toBe(true);
    expect(payload.testCode).toBe('K');
    expect(payload.testDisplay).toBe('血钾');
    expect(payload.value).toBe('6.8');
    expect(payload.unit).toBe('mmol/L');
    expect(payload.severity).toBe('critical');
    expect(payload.detectedAt).toBeTruthy();
    expect(payload.actionUrl).toContain('/critical');
    const json = JSON.stringify(payload);
    expect(json).not.toContain('P12345');
    expect(json).not.toContain('张三');
    expect(json).not.toContain('身份证');
    expect(() => assertNoPii(payload)).not.toThrow();
  });

  it('多连接中部分 CLOSED 时部分送达（不因一个坏连接全盘失败）', async () => {
    const open1 = client(1);
    const open2 = client(1);
    const closed = client(3);
    const dispatcher = new NotificationDispatcher({ db, wsServer: { clients: [closed, open1, open2] } });
    const r = await dispatcher.dispatch(task, extras);
    expect(r.ok).toBe(true);
    expect(r.channel).toBe('ws');
    expect(open1.sent).toHaveLength(1);
    expect(open2.sent).toHaveLength(1);
    expect(closed.sent).toHaveLength(0);
  });

  it('断网入队后恢复 WS → 按序补推并回写 delivered', async () => {
    const offline = new NotificationDispatcher({ db, wsServer: { clients: [] } });
    await offline.dispatch(task, extras);
    await offline.dispatch({ ...task, id: 'task-002' }, extras);
    expect((db.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE status='pending'").get() as { n: number }).n).toBe(2);

    const c = client(1);
    const online = new NotificationDispatcher({ db, wsServer: { clients: [c] } });
    const result = await online.replayPending();
    expect(result).toEqual({ delivered: 2, failed: 0 });
    expect(c.sent).toHaveLength(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE status='delivered'").get() as { n: number }).n).toBe(2);
  });
});
