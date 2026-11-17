/**
 * bytestream + SerialPort + Private + channel-loader 单元测试
 *
 * 用例覆盖（任务 T5 步骤表）：
 * 1. ASTM 切帧（ENQ 0x05 起 + EOT 0x04 收） → ByteStreamChannel 完整帧 emit
 * 2. 串口 mock → SerialPortChannel 走 fake factory 不连真实 serialport
 * 3. private yaml → PrivateBytesParser 从脱敏字节提取字段
 * 4. yaml schema 失败 → loadChannelYaml 抛 ChannelConfigError
 * 5. channel-loader 加载 example-hl7.yaml 成功
 * 6. autoRespond 匹配后立刻回包（链路级握手）
 * 7. filterMessageBytes 单测（stripSequences + keepControlChars）
 * 8. ByteSequenceMatcher 滑动窗口 + reset
 *
 * T5 追加（字节流通道切帧矩阵）：
 * 9. 完整帧触发 / 半帧不触发 / startChar 复位清窗 / 粘包拆成两帧
 * 10. 跨 read 边界不丢字节（pendingStart 越界回归）
 * 11. autoRespond 应答字节逐字节正确 + 帧外握手也应答
 * 12. GBK 非 UTF-8 字节解码（中文检验项名不乱码）
 * 13. ASTM fixture 走字节流通道 → 帧体含全部 4R 结果行
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import iconv from 'iconv-lite';
import {
  ByteStreamChannel,
  ByteStreamChannelConnection,
  ByteSequenceMatcher,
  filterMessageBytes,
  buildByteStreamConfig,
  PrivateBytesParser,
  buildPrivateBytesConfig,
  type FramedMessage,
  type MinimalSerialPort,
  SerialPortChannel,
  loadChannelYaml,
  loadAllChannels,
  SerialPortChannel as NamedSerialPortChannel,
} from '../../src/channels/index.js';
import { defaultSerialPortFactory } from '../../src/channels/SerialPortChannel.js';
import { ChannelConfigError } from '../../src/shared/errors.js';

/**
 * 连接级替身：可精确控制每次 read 的字节边界。
 * TCP 的 read 边界由内核决定，测试必须能主动制造「帧跨 read」的场景，
 * 否则切帧错位这类缺陷在测试里根本不会暴露。
 */
class FakeSocket extends EventEmitter {
  remoteAddress = '127.0.0.1';
  remotePort = 4242;
  destroyed = false;
  readonly written: Buffer[] = [];

  write(data: Buffer): boolean {
    this.written.push(Buffer.from(data));
    return true;
  }

  end(): void {
    /* noop */
  }

  /** 模拟一次 read（socket 'data' 事件） */
  feed(data: Buffer): void {
    this.emit('data', data);
  }
}

/** 建一条连接级通道 + 收集其帧 */
function makeConnection(
  config: ReturnType<typeof buildByteStreamConfig>,
  encoding = 'utf-8',
): { conn: ByteStreamChannelConnection; socket: FakeSocket; frames: FramedMessage[] } {
  const channel = new ByteStreamChannel('test-bytestream-conn', {
    encoding,
    initialConfig: config,
  });
  const socket = new FakeSocket();
  const conn = new ByteStreamChannelConnection(channel, socket as unknown as Socket);
  const frames: FramedMessage[] = [];
  conn.on('framed-message', (m: FramedMessage) => frames.push(m));
  return { conn, socket, frames };
}

/** ASTM 常用控制字节 */
const STX = 0x02; // start of text（ASTM 帧起）
const ETX = 0x03; // end of text（ASTM 帧收）
const ENQ = 0x05; // enquire（链路握手）
const ACK = 0x06; // acknowledge（链路应答）


function waitForFramedMessage(
  ch: ByteStreamChannel,
  timeoutMs = 1000,
): Promise<FramedMessage> {
  return new Promise<FramedMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      ch.removeListener('framed-message', onMsg);
      reject(new Error('framed-message 收集超时'));
    }, timeoutMs);
    function onMsg(m: FramedMessage) {
      clearTimeout(timer);
      resolve(m);
    }
    ch.once('framed-message', onMsg);
  });
}

function connectAndSend(port: number, bytes: Buffer, receiveTimeoutMs = 1000): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const conn = createConnection({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('回包超时'));
    }, receiveTimeoutMs);
    conn.once('connect', () => conn.write(bytes));
    conn.once('data', (data: Buffer) => {
      clearTimeout(timer);
      resolve(data);
      conn.end();
    });
    conn.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('ByteSequenceMatcher 滑动窗口', () => {
  it('字节序列匹配 - 单字节 pattern（ENQ/ACK）', () => {
    const matcher = new ByteSequenceMatcher([
      { pattern: Buffer.from([0x05]), response: Buffer.from([0x06]) },
    ]);
    expect(matcher.match(0x05).length).toBe(1);
    expect(matcher.match(0x05)[0].equals(Buffer.from([0x06]))).toBe(true);
    expect(matcher.match(0xff).length).toBe(0);
  });

  it('滑动窗口匹配 - 跨多次 match 才能命中', () => {
    const matcher = new ByteSequenceMatcher([
      { pattern: Buffer.from([0x05, 0x01]), response: Buffer.from([0x06]) },
    ]);
    expect(matcher.match(0x05).length).toBe(0);
    expect(matcher.match(0x01).length).toBe(1);
  });

  it('reset 丢弃部分匹配进度', () => {
    const matcher = new ByteSequenceMatcher([
      { pattern: Buffer.from([0x05, 0x01]), response: Buffer.from([0x06]) },
    ]);
    matcher.match(0x05);
    matcher.reset();
    expect(matcher.match(0x01).length).toBe(0);
  });
});

describe('filterMessageBytes', () => {
  it('stripSequences 整体删除', () => {
    // 构造 0xAA 0xBB 0xCC 0xDD，对 strip 序列 0xBB 单字节
    const buf = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const out = filterMessageBytes(
      buf,
      [Buffer.from([0xbb])],
      false,
    );
    expect(Array.from(out)).toEqual([0xaa, 0xcc, 0xdd]);
  });

  it('stripControlChars=true 但 keepControlChars 例外', () => {
    // 0x0D 在 buf 中以单字节存在：0x41 0x0D 0x42
    const buf = Buffer.from([0x41, 0x0d, 0x42]);
    const without_keep = filterMessageBytes(buf, [], true, []);
    expect(without_keep.toString('hex')).toBe('4142');
    const with_keep = filterMessageBytes(buf, [], true, [0x0d]);
    expect(with_keep.toString('hex')).toBe('410d42');
  });

  it('无 strip 配置时返回原 buffer', () => {
    const buf = Buffer.from('abc');
    const out = filterMessageBytes(buf, [], false);
    expect(out).toBe(buf);
  });
});

describe('ByteStreamChannel ASTM 切帧', () => {
  let ch: ByteStreamChannel;

  beforeEach(() => {
    ch = new ByteStreamChannel('test-bytestream', {
      initialConfig: buildByteStreamConfig({
        startChar: 0x05,
        endChar: 0x04,
        bodyEncoding: 'utf-8',
        stripSequences: ['06'], // ASTM ACK
        keepControlChars: [0x0d, 0x0a],
        stripControlChars: false,
        autoRespond: [
          { patternHex: '05', responseHex: '06' },
        ],
      }),
    });
  });

  afterEach(async () => {
    await ch.stop({ forceDrainTimeoutMs: -1 });
  });

  it('ENQ 起 + EOT 收 切完整帧', async () => {
    const port = await ch.start(0);
    const framedP = waitForFramedMessage(ch);
    // ASTM E1394: ENQ 起 + body + EOT 收（脱敏字节：H|...|CR\nP|...|CR\nO|...|CR\nEOT）
    const payload = Buffer.concat([
      Buffer.from([0x05]),
      Buffer.from('1H|\\^&|||LAB|||\rP|1||12345\rO|1||K+|||4.5\r', 'utf-8'),
      Buffer.from([0x04]),
    ]);
    // 客户端只发；server 立刻 ack 0x06（autoRespond）
    const conn = createConnection({ port, host: '127.0.0.1' });
    const ackChunks: Buffer[] = [];
    conn.on('data', (data) => ackChunks.push(data));
    await new Promise<void>((r) => conn.once('connect', () => r()));
    conn.write(payload);
    const framed = await framedP;
    expect(framed.body.length).toBeGreaterThan(0);
    expect(framed.body.toString('utf-8').includes('K+')).toBe(true);
    conn.end();
    // 等 autoRespond 回包到位
    await new Promise((r) => setTimeout(r, 50));
    const ack = Buffer.concat(ackChunks);
    expect(ack.includes(0x06)).toBe(true);
  });

  it('autoRespond 匹配 ENQ 立刻回包 0x06', async () => {
    const port = await ch.start(0);
    const ackP = connectAndSend(port, Buffer.from([0x05]));
    const ack = await ackP;
    expect(ack[0]).toBe(0x06);
  });
});

describe('SerialPortChannel 串口 mock', () => {
  it('open() 用 fake port factory 收到 framed-message', async () => {
    // 构造 fake serial port：emit 'data' 模拟仪器推字节
    class FakeSerialPort extends EventEmitter {
      isOpen = false;
      writes: Buffer[] = [];
      write(data: Buffer | string): boolean {
        this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        return true;
      }
      open(cb: (err: Error | null) => void): void {
        this.isOpen = true;
        setImmediate(() => cb(null));
      }
      close(cb: (err: Error | null) => void): void {
        this.isOpen = false;
        setImmediate(() => cb(null));
      }
    }
    const factoryCalls: { path: string; baudRate: number }[] = [];
    const openPort: (path: string, opts: { baudRate: number }) => MinimalSerialPort = (
      path,
      opts,
    ) => {
      factoryCalls.push({ path, baudRate: opts.baudRate });
      return new FakeSerialPort() as unknown as MinimalSerialPort;
    };

    const cfg = buildByteStreamConfig({
      startChar: 0x02,
      endChar: 0x03,
      bodyEncoding: 'utf-8',
      autoRespond: [],
      stripSequences: [],
      stripControlChars: false,
      keepControlChars: [],
    });
    const ch = new SerialPortChannel('test-serial', cfg, {
      path: '/dev/fake-ttyS0',
      baudRate: 19200,
      openPort,
      encoding: 'utf-8',
    });
    const frammedP = new Promise<{ body: Buffer; bodyText: string }>((resolve) => {
      ch.once('framed-message', (m: { body: Buffer; bodyText: string }) => resolve(m));
    });

    await ch.open();
    expect(factoryCalls[0]).toEqual({ path: '/dev/fake-ttyS0', baudRate: 19200 });

    // 通过 portInstance's listeners 模拟仪器推送（直接 emit data）
    const port = (ch as unknown as { portInstance: FakeSerialPort }).portInstance;
    port.emit('data', Buffer.concat([Buffer.from([0x02]), Buffer.from('K=4.5', 'utf-8'), Buffer.from([0x03])]));

    const framed = await frammedP;
    // body 包含 framing bytes（startChar/endChar）；下游解析时跳过即可
    expect(framed.body[0]).toBe(0x02);
    expect(framed.body[framed.body.length - 1]).toBe(0x03);
    expect(framed.body.toString('utf-8').includes('K=4.5')).toBe(true);

    await ch.close();
    expect(ch.isOpen()).toBe(false);
  });

  it('openPort 未传且 serialport 包不可用时优雅失败（非单测硬要求，只跑通即可）', async () => {
    // 这里不直接断网；只用 default factory 可能在 serialport 未安装时抛错
    // 故本用例仅当 open 已显式注入端口时才成功；本条 skipped-on-no-serialport 留作日志
    const cfg = buildByteStreamConfig({
      startChar: 0x02,
      endChar: 0x03,
      bodyEncoding: 'utf-8',
      autoRespond: [],
      stripSequences: [],
      stripControlChars: false,
      keepControlChars: [],
    });
    const ch = new NamedSerialPortChannel('test-serial-no-port', cfg, {
      path: '/nonexistent/serial',
      baudRate: 9600,
      openPort: (_path, _opts) => {
        const p = new EventEmitter() as unknown as MinimalSerialPort;
        (p as unknown as { isOpen: boolean }).isOpen = false;
        (p as unknown as { write: (d: Buffer) => boolean }).write = () => true;
        (p as unknown as { close: (cb: (err: Error | null) => void) => void }).close = (
          cb,
        ) => cb(null);
        (p as unknown as { open: (cb: (err: Error | null) => void) => void }).open = (
          cb,
        ) => cb(new Error('mock: port not present'));
        return p;
      },
    });
    await expect(ch.open()).rejects.toThrow();
  });
});

describe('PrivateBytesParser 私有协议 yaml', () => {
  it('从脱敏字节提取字段（offset+length）', () => {
    const cfg = buildPrivateBytesConfig({
      name: 'example-biochem',
      deviceId: 'DEV-001',
      startTriggerHex: '0x02',
      endTriggerHex: '0x03',
      fields: [
        { name: 'patientId', offset: 0, length: 8, encoding: 'utf-8' },
        { name: 'potassium', offset: 8, length: 5, encoding: 'utf-8' },
        { name: 'sodium', offset: 13, length: 5, encoding: 'utf-8' },
      ],
    });
    const parser = new PrivateBytesParser(cfg);
    // 构造 0x02 + patientId(8) + K(5) + Na(5) + 0x03
    const raw = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from('12345678', 'utf-8'),
      Buffer.from('4.5  ', 'utf-8'),
      Buffer.from('140  ', 'utf-8'),
      Buffer.from([0x03]),
    ]);
    const r = parser.parse(raw);
    expect(r.fields.patientId).toBe('12345678');
    expect(r.fields.potassium).toBe('4.5');
    expect(r.fields.sodium).toBe('140');
    expect(r.extractedCount).toBe(3);
    expect(r.declaredCount).toBe(3);
  });

  it('字段偏移越界时不抛错，字段为空', () => {
    const cfg = buildPrivateBytesConfig({
      name: 'example',
      deviceId: 'X',
      startTriggerHex: '0x02',
      endTriggerHex: '0x03',
      fields: [{ name: 'na', offset: 100, length: 5, encoding: 'utf-8' }],
    });
    const parser = new PrivateBytesParser(cfg);
    const raw = Buffer.from([0x02, 0x41, 0x03]);
    const r = parser.parse(raw);
    expect(r.fields.na).toBe('');
    expect(r.extractedCount).toBe(0);
  });

  it('startTrigger 不匹配 → 抛 PrivateBytesParseFailError', () => {
    const cfg = buildPrivateBytesConfig({
      name: 'example',
      deviceId: 'X',
      startTriggerHex: '0x02',
      endTriggerHex: '0x03',
      fields: [],
    });
    const parser = new PrivateBytesParser(cfg);
    const raw = Buffer.from([0xff, 0x03]);
    expect(() => parser.parse(raw)).toThrow();
  });
});

describe('channel-loader yaml schema', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lab-ops-yml-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('合法 hl7 yaml → loadChannelYaml 返回 yaml', () => {
    const raw = `
name: ok-hl7
type: hl7
deviceListenPort: 2575
encoding: utf-8
`;
    const cfg = loadChannelYaml({ rawYaml: raw, fileName: 'ok-hl7.yaml' });
    expect(cfg.type).toBe('hl7');
    if (cfg.type === 'hl7') {
      expect(cfg.deviceListenPort).toBe(2575);
    }
  });

  it('缺 deviceListenPort → 抛 ChannelConfigError', () => {
    const raw = `
name: bad
type: hl7
encoding: utf-8
`;
    expect(() => loadChannelYaml({ rawYaml: raw, fileName: 'bad.yaml' })).toThrow(
      ChannelConfigError,
    );
  });

  it('type 非法 → 抛 ChannelConfigError', () => {
    const raw = `
name: bad-type
type: unicorn
deviceListenPort: 2575
`;
    expect(() => loadChannelYaml({ rawYaml: raw, fileName: 'u.yaml' })).toThrow(
      ChannelConfigError,
    );
  });

  it('合法 bytestream yaml + 字段偏移 hex 解析', () => {
    const raw = `
name: ok-bs
type: bytestream
serialPort: /dev/ttyUSB0
baudRate: 9600
startCharHex: '0x05'
endCharHex: '0x04'
keepControlChars: [0x0d, 0x0a]
`;
    const cfg = loadChannelYaml({ rawYaml: raw, fileName: 'ok-bs.yaml' });
    expect(cfg.type).toBe('bytestream');
  });

  it('loadAllChannels 能加载项目自带 example-hl7.yaml', async () => {
    // 拷贝 example-hl7.yaml 到临时目录，确保文件存在
    const examplePath = join(tmpDir, 'example-hl7.yaml');
    writeFileSync(
      examplePath,
      readFileSync(join(__dirname, '../../channels/example-hl7.yaml'), 'utf-8'),
    );
    const channels = await loadAllChannels(tmpDir);
    expect(channels.length).toBe(1);
    expect(channels[0].yaml.type).toBe('hl7');
    expect(channels[0].yaml.name).toBe('example-hl7');
  });
});

/**
 * T5 · 字节流通道切帧矩阵（连接级，可精确控制 read 边界）
 *
 * 帧格式：<STX> 载荷 <ETX>；startChar / endChar 由通道配置字段化。
 */
describe('ByteStreamChannel 切帧矩阵', () => {
  const cfg = () =>
    buildByteStreamConfig({
      startChar: STX,
      endChar: ETX,
      bodyEncoding: 'utf-8',
    });

  it('完整帧触发：<STX>载荷<ETX> 一次 read → 恰好一帧', () => {
    const { socket, frames } = makeConnection(cfg());
    socket.feed(Buffer.concat([Buffer.from([STX]), Buffer.from('K=4.5', 'utf-8'), Buffer.from([ETX])]));
    expect(frames).toHaveLength(1);
    expect(frames[0].body.toString('utf-8')).toContain('K=4.5');
    // 帧体保留 framing 字节（startChar/endChar），下游解析层按协议跳过
    expect(frames[0].body[0]).toBe(STX);
    expect(frames[0].body[frames[0].body.length - 1]).toBe(ETX);
  });

  it('半帧不触发：只有 <STX> + 半截载荷 → 不出帧；补齐后仅出一帧', () => {
    const { socket, frames } = makeConnection(cfg());
    socket.feed(Buffer.concat([Buffer.from([STX]), Buffer.from('K=4.', 'utf-8')]));
    expect(frames).toHaveLength(0); // 半帧不触发回调
    socket.feed(Buffer.concat([Buffer.from('5'), Buffer.from([ETX])]));
    expect(frames).toHaveLength(1); // 补齐后触发一次，不重复
    expect(frames[0].body.toString('utf-8')).toContain('K=4.5');
  });

  it('startChar 复位清窗：新 <STX> 丢弃上一段残帧，只出后一帧', () => {
    const { socket, frames } = makeConnection(cfg());
    socket.feed(
      Buffer.concat([
        Buffer.from([STX]),
        Buffer.from('PARTIAL', 'utf-8'), // 未收帧的残段
        Buffer.from([STX]), // 帧重启 → 残段应被丢弃
        Buffer.from('K=4.5', 'utf-8'),
        Buffer.from([ETX]),
      ]),
    );
    expect(frames).toHaveLength(1);
    const body = frames[0].body.toString('utf-8');
    expect(body).toContain('K=4.5');
    expect(body).not.toContain('PARTIAL');
  });

  it('粘包拆成两帧：一次 read 内两帧 → 出两帧且内容互不串', () => {
    const { socket, frames } = makeConnection(cfg());
    socket.feed(
      Buffer.concat([
        Buffer.from([STX]),
        Buffer.from('FIRST', 'utf-8'),
        Buffer.from([ETX]),
        Buffer.from([STX]),
        Buffer.from('SECOND', 'utf-8'),
        Buffer.from([ETX]),
      ]),
    );
    expect(frames).toHaveLength(2);
    expect(frames[0].body.toString('utf-8')).toContain('FIRST');
    expect(frames[0].body.toString('utf-8')).not.toContain('SECOND');
    expect(frames[1].body.toString('utf-8')).toContain('SECOND');
    expect(frames[1].body.toString('utf-8')).not.toContain('FIRST');
  });

  it('跨 read 边界不丢字节：帧跨两次 read 且 startChar 不在首块开头', () => {
    const { socket, frames } = makeConnection(cfg());
    // 第一块：前置噪声 + <STX> + 部分载荷（startChar 不在偏移 0）
    socket.feed(
      Buffer.concat([
        Buffer.from('NOISE', 'utf-8'),
        Buffer.from([STX]),
        Buffer.from('AB', 'utf-8'),
      ]),
    );
    expect(frames).toHaveLength(0);
    // 第二块：剩余载荷 + <ETX>
    socket.feed(Buffer.concat([Buffer.from('CD', 'utf-8'), Buffer.from([ETX])]));

    expect(frames).toHaveLength(1);
    const body = frames[0].body.toString('utf-8');
    // 载荷中间字节一个都不能丢（回归：pendingStart 跨 read 复用会切错起点）
    expect(body).toContain('ABCD');
    expect(body).not.toContain('NOISE');
  });

  it('跨 read 边界：一块内多帧 + 末帧跨块 → 三帧全出且顺序正确', () => {
    const { socket, frames } = makeConnection(cfg());
    socket.feed(
      Buffer.concat([
        Buffer.from([STX]),
        Buffer.from('ONE', 'utf-8'),
        Buffer.from([ETX]),
        Buffer.from([STX]),
        Buffer.from('TWO', 'utf-8'),
      ]),
    );
    expect(frames).toHaveLength(1);
    socket.feed(Buffer.concat([Buffer.from('THREE', 'utf-8'), Buffer.from([ETX])]));
    expect(frames).toHaveLength(2);
    expect(frames[0].body.toString('utf-8')).toContain('ONE');
    expect(frames[1].body.toString('utf-8')).toContain('TWOTHREE');
  });
});

describe('autoRespond 自动应答', () => {
  it('应答字节逐字节正确：多字节 pattern → 精确回同样的响应字节', () => {
    const { socket } = makeConnection(
      buildByteStreamConfig({
        startChar: STX,
        endChar: ETX,
        bodyEncoding: 'utf-8',
        autoRespond: [{ patternHex: '05', responseHex: '0606' }],
      }),
    );
    socket.feed(Buffer.from([ENQ]));
    expect(socket.written).toHaveLength(1);
    expect(Array.from(socket.written[0])).toEqual([ACK, ACK]);
  });

  it('帧外握手也应答：应答发生在 framing 之前，不等帧收齐', () => {
    const { socket, frames } = makeConnection(
      buildByteStreamConfig({
        startChar: STX,
        endChar: ETX,
        bodyEncoding: 'utf-8',
        autoRespond: [{ patternHex: '05', responseHex: '06' }],
      }),
    );
    // 只发 ENQ，不发完整帧 → 依然应答，且不出帧
    socket.feed(Buffer.from([ENQ]));
    expect(socket.written.length).toBeGreaterThanOrEqual(1);
    expect(socket.written[0][0]).toBe(ACK);
    expect(frames).toHaveLength(0);
  });

  it('startChar 复位 matcher 窗口：残缺 pattern 被丢弃，不误触发应答', () => {
    const { socket } = makeConnection(
      buildByteStreamConfig({
        startChar: STX,
        endChar: ETX,
        bodyEncoding: 'utf-8',
        // 两字节 pattern：0x05 0x01；startChar 到来时窗口应被清空
        autoRespond: [{ patternHex: '0501', responseHex: '06' }],
      }),
    );
    socket.feed(Buffer.from([ENQ])); // 半个 pattern
    expect(socket.written).toHaveLength(0);
    socket.feed(Buffer.from([STX])); // 帧重启 → 窗口清空
    socket.feed(Buffer.from([0x01])); // 补上后半段，但前半段已被丢弃 → 不应答
    expect(socket.written).toHaveLength(0);
  });
});

describe('GBK 非 UTF-8 字节解码', () => {
  const gbkPayload = iconv.encode('钾 4.8 mmol/L', 'gbk');

  it('通道编码为 gbk 时中文检验项名解码正确', () => {
    const { socket, frames } = makeConnection(
      buildByteStreamConfig({
        startChar: STX,
        endChar: ETX,
        bodyEncoding: 'utf-8',
      }),
      'gbk',
    );
    socket.feed(
      Buffer.concat([
        Buffer.from([STX]),
        gbkPayload,
        Buffer.from([ETX]),
      ]),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].bodyText).toContain('钾');
    expect(frames[0].bodyText).toContain('4.8 mmol/L');
    // 原始字节仍是 GBK 两字节序列，未被就地改写
    expect(frames[0].body.includes(iconv.encode('钾', 'gbk'))).toBe(true);
  });

  it('通道编码为 utf-8 时同一 GBK 字节解不出中文（证明编码确实生效）', () => {
    const { socket, frames } = makeConnection(
      buildByteStreamConfig({
        startChar: STX,
        endChar: ETX,
        bodyEncoding: 'utf-8',
      }),
      'utf-8',
    );
    socket.feed(
      Buffer.concat([Buffer.from([STX]), gbkPayload, Buffer.from([ETX])]),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].bodyText).not.toContain('钾');
  });

  it('非法字节不抛错：解码失败退化为替换字符，通道不断链', () => {
    const { socket, frames } = makeConnection(
      buildByteStreamConfig({
        startChar: STX,
        endChar: ETX,
        bodyEncoding: 'utf-8',
      }),
      'utf-8',
    );
    socket.feed(
      Buffer.concat([
        Buffer.from([STX]),
        Buffer.from([0xff, 0xfe, 0x41]),
        Buffer.from([ETX]),
      ]),
    );
    expect(frames).toHaveLength(1);
    expect(typeof frames[0].bodyText).toBe('string');
  });
});

describe('ASTM fixture 走字节流通道', () => {
  it('脱敏 ASTM 样例 → 通道切出的帧体含全部 4R 结果行', () => {
    const fixturePath = join(__dirname, '../fixtures/astm-record-sample.txt');
    const record = readFileSync(fixturePath, 'utf-8');
    const { socket, frames } = makeConnection(
      buildByteStreamConfig({
        startChar: STX,
        endChar: ETX,
        bodyEncoding: 'utf-8',
        keepControlChars: [0x0d, 0x0a],
      }),
    );
    socket.feed(
      Buffer.concat([
        Buffer.from([STX]),
        Buffer.from(record, 'utf-8'),
        Buffer.from([ETX]),
      ]),
    );
    expect(frames).toHaveLength(1);
    const body = frames[0].body.toString('utf-8');
    const resultLines = body.split(/\r\n|\r|\n/).filter((l) => l.startsWith('4R|'));
    expect(resultLines).toHaveLength(4); // K / NA / CL / GLU
    expect(body).toContain('3.5-5.5');
    expect(body).toContain('生化七项');
  });
});

describe('SerialPortChannel 跨 read 不丢字节（回归）', () => {
  class FakeSerialPort extends EventEmitter {
    isOpen = false;
    writes: Buffer[] = [];
    write(data: Buffer | string): boolean {
      this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return true;
    }
    open(cb: (err: Error | null) => void): void {
      this.isOpen = true;
      setImmediate(() => cb(null));
    }
    close(cb: (err: Error | null) => void): void {
      this.isOpen = false;
      setImmediate(() => cb(null));
    }
  }

  it('帧跨两次 data 事件 → 载荷完整不丢字节', async () => {
    const cfg = buildByteStreamConfig({
      startChar: STX,
      endChar: ETX,
      bodyEncoding: 'utf-8',
    });
    const ch = new SerialPortChannel('test-serial-split', cfg, {
      path: '/dev/fake-ttyS1',
      baudRate: 9600,
      openPort: () => new FakeSerialPort() as unknown as MinimalSerialPort,
      encoding: 'utf-8',
    });
    const framedP = new Promise<{ body: Buffer }>((resolve) => {
      ch.once('framed-message', (m: { body: Buffer }) => resolve(m));
    });
    await ch.open();
    const port = (ch as unknown as { portInstance: FakeSerialPort }).portInstance;
    port.emit('data', Buffer.concat([Buffer.from('NOISE'), Buffer.from([STX]), Buffer.from('AB')]));
    port.emit('data', Buffer.concat([Buffer.from('CD'), Buffer.from([ETX])]));

    const framed = await framedP;
    expect(framed.body.toString('utf-8')).toContain('ABCD');
    await ch.close();
  });
});

/**
 * T5 · 真实 serialport 接口兼容性
 *
 * 串口替身只能出现在测试数据层；产品代码必须按真实 serialport 的构造形状
 * 建端口，否则真实仪器串口永远打不开（单元测试用替身时看不出来）。
 */
describe('serialport 真实接口兼容性', () => {
  it('真实 serialport 包：构造成功，open 失败是路径错误而非参数形状错误', async () => {
    const port = await defaultSerialPortFactory('/dev/lab-ops-console-no-such-tty', {
      baudRate: 9600,
    });
    expect(port.isOpen).toBe(false);

    const err = await new Promise<Error | null>((resolve) => {
      port.open((e) => resolve(e));
    });
    expect(err).not.toBeNull();
    // serialport ≥ 12 误用位置参数会在构造期抛 '"path" is not defined'；
    // 走到 open 才失败说明构造形状正确，错误来自真实设备层。
    expect(err!.message).not.toContain('is not defined');
    expect(err!.message).toMatch(/no-such-tty|cannot open|ENOENT|不存在/i);
  });

  it('serialport ≥ 12 分支：传单一 options 对象 { path, baudRate, autoOpen:false }', async () => {
    const captured: unknown[] = [];
    class OptionsObjectSerialPort extends EventEmitter {
      isOpen = false;
      constructor(...args: unknown[]) {
        super();
        captured.push(args);
      }
      write(): boolean {
        return true;
      }
      open(cb: (e: Error | null) => void): void {
        cb(null);
      }
      close(cb: (e: Error | null) => void): void {
        cb(null);
      }
    }
    vi.doMock('serialport', () => ({ SerialPort: OptionsObjectSerialPort }));
    try {
      const port = await defaultSerialPortFactory('/dev/ttyLAB0', { baudRate: 19200 });
      expect(port.isOpen).toBe(false);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual([
        { path: '/dev/ttyLAB0', baudRate: 19200, autoOpen: false },
      ]);
    } finally {
      vi.doUnmock('serialport');
      vi.resetModules();
    }
  });

  it('serialport ≤ 11 分支：传位置参数 (path, { baudRate, autoOpen:false })', async () => {
    const captured: unknown[] = [];
    class LegacySerialPort extends EventEmitter {
      isOpen = false;
      constructor(...args: unknown[]) {
        super();
        captured.push(args);
      }
      write(): boolean {
        return true;
      }
      open(cb: (e: Error | null) => void): void {
        cb(null);
      }
      close(cb: (e: Error | null) => void): void {
        cb(null);
      }
    }
    // 位置参数版本的构造器形参个数为 3
    Object.defineProperty(LegacySerialPort, 'length', { value: 3 });
    vi.doMock('serialport', () => ({ SerialPort: LegacySerialPort }));
    try {
      await defaultSerialPortFactory('/dev/ttyLEGACY0', { baudRate: 4800 });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual([
        '/dev/ttyLEGACY0',
        { baudRate: 4800, autoOpen: false },
      ]);
    } finally {
      vi.doUnmock('serialport');
      vi.resetModules();
    }
  });
});
