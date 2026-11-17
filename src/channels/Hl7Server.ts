/**
 * Hl7Server —— HL7 v2 TCP 服务器
 *
 * 设计原则：
 * - 复刻 medplum Hl7Server 主路径：net.createServer + connection Set + graceful drain + EADDRINUSE 重试
 * - 收到帧后：解析成功 → ack AA + emit 'message'；解析失败 → ack CA + emit 'error' + DLQ 入队（由 handler 决定）
 * - 默认监听 2575（HL7 v2 MLLP 常用端口）
 * - forceDrainTimeoutMs 默认 10_000（与 medplum 默认对齐）
 */

import net, { type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  Hl7ParseFailError,
  Hl7FrameInvalidError,
  Hl7EncodingFailError,
  isBaseError,
  wrapError,
} from '../shared/errors.js';
import {
  type Hl7Connection,
  type Hl7Message,
  formatHl7Timestamp,
  parseHl7Message,
} from './Hl7Connection.js';
import { Hl7Connection as Hl7ConnectionClass } from './Hl7Connection.js';
import { type DLQ, getDLQ } from './DLQ.js';
import { DEFAULT_FORCE_DRAIN_TIMEOUT_MS, ACK_AA, ACK_CA } from './constants.js';
import { createLogger } from '../shared/logger.js';
import { type BackpressureGate } from './backpressure.js';

const log = createLogger('channels.Hl7Server');

/** 运行摘要的最小注入面（避免通道层依赖 shared/run-summary 的具体类型） */
export interface SummarySink {
  record(event: string, count?: number): void;
}

export interface Hl7ServerOptions {
  /** 编码（utf-8 / gbk / gb18030） */
  encoding?: string;
  /** 每分钟限速（消息数） */
  messagesPerMin?: number;
  /** 强制 drain 超时（毫秒） */
  forceDrainTimeoutMs?: number;
  /** DLQ 实例（默认 getDLQ()） */
  dlq?: DLQ;
  /** 自定义 Hl7Connection 类（测试可替换） */
  connectionFactory?: (socket: Socket, channelName: string) => Hl7Connection;
  /** T16 · 入站背压闸门（投递前生效；不传则不限速） */
  backpressure?: BackpressureGate;
  /** T16/T35 · 运行摘要打点 */
  summary?: SummarySink;
}

export interface Hl7ServerStopOptions {
  forceDrainTimeoutMs?: number;
}

export class Hl7Server extends EventEmitter {
  readonly channelName: string;
  private encoding: string;
  private messagesPerMin: number;
  private forceDrainTimeoutMs: number;
  private dlq: DLQ;
  private connectionFactory: (socket: Socket, channelName: string) => Hl7Connection;
  private readonly gate?: BackpressureGate;
  private readonly summary?: SummarySink;
  server?: Server;
  readonly connections = new Set<Hl7Connection>();

  constructor(channelName: string, opts: Hl7ServerOptions = {}) {
    super();
    this.channelName = channelName;
    this.encoding = opts.encoding ?? 'utf-8';
    this.messagesPerMin = opts.messagesPerMin ?? 0;
    this.forceDrainTimeoutMs = opts.forceDrainTimeoutMs ?? DEFAULT_FORCE_DRAIN_TIMEOUT_MS;
    this.dlq = opts.dlq ?? getDLQ();
    this.gate = opts.backpressure;
    this.summary = opts.summary;
    this.connectionFactory =
      opts.connectionFactory ??
      ((socket, name) =>
        new Hl7ConnectionClass(socket, name, {
          messagesPerMin: this.messagesPerMin,
          encoding: this.encoding,
        }));

    // Node 的 EventEmitter：没有 'error' 监听器时 emit('error') 会直接抛异常，
    // 未捕获就会终止整个进程。采集进程不能因为一台仪器送了个坏帧就整体挂掉 ——
    // 坏帧已经落进 DLQ，这里只做兜底记录（上层挂了监听器时两者都会收到，不冲突）。
    this.on('error', (err: Error) => {
      log.warn(
        {
          channelName: this.channelName,
          err_code: (err as { code?: string })?.code ?? 'HL7_ERROR',
          err_message: err?.message ?? String(err),
        },
        'HL7 通道错误（默认兜底记录，原始字节已落 DLQ）',
      );
    });
  }

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }
  getEncoding(): string {
    return this.encoding;
  }

  /**
   * 启动 server；端口为 0 → 由 OS 分配。
   * EADDRINUSE 自动重试一次（与源仓库行为一致）。
   */
  start(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const conn = this.connectionFactory(socket, this.channelName);
        conn.setEncoding(this.encoding);
        this.connections.add(conn);

        conn.on('message', (msg: Hl7Message) => {
          // 解析成功：ack AA + emit
          try {
            conn.sendAck(msg, ACK_AA);
          } catch (err) {
            this.emit('error', wrapError(err, 'HL7_ENCODING_FAIL'));
          }
          // T16 · 限速在业务投递「之前」生效。被限速帧仍回 AA（原始字节已入有界
          // 队列或 DLQ，不需要仪器重发），但绝不进入下游解析 / FHIR 写入主路径。
          if (this.gate) {
            this.summary?.record('inbound_frame');
            const verdict = this.gate.accept(this.channelName, msg.raw);
            if (!verdict.accepted) {
              this.summary?.record('rate_limited');
              this.emit('rate-limited', {
                channelName: this.channelName,
                controlId: msg.controlId,
                ...verdict,
              });
              return;
            }
          }
          this.emit('message', { connection: conn, message: msg });
        });

        conn.on('error', (err: Error) => {
          // 解析失败 → ack CA + DLQ + emit error
          const classified = this.classifyError(err);
          // MSA.2 必须回显原始 MSH.10，仪器才能把 ACK 对上自己发出的那条报文
          const originalControlId =
            typeof classified.context.controlId === 'string' ? classified.context.controlId : '';
          // ack CA（best-effort；若 socket 已断则静默）
          try {
            if (conn.socket.writable && !conn.socket.destroyed) {
              const ackTimestamp = formatHl7Timestamp(new Date());
              conn.sendString(
                `MSH|^~\\&|lab-ops-console||device||${ackTimestamp}||ACK|${randomControlId()}|P|2.5\r` +
                  `MSA|CA|${originalControlId || 'ERR'}|消息接收失败`,
              );
            }
          } catch {
            // 静默
          }
          // 入 DLQ —— 保留原始字节（失败不静默改数据，坏帧可回放可核对）
          try {
            const raw = classified.context.rawBytes;
            this.dlq.enqueue({
              channelName: this.channelName,
              errorCode: classified.code,
              errorMessage: classified.message,
              rawBytes: Buffer.isBuffer(raw) ? raw : Buffer.from([]),
            });
          } catch (dlqErr) {
            this.emit('error', wrapError(dlqErr, 'DLQ_ENQUEUE'));
          }
          this.emit('error', classified);
        });

        conn.on('close', () => {
          this.connections.delete(conn);
        });
      });

      const onError = (e: Error & { code?: string }) => {
        if (e?.code === 'EADDRINUSE') {
          // 重试一次
          setTimeout(() => {
            server.listen(port, () => {
              const addr = server.address();
              const boundPort = typeof addr === 'object' && addr ? addr.port : port;
              this.server = server;
              resolve(boundPort);
            });
          }, 50);
        } else {
          reject(e);
        }
      };

      server.on('error', onError);

      server.listen(port, () => {
        server.off('error', onError);
        const addr = server.address();
        const boundPort = typeof addr === 'object' && addr ? addr.port : port;
        this.server = server;
        resolve(boundPort);
      });

      this.server = server;
    });
  }

  /**
   * T16 · 恢复后按序消费本通道的等待队列。
   * 队列里的帧是原始 HL7 文本，重新解析后以普通 'message' 事件投递
   * （不再走 accept，避免二次限速把已经排队的帧又推回去）。
   */
  async drainBackpressure(): Promise<number> {
    if (!this.gate) return 0;
    return this.gate.drain(this.channelName, (frame) => {
      const raw = Buffer.from(frame).toString('utf-8');
      try {
        this.emit('message', { connection: undefined, message: parseHl7Message(raw) });
      } catch (err) {
        this.emit('error', wrapError(err, 'HL7_PARSE_FAIL'));
      }
    });
  }

  /** 全局等待队列（多通道共享配额时由上层定时调用） */
  async drainGlobalBackpressure(): Promise<number> {
    if (!this.gate) return 0;
    return this.gate.drainGlobal((_channelId, frame) => {
      const raw = Buffer.from(frame).toString('utf-8');
      try {
        this.emit('message', { connection: undefined, message: parseHl7Message(raw) });
      } catch (err) {
        this.emit('error', wrapError(err, 'HL7_PARSE_FAIL'));
      }
    });
  }

  /**
   * 停止 server —— graceful drain；超时后强制断连。
   * forceDrainTimeoutMs = -1 禁用强制断连。
   */
  stop(options?: Hl7ServerStopOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Stop was called but there is no server running'));
        return;
      }
      const drainTimeout =
        options?.forceDrainTimeoutMs !== undefined
          ? options.forceDrainTimeoutMs
          : this.forceDrainTimeoutMs;

      let forceDrainTimer: NodeJS.Timeout | undefined;
      if (drainTimeout !== -1) {
        forceDrainTimer = setTimeout(() => {
          for (const conn of this.connections) {
            conn.close().catch((err) => this.emit('error', wrapError(err)));
          }
        }, drainTimeout);
      }

      this.server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (forceDrainTimer) clearTimeout(forceDrainTimer);
        this.connections.clear();
        this.server = undefined;
        resolve();
      });
    });
  }

  /** 把原始错误分类成已知错误码 */
  private classifyError(err: Error): ReturnType<typeof wrapError> {
    if (isBaseError(err)) {
      return err;
    }
    // socket 级 ECONNRESET / EADDRINUSE
    const code = (err as Error & { code?: string }).code;
    if (code === 'ECONNRESET') {
      return wrapError(err, 'HL7_FRAME_INVALID');
    }
    if (err instanceof Hl7ParseFailError) {
      return err;
    }
    if (err instanceof Hl7EncodingFailError) {
      return err;
    }
    if (err instanceof Hl7FrameInvalidError) {
      return err;
    }
    return wrapError(err, 'HL7_FRAME_INVALID');
  }
}

function randomControlId(): string {
  return Math.random().toString(36).slice(2, 12);
}
