/**
 * SerialPortChannel —— 串口通道适配器（USB 串口 / RS-232 仪器常用）
 *
 * 设计原则：
 * - 复用 ByteStreamChannel 的切帧逻辑（不要重新发明）
 * - 包装 serialport.SerPort（serialport npm 包）作为输入输出
 * - mock-friendly：构造时允许传入 `openPort` 工厂，便于测试不连真硬件
 * - open() 后立刻推 framed-message 事件 —— 上层订阅者无需关心是 TCP 还是串口
 *
 * 适配：
 * - serialport 是异步开端口；提供 open() 返回 Promise
 * - factory 函数注入便于写 vitest 测试（fake serialport 替身）
 */

import { EventEmitter } from 'node:events';
import {
  type ByteStreamConfig,
  ByteSequenceMatcher,
  decodeBody,
  filterMessageBytes,
} from './bytestream.js';
import { type ByteStreamChannelConnection } from './ByteStreamChannel.js';
import { DEFAULT_FORCE_DRAIN_TIMEOUT_MS } from './constants.js';
import {
  Hl7FrameInvalidError,
  wrapError,
} from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels.SerialPortChannel');

/** serialport 的最小接口（避免引入完整类型，作为 duck-typed port） */
export interface MinimalSerialPort {
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  write(data: Buffer | string): boolean;
  close(cb?: (err: Error | null) => void): void;
  isOpen: boolean;
  open(cb: (err: Error | null) => void): void;
}

/** serialport factory：默认走真实 SerialPort；测试可注入替身 */
export type SerialPortFactory = (
  path: string,
  opts: { baudRate: number },
) => MinimalSerialPort;

export interface SerialPortChannelOptions {
  /** 串口路径（/dev/ttyUSB0 / COM3） */
  path: string;
  /** 波特率（默认 9600） */
  baudRate?: number;
  /** 强制 drain 超时（毫秒） */
  forceDrainTimeoutMs?: number;
  /** openPort 工厂（测试可注入） */
  openPort?: SerialPortFactory;
  /** 编码（utf-8 / gbk）—— 影响 bodyEncoding=utf-8 时的解码 */
  encoding?: string;
}

export interface SerialFramedMessage {
  remote: string;
  body: Buffer;
  bodyEncoding: 'hex' | 'utf-8';
  bodyText: string;
  receivedAt: number;
  port: string;
}

/**
 * 默认 serialport factory —— 走真实 serialport 包；动态 import 避免 mock 困难。
 *
 * 构造签名按 serialport 大版本分两支（两者 API 不兼容，不能混用）：
 * - serialport ≥ 12：单一 options 对象 `new SerialPort({ path, baudRate, autoOpen })`
 * - serialport ≤ 11：位置参数 `new SerialPort(path, { baudRate, autoOpen })`
 *
 * 误用位置参数时 serialport ≥ 12 会在构造期抛 `"path" is not defined`，
 * 真实仪器串口永远打不开 —— 故按构造器形参个数判别大版本。
 *
 * autoOpen 固定 false：串口由本类显式 open() 控制，避免与包的自动打开撞车
 * （重复 open 会得到 "Port is already opening"）。
 */
export async function defaultSerialPortFactory(
  path: string,
  opts: { baudRate: number },
): Promise<MinimalSerialPort> {
  const mod = (await import('serialport')) as unknown as {
    SerialPort: new (...args: never[]) => MinimalSerialPort;
  };
  const SerialPortCtor = mod.SerialPort as unknown as new (
    ...args: unknown[]
  ) => MinimalSerialPort;

  // serialport ≥ 12 的构造函数形参为 (options, openCallback?) → length 2；
  // ≤ 11 为 (path, options, openCallback) → length 3。
  const usesOptionsObject = SerialPortCtor.length <= 2;
  const port = usesOptionsObject
    ? new SerialPortCtor({ path, baudRate: opts.baudRate, autoOpen: false })
    : new SerialPortCtor(path, { baudRate: opts.baudRate, autoOpen: false });
  return port;
}

export class SerialPortChannel extends EventEmitter {
  readonly port: string;
  readonly baudRate: number;
  readonly channelName: string;
  readonly config: ByteStreamConfig;
  private readonly forceDrainTimeoutMs: number;
  private readonly openPortFactory: SerialPortFactory | null;
  private readonly encoding: string;
  private portInstance: MinimalSerialPort | null = null;
  private closing = false;
  private opened = false;

  constructor(channelName: string, config: ByteStreamConfig, opts: SerialPortChannelOptions) {
    super();
    this.channelName = channelName;
    this.port = opts.path;
    this.baudRate = opts.baudRate ?? 9600;
    this.config = config;
    this.forceDrainTimeoutMs = opts.forceDrainTimeoutMs ?? DEFAULT_FORCE_DRAIN_TIMEOUT_MS;
    this.openPortFactory = opts.openPort as SerialPortFactory | null;
    this.encoding = opts.encoding ?? 'utf-8';
  }

  /** 打开串口；测试可传入 openPort fake 工厂 */
  async open(): Promise<void> {
    if (this.opened) return;
    let port: MinimalSerialPort;
    if (this.openPortFactory) {
      port = this.openPortFactory(this.port, { baudRate: this.baudRate });
    } else {
      port = await defaultSerialPortFactory(this.port, { baudRate: this.baudRate });
    }
    if (!port) {
      throw new Hl7FrameInvalidError(
        'SerialPort factory returned no port',
        { port: this.port, baudRate: this.baudRate },
      );
    }
    this.portInstance = port;

    // 绑事件
    let portOpened = false;
    await new Promise<void>((resolve, reject) => {
      port.open((err: Error | null) => {
        if (err) {
          reject(wrapError(err, 'HL7_FRAME_INVALID'));
          return;
        }
        portOpened = true;
        resolve();
      });
    });

    if (!portOpened) {
      throw new Hl7FrameInvalidError(
        'SerialPort failed to open',
        { port: this.port, baudRate: this.baudRate },
      );
    }

    const matcher = new ByteSequenceMatcher(this.config.autoRespond);
    const chunks: Buffer[] = [];
    let totalLen = -1;

    port.on('data', (data: Buffer) => {
      try {
        // pendingStart 是本次 data 缓冲区的下标，必须逐次 read 归零；
        // 跨 read 复用会让 endChar 切片起点错位、帧中字节被静默丢弃。
        let pendingStart = 0;
        let i = 0;
        while (i < data.length) {
          const char = data[i];

          for (const response of matcher.match(char)) {
            if (port?.isOpen) port.write(response);
          }

          if (char === this.config.startChar) {
            chunks.length = 0;
            totalLen = 0;
            pendingStart = i;
            matcher.reset();
            i++;
            continue;
          }
          if (char === this.config.endChar) {
            if (totalLen === -1) {
              i++;
              continue;
            }
            const slice = data.subarray(pendingStart, i + 1);
            chunks.push(Buffer.from(slice));
            totalLen += slice.length;
            const raw = Buffer.concat(chunks, totalLen);
            const body = filterMessageBytes(
              raw,
              this.config.stripSequences,
              this.config.stripControlChars,
              this.config.keepControlChars,
            );
            this.emit('framed-message', {
              remote: this.port,
              body,
              bodyEncoding: this.config.bodyEncoding,
              // bodyEncoding='utf-8' 时按通道编码解码（GBK / GB18030 等），
              // 不用 Buffer.toString('utf-8') 硬解，否则中文检验项名变乱码。
              bodyText:
                this.config.bodyEncoding === 'utf-8'
                  ? decodeBody(body, this.encoding)
                  : body.toString('hex'),
              receivedAt: Date.now(),
              port: this.port,
            } as SerialFramedMessage);
            chunks.length = 0;
            totalLen = -1;
            pendingStart = i + 1;
            i++;
            continue;
          }
          i++;
        }
        if (totalLen !== -1 && pendingStart < data.length) {
          const remaining = data.subarray(pendingStart);
          chunks.push(Buffer.from(remaining));
          totalLen += remaining.length;
        }
      } catch (err) {
        this.emit('byte-stream-error', wrapError(err));
      }
    });

    port.on('error', (err) => this.emit('byte-stream-error', wrapError(err)));
    port.on('close', () => this.emit('close'));

    this.opened = true;
    log.info({ port: this.port, baudRate: this.baudRate }, 'SerialPortChannel opened');
  }

  isOpen(): boolean {
    return this.opened && (this.portInstance?.isOpen ?? false);
  }

  /** 写字节（用于自动响应 / 测试手写） */
  write(data: Buffer | string): boolean {
    if (!this.portInstance) return false;
    return this.portInstance.write(data);
  }

  /** 优雅关闭 */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.portInstance?.isOpen) {
          try {
            this.portInstance.close(() => undefined);
          } catch {
            // ignore
          }
        }
        resolve();
      }, this.forceDrainTimeoutMs);
      if (this.portInstance) {
        this.portInstance.close((err) => {
          if (err) log.warn({ err: err.message }, 'SerialPort close error');
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    });
    this.opened = false;
  }
}
