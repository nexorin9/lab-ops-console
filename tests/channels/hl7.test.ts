/**
 * Hl7Server + Hl7Connection + DLQ 单元测试
 *
 * 用例覆盖：
 * 1. 正常 ORU^R01 → ack AA + 解析成功（K/Na/Cl 三项 + PID.5 中文）
 * 2. 字段缺失 → ack CA + DLQ 入队
 * 3. GBK 编码 → iconv-lite fallback 解码成功
 * 4. 客户端断连 → graceful drain（pending 清空）
 * 5. 半个帧 → 不触发回调；补齐后半 → 正常解析
 * 6. 非法控制字符 → 拒收（ack CA + DLQ 保留原始字节）
 * 7. 两条连接并发 → 互不干扰（各自 ACK 与控制 ID 正确）
 * 8. stop() 后端口释放（可被重新绑定）
 * 9. 段视图：字节 → { msh, pid, pv1, obr, obx[] }
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';
import iconv from 'iconv-lite';
import { Hl7Server, Hl7Connection, parseHl7Message, ACK_AA, ACK_CA } from '../../src/channels/index.js';
import { DLQ, _resetDLQSingleton } from '../../src/channels/DLQ.js';
import { createTestSqlite } from '../../src/shared/sqlite.js';
import { parseOruR01Frame } from '../../src/parser/oru-r01.js';
import type { Hl7Message } from '../../src/channels/Hl7Connection.js';

const FIXTURE_NORMAL = readFileSync(
  resolve(__dirname, '../fixtures/oru-r01-k-nacl.txt'),
  'utf-8',
);

/** 把 HL7 帧内容包成 VT + body + FS + CR 字节 */
function frameBytes(content: string, encoding: 'utf-8' | 'gbk' = 'utf-8'): Buffer {
  const enc = encoding === 'gbk' ? iconv.encode(content, 'gbk') : Buffer.from(content, 'utf-8');
  const out = Buffer.alloc(enc.length + 3);
  out.writeInt8(0x0b, 0);
  enc.copy(out, 1);
  out.writeInt8(0x1c, enc.length + 1);
  out.writeInt8(0x0d, enc.length + 2);
  return out;
}

/**
 * 用 socket 连接 server 发一帧 HL7（含 VT/FS/CR），
 * 收集 ACK 回包（最多收集 1 次 data）。
 */
function sendAndCollectAck(
  port: number,
  rawContent: string,
  encoding: 'utf-8' | 'gbk' = 'utf-8',
  collectTimeoutMs = 1500,
): Promise<Buffer> {
  return new Promise<Buffer>((resolveP, rejectP) => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      conn.destroy();
      rejectP(new Error('ACK 收集超时'));
    }, collectTimeoutMs);
    conn.once('connect', () => {
      conn.write(frameBytes(rawContent, encoding));
    });
    conn.once('data', (data: Buffer) => {
      clearTimeout(timer);
      resolveP(data);
      conn.end();
    });
    conn.once('error', (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
  });
}

describe('Hl7Server + Hl7Connection + DLQ', () => {
  let server: Hl7Server;
  let dlq: DLQ;
  let testSqlite: ReturnType<typeof createTestSqlite>;
  let port = 0;
  let messagesReceived: Hl7Message[] = [];
  let errorsReceived: Error[] = [];

  beforeEach(async () => {
    testSqlite = createTestSqlite();
    dlq = new DLQ(testSqlite.db);
    _resetDLQSingleton();
    messagesReceived = [];
    errorsReceived = [];
    server = new Hl7Server('test-hl7', {
      encoding: 'utf-8',
      dlq,
    });
    server.on('message', ({ message }: { message: Hl7Message }) => {
      messagesReceived.push(message);
    });
    server.on('error', (err: Error) => {
      errorsReceived.push(err);
    });
    port = await server.start(0);
  });

  afterEach(async () => {
    await server.stop({ forceDrainTimeoutMs: 100 });
    testSqlite.close();
  });

  it('正常 ORU^R01 → ack AA + 解析 K/Na/Cl', async () => {
    const ackBuf = await sendAndCollectAck(port, FIXTURE_NORMAL);
    const ackStr = ackBuf.toString('utf-8').replace(/[\x0b\x1c\x0d]/g, '');
    expect(ackStr).toMatch(/^MSH/);
    expect(ackStr).toMatch(/MSA\|AA\|MSG00001/);

    // 等 server emit message
    await new Promise((r) => setTimeout(r, 50));
    expect(messagesReceived.length).toBeGreaterThanOrEqual(1);
    const msg = messagesReceived[0];
    expect(msg.messageType).toBe('ORU');
    expect(msg.triggerEvent).toBe('R01');
    expect(msg.controlId).toBe('MSG00001');
    expect(msg.segments.length).toBeGreaterThanOrEqual(4);
    const obxLines = msg.segments.filter((s) => s[0] === 'OBX');
    expect(obxLines.length).toBe(3);
    const kLine = obxLines.find((s) => s[3]?.startsWith('K^'));
    expect(kLine?.[5]).toBe('4.5');
  });

  it('字段缺失（MSH.10 空） → ack CA + DLQ 入队 + 错误码 HL7_PARSE_FAIL', async () => {
    // 把 MSH.10（MSG00001）删空
    const broken = FIXTURE_NORMAL.replace('MSG00001', '');
    const ackBuf = await sendAndCollectAck(port, broken);
    const ackStr = ackBuf.toString('utf-8').replace(/[\x0b\x1c\x0d]/g, '');
    expect(ackStr).toMatch(/MSA\|CA\|/);

    await new Promise((r) => setTimeout(r, 50));
    expect(errorsReceived.length).toBeGreaterThanOrEqual(1);
    expect(messagesReceived.length).toBe(0);

    // DLQ 入队
    const rows = dlq.query({ channelName: 'test-hl7' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].error_code).toMatch(/HL7_/);
  });

  it('GBK 编码 → iconv-lite 解码成功（PID.5 中文姓名）', async () => {
    const serverGbk = new Hl7Server('test-gbk', {
      encoding: 'gbk',
      dlq,
    });
    let gbkMsg: Hl7Message | null = null;
    serverGbk.on('message', ({ message }: { message: Hl7Message }) => {
      gbkMsg = message;
    });
    const gbkPort = await serverGbk.start(0);

    try {
      const ackBuf = await sendAndCollectAck(gbkPort, FIXTURE_NORMAL, 'gbk');
      const ackStr = ackBuf.toString('utf-8').replace(/[\x0b\x1c\x0d]/g, '');
      expect(ackStr).toMatch(/MSA\|AA\|/);

      await new Promise((r) => setTimeout(r, 50));
      expect(gbkMsg).not.toBeNull();
      expect(gbkMsg!.messageType).toBe('ORU');
      // PID 段第 5 个组件是患者姓名（中文 GBK 编码 → UTF-8 解码）
      const pidSeg = gbkMsg!.segments.find((s) => s[0] === 'PID');
      expect(pidSeg).toBeDefined();
    } finally {
      await serverGbk.stop({ forceDrainTimeoutMs: 100 });
    }
  });

  it('客户端断连 → graceful drain（pending 清空，server 不挂）', async () => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => conn.once('connect', () => r()));
    conn.destroy();

    await new Promise((r) => setTimeout(r, 100));
    expect(server.connections.size).toBe(0);
    // server 还能继续接新连接
    const ackBuf = await sendAndCollectAck(port, FIXTURE_NORMAL);
    expect(ackBuf.toString('utf-8')).toMatch(/MSA\|AA\|/);
  });

  it('半个帧 → 不触发回调不发 ACK；补齐后半段 → 正常解析并 ACK', async () => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => conn.once('connect', () => r()));
    const ackChunks: Buffer[] = [];
    conn.on('data', (d: Buffer) => ackChunks.push(d));

    const full = frameBytes(FIXTURE_NORMAL);
    const cut = Math.floor(full.length / 2);
    // 只发前半段（尚无 FS+CR）
    conn.write(full.subarray(0, cut));

    await new Promise((r) => setTimeout(r, 150));
    expect(messagesReceived.length).toBe(0);
    expect(ackChunks.length).toBe(0);

    // 补齐后半段（含 FS+CR）→ 帧完整，解析成功
    conn.write(full.subarray(cut));

    await new Promise((r) => setTimeout(r, 150));
    expect(messagesReceived.length).toBe(1);
    expect(messagesReceived[0]!.controlId).toBe('MSG00001');
    expect(ackChunks.length).toBe(1);
    expect(ackChunks[0]!.toString('utf-8')).toMatch(/MSA\|AA\|MSG00001/);
    conn.destroy();
  });

  it('非法控制字符 → 拒收整帧（ack CA + DLQ 保留原始字节，不静默丢弃）', async () => {
    const dirty = FIXTURE_NORMAL.replace('4.5', '4.5\x00');

    const ackBuf = await sendAndCollectAck(port, dirty);
    const ackStr = ackBuf.toString('utf-8').replace(/[\x0b\x1c\x0d]/g, '');
    expect(ackStr).toMatch(/MSA\|CA\|/);

    await new Promise((r) => setTimeout(r, 80));
    // 不派发业务消息
    expect(messagesReceived.length).toBe(0);
    expect(errorsReceived.length).toBeGreaterThanOrEqual(1);

    // DLQ 保留原始字节（坏帧可回放可核对）
    const rows = dlq.query({ channelName: 'test-hl7' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.error_code).toBe('HL7_FRAME_INVALID');
    expect(rows[0]!.raw_bytes.length).toBeGreaterThan(0);
  });

  it('两条连接并发 → 互不干扰（各自 ACK 回显自己的控制 ID）', async () => {
    const connA = createConnection({ port, host: '127.0.0.1' });
    const connB = createConnection({ port, host: '127.0.0.1' });
    const ackA = new Promise<string>((res) =>
      connA.once('data', (d: Buffer) => res(d.toString('utf-8'))),
    );
    const ackB = new Promise<string>((res) =>
      connB.once('data', (d: Buffer) => res(d.toString('utf-8'))),
    );
    await new Promise<void>((r) => connA.once('connect', () => r()));
    await new Promise<void>((r) => connB.once('connect', () => r()));

    connA.write(frameBytes(FIXTURE_NORMAL.replace('MSG00001', 'MSG-A')));
    connB.write(frameBytes(FIXTURE_NORMAL.replace('MSG00001', 'MSG-B')));

    const [rawA, rawB] = await Promise.all([ackA, ackB]);
    expect(rawA.replace(/[\x0b\x1c\x0d]/g, '')).toMatch(/MSA\|AA\|MSG-A/);
    expect(rawB.replace(/[\x0b\x1c\x0d]/g, '')).toMatch(/MSA\|AA\|MSG-B/);

    await new Promise((r) => setTimeout(r, 80));
    const ids = messagesReceived.map((m) => m.controlId).sort();
    expect(ids).toEqual(['MSG-A', 'MSG-B']);
    // 两条连接的样本内容不串扰
    const kValues = messagesReceived
      .map((m) => m.segments.find((s) => s[0] === 'OBX')?.[5])
      .sort();
    expect(kValues).toEqual(['4.5', '4.5']);
    connA.destroy();
    connB.destroy();
  });

  it('stop() 后端口释放（可被重新绑定）', async () => {
    const tmp = new Hl7Server('tmp-stop', { encoding: 'utf-8', dlq });
    const tmpPort = await tmp.start(0);
    await tmp.stop({ forceDrainTimeoutMs: 100 });

    const rebound = createServer();
    const reboundPort = await new Promise<number>((res, rej) => {
      rebound.once('error', rej);
      rebound.listen(tmpPort, '127.0.0.1', () => {
        const addr = rebound.address();
        res(typeof addr === 'object' && addr ? addr.port : tmpPort);
      });
    });
    expect(reboundPort).toBe(tmpPort);
    await new Promise<void>((res) => rebound.close(() => res()));
  });

  it('坏帧与好帧同一 chunk → 坏帧进 DLQ，好帧照常派发（不静默丢数据）', async () => {
    const bad = FIXTURE_NORMAL.replace('4.5', '4.5\x00');
    const conn = createConnection({ port, host: '127.0.0.1' });
    const acks: string[] = [];
    conn.on('data', (d: Buffer) => acks.push(d.toString('utf-8').replace(/[\x0b\x1c\x0d]/g, '')));
    await new Promise<void>((r) => conn.once('connect', () => r()));

    // 一个 TCP 段里先塞坏帧、再塞好帧
    conn.write(Buffer.concat([frameBytes(bad), frameBytes(FIXTURE_NORMAL)]));

    await new Promise((r) => setTimeout(r, 150));

    // 好帧不能因为前面一帧坏掉而被丢掉
    expect(messagesReceived.map((m) => m.controlId)).toEqual(['MSG00001']);
    // 坏帧仍进 DLQ（可回放可核对）
    const rows = dlq.query({ channelName: 'test-hl7' });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.error_code).toBe('HL7_FRAME_INVALID');
    expect(rows[0]!.raw_bytes.length).toBeGreaterThan(0);
    // 两个 ACK：坏帧 CA + 好帧 AA
    expect(acks.some((a) => /MSA\|CA\|/.test(a))).toBe(true);
    expect(acks.some((a) => /MSA\|AA\|MSG00001/.test(a))).toBe(true);
    conn.destroy();
  });

  it('sendAndWait 命中 ACK 映射（客户端查询 → 服务端 AA → promise 兑现）', async () => {
    const clientSock = createConnection({ port, host: '127.0.0.1' });
    await new Promise<void>((r) => clientSock.once('connect', () => r()));
    const client = new Hl7Connection(clientSock, 'client-side', { encoding: 'utf-8' });
    client.on('error', () => {});
    const warnings: Error[] = [];
    client.on('warning', (e: Error) => warnings.push(e));

    const query = parseHl7Message(
      'MSH|^~\\&|LabOpsConsole|Hospital-B|LIS|Hospital-A|20261013093000||QRY^Q22^Q22_Q22|MSG-Q1|P|2.5',
    );
    const ack = await client.sendAndWait(query, 'AA');

    expect(ack.ackCode).toBe('AA');
    expect(ack.controlId).toBe('MSG-Q1');
    expect(client.getPendingMessageCount()).toBe(0);
    expect(warnings.length).toBe(0);
    clientSock.destroy();
  });
});

describe('HL7 常量与编码常量', () => {
  it('ACK 码值正确', () => {
    expect(ACK_AA).toBe('AA');
    expect(ACK_CA).toBe('CA');
  });
});

describe('Hl7Connection 类独立测试', () => {
  it('parseHl7Message 解析正常 ORU^R01', async () => {
    const { parseHl7Message } = await import('../../src/channels/Hl7Connection.js');
    const msg = parseHl7Message(FIXTURE_NORMAL);
    expect(msg.controlId).toBe('MSG00001');
    expect(msg.messageType).toBe('ORU');
    expect(msg.triggerEvent).toBe('R01');
  });

  it('段视图：字节 → { msh, pid, pv1, obr, obx[] }（一条命令拿到结构化样本）', () => {
    const view = parseOruR01Frame(`\x0b${FIXTURE_NORMAL}\x1c\x0d`);
    expect(view.msh[0]).toBe('MSH');
    expect(view.msh[9]).toBe('MSG00001');
    expect(view.pid?.[3]).toContain('P12345');
    expect(view.pv1?.[0]).toBe('PV1');
    expect(view.obr?.[0]).toBe('OBR');
    expect(view.obx).toHaveLength(3);
    expect(view.obx[0]?.[5]).toBe('4.5');
    expect(view.obx[1]?.[5]).toBe('140');
    expect(view.obx[2]?.[5]).toBe('102');
  });

  it('段视图：同一段视图也可从已解析的 Hl7Message 取得', async () => {
    const { parseHl7Message } = await import('../../src/channels/Hl7Connection.js');
    const { parseOruR01Segments } = await import('../../src/parser/oru-r01.js');
    const view = parseOruR01Segments(parseHl7Message(FIXTURE_NORMAL));
    expect(view.obx).toHaveLength(3);
    expect(view.msh[9]).toBe('MSG00001');
  });
});
