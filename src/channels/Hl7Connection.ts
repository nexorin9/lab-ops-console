/**
 * Hl7Connection —— 单个 HL7 v2 TCP 连接
 *
 * 设计原则：
 * - 复刻 medplum Hl7Connection 主路径：VT/FS/CR frame 切分 + parseMessages + ACK AA/CA 派发 + pendingMessages Map + sendAndWait
 * - 用 Node EventEmitter 替代源仓库 Hl7Base（避免引入 medplum/core）
 * - 不依赖 medplum Hl7Message：直接对 HL7 v2 字符串做行/段解析（医院场景 ORU^R01 简化足够）
 * - parseMessages 逐帧隔离：坏帧的错误进 errors[]，同批好帧照常返回（不静默丢数据）；
 *   上层 Hl7Server 决定 ack AA/CA + DLQ
 * - iconv-lite 处理 GBK 编码（中文 PID.5 等）
 */

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import iconv from 'iconv-lite';
import {
  Hl7ParseFailError,
  Hl7FrameInvalidError,
  Hl7EncodingFailError,
  BaseError,
  ErrorCode,
} from '../shared/errors.js';
import {
  VT,
  FS,
  CR,
  DEFAULT_ENCODING,
  ACK_AA,
  ACK_CA,
  DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS,
  ALLOWED_BODY_CONTROL_CHARS,
  ILLEGAL_CONTROL_CHAR_RANGE,
} from './constants.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels.Hl7Connection');

export interface Hl7ConnectionOptions {
  /** 强制 drain 超时（毫秒）—— stop() 时排空 pending 超时 */
  gracefulCloseTimeoutMs?: number;
  /** 每分钟限速（消息数）—— 0/undefined 不限速 */
  messagesPerMin?: number;
  /** 帧解码编码（utf-8 / gbk / gb18030…）—— 缺省 utf-8 */
  encoding?: string;
}

export interface Hl7Message {
  /** 整段消息（不含 VT / FS / CR） */
  raw: string;
  /** MSH 段字段数组（位置 0 是 fieldSep，位置 1 是 encoding chars，…） */
  msh: string[];
  /** 消息控制 ID（MSH.10） */
  controlId: string;
  /** 消息类型（MSH.9.1 ^ MSH.9.2） */
  messageType: string;
  /** 触发事件（MSH.9.2） */
  triggerEvent: string;
  /** 消息结构（MSH.9.3） */
  messageStructure: string;
  /** 段列表（不含 MSH） */
  segments: string[][];
  /** 接收时间戳 */
  receivedAt: number;
}

export interface ParsedAck {
  ackCode: 'AA' | 'AE' | 'AR' | 'CA';
  controlId: string;
}

/**
 * 一次 parseMessages 的结果 —— 好帧与坏帧分开交代。
 * - messages：解析成功的帧（上层照常 ack AA + 派发业务）
 * - errors：逐帧失败原因（error.context.rawBytes 为该帧原始字节，供 DLQ 落盘回放）
 */
export interface Hl7ParseOutcome {
  messages: Hl7Message[];
  errors: Error[];
}

const ONE_MINUTE = 60_000;

/**
 * 把 ORU^R01 解析成 Hl7Message 对象（极简版，不复用 medplum/core 的 Hl7Message 类）。
 * 简化策略：仅解析 MSH 段 + 后续行段切分。
 */
export function parseHl7Message(raw: string): Hl7Message {
  // 行段分隔：HL7 v2 用 \r 分隔；也允许 \n 兜底
  const lines = raw.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Hl7ParseFailError('HL7 帧为空', { rawLength: raw.length });
  }
  const mshLine = lines[0];
  if (!mshLine.startsWith('MSH')) {
    throw new Hl7ParseFailError('HL7 帧首段不是 MSH', { firstLine: mshLine.slice(0, 32) });
  }
  const fieldSep = mshLine.charAt(3);
  if (!fieldSep) {
    throw new Hl7ParseFailError('MSH 缺字段分隔符', { msh: mshLine.slice(0, 32) });
  }
  const encodingChars = mshLine.charAt(4);
  const msh = mshLine.split(fieldSep);
  // HL7 MSH 字段编号 1-indexed，但 msh[0] = "MSH"（段名），msh[1] = MSH.1（fieldSep，被 split 吃掉），
  // 因此 msh[N] 实际对应 MSH.(N+1)。即 MSH.10 = msh[9]，MSH.9 = msh[8]。
  const controlId = msh[9] ?? '';
  // MSH.9 = Message Type, 形如 ORU^R01^ORU_R01
  const msgTypeField = msh[8] ?? '';
  const msgTypeParts = msgTypeField.split('^');
  const messageType = msgTypeParts[0] ?? '';
  const triggerEvent = msgTypeParts[1] ?? '';
  const messageStructure = msgTypeParts[2] ?? '';

  if (!controlId) {
    throw new Hl7ParseFailError('MSH.10 消息控制 ID 缺失', { msh: mshLine.slice(0, 64) });
  }

  const segments: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const seg = lines[i].split(fieldSep);
    segments.push(seg);
  }

  return {
    raw,
    msh,
    controlId,
    messageType,
    triggerEvent,
    messageStructure,
    segments,
    receivedAt: Date.now(),
  };
}

/** 构造 ACK 帧（应用层 ack，AA / CA / AE / AR） */
export function buildAck(parsed: Hl7Message, ackCode: 'AA' | 'CA' | 'AE' | 'AR'): string {
  // HL7 MSH: msh[N] 对应 MSH.(N+1)
  // msh[0] = "MSH" 段名
  // msh[1] = MSH.2 (encoding chars)
  // msh[2] = MSH.3 (sending app)
  // msh[3] = MSH.4 (sending facility)
  // msh[4] = MSH.5 (receiving app)
  // msh[5] = MSH.6 (receiving facility)
  // msh[6] = MSH.7 (timestamp)
  // msh[7] = MSH.8 (security)
  // msh[8] = MSH.9 (message type)
  // msh[9] = MSH.10 (control id)
  // msh[10] = MSH.11 (processing id)
  // msh[11] = MSH.12 (version id)
  const fieldSep = '|'; // ACK frame 默认使用 |
  const encodingChars = parsed.msh[1] ?? '^~\\&';
  const sendingApp = parsed.msh[2] ?? '';
  const sendingFacility = parsed.msh[3] ?? '';
  const receivingApp = parsed.msh[4] ?? '';
  const receivingFacility = parsed.msh[5] ?? '';
  const msgType = parsed.msh[8] ?? '';
  const controlId = parsed.msh[9] ?? '';
  const processingId = parsed.msh[10] ?? 'P';
  const versionId = parsed.msh[11] ?? '2.5';

  const ackTimestamp = formatHl7Timestamp(new Date());

  // MSH frame: MSH|encoding|sendingApp|sendingFacility|receivingApp|receivingFacility|timestamp|security|messageType|controlId|processingId|versionId
  const mshLine = [
    'MSH',
    encodingChars,
    sendingApp,
    sendingFacility,
    receivingApp,
    receivingFacility,
    ackTimestamp,
    '',
    `ACK^${ackCode[0] === 'A' ? ackCode : 'ACK'}`,
    controlId,
    processingId,
    versionId,
  ].join(fieldSep);
  const msaLine = ['MSA', ackCode, controlId, '', '消息已接收'].join(fieldSep);

  return [mshLine, msaLine].join('\r');
}

/** HL7 v2 标准时间戳：YYYYMMDDHHMMSS */
export function formatHl7Timestamp(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

/**
 * 帧体内非法控制字符探测。
 * HL7 v2 帧体只允许 CR（段分隔）与 LF（部分仪器兜底）；其余 C0 控制字符与 DEL 一律非法。
 * 返回第一个非法字符的位置，供上层精确报错（不是整帧丢掉的笼统失败）。
 */
export function findIllegalControlChar(content: string): {
  char: string;
  code: number;
  index: number;
} | null {
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (ALLOWED_BODY_CONTROL_CHARS.has(code)) continue;
    const isC0 = code >= ILLEGAL_CONTROL_CHAR_RANGE.min && code <= ILLEGAL_CONTROL_CHAR_RANGE.max;
    if (isC0 || code === ILLEGAL_CONTROL_CHAR_RANGE.del) {
      return { char: content.charAt(i), code, index: i };
    }
  }
  return null;
}

/**
 * 宽松提取 MSH.10（消息控制 ID）。
 * 帧解析失败时上层仍需知道这条坏帧对应哪条消息（ACK 的 MSA.2 必须回显原控制 ID，
 * 否则仪器无法把 ACK 对上自己发出的那条报文）。
 */
export function extractControlId(content: string): string {
  const firstLine = content.split(/\r\n|\r|\n/, 1)[0] ?? '';
  if (!firstLine.startsWith('MSH')) return '';
  const fieldSep = firstLine.charAt(3);
  if (!fieldSep) return '';
  const msh = firstLine.split(fieldSep);
  // MSH.10 在 split 后的下标为 9（msh[0]=段名，msh[1]=MSH.1 字段分隔符被吃掉）
  return (msh[9] ?? '').trim();
}

export class Hl7Connection extends EventEmitter {
  readonly socket: Socket;
  readonly channelName: string;
  encoding: string;
  private chunks: Buffer[] = [];
  private readonly pendingMessages = new Map<string, Hl7Message>();
  private lastMessageDispatchedTime = 0;
  private responseQueue: Hl7Message[] = [];
  private responseQueueProcessing = false;
  private closing = false;
  private readonly messagesPerMin: number;
  private readonly gracefulCloseTimeoutMs: number;

  constructor(
    socket: Socket,
    channelName: string,
    options: Hl7ConnectionOptions = {},
  ) {
    super();
    this.socket = socket;
    this.channelName = channelName;
    this.encoding = options.encoding ?? DEFAULT_ENCODING;
    this.messagesPerMin = options.messagesPerMin ?? 0;
    this.gracefulCloseTimeoutMs = options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS;

    socket.on('data', (data: Buffer) => {
      if (this.closing) {
        this.emit('warning', new BaseError(
          'HL7_FRAME_INVALID' as never,
          'Data received after close was initiated',
          { channelName: this.channelName },
        ));
        return;
      }
      // 解析与上报分开走：解析阶段抛错只报一次
      // （早先把上报也裹在同一个 try 里，监听器一抛错就会把同一帧再报一次 →
      //   同一帧被重复落 DLQ，且同批其余坏帧被整批吞掉）
      let messages: Hl7Message[];
      let errors: Error[];
      try {
        this.appendData(data);
        ({ messages, errors } = this.parseMessages());
      } catch (err) {
        this.reportError(err as Error);
        return;
      }
      // 坏帧逐帧上报（上层据此 ack CA + 落 DLQ），同批好帧不受牵连
      for (const err of errors) {
        this.reportError(err);
      }
      for (const m of messages) {
        // ACK 报文走 pendingMessages 映射（命中 sendAndWait 的等待），不当业务消息派发
        if (this.handleIncomingAck(m)) continue;
        this.responseQueue.push(m);
      }
      if (this.responseQueue.length > 0) {
        this.processResponseQueue().catch((err) => {
          this.reportError(err);
        });
      }
    });

    socket.on('error', (err) => {
      this.resetBuffer();
      this.reportError(err);
    });

    socket.on('close', () => {
      this.drainPendingMessages('Connection closed');
      this.emit('close');
    });
  }

  /** 已关闭 */
  isClosed(): boolean {
    return this.socket.destroyed;
  }

  /** 当前编码 */
  getEncoding(): string {
    return this.encoding;
  }
  setEncoding(enc: string): void {
    this.encoding = enc;
  }

  /** 每分钟限速 */
  getMessagesPerMin(): number {
    return this.messagesPerMin;
  }

  /** 待 sendAndWait 消息数量 */
  getPendingMessageCount(): number {
    return this.pendingMessages.size;
  }

  /**
   * 解析当前缓冲区中的完整 HL7 消息。
   * - 切帧规则：VT 起，FS+CR 收
   * - 逐帧隔离：一帧坏（解码失败 / 非法控制字符 / 字段缺失）不影响同批其余帧 ——
   *   坏帧进 errors[]（带原始字节，供 DLQ 落盘回放），好帧照常进 messages[]
   * - 不完整的帧保留在 chunks 等下一块数据
   */
  parseMessages(): Hl7ParseOutcome {
    const buffer = Buffer.concat(this.chunks);
    this.resetBuffer();

    const messages: Hl7Message[] = [];
    const errors: Error[] = [];
    if (buffer.length === 0) return { messages, errors };

    let bufferIdx = 0;

    while (bufferIdx < buffer.length) {
      // 跳到下一个 VT
      while (bufferIdx < buffer.length && buffer[bufferIdx] !== VT) {
        bufferIdx++;
      }
      if (bufferIdx >= buffer.length) break;

      // 寻找 FS+CR
      let messageEndIndex = -1;
      for (let i = bufferIdx + 1; i < buffer.length - 1; i++) {
        if (buffer[i] === FS && buffer[i + 1] === CR) {
          messageEndIndex = i + 1;
          break;
        }
      }
      if (messageEndIndex === -1) {
        // 不完整帧：VT 起的剩余字节留在 chunks，等下一块数据补齐 FS+CR
        break;
      }

      const messageBuffer = buffer.subarray(bufferIdx, messageEndIndex + 1);
      const contentBuffer = messageBuffer.subarray(1, -2);
      // 先推进游标：即便本帧解析失败，后续帧也不会被这一帧的异常拖掉
      bufferIdx = messageEndIndex + 1;

      try {
        messages.push(this.parseFrame(contentBuffer));
      } catch (err) {
        errors.push(err as Error);
      }
    }

    // 残留的字节（不完整帧）保留
    if (bufferIdx < buffer.length) {
      this.chunks = [buffer.subarray(bufferIdx)];
    }
    return { messages, errors };
  }

  /**
   * 安全上报错误 —— 上层监听器抛错也不能带崩采集进程，更不能连累同批其余帧。
   *
   * 背景：Node 的 EventEmitter 在没有 'error' 监听器时，emit('error') 会抛异常；
   * 监听器内部自己抛错同样会冒泡回 socket 回调，把整个采集进程带下去。
   * 采集进程必须活着 —— 坏帧已经落进 DLQ，这里只把异常隔离并记日志（不静默吞掉）。
   */
  private reportError(err: Error): void {
    try {
      this.emit('error', err);
    } catch (emitErr) {
      log.error(
        {
          channelName: this.channelName,
          err_message: (emitErr as Error)?.message ?? String(emitErr),
        },
        'HL7 错误监听器抛异常（已隔离，不影响采集进程与同批其余帧）',
      );
    }
  }

  /**
   * 解析单帧内容（不含 VT/FS/CR）—— 失败时抛带原始字节与控制 ID 的结构化错误。
   */
  private parseFrame(contentBuffer: Buffer): Hl7Message {
    let contentString: string;
    try {
      contentString = iconv.decode(contentBuffer, this.encoding);
    } catch (err) {
      throw new Hl7EncodingFailError(
        `iconv 解码失败：${(err as Error).message ?? err}`,
        {
          encoding: this.encoding,
          length: contentBuffer.length,
          rawBytes: Buffer.from(contentBuffer),
        },
        err,
      );
    }
    // 非法控制字符 → 拒收整帧（原始字节进 DLQ，不静默丢弃）
    const illegal = findIllegalControlChar(contentString);
    if (illegal) {
      throw new Hl7FrameInvalidError(
        `HL7 帧含非法控制字符：0x${illegal.code.toString(16).padStart(2, '0')}（偏移 ${illegal.index}）`,
        {
          controlId: extractControlId(contentString),
          illegalCharCode: illegal.code,
          illegalCharIndex: illegal.index,
          length: contentBuffer.length,
          rawBytes: Buffer.from(contentBuffer),
        },
      );
    }
    try {
      return parseHl7Message(contentString);
    } catch (err) {
      // 统一补上原始字节 + 控制 ID，供上层 DLQ 与 ACK 回显使用
      const controlId = extractControlId(contentString);
      if (err instanceof Hl7ParseFailError) {
        throw new Hl7ParseFailError(
          err.message,
          { ...err.context, controlId, rawBytes: Buffer.from(contentBuffer) },
          err.cause,
        );
      }
      if (err instanceof BaseError) {
        throw err;
      }
      throw new Hl7FrameInvalidError(
        `HL7 帧非法：${(err as Error).message ?? err}`,
        { controlId, length: contentBuffer.length, rawBytes: Buffer.from(contentBuffer) },
        err,
      );
    }
  }

  /** 异步处理 response queue（限速 dispatch） */
  private async processResponseQueue(): Promise<void> {
    if (this.responseQueueProcessing) return;
    this.responseQueueProcessing = true;
    try {
      while (this.responseQueue.length > 0) {
        if (this.messagesPerMin > 0) {
          const millisBetweenMsgs = ONE_MINUTE / this.messagesPerMin;
          const elapsedMillis = Date.now() - this.lastMessageDispatchedTime;
          if (millisBetweenMsgs > elapsedMillis) {
            await sleep(millisBetweenMsgs - elapsedMillis);
          }
        }
        const m = this.responseQueue.shift();
        if (m) {
          this.emit('message', m);
        }
        this.lastMessageDispatchedTime = Date.now();
      }
    } finally {
      this.responseQueueProcessing = false;
    }
  }

  /** 发送 ACK 帧（AA = 接受 / CA = commit / AE = 错误 / AR = 拒绝） */
  sendAck(parsed: Hl7Message, ackCode: 'AA' | 'CA' | 'AE' | 'AR' = ACK_AA): void {
    const ackStr = buildAck(parsed, ackCode);
    this.sendString(ackStr);
  }

  /** 直接发送字符串（自动加 VT/FS/CR 帧边界） */
  sendString(content: string): void {
    let encoded: Buffer;
    try {
      encoded = iconv.encode(content, this.encoding);
    } catch (err) {
      this.reportError(new Hl7EncodingFailError(
        `iconv 编码失败：${(err as Error).message ?? err}`,
        { encoding: this.encoding },
        err,
      ));
      return;
    }
    const out = Buffer.alloc(encoded.length + 3);
    out.writeInt8(VT, 0);
    encoded.copy(out, 1);
    out.writeInt8(FS, encoded.length + 1);
    out.writeInt8(CR, encoded.length + 2);
    this.socket.write(out);
  }

  /**
   * 发送消息并等待 ACK（控制 ID → ACK）。
   * 简化版：把消息放入 pendingMessages Map + 监听 ACK 事件。
   */
  sendAndWait(msg: Hl7Message, ackCode: 'AA' | 'AE' | 'AR' | 'CA' = ACK_AA): Promise<ParsedAck> {
    return new Promise<ParsedAck>((resolve, reject) => {
      this.pendingMessages.set(msg.controlId, msg);
      this.sendString(msg.raw);
      const timer = setTimeout(() => {
        this.pendingMessages.delete(msg.controlId);
        reject(new BaseError(
          ErrorCode.HL7_ACK_TIMEOUT,
          'sendAndWait 超时',
          { controlId: msg.controlId, timeoutMs: 5000 },
        ));
      }, 5000);
      const onAck = (ack: ParsedAck) => {
        if (ack.controlId === msg.controlId) {
          clearTimeout(timer);
          this.off('ack', onAck);
          if (ack.ackCode === ackCode || ackCode === ACK_AA) {
            resolve(ack);
          } else {
            reject(new BaseError(
              ErrorCode.HL7_ACK_TIMEOUT,
              `sendAndWait 收到非期望 ACK：${ack.ackCode}`,
              { controlId: msg.controlId, expected: ackCode, got: ack.ackCode },
            ));
          }
        }
      };
      this.on('ack', onAck);
    });
  }

  /**
   * 收到报文时判定它是不是 ACK —— HL7 里带 MSA 段的就是应答报文。
   * 命中 pendingMessages（MSA.2 = 被应答报文的 MSH.10）→ resolve 对应的 sendAndWait。
   * @returns true 表示这条报文是 ACK（不再作为业务消息派发，避免给 ACK 回 ACK）
   */
  private handleIncomingAck(msg: Hl7Message): boolean {
    const msa = msg.segments.find((s) => s[0] === 'MSA');
    if (!msa) return false;
    const ackCode = (msa[1] ?? '').trim().toUpperCase();
    const controlId = (msa[2] ?? '').trim();
    if (!ackCode) {
      this.emit('warning', new BaseError(
        ErrorCode.HL7_ACK_UNMATCHED,
        'ACK 报文缺 MSA.1 应答码',
        { channelName: this.channelName, controlId },
      ));
      return true;
    }
    this.dispatchAck({
      ackCode: (['AA', 'AE', 'AR', 'CA'].includes(ackCode) ? ackCode : 'AE') as ParsedAck['ackCode'],
      controlId,
    });
    return true;
  }

  /** 派发收到的 ACK */
  dispatchAck(ack: ParsedAck): void {
    const pending = this.pendingMessages.get(ack.controlId);
    if (pending) {
      this.pendingMessages.delete(ack.controlId);
    } else {
      // 对不上 pending 的 ACK 不静默丢弃 —— 留一条 warning 供排障
      this.emit('warning', new BaseError(
        ErrorCode.HL7_ACK_UNMATCHED,
        `收到无对应 pending 的 ACK：${ack.controlId}`,
        { channelName: this.channelName, controlId: ack.controlId, ackCode: ack.ackCode },
      ));
    }
    this.emit('ack', ack);
  }

  /** 关闭连接 —— graceful drain → force drain */
  async close(): Promise<void> {
    if (this.isClosed()) return;
    this.closing = true;
    this.socket.end();
    this.drainPendingMessages('Connection closed via close()');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
      }, this.gracefulCloseTimeoutMs);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 拒绝 pendingMessages 上的所有等待 */
  private drainPendingMessages(reason: string): void {
    if (this.pendingMessages.size === 0) return;
    const count = this.pendingMessages.size;
    this.pendingMessages.clear();
    this.emit(
      'error',
      new BaseError(
        'HL7_FRAME_INVALID' as never,
        `${reason} —— ${count} 条 pending 被丢弃`,
        { channelName: this.channelName, droppedCount: count },
      ),
    );
  }

  private appendData(data: Buffer): void {
    this.chunks.push(Buffer.from(data));
  }
  private resetBuffer(): void {
    this.chunks = [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
