/**
 * ByteStreamChannel —— 字节流 TCP 通道（与源仓库 medplum AgentByteStreamChannel 同源）
 *
 * 设计原则：
 * - 复刻主路径：net.createServer + connection Map + graceful drain + EADDRINUSE 重试
 * - ByteStreamConfig：每连接共享一份（reload 后整体替换）
 * - 切帧：startChar 起 + endChar 收；每完整帧触发 'framed-message' 事件
 * - 自动响应：链路级握手，匹配立刻回包（在 framing 之前）
 * - 解析失败：保留原始字节到 DLQ
 *
 * 适配：
 * - 不绑 medplum/app：emit 'framed-message' / 'byte-stream-error' 给上层订阅
 * - 加 EADDRINUSE 自动重试一次 + forceDrainTimeoutMs
 */

import net, { type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  type ByteStreamConfig,
  ByteSequenceMatcher,
  decodeBody,
  filterMessageBytes,
} from './bytestream.js';
import {
  Hl7ParseFailError,
  AstmParseFailError,
  PrivateBytesParseFailError,
  wrapError,
  isBaseError,
} from '../shared/errors.js';
import { type DLQ, getDLQ } from './DLQ.js';
import { DEFAULT_FORCE_DRAIN_TIMEOUT_MS } from './constants.js';
import { type BackpressureGate } from './backpressure.js';
import { type SummarySink } from './Hl7Server.js';

export interface ByteStreamChannelOptions {
  /** 默认编码（utf-8 / gbk / gb18030）—— 仅用于 bodyEncoding 链路 */
  encoding?: string;
  /** 强制 drain 超时（毫秒） */
  forceDrainTimeoutMs?: number;
  /** DLQ 实例 */
  dlq?: DLQ;
  /** 自定义 Connection 类（测试可替换） */
  connectionFactory?: (socket: Socket, channelName: string) => ByteStreamChannelConnection;
  /** 直接传 ByteStreamConfig（用于 channel-loader 加载 yaml 后用）；不传走默认 */
  initialConfig?: ByteStreamConfig;
  /** T16 · 入站背压闸门（投递前生效；不传则不限速） */
  backpressure?: BackpressureGate;
  /** T16/T35 · 运行摘要打点 */
  summary?: SummarySink;
}

export interface ByteStreamServerStopOptions {
  forceDrainTimeoutMs?: number;
}

export interface FramedMessage {
  /** 远程地址 */
  remote: string;
  /** 清理后的字节体 */
  body: Buffer;
  /** 配置时声明的 bodyEncoding（hex / utf-8） */
  bodyEncoding: 'hex' | 'utf-8';
  /** 编码后字符串（utf-8 时与 body 内容一致；hex 时是十六进制串） */
  bodyText: string;
  /** 接收时间戳（毫秒） */
  receivedAt: number;
}

export class ByteStreamChannel extends EventEmitter {
  readonly channelName: string;
  /** 通道编码（utf-8 / gbk / gb18030…）—— 帧体按此解码，连接层读取 */
  readonly encoding: string;
  private forceDrainTimeoutMs: number;
  private dlq: DLQ;
  private connectionFactory: (socket: Socket, channelName: string) => ByteStreamChannelConnection;
  private readonly gate?: BackpressureGate;
  private readonly summary?: SummarySink;
  server?: Server;
  readonly connections = new Map<string, ByteStreamChannelConnection>();
  private config: ByteStreamConfig;

  constructor(channelName: string, opts: ByteStreamChannelOptions = {}) {
    super();
    this.channelName = channelName;
    this.encoding = opts.encoding ?? 'utf-8';
    this.forceDrainTimeoutMs = opts.forceDrainTimeoutMs ?? DEFAULT_FORCE_DRAIN_TIMEOUT_MS;
    this.dlq = opts.dlq ?? getDLQ();
    this.gate = opts.backpressure;
    this.summary = opts.summary;
    this.connectionFactory =
      opts.connectionFactory ??
      ((socket, name) => new ByteStreamChannelConnection(this, socket, name));
    this.config = opts.initialConfig ?? {
      startChar: -1,
      endChar: -1,
      autoRespond: [],
      stripSequences: [],
      stripControlChars: false,
      keepControlChars: [],
      bodyEncoding: 'hex',
      ignoreResponse: false,
    };
  }

  /** 通道当前配置（共享只读） */
  getConfig(): ByteStreamConfig {
    return this.config;
  }

  /**
   * 热更新配置 —— 通知所有 connection 重新构造 matcher
   * 注意：startChar / endChar 变更后需要 reload 才能对新连接生效（与源仓库行为一致）
   */
  applyConfig(next: ByteStreamConfig): void {
    this.config = next;
    for (const conn of this.connections.values()) {
      conn.applyConfig(next);
    }
    this.emit('config-reloaded', next);
  }

  /** T16 · 恢复后按序消费本通道等待队列，重新封装成 FramedMessage 投递 */
  async drainBackpressure(): Promise<number> {
    if (!this.gate) return 0;
    return this.gate.drain(this.channelName, (frame) => {
      const body = Buffer.from(frame);
      this.emit('framed-message', this.framedFromBody(body));
    });
  }

  /** T16 · 全局等待队列消费 */
  async drainGlobalBackpressure(): Promise<number> {
    if (!this.gate) return 0;
    return this.gate.drainGlobal((_channelId, frame) => {
      this.emit('framed-message', this.framedFromBody(Buffer.from(frame)));
    });
  }

  private framedFromBody(body: Buffer): FramedMessage {
    const encoding = this.config.bodyEncoding;
    let bodyText: string;
    try {
      bodyText = encoding === 'utf-8' ? decodeBody(body, this.encoding) : body.toString('hex');
    } catch {
      bodyText = body.toString('hex');
    }
    return { remote: 'replayed', body, bodyEncoding: encoding, bodyText, receivedAt: Date.now() };
  }

  /** 启动 TCP server；端口 0 = OS 分配 */
  start(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const conn = this.connectionFactory(socket, this.channelName);
        this.connections.set(conn.remote, conn);

        conn.on('framed-message', (msg: FramedMessage) => {
          // T16 · 统一帧投递入口：限速在业务事件发出之前生效
          if (this.gate) {
            this.summary?.record('inbound_frame');
            const verdict = this.gate.accept(this.channelName, msg.body);
            if (!verdict.accepted) {
              this.summary?.record('rate_limited');
              this.emit('rate-limited', { channelName: this.channelName, ...verdict });
              return;
            }
          }
          this.emit('framed-message', msg);
        });

        conn.on('byte-stream-error', (err: Error) => {
          // 仅入 DLQ（非 BaseError 先包成 ASTM_PARSE_FAIL，作为字节流通用错误码）
          const classified = this.classifyError(err);
          try {
            this.dlq.enqueue({
              channelName: this.channelName,
              errorCode: classified.code,
              errorMessage: classified.message,
              rawBytes: Buffer.from([]),
            });
          } catch {
            // DLQ 失败不阻塞主路径（已 throw 包装错误一次）
          }
          this.emit('byte-stream-error', classified);
        });

        conn.on('close', () => {
          this.connections.delete(conn.remote);
        });
      });

      const onError = (e: Error & { code?: string }) => {
        if (e?.code === 'EADDRINUSE') {
          // EADDRINUSE 短退避后重试一次（与 Hl7Server 同策略）
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
   * 优雅关闭 —— graceful drain；超时后强制断连
   * forceDrainTimeoutMs = -1 禁用强制断连
   */
  stop(options?: ByteStreamServerStopOptions): Promise<void> {
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
          for (const conn of this.connections.values()) conn.close();
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

  private classifyError(err: Error) {
    if (isBaseError(err)) return err;
    const code = (err as Error & { code?: string }).code;
    if (code === 'ECONNRESET') return wrapError(err, 'HL7_FRAME_INVALID');
    if (err instanceof Hl7ParseFailError) return err;
    if (err instanceof AstmParseFailError) return err;
    if (err instanceof PrivateBytesParseFailError) return err;
    return wrapError(err, 'ASTM_PARSE_FAIL');
  }
}

/**
 * ByteStreamChannelConnection —— 单连接的帧切分器
 * - matcher：每连接独立（避免交叉污染）
 * - msgChunks + msgTotalLength：跨 read 累积不完整帧
 * - pendingStart：当前帧在**本次 read** 缓冲区中的起点（用于 endChar 时切片），逐次 read 归零
 */
export class ByteStreamChannelConnection extends EventEmitter {
  readonly channel: ByteStreamChannel;
  readonly socket: Socket;
  readonly remote: string;
  private readonly msgChunks: Buffer[] = [];
  private msgTotalLength = -1;
  private matcher: ByteSequenceMatcher;
  private closing = false;

  constructor(channel: ByteStreamChannel, socket: Socket, _channelName?: string) {
    super();
    this.channel = channel;
    this.socket = socket;
    this.remote = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
    this.matcher = new ByteSequenceMatcher(channel.getConfig().autoRespond);

    socket.on('data', (data: Buffer) => this.handle(data));
    socket.on('error', (err) => {
      this.msgChunks.length = 0;
      this.msgTotalLength = -1;
      this.emit('byte-stream-error', err);
    });
    socket.on('close', () => this.emit('close'));
  }

  /** 热更新匹配器（channel config 重载） */
  applyConfig(config: ByteStreamConfig): void {
    this.matcher = new ByteSequenceMatcher(config.autoRespond);
  }

  /** 主动关闭 */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.socket.end();
  }

  /** 写字节到 socket（供 autoRespond 使用） */
  write(buf: Buffer): boolean {
    if (this.socket.destroyed) return false;
    this.socket.write(buf);
    return true;
  }

  private handle(data: Buffer): void {
    try {
      const config = this.channel.getConfig();
      // pendingStart 只在本次 read 的缓冲区内有意义：它是 data 的下标。
      // 若跨 read 复用（曾为实例字段），上一块残留的下标会让下一次 read 的
      // endChar 切片起点错位，帧中间的字节被静默丢弃 —— 故每次 read 归零。
      let pendingStart = 0;
      let i = 0;
      while (i < data.length) {
        const char = data[i];

        // 1) 自动响应（链路级握手，匹配立刻回包）
        for (const response of this.matcher.match(char)) {
          this.write(response);
        }

        if (char === config.startChar) {
          // 帧重启：丢弃之前部分匹配进度
          this.msgChunks.length = 0;
          this.msgTotalLength = 0;
          pendingStart = i;
          this.matcher.reset();
          i++;
          continue;
        }

        if (char === config.endChar) {
          // 没有 start 的孤立 endChar → 跳过
          if (this.msgTotalLength === -1) {
            i++;
            continue;
          }
          // 含 endChar 本字节
          const slice = data.subarray(pendingStart, i + 1);
          this.msgChunks.push(Buffer.from(slice));
          this.msgTotalLength += slice.length;
          const raw = Buffer.concat(this.msgChunks, this.msgTotalLength);
          const body = filterMessageBytes(
            raw,
            config.stripSequences,
            config.stripControlChars,
            config.keepControlChars,
          );

          let bodyText: string;
          try {
            bodyText =
              config.bodyEncoding === 'utf-8'
                ? decodeBody(body, this.channel.encoding)
                : body.toString('hex');
          } catch {
            bodyText = body.toString('hex');
          }

          const framed: FramedMessage = {
            remote: this.remote,
            body,
            bodyEncoding: config.bodyEncoding,
            bodyText,
            receivedAt: Date.now(),
          };
          this.emit('framed-message', framed);

          this.msgChunks.length = 0;
          this.msgTotalLength = -1;
          pendingStart = i + 1;
          i++;
          continue;
        }

        i++;
      }

      // 残留：不完整帧保留到 chunks
      if (this.msgTotalLength !== -1 && pendingStart < data.length) {
        const remaining = data.subarray(pendingStart);
        this.msgChunks.push(Buffer.from(remaining));
        this.msgTotalLength += remaining.length;
      }
    } catch (err) {
      this.emit('byte-stream-error', err);
    }
  }
}
