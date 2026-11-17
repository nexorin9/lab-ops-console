/**
 * T17 · ASTM E1394 会话层
 *
 * 仪器不是「推一段文本」，而是按会话握手：
 *   仪器 ENQ → 我方 ACK → 仪器逐帧送 record → 我方逐帧 ACK / NAK → 仪器 EOT → 会话结束
 *
 * 本模块把链路层状态和业务解析解耦：只有会话完整收齐（EOT 到达）后才把
 * 整条 record 投递给解析层，避免半截 record 被当作完整结果写进 LIS。
 *
 * 可靠性约定：
 * - 帧号按 1..7,0..7 循环递增；重复帧号丢弃并计数，缺号进 DLQ 并告警
 * - 握手超时按 maxRetries 重传，超限置 down 并发告警（不静默等死）
 * - 可重试错误回 NAK（请仪器重发本帧），不可重试错误回 EOT 直接关会话
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../shared/logger.js';

const log = createLogger('parser.astm-session');

export const ASTM = {
  STX: 0x02,
  ETX: 0x03,
  EOT: 0x04,
  ENQ: 0x05,
  ACK: 0x06,
  NAK: 0x15,
  CR: 0x0d,
  LF: 0x0a,
} as const;

export const ASTM_ERROR_CODES = {
  SEQUENCE_GAP: 'ASTM_FRAME_SEQUENCE_GAP',
  DUPLICATE: 'ASTM_DUPLICATE_FRAME',
  TIMEOUT: 'ASTM_HANDSHAKE_TIMEOUT',
  MALFORMED: 'ASTM_FRAME_MALFORMED',
  NAK: 'ASTM_NAK',
} as const;

export type AstmSessionState = 'idle' | 'connected' | 'transfer' | 'closed' | 'down';

export interface AstmDlqSink {
  enqueue(input: {
    channelName: string;
    errorCode: string;
    errorMessage?: string;
    rawBytes: Buffer | Uint8Array;
  }): unknown;
}

export interface AstmAlert {
  code: string;
  message: string;
  state: AstmSessionState;
  retries: number;
  at: number;
}

export interface AstmSessionOptions {
  /** 握手 / 帧间超时重传上限，默认 3 次 */
  maxRetries?: number;
  /** 超时阈值，默认 15_000ms（可注入短值做测试） */
  handshakeTimeoutMs?: number;
  channelName?: string;
  now?: () => number;
  dlq?: AstmDlqSink;
  onAlert?: (alert: AstmAlert) => void;
}

export interface AstmSessionStats {
  framesAccepted: number;
  duplicateFrames: number;
  missingFrames: number;
  retransmits: number;
  naks: number;
  records: number;
  timeouts: number;
}

export interface AstmRecordEvent {
  /** 拼接后的完整 ASTM record 文本（不含链路控制字节） */
  text: string;
  /** 组成该 record 的帧号序列 */
  frameNumbers: number[];
  channelName: string;
  receivedAt: number;
}

/** ASTM 帧号循环：1..7 → 0 → 1..7 → 0 … */
export function nextFrameNumber(current: number): number {
  return current >= 7 ? 0 : current + 1;
}

/** 从一帧文本里取帧号；取不到返回 null */
export function extractFrameNumber(raw: string): number | null {
  const cleaned = raw.replace(/^[\x02-\x06\x15]+/, '');
  const m = /^([0-7])/.exec(cleaned);
  return m ? Number(m[1]) : null;
}

/** 剥掉 STX / ETX / checksum / CR / LF，只留 record 正文（保留帧号后内容） */
function frameBody(raw: string): string {
  return raw
    .replace(/^[\x02]+/, '')
    .replace(/[\x03][0-9A-Fa-f]{0,2}[\x0d\x0a]*$/, '')
    .replace(/[\x0d\x0a]+$/, '')
    .replace(/^[0-7]/, '');
}

export class AstmSession extends EventEmitter {
  private status: AstmSessionState = 'idle';
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly channelName: string;
  private readonly now: () => number;
  private readonly dlq?: AstmDlqSink;
  private readonly onAlert?: (alert: AstmAlert) => void;

  private expected = 1;
  private lastFrameNumber: number | null = null;
  private lastActivityAt: number;
  private retries = 0;
  private frameBodies: string[] = [];
  private frameNumbers: number[] = [];
  private readonly counters: AstmSessionStats = {
    framesAccepted: 0, duplicateFrames: 0, missingFrames: 0,
    retransmits: 0, naks: 0, records: 0, timeouts: 0,
  };

  constructor(opts: AstmSessionOptions = {}) {
    super();
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.handshakeTimeoutMs ?? 15_000;
    this.channelName = opts.channelName ?? 'astm';
    this.now = opts.now ?? Date.now;
    this.dlq = opts.dlq;
    this.onAlert = opts.onAlert;
    this.lastActivityAt = this.now();
  }

  get state(): AstmSessionState { return this.status; }
  get stats(): Readonly<AstmSessionStats> { return { ...this.counters }; }
  get pendingFrames(): number { return this.frameBodies.length; }

  private alert(code: string, message: string): void {
    const a: AstmAlert = { code, message, state: this.status, retries: this.retries, at: this.now() };
    log.warn({ channelId: this.channelName, errorCode: code, retries: this.retries }, message);
    this.onAlert?.(a);
    this.emit('alert', a);
  }

  private toDlq(errorCode: string, message: string, raw: Buffer | string): void {
    if (!this.dlq) return;
    try {
      this.dlq.enqueue({
        channelName: this.channelName,
        errorCode,
        errorMessage: message,
        rawBytes: Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf-8'),
      });
    } catch (err) {
      log.error({ errorCode, err: (err as Error).message }, 'ASTM 坏帧写 DLQ 失败');
    }
  }

  /**
   * 喂入一个链路单元（控制字节或一帧文本），返回应回写给仪器的字节。
   * 控制字节按 Buffer 传入；文本帧按 string 或 Buffer 传入均可。
   */
  feed(input: Buffer | string): Buffer {
    if (Buffer.isBuffer(input) && input.length === 1) {
      return this.feedControl(input[0]!);
    }
    const text = Buffer.isBuffer(input) ? input.toString('utf-8') : input;
    // 混合输入：一整段字节流里可能同时含 ENQ / ACK / EOT 与多帧文本
    if (/[\x04\x05\x06\x15]/.test(text)) return this.feedMixed(text);
    return this.feedFrame(text);
  }

  private feedControl(byte: number): Buffer {
    switch (byte) {
      case ASTM.ENQ:
        this.status = 'connected';
        this.retries = 0;
        this.expected = 1;
        this.lastFrameNumber = null;
        this.frameBodies = [];
        this.frameNumbers = [];
        this.lastActivityAt = this.now();
        this.emit('handshake', { channelName: this.channelName, at: this.lastActivityAt });
        return Buffer.from([ASTM.ACK]);

      case ASTM.ACK:
        // 仪器确认我方重传的应答 → 清除待重传状态
        this.retries = 0;
        this.lastActivityAt = this.now();
        if (this.status === 'down') this.status = 'transfer';
        this.emit('ack', { at: this.lastActivityAt });
        return Buffer.alloc(0);

      case ASTM.EOT:
        return this.finish();

      case ASTM.NAK:
        // 仪器要求我方重发上一应答
        this.alert(ASTM_ERROR_CODES.NAK, '仪器回 NAK，重发上一应答');
        this.lastActivityAt = this.now();
        return Buffer.from([ASTM.ACK]);

      default:
        return Buffer.alloc(0);
    }
  }

  private feedMixed(text: string): Buffer {
    // 按控制字节切段，逐段处理；文本段按 \r 分帧
    const parts = text.split(/([\x04\x05\x06\x15])/).filter((p) => p.length > 0);
    let out = Buffer.alloc(0);
    for (const part of parts) {
      if (/^[\x04\x05\x06\x15]$/.test(part)) {
        out = Buffer.concat([out, this.feedControl(part.charCodeAt(0))]);
        continue;
      }
      for (const frame of part.split(/\r/).filter((f) => f.trim().length > 0)) {
        out = Buffer.concat([out, this.feedFrame(frame)]);
      }
    }
    return out;
  }

  private feedFrame(raw: string): Buffer {
    if (this.status === 'idle' || this.status === 'closed') {
      // 仪器省略 ENQ 直接送帧：容错进入 transfer，但记一条告警
      this.alert(ASTM_ERROR_CODES.MALFORMED, '未收到 ENQ 即收到数据帧，按容错进入 transfer');
      this.status = 'transfer';
    }
    if (this.status === 'down') {
      this.toDlq(ASTM_ERROR_CODES.TIMEOUT, '会话已置 down，收到的数据帧进 DLQ', raw);
      return Buffer.from([ASTM.EOT]);
    }

    const fn = extractFrameNumber(raw);
    if (fn === null) {
      this.toDlq(ASTM_ERROR_CODES.MALFORMED, 'ASTM 帧缺少帧号', raw);
      this.alert(ASTM_ERROR_CODES.MALFORMED, 'ASTM 帧缺少帧号，原始字节已入 DLQ');
      return Buffer.from([ASTM.NAK]);
    }

    this.lastActivityAt = this.now();
    this.retries = 0;

    if (this.lastFrameNumber !== null && fn === this.lastFrameNumber) {
      // 重复帧号：丢弃并计数，仍回 ACK 让仪器继续（否则会卡死在重发循环）
      this.counters.duplicateFrames += 1;
      this.toDlq(ASTM_ERROR_CODES.DUPLICATE, `重复帧号 ${fn} 已丢弃`, raw);
      this.emit('duplicate-frame', { frameNumber: fn, channelName: this.channelName });
      return Buffer.from([ASTM.ACK]);
    }

    if (fn !== this.expected) {
      // 缺号：不丢帧，先记账 + 告警 + 原始字节留底，再按当前帧号续上
      this.counters.missingFrames += 1;
      const message = `ASTM 帧号不连续：期望 ${this.expected}，实收 ${fn}`;
      this.toDlq(ASTM_ERROR_CODES.SEQUENCE_GAP, message, raw);
      this.alert(ASTM_ERROR_CODES.SEQUENCE_GAP, message);
      this.emit('sequence-gap', { expected: this.expected, actual: fn });
    }

    this.lastFrameNumber = fn;
    this.expected = nextFrameNumber(fn);
    this.frameNumbers.push(fn);
    this.frameBodies.push(frameBody(raw));
    this.counters.framesAccepted += 1;
    if (this.status === 'connected') this.status = 'transfer';
    this.emit('frame', { frameNumber: fn, text: frameBody(raw) });
    return Buffer.from([ASTM.ACK]);
  }

  /** 会话结束：拼接完整 record 并投递（只有这一步之后解析层才会看到数据） */
  finish(): Buffer {
    const record: AstmRecordEvent = {
      text: this.frameBodies.join('\r'),
      frameNumbers: [...this.frameNumbers],
      channelName: this.channelName,
      receivedAt: this.now(),
    };
    const hadFrames = this.frameBodies.length > 0;
    this.status = 'closed';
    this.frameBodies = [];
    this.frameNumbers = [];
    this.lastFrameNumber = null;
    this.expected = 1;
    this.retries = 0;
    this.lastActivityAt = this.now();
    if (hadFrames) {
      this.counters.records += 1;
      this.emit('record', record);
      this.emit('astm-record', record);
    }
    this.emit('session-end', { channelName: this.channelName, records: this.counters.records });
    return Buffer.alloc(0);
  }

  /**
   * 超时检查（由上层定时器按可配间隔调用）。
   * 未超上限 → 重发 ACK 催帧；超上限 → 置 down、发告警、回 EOT 关会话。
   */
  tick(at: number = this.now()): Buffer {
    if (this.status === 'idle' || this.status === 'closed' || this.status === 'down') return Buffer.alloc(0);
    if (at - this.lastActivityAt < this.timeoutMs) return Buffer.alloc(0);

    this.counters.timeouts += 1;
    if (this.retries < this.maxRetries) {
      this.retries += 1;
      this.counters.retransmits += 1;
      this.lastActivityAt = at;
      this.emit('retransmit', { attempt: this.retries, maxRetries: this.maxRetries });
      return Buffer.from([ASTM.ACK]);
    }
    this.status = 'down';
    this.alert(ASTM_ERROR_CODES.TIMEOUT, `ASTM 握手超时重传 ${this.retries} 次仍无响应，会话置 down`);
    this.emit('down', { retries: this.retries });
    return Buffer.from([ASTM.EOT]);
  }

  /**
   * NAK 策略：可重试错误回 NAK（本帧不入库，请仪器重发），
   * 不可重试错误回 EOT 并关闭会话（避免坏帧把会话拖死）。
   */
  fail(message: string, retryable: boolean, raw: string = ''): Buffer {
    if (retryable) {
      this.counters.naks += 1;
      this.toDlq(ASTM_ERROR_CODES.NAK, message, raw);
      this.emit('nak', { message, raw });
      return Buffer.from([ASTM.NAK]);
    }
    this.toDlq(ASTM_ERROR_CODES.MALFORMED, message, raw);
    this.alert(ASTM_ERROR_CODES.MALFORMED, `${message}（不可重试，关闭会话）`);
    this.status = 'closed';
    this.frameBodies = [];
    this.frameNumbers = [];
    this.emit('session-end', { channelName: this.channelName, reason: message });
    return Buffer.from([ASTM.EOT]);
  }
}

/**
 * 接到 ByteStreamChannel 的 ASTM 通道：只有会话层收到完整 record 才向业务层投递。
 * 返回的 detach() 用于通道热重载时解绑，避免重复订阅。
 */
export function attachAstmSession(
  channel: { on(event: string, listener: (...args: unknown[]) => void): unknown; off?(event: string, listener: (...args: unknown[]) => void): unknown },
  session: AstmSession,
  onRecord: (record: AstmRecordEvent) => void,
): () => void {
  const onFramed = (msg: unknown): void => {
    const framed = msg as { bodyText?: string; body?: Buffer };
    const text = framed.bodyText ?? (framed.body ? framed.body.toString('utf-8') : '');
    if (text) session.feed(text);
  };
  const onRecordEvent = (record: AstmRecordEvent): void => onRecord(record);
  channel.on('framed-message', onFramed);
  session.on('record', onRecordEvent);
  return () => {
    channel.off?.('framed-message', onFramed);
    session.off('record', onRecordEvent);
  };
}
