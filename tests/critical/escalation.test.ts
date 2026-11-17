/**
 * T24 · 升级与超时策略（≥6 条）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CriticalStore } from '../../src/critical/store.js';
import { EscalationWorker, type EscalationNotification } from '../../src/critical/escalation.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let store: CriticalStore;
const loops: EscalationWorker[] = [];

const BASE = Date.parse('2026-11-08T22:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** 同步造数据：直接落库，避免测试里 async 夹具的时序歧义 */
function makeTask(
  id: string,
  opts: { createdMs?: number; receivedMs?: number | null; status?: string } = {},
): void {
  const createdMs = opts.createdMs ?? BASE;
  const receivedMs = opts.receivedMs ?? createdMs;
  db.prepare(`INSERT INTO critical_tasks
      (id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, reason_text, created_at, updated_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, `pid:${id}`,
    opts.status ?? 'received',
    `DR-${id}`, 'K', 'urgent', null,
    iso(createdMs), iso(receivedMs),
    opts.receivedMs === null ? null : iso(receivedMs),
  );
}

function makeWorker(overrides: Record<string, unknown> = {}) {
  const notifications: EscalationNotification[] = [];
  const worker = new EscalationWorker(store, {
    onNotify: (n) => notifications.push(n),
    ...overrides,
  });
  loops.push(worker);
  return { worker, notifications };
}

beforeEach(() => {
  db = createTestSqlite().db;
  store = new CriticalStore(db);
});
afterEach(() => {
  for (const w of loops) w.stopLoop();
  loops.length = 0;
  db.close();
});

describe('T24 · 升级链', () => {
  it('停留 6 分钟 → 产生一条 level=dept_head 的 escalation_events（科主任）', () => {
    const receivedMs = BASE;
    // 用同步方式准备数据（store 方法虽是 async，但内部无 await，落库已完成）
    void makeTask('t1', { createdMs: BASE, receivedMs });
    const { worker, notifications } = makeWorker();
    const r = worker.scan(receivedMs + 6 * 60_000);
    expect(r.scanned).toBe(1);
    expect(r.created).toBe(1);
    const events = worker.listEvents('t1');
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe('dept_head');
    expect(events[0]!.target_role).toBe('科主任');
    expect(events[0]!.created_at).toBe(iso(receivedMs + 6 * 60_000));
    expect(events[0]!.responded).toBe(0);
    expect(notifications[0]).toMatchObject({ level: 'dept_head', targetRole: '科主任' });
  });

  it('停留 16 分钟 → 产生医务科级升级（同时补齐科主任级，各一条不重复）', () => {
    void makeTask('t2', { receivedMs: BASE });
    const { worker } = makeWorker();
    worker.scan(BASE + 16 * 60_000);
    const levels = worker.listEvents('t2').map((e) => e.level).sort();
    expect(levels).toEqual(['dept_head', 'medical_affairs']);
    const medical = worker.listEvents('t2').find((e) => e.level === 'medical_affairs');
    expect(medical?.target_role).toBe('医务科');
    expect(medical?.reason).toContain('16 分钟');
  });

  it('同一 Task 重复扫描不产生重复升级记录', () => {
    void makeTask('t3', { receivedMs: BASE });
    const { worker } = makeWorker();
    worker.scan(BASE + 6 * 60_000);
    const second = worker.scan(BASE + 7 * 60_000);
    const third = worker.scan(BASE + 16 * 60_000);
    expect(second.created).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
    expect(third.created).toBe(1); // 只新增医务科这一级
    expect(worker.listEvents('t3')).toHaveLength(2);
  });

  it('计时基于收到时间而非创建时间（夜班 22:00 建单 / 23:50 接单不算超时）', () => {
    const createdMs = BASE;                          // 22:00
    const receivedMs = BASE + 110 * 60_000;         // 23:50 才接单
    void makeTask('t4', { createdMs, receivedMs });
    const { worker } = makeWorker();
    const r = worker.scan(receivedMs + 60_000);     // 接单后 1 分钟
    expect(r.created).toBe(0);
    expect(worker.listEvents('t4')).toHaveLength(0);
    const dwell = worker.dwellMs('t4', receivedMs + 60_000);
    expect(dwell?.elapsedMs).toBe(60_000);
    expect(dwell?.timingSource).toBe('received_at');
    const after = worker.scan(receivedMs + 6 * 60_000);
    expect(after.created).toBe(1);
  });

  it('未接收（requested）与已完成（completed）Task 不参与升级扫描', () => {
    void makeTask('t5', { receivedMs: null, status: 'requested' }); // 仍是 requested
    void makeTask('t6', { receivedMs: BASE, status: 'completed' }); // 已处置
    const { worker } = makeWorker();
    const r = worker.scan(BASE + 60 * 60_000);
    expect(r.scanned).toBe(0);
    expect(worker.listEvents()).toHaveLength(0);
  });

  it('markResponded 标记响应状态，且不影响后续扫描重复写入', () => {
    void makeTask('t7', { receivedMs: BASE });
    const { worker } = makeWorker();
    worker.scan(BASE + 6 * 60_000);
    expect(worker.markResponded('t7', 'dept_head')).toBe(true);
    expect(worker.listEvents('t7')[0]!.responded).toBe(1);
    expect(worker.markResponded('t7', 'medical_affairs')).toBe(false);
    expect(worker.scan(BASE + 7 * 60_000).created).toBe(0);
  });

  it('升级写审计（escalation_<level>），飞检可倒查目标角色与停留时长', async () => {
    void makeTask('t8', { receivedMs: BASE });
    const { worker } = makeWorker();
    worker.scan(BASE + 6 * 60_000);
    const chain = await store.queryAuditChain('t8');
    const escalation = chain.find((a) => a.reason?.startsWith('escalation_'));
    expect(escalation).toBeTruthy();
    expect(escalation?.outcome).toBe('success');
    expect(escalation?.context).toContain('科主任');
    expect(escalation?.agent).toBe('system:escalation');
  });

  it('自定义策略阈值生效，startLoop 定时扫描后 stopLoop 停止', async () => {
    void makeTask('t9', { receivedMs: BASE });
    const { worker } = makeWorker({ policy: { deptHeadAfterMs: 1000, medicalAffairsAfterMs: 5000 }, now: () => BASE + 2000 });
    worker.startLoop(20);
    await new Promise((r) => setTimeout(r, 90));
    worker.stopLoop();
    expect(worker.listEvents('t9').some((e) => e.level === 'dept_head')).toBe(true);
  });
});
