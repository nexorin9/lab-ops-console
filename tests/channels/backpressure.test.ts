/**
 * T16 · 入站速率限制与背压
 *
 * 覆盖（任务书 T16 步骤表 ≥6 条）：
 * 1. 令牌桶限速生效（burst + 固定时钟不补令牌）
 * 2. 有界队列长度恒不超过上限
 * 3. 溢出帧进 DLQ 且 error_code='rate_limited'，原始字节可还原
 * 4. 恢复后 drain 按序继续消费，不丢帧
 * 5. 两通道配额互不影响
 * 6. 全局配额溢出单列统计
 * 7. 计数指标单调递增且守恒：submitted = delivered + queued + rejected
 * 8. Hl7Server 接线：限速在 'message' 投递之前生效，仍回 AA
 * 9. ByteStreamChannel 接线：限速在 'framed-message' 投递之前生效
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import {
  TokenBucket,
  BoundedQueue,
  BackpressureGate,
  RATE_LIMITED_ERROR_CODE,
  Hl7Server,
  ByteStreamChannel,
  buildByteStreamConfig,
  type FramedMessage,
} from '../../src/channels/index.js';
import { DLQ } from '../../src/channels/DLQ.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let dlq: DLQ;

beforeEach(() => {
  db = createTestSqlite().db;
  dlq = new DLQ(db);
});

afterEach(() => {
  db.close();
});

/** 固定时钟：不调用 tick() 就不补令牌，让限速行为可复现 */
function clock() {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    tick: (ms: number) => { t += ms; },
  };
}

const FRAME = (tag: string) => `MSH|^~\\&|LAB|A|B|LAB|C|20260101120000||ORU^R01|${tag}|P|2.5\rOBR|1\r`;

describe('T16 · TokenBucket / BoundedQueue', () => {
  it('令牌桶按 burst 放行、不补令牌时不再放行；补时后恢复', () => {
    const c = clock();
    const bucket = new TokenBucket({ ratePerSec: 10, burst: 3, now: c.now });
    expect([bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()]).toEqual([true, true, true]);
    expect(bucket.tryConsume()).toBe(false);
    expect(bucket.available).toBe(0);
    c.tick(100); // 100ms × 10/s = 1 个令牌
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it('有界队列长度恒 ≤ 上限，越界 push 返回 false', () => {
    const q = new BoundedQueue<number>(3);
    expect([q.push(1), q.push(2), q.push(3), q.push(4)]).toEqual([true, true, true, false]);
    expect(q.size).toBe(3);
    expect(q.highWaterMark).toBe(3);
    expect(q.shift()).toBe(1);
    expect(q.size).toBe(2);
    expect(q.push(4)).toBe(true);
    expect(q.size).toBeLessThanOrEqual(3);
    expect(q.highWaterMark).toBe(3);
  });
});

describe('T16 · BackpressureGate 溢出与对账', () => {
  it('队列满的帧进 DLQ 且 error_code 正确、原始字节逐字节可还原', () => {
    const c = clock();
    const gate = new BackpressureGate({
      perChannel: { ratePerSec: 1, burst: 2, queueLimit: 2 },
      dlq,
      now: c.now,
    });
    // 帧 1、2 直接放行；帧 3、4 入队；帧 5 队列满 → DLQ
    const verdicts = ['a', 'b', 'c', 'd', 'e'].map((t) => gate.accept('chem-1', FRAME(t)));
    expect(verdicts.map((v) => v.accepted)).toEqual([true, true, false, false, false]);
    expect(verdicts[4].reason).toBe('queue_full');

    const rows = dlq.list({ errorCode: RATE_LIMITED_ERROR_CODE, order: 'asc' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error_code).toBe(RATE_LIMITED_ERROR_CODE);
    expect(rows[0]!.channel_name).toBe('chem-1');
    expect(rows[0]!.raw_bytes.toString('utf-8')).toBe(FRAME('e'));

    const m = gate.metrics();
    expect(m.submitted).toBe(5);
    expect(m.delivered).toBe(2);
    expect(m.queued).toBe(2);
    expect(m.rejected).toBe(1);
    // 无静默丢帧：发送数 = 已投递 + 排队中 + 已拒绝
    expect(m.submitted).toBe(m.delivered + m.queued + m.rejected);
  });

  it('恢复后 drain 按序继续消费，队列清空且计数守恒', async () => {
    const c = clock();
    const gate = new BackpressureGate({
      perChannel: { ratePerSec: 10, burst: 2, queueLimit: 10 },
      dlq,
      now: c.now,
    });
    gate.accept('chem-1', 'frame-1');
    gate.accept('chem-1', 'frame-2');
    gate.accept('chem-1', 'frame-3');
    gate.accept('chem-1', 'frame-4');
    const before = gate.metrics();
    expect(before.queued).toBe(2);

    c.tick(1000); // 桶补满
    const seen: string[] = [];
    const drained = await gate.drain('chem-1', (f) => {
      seen.push(Buffer.from(f).toString('utf-8'));
    });
    expect(drained).toBe(2);
    expect(seen).toEqual(['frame-3', 'frame-4']);
    const after = gate.metrics();
    expect(after.queued).toBe(0);
    expect(after.delivered).toBe(4);
    expect(after.submitted).toBe(after.delivered + after.queued + after.rejected);
  });

  it('两通道配额互不影响：A 打满后 B 仍可放行', () => {
    const c = clock();
    const gate = new BackpressureGate({
      perChannel: { ratePerSec: 1, burst: 1, queueLimit: 1 },
      dlq,
      now: c.now,
    });
    expect(gate.accept('A', 'a1').accepted).toBe(true);
    expect(gate.accept('A', 'a2').accepted).toBe(false);
    expect(gate.accept('B', 'b1').accepted).toBe(true);
    expect(gate.metrics().byChannel.A).toMatchObject({ submitted: 2, rejected: 0, queueDepth: 1 });
    expect(gate.metrics().byChannel.B).toMatchObject({ submitted: 1, rejected: 0, queueDepth: 0 });
  });

  it('全局配额溢出单列统计，且不污染通道级配额', () => {
    const c = clock();
    const gate = new BackpressureGate({
      perChannel: { ratePerSec: 100, burst: 100, queueLimit: 0 },
      global: { ratePerSec: 1, burst: 1, queueLimit: 1 },
      dlq,
      now: c.now,
    });
    expect(gate.accept('A', 'g1').accepted).toBe(true); // 用掉全局唯一令牌
    expect(gate.accept('B', 'g2')).toMatchObject({ accepted: false, scope: 'global' }); // 入全局队列
    expect(gate.accept('C', 'g3')).toMatchObject({ accepted: false, scope: 'global' }); // 全局队列满 → DLQ

    const m = gate.metrics();
    expect(m.globalOverflow).toBe(1);
    expect(m.byChannel.A.submitted).toBe(1);
    expect(m.submitted).toBe(m.delivered + m.queued + m.rejected);
    const rows = dlq.list({ errorCode: RATE_LIMITED_ERROR_CODE });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_bytes.toString('utf-8')).toBe('g3');

    c.tick(5000);
    const seen: string[] = [];
    return gate.drainGlobal((_id, f) => { seen.push(Buffer.from(f).toString('utf-8')); }).then((n) => {
      expect(n).toBe(1);
      expect(seen).toEqual(['g2']);
    });
  });

  it('计数指标单调递增，且每步守恒', () => {
    const c = clock();
    const gate = new BackpressureGate({
      perChannel: { ratePerSec: 1, burst: 2, queueLimit: 1 },
      dlq,
      now: c.now,
    });
    let prev = gate.metrics();
    for (let i = 0; i < 20; i += 1) {
      gate.accept('chem-1', FRAME(String(i)));
      const m = gate.metrics();
      expect(m.submitted).toBeGreaterThan(prev.submitted);
      expect(m.rateLimited).toBeGreaterThanOrEqual(prev.rateLimited);
      expect(m.queueHighWater).toBeGreaterThanOrEqual(prev.queueHighWater);
      expect(m.submitted).toBe(m.delivered + m.queued + m.rejected);
      prev = m;
    }
    // 队列上限 1 → 高水位绝不超过 1
    expect(gate.metrics().queueHighWater).toBeLessThanOrEqual(1);
  });
});

describe('T16 · 接线：限速在业务投递之前生效', () => {
  function mllp(raw: string): Buffer {
    return Buffer.concat([Buffer.from([0x0b]), Buffer.from(raw, 'utf-8'), Buffer.from([0x1c, 0x0d])]);
  }

  it('Hl7Server：被限速帧仍回 ACK AA，但不投递 message，且进 DLQ', async () => {
    const c = clock();
    const gate = new BackpressureGate({
      perChannel: { ratePerSec: 0, burst: 1, queueLimit: 0 },
      dlq,
      now: c.now,
    });
    const server = new Hl7Server('bp-hl7', { dlq, backpressure: gate });
    const received: string[] = [];
    const limited: unknown[] = [];
    server.on('message', ({ message }: { message: { raw: string } }) => received.push(message.raw));
    server.on('rate-limited', (e) => limited.push(e));
    const port = await server.start(0);
    try {
      const ack = await new Promise<Buffer>((resolveP, rejectP) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' });
        const timer = setTimeout(() => { sock.destroy(); rejectP(new Error('ACK 超时')); }, 2000);
        sock.once('connect', () => sock.write(Buffer.concat([mllp(FRAME('OK1')), mllp(FRAME('DROP2'))])));
        sock.once('data', (d: Buffer) => { clearTimeout(timer); sock.end(); resolveP(d); });
        sock.once('error', rejectP);
      });
      expect(ack.toString('utf-8')).toContain('MSA|AA');
      // 等第二个 ACK 与 DLQ 落盘
      await new Promise((r) => setTimeout(r, 120));
      expect(received).toHaveLength(1);
      expect(received[0]).toContain('OK1');
      expect(limited).toHaveLength(1);
      expect(dlq.list({ errorCode: RATE_LIMITED_ERROR_CODE })).toHaveLength(1);
      expect(gate.metrics().rateLimited).toBe(1);
    } finally {
      await server.stop({ forceDrainTimeoutMs: 50 });
    }
  });

  it('ByteStreamChannel：被限速帧不投递 framed-message', async () => {
    const c = clock();
    const gate = new BackpressureGate({
      perChannel: { ratePerSec: 0, burst: 1, queueLimit: 0 },
      dlq,
      now: c.now,
    });
    const ch = new ByteStreamChannel('bp-bytestream', {
      dlq,
      backpressure: gate,
      initialConfig: buildByteStreamConfig({
        startChar: 0x05,
        endChar: 0x04,
        bodyEncoding: 'utf-8',
      }),
    });
    const frames: FramedMessage[] = [];
    ch.on('framed-message', (m: FramedMessage) => frames.push(m));
    const port = await ch.start(0);
    try {
      await new Promise<void>((resolveP, rejectP) => {
        const sock = net.createConnection({ port, host: '127.0.0.1' });
        const timer = setTimeout(() => { sock.destroy(); resolveP(); }, 250);
        sock.once('connect', () => {
          sock.write(Buffer.concat([
            Buffer.from([0x05]), Buffer.from('1H|\\^&|||LAB\r'), Buffer.from([0x04]),
            Buffer.from([0x05]), Buffer.from('2O|1||K+\r'), Buffer.from([0x04]),
          ]));
        });
        sock.once('error', rejectP);
        sock.on('close', () => { clearTimeout(timer); resolveP(); });
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(frames).toHaveLength(1);
      expect(frames[0]!.bodyText).toContain('1H|');
      expect(dlq.list({ errorCode: RATE_LIMITED_ERROR_CODE })).toHaveLength(1);
    } finally {
      await ch.stop({ forceDrainTimeoutMs: -1 });
    }
  });
});
