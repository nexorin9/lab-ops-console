/**
 * ChannelRegistry —— 多通道并存装配 + 统一事件总线 + 通道状态上报
 *
 * 设计原则：
 * - 一份 yaml 一条通道；各通道互不影响（一条配错 / 一条断线不动其余）
 * - 所有通道的业务事件汇到同一个事件总线，上层只订阅一处：
 *     'channel:message'      → { channelId, message }   （HL7 v2 解析成功的帧）
 *     'channel:framed-message'→ { channelId, frame }     （字节流 / ASTM 帧）
 *     'channel:error'        → { channelId, error }      （解析失败等，已落 DLQ）
 * - 通道健康状态：connected（已连上）/ degraded（连着但有错）/ down（断了）/ stopped（已停）
 *   —— 面板据此显示「这台仪器现在还能不能用」，而不是只显示「进程还活着」
 * - 状态变更走结构化日志 + 事件总线，面板可订阅 'channel:status'
 *
 * 现场价值：换一台仪器 = 改一份 yaml + 重启通道，其余仪器照常收样本。
 */

import { EventEmitter } from 'node:events';
import { createLogger } from '../shared/logger.js';
import { isBaseError } from '../shared/errors.js';
import { Hl7Server } from './Hl7Server.js';
import { ByteStreamChannel } from './ByteStreamChannel.js';
import { SerialPortChannel } from './SerialPortChannel.js';
import { getDLQ, type DLQ } from './DLQ.js';
import {
  loadAllChannelsWithReport,
  type ChannelLoadError,
  type LoadedChannel,
  type LoadChannelsOptions,
} from './channel-loader.js';

const log = createLogger('channels.registry');

/** 通道健康状态 */
export type ChannelHealth = 'connected' | 'degraded' | 'down' | 'stopped';

export interface ChannelStatus {
  /** 通道标识（yaml 的 name） */
  id: string;
  /** 通道协议类型（hl7 / bytestream / private） */
  type: string;
  /** 当前健康状态 */
  status: ChannelHealth;
  /** 最近一次收到数据的时间（ISO） */
  lastHeartbeatAt: string | null;
  /** 累计收到的帧数 */
  framesReceived: number;
  /** 最近一次错误码 */
  lastErrorCode: string | null;
  /** 实际监听端口（0 / 未监听为 null） */
  port: number | null;
}

export interface ChannelRegistryOptions extends LoadChannelsOptions {
  /** 端口冲突 / 启动失败时是否把通道置为 down（默认 true，不抛） */
  tolerateStartFailure?: boolean;
}

export class ChannelRegistry extends EventEmitter {
  private readonly channels = new Map<string, LoadedChannel>();
  private readonly statusMap = new Map<string, ChannelStatus>();
  private readonly errors: ChannelLoadError[] = [];

  constructor(private readonly opts: ChannelRegistryOptions = {}) {
    super();
  }

  /**
   * 加载 channels 目录 —— 单条非法配置只报错，其余通道照常装配。
   * @returns 加载失败的配置（逐条，含字段名）
   */
  async load(dir: string): Promise<ChannelLoadError[]> {
    const result = await loadAllChannelsWithReport(dir, {
      onChannel: this.opts.onChannel,
      onError: this.opts.onError,
      strict: this.opts.strict,
      dlq: this.opts.dlq,
    });
    this.errors.length = 0;
    this.errors.push(...result.errors);
    for (const lc of result.channels) {
      this.channels.set(lc.yaml.name, lc);
      this.statusMap.set(lc.yaml.name, {
        id: lc.yaml.name,
        type: lc.yaml.type,
        status: 'stopped',
        lastHeartbeatAt: null,
        framesReceived: 0,
        lastErrorCode: null,
        port: null,
      });
      this.wire(lc);
    }
    if (result.errors.length > 0) {
      log.warn(
        { failed: result.errors.length, files: result.errors.map((e) => e.file) },
        '部分通道配置加载失败（其余通道不受影响）',
      );
    }
    return result.errors;
  }

  /**
   * 启动全部已装配通道 —— 一条起不来不影响其余（该条置 down 并记录错误码）。
   * @returns 每条通道启动后的状态
   */
  async startAll(): Promise<ChannelStatus[]> {
    for (const [id, lc] of this.channels) {
      await this.startOne(id, lc);
    }
    return this.status();
  }

  /** 启动单条通道 */
  private async startOne(id: string, lc: LoadedChannel): Promise<void> {
    const instance = lc.instance;
    if (!instance) {
      // private 协议通道当前只装配解析配置，不起 socket
      this.updateStatus(id, { status: 'connected', port: null });
      return;
    }
    try {
      if (instance instanceof Hl7Server) {
        const port = await instance.start(portOf(lc));
        this.updateStatus(id, { status: 'connected', port });
      } else if (instance instanceof ByteStreamChannel) {
        const port = await instance.start(portOf(lc));
        this.updateStatus(id, { status: 'connected', port });
      } else if (instance instanceof SerialPortChannel) {
        await instance.open();
        this.updateStatus(id, { status: 'connected', port: null });
      } else {
        this.updateStatus(id, { status: 'connected', port: null });
      }
      log.info({ channelId: id, type: lc.yaml.type }, '通道已启动');
    } catch (err) {
      const code = isBaseError(err) ? err.code : 'CHANNEL_CONFIG_ERROR';
      this.updateStatus(id, { status: 'down', lastErrorCode: code });
      log.error(
        { channelId: id, type: lc.yaml.type, err_message: (err as Error).message },
        '通道启动失败（其余通道不受影响）',
      );
      if (!this.opts.tolerateStartFailure) throw err;
    }
  }

  /** 把单条通道的事件接到统一总线 */
  private wire(lc: LoadedChannel): void {
    const id = lc.yaml.name;
    const instance = lc.instance;
    if (!instance) return;

    if (instance instanceof Hl7Server) {
      instance.on('message', ({ message }: { message: unknown }) => {
        this.touch(id);
        this.emit('channel:message', { channelId: id, message });
      });
      instance.on('error', (err: Error) => {
        this.markError(id, err);
        this.emit('channel:error', { channelId: id, error: err });
      });
      return;
    }

    if (instance instanceof ByteStreamChannel) {
      instance.on('framed-message', (frame: unknown) => {
        this.touch(id);
        this.emit('channel:framed-message', { channelId: id, frame });
      });
      instance.on('byte-stream-error', (err: Error) => {
        this.markError(id, err);
        this.emit('channel:error', { channelId: id, error: err });
      });
      return;
    }

    if (instance instanceof SerialPortChannel) {
      instance.on('framed-message', (frame: unknown) => {
        this.touch(id);
        this.emit('channel:framed-message', { channelId: id, frame });
      });
      instance.on('byte-stream-error', (err: Error) => {
        this.markError(id, err);
        this.emit('channel:error', { channelId: id, error: err });
      });
    }
  }

  /** 收到数据 → 刷新心跳 + 帧数 */
  private touch(id: string): void {
    const st = this.statusMap.get(id);
    if (!st) return;
    this.updateStatus(id, {
      lastHeartbeatAt: new Date().toISOString(),
      framesReceived: st.framesReceived + 1,
      status: st.status === 'degraded' ? 'connected' : st.status,
    });
  }

  /** 出错 → 置 degraded 并记错误码（连接还在，但这条数据没进来） */
  private markError(id: string, err: Error): void {
    const code = isBaseError(err) ? err.code : 'CHANNEL_CONFIG_ERROR';
    const st = this.statusMap.get(id);
    this.updateStatus(id, {
      status: st?.status === 'down' ? 'down' : 'degraded',
      lastErrorCode: code,
    });
  }

  private updateStatus(id: string, patch: Partial<ChannelStatus>): void {
    const st = this.statusMap.get(id);
    if (!st) return;
    const next = { ...st, ...patch };
    this.statusMap.set(id, next);
    this.emit('channel:status', next);
  }

  /** 通道状态快照（面板 /api/channels 用） */
  status(): ChannelStatus[] {
    return [...this.statusMap.values()].map((s) => ({ ...s }));
  }

  /** 加载失败的配置 */
  loadErrors(): ChannelLoadError[] {
    return this.errors.map((e) => ({ ...e }));
  }

  /** 已装配的通道 id */
  channelIds(): string[] {
    return [...this.channels.keys()];
  }

  /**
   * 共享死信队列实例 —— 通道解析失败与 FHIR 写回失败都进这一份，
   * 面板 / 运维查的是同一张 dlq_messages 表。
   */
  getDlq(): DLQ {
    return this.opts.dlq ?? getDLQ();
  }

  /** 停止全部通道 */
  async stopAll(): Promise<void> {
    for (const [id, lc] of this.channels) {
      const instance = lc.instance;
      try {
        if (instance instanceof Hl7Server) {
          await instance.stop({ forceDrainTimeoutMs: 1000 });
        } else if (instance instanceof ByteStreamChannel) {
          await instance.stop({ forceDrainTimeoutMs: 1000 });
        } else if (instance instanceof SerialPortChannel) {
          await instance.close();
        }
      } catch (err) {
        log.warn(
          { channelId: id, err_message: (err as Error).message },
          '通道停止失败（忽略，继续停其余通道）',
        );
      }
      this.updateStatus(id, { status: 'stopped' });
    }
  }
}

/** 从 yaml 里取监听端口（hl7 → deviceListenPort；bytestream → listenPort） */
function portOf(lc: LoadedChannel): number {
  const yaml = lc.yaml as unknown as {
    deviceListenPort?: number;
    listenPort?: number;
  };
  return yaml.deviceListenPort ?? yaml.listenPort ?? 0;
}
