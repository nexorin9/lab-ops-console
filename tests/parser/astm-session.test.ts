/**
 * T17 · ASTM E1394 会话层
 *
 * 1. ENQ → ACK 握手，EOT 后才投递完整 record
 * 2. 重复帧号丢弃且计数 +1
 * 3. 缺号告警并进 DLQ（带 error_code）
 * 4. 超时重传后收到帧即恢复（重传计数清零）
 * 5. 重传超限置 down、发告警、回 EOT
 * 6. NAK 策略：可重试回 NAK，不可重试回 EOT 并关会话
 * 7. nextFrameNumber 1..7,0 循环
 * 8. attachAstmSession 接线：半截 record 不投递解析
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  AstmSession,
  ASTM,
  ASTM_ERROR_CODES,
  nextFrameNumber,
  extractFrameNumber,
  attachAstmSession,
  type AstmRecordEvent,
  type AstmAlert,
} from '../../src/parser/astm-session.js';
import { DLQ } from '../../src/channels/DLQ.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import type { Database as DB } from 'better-sqlite3';

let db: DB;
let dlq: DLQ;

beforeEach(() => {
  db = createTestSqlite().db;
  dlq = new DLQ(db);
});
afterEach(() => db.close());

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

function make(overrides: Record<string, unknown> = {}) {
  const c = clock();
  const alerts: AstmAlert[] = [];
  const session = new AstmSession({
    now: c.now,
    handshakeTimeoutMs: 100,
    maxRetries: 2,
    dlq,
    channelName: 'astm-1',
    onAlert: (a) => alerts.push(a),
    ...overrides,
  });
  return { c, alerts, session };
}

describe('T17 · AstmSession 握手与帧号', () => {
  it('ENQ → 回 ACK 且状态 connected；EOT 后才投递一条完整 record', () => {
    const { session } = make();
    const records: AstmRecordEvent[] = [];
    session.on('record', (r) => records.push(r));
    expect(session.state).toBe('idle');

    expect(session.feed(Buffer.from([ASTM.ENQ]))[0]).toBe(ASTM.ACK);
    expect(session.state).toBe('connected');

    expect(session.feed('1H|\\^&|||LAB|||P|1\r')[0]).toBe(ASTM.ACK);
    expect(session.feed('2P|1||ACC-001\r')[0]).toBe(ASTM.ACK);
    expect(session.feed('3O|1||K+|||6.8|mmol/L\r')[0]).toBe(ASTM.ACK);
    expect(records).toHaveLength(0); // 半截 record 绝不提前投递解析
    expect(session.pendingFrames).toBe(3);

    session.feed(Buffer.from([ASTM.EOT]));
    expect(records).toHaveLength(1);
    expect(records[0]!.frameNumbers).toEqual([1, 2, 3]);
    expect(records[0]!.text).toContain('O|1||K+|||6.8|mmol/L');
    expect(session.state).toBe('closed');
    expect(session.stats.records).toBe(1);
  });

  it('重复帧号被丢弃且 duplicateFrames +1，回 ACK 不卡住仪器', () => {
    const { session } = make();
    session.feed(Buffer.from([ASTM.ENQ]));
    const dup: unknown[] = [];
    session.on('duplicate-frame', (e) => dup.push(e));
    session.feed('1H|\\^&|||LAB\r');
    expect(session.feed('1H|\\^&|||LAB\r')[0]).toBe(ASTM.ACK);
    expect(session.stats.duplicateFrames).toBe(1);
    expect(session.stats.framesAccepted).toBe(1);
    expect(session.pendingFrames).toBe(1);
    expect(dup).toHaveLength(1);
    const rows = dlq.list({ errorCode: ASTM_ERROR_CODES.DUPLICATE });
    expect(rows).toHaveLength(1);
  });

  it('帧号缺号 → 告警 + 原始字节进 DLQ 且带 error_code，不丢帧', () => {
    const { session, alerts } = make();
    session.feed(Buffer.from([ASTM.ENQ]));
    session.feed('1H|\\^&|||LAB\r');
    expect(session.feed('4O|1||K+\r')[0]).toBe(ASTM.ACK); // 期望 2，实收 4
    expect(session.stats.missingFrames).toBe(1);
    expect(alerts.some((a) => a.code === ASTM_ERROR_CODES.SEQUENCE_GAP)).toBe(true);
    const rows = dlq.list({ errorCode: ASTM_ERROR_CODES.SEQUENCE_GAP });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error_code).toBe(ASTM_ERROR_CODES.SEQUENCE_GAP);
    expect(rows[0]!.raw_bytes.toString('utf-8')).toContain('4O|');
    // 缺号后续号从 4 之后继续，帧仍被接收
    expect(session.feed('5L|1|N\r')[0]).toBe(ASTM.ACK);
    expect(session.stats.framesAccepted).toBe(3);
  });

  it('缺帧号的坏帧进 DLQ 并回 NAK', () => {
    const { session } = make();
    session.feed(Buffer.from([ASTM.ENQ]));
    expect(session.feed('XH|\\^&|||LAB\r')[0]).toBe(ASTM.NAK);
    expect(dlq.list({ errorCode: ASTM_ERROR_CODES.MALFORMED })).toHaveLength(1);
    expect(session.stats.framesAccepted).toBe(0);
  });
});

describe('T17 · 超时重传与 NAK 策略', () => {
  it('超时按上限重传，重传期间收到数据帧即恢复且计数清零', () => {
    const { c, session } = make();
    session.feed(Buffer.from([ASTM.ENQ]));
    c.tick(150);
    expect(session.tick()[0]).toBe(ASTM.ACK);
    expect(session.stats.retransmits).toBe(1);
    c.tick(150);
    expect(session.tick()[0]).toBe(ASTM.ACK);
    expect(session.stats.retransmits).toBe(2);
    expect(session.state).toBe('connected');

    // 仪器恢复送帧 → 重传计数清零、进入 transfer
    session.feed('1H|\\^&|||LAB\r');
    expect(session.state).toBe('transfer');
    expect(session.stats.framesAccepted).toBe(1);
    c.tick(150);
    expect(session.tick()[0]).toBe(ASTM.ACK); // 重新计数，未直接置 down
    expect(session.state).toBe('transfer');
  });

  it('重传超上限 → 状态 down、发告警、回 EOT，后续帧进 DLQ', () => {
    const { c, session, alerts } = make();
    session.feed(Buffer.from([ASTM.ENQ]));
    c.tick(150); session.tick(); // 1
    c.tick(150); session.tick(); // 2
    c.tick(150);
    expect(session.tick()[0]).toBe(ASTM.EOT); // 第 3 次超限
    expect(session.state).toBe('down');
    expect(alerts.some((a) => a.code === ASTM_ERROR_CODES.TIMEOUT)).toBe(true);
    expect(session.stats.retransmits).toBe(2);

    expect(session.feed('1H|\\^&|||LAB\r')[0]).toBe(ASTM.EOT);
    expect(dlq.list({ errorCode: ASTM_ERROR_CODES.TIMEOUT })).toHaveLength(1);
  });

  it('可重试错误回 NAK 且会话保持；不可重试错误回 EOT 并关闭会话', () => {
    const { session } = make();
    session.feed(Buffer.from([ASTM.ENQ]));
    session.feed('1H|\\^&|||LAB\r');

    expect(session.fail('校验和不匹配，请重发本帧', true, '1H|...')[0]).toBe(ASTM.NAK);
    expect(session.state).toBe('transfer');
    expect(session.stats.naks).toBe(1);
    expect(dlq.list({ errorCode: ASTM_ERROR_CODES.NAK })).toHaveLength(1);

    expect(session.fail('记录头非法且无法恢复', false, 'XH|...')[0]).toBe(ASTM.EOT);
    expect(session.state).toBe('closed');
    expect(session.pendingFrames).toBe(0);
    expect(dlq.list({ errorCode: ASTM_ERROR_CODES.MALFORMED })).toHaveLength(1);
  });

  it('帧号循环 1..7,0 且非法帧号解析为 null', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(nextFrameNumber)).toEqual([2, 3, 4, 5, 6, 7, 0]);
    expect(nextFrameNumber(0)).toBe(1);
    expect(extractFrameNumber('\x022O|1||K+\r')).toBe(2);
    expect(extractFrameNumber('XH|bad')).toBeNull();
  });
});

describe('T17 · 接线到字节流通道', () => {
  it('attachAstmSession：只有会话收齐（EOT）后才把完整 record 交给解析层', () => {
    const { session } = make();
    const channel = new EventEmitter();
    const delivered: AstmRecordEvent[] = [];
    const detach = attachAstmSession(channel, session, (r) => delivered.push(r));

    session.feed(Buffer.from([ASTM.ENQ]));
    channel.emit('framed-message', { bodyText: '1H|\\^&|||LAB\r' });
    channel.emit('framed-message', { bodyText: '2O|1||K+|||6.8|mmol/L\r' });
    expect(delivered).toHaveLength(0);
    session.feed(Buffer.from([ASTM.EOT]));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain('6.8');

    detach();
    channel.emit('framed-message', { bodyText: '1L|1|N\r' });
    expect(delivered).toHaveLength(1);
  });
});
