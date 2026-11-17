/**
 * ChannelSupervisor —— 多通道生命周期 / 单通道热重载 / 断线指数退避重连
 *
 * 关键不变量：reload(channelId) 只重建目标通道的连接与解析器，
 * 其余通道的 TCP 端口与在途消息不受影响（「换一台仪器不影响别的仪器」）。
 * 断线置 degraded 并按 10s / 30s / 90s 退避，最多 5 次后置 down 并发告警。
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('channels.supervisor');

export type ChannelHealth = 'starting' | 'running' | 'degraded' | 'down' | 'stopped';

/** 通道实例的最小契约（Hl7Server / ByteStreamChannel / SerialPortChannel 各自适配） */
export interface ManagedChannel {
  id: string;
  type: string;
  start(): Promise<number>;
  stop(): Promise<void>;
  /** 断线回调注册（可选；不支持时由上层显式调用 markDisconnect） */
  onDisconnect?(cb: (err?: Error) => void): void;
}

export interface ChannelFactory {
  id: string;
  type: string;
  create: () => ManagedChannel;
}

export interface ChannelRuntimeStatus {
  id: string;
  type: string;
  status: ChannelHealth;
  port: number;
  lastHeartbeatAt: string | null;
  frameCount: number;
  lastErrorCode: string | null;
  retryCount: number;
}

export interface SupervisorOptions {
  factories: ChannelFactory[];
  /** 退避序列（默认 10s / 30s / 90s，之后沿用最后一档） */
  backoffMs?: number[];
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onAlert?: (event: { channelId: string; level: string; message: string }) => void | Promise<void>;
  onStatusChange?: (status: ChannelRuntimeStatus) => void;
  /** 断线后是否自动重连（默认 true；测试可关） */
  autoReconnect?: boolean;
}

export const DEFAULT_BACKOFF_MS = [10_000, 30_000, 90_000];

interface ChannelSlot {
  factory: ChannelFactory;
  channel: ManagedChannel | null;
  status: ChannelHealth;
  port: number;
  lastHeartbeatAt: string | null;
  frameCount: number;
  lastErrorCode: string | null;
  retryCount: number;
  reloading: boolean;
}

export class ChannelSupervisor {
  private readonly slots = new Map<string, ChannelSlot>();
  private readonly backoff: number[];
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onAlert?: SupervisorOptions['onAlert'];
  private readonly onStatusChange?: SupervisorOptions['onStatusChange'];
  private readonly autoReconnect: boolean;
  private reconnectChain = new Map<string, Promise<void>>();

  constructor(opts: SupervisorOptions) {
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxRetries = opts.maxRetries ?? 5;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onAlert = opts.onAlert;
    this.onStatusChange = opts.onStatusChange;
    this.autoReconnect = opts.autoReconnect ?? true;
    for (const f of opts.factories) this.addFactory(f);
  }

  /** 注册 / 替换工厂（loadChannels 语义） */
  addFactory(factory: ChannelFactory): void {
    this.slots.set(factory.id, {
      factory, channel: null, status: 'stopped', port: 0,
      lastHeartbeatAt: null, frameCount: 0, lastErrorCode: null, retryCount: 0, reloading: false,
    });
  }

  async startAll(): Promise<ChannelRuntimeStatus[]> {
    const out: ChannelRuntimeStatus[] = [];
    for (const id of this.slots.keys()) out.push(await this.startChannel(id));
    return out;
  }

  async startChannel(id: string): Promise<ChannelRuntimeStatus> {
    const slot = this.slot(id);
    this.setStatus(slot, 'starting');
    try {
      const channel = slot.factory.create();
      slot.port = await channel.start();
      slot.channel = channel;
      slot.lastHeartbeatAt = new Date(this.now()).toISOString();
      slot.retryCount = 0;
      slot.lastErrorCode = null;
      this.setStatus(slot, 'running');
      channel.onDisconnect?.((err) => { void this.handleDisconnect(id, err); });
    } catch (err) {
      slot.lastErrorCode = err instanceof Error ? err.message : String(err);
      this.setStatus(slot, 'down');
      void this.onAlert?.({ channelId: id, level: 'error', message: `通道启动失败：${slot.lastErrorCode}` });
    }
    return this.view(slot);
  }

  /** 单通道热重载：只 stop/start 目标通道，其余槽位原封不动 */
  async reload(id: string): Promise<ChannelRuntimeStatus> {
    const slot = this.slot(id);
    if (slot.reloading) return this.view(slot); // 重复 reload 幂等
    slot.reloading = true;
    try {
      if (slot.channel) {
        try { await slot.channel.stop(); } catch (err) {
          log.warn({ channelId: id, err: (err as Error).message }, 'reload: stop 旧通道失败，继续重建');
        }
      }
      slot.channel = null;
      this.setStatus(slot, 'stopped');
      return await this.startChannel(id);
    } finally {
      slot.reloading = false;
    }
  }

  async stopAll(): Promise<void> {
    for (const slot of this.slots.values()) {
      if (slot.channel) {
        try { await slot.channel.stop(); } catch { /* 停止阶段不再抛给调用方 */ }
      }
      slot.channel = null;
      slot.port = 0;
      this.setStatus(slot, 'stopped');
    }
    this.reconnectChain.clear();
  }

  /** 通道收到一帧：心跳时间 + 累计帧数 + 从 degraded 自动回到 running */
  markFrame(id: string, count = 1): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.frameCount += count;
    slot.lastHeartbeatAt = new Date(this.now()).toISOString();
    if (slot.status === 'degraded') {
      slot.retryCount = 0;
      this.setStatus(slot, 'running');
    }
  }

  markError(id: string, code: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.lastErrorCode = code;
  }

  /** 断线：置 degraded，按 10s/30s/90s 退避重连，5 次后 down + 告警 */
  async handleDisconnect(id: string, err?: Error): Promise<void> {
    const slot = this.slot(id);
    slot.lastErrorCode = err?.message ?? 'connection_closed';
    this.setStatus(slot, 'degraded');
    if (!this.autoReconnect) return;
    const prev = this.reconnectChain.get(id) ?? Promise.resolve();
    const chain = prev.then(() => this.reconnectLoop(id));
    this.reconnectChain.set(id, chain);
    await chain;
  }

  private async reconnectLoop(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || slot.status === 'stopped') return;
    const isStopped = (): boolean => (slot.status as ChannelHealth) === 'stopped';
    while (slot.retryCount < this.maxRetries && !isStopped()) {
      const wait = this.backoff[Math.min(slot.retryCount, this.backoff.length - 1)]!;
      slot.retryCount += 1;
      await this.sleep(wait);
      if (isStopped()) return;
      try {
        const channel = slot.factory.create();
        slot.port = await channel.start();
        slot.channel = channel;
        slot.lastHeartbeatAt = new Date(this.now()).toISOString();
        slot.retryCount = 0;
        slot.lastErrorCode = null;
        this.setStatus(slot, 'running');
        channel.onDisconnect?.((e) => { void this.handleDisconnect(id, e); });
        return;
      } catch (err) {
        slot.lastErrorCode = err instanceof Error ? err.message : String(err);
      }
    }
    this.setStatus(slot, 'down');
    await this.onAlert?.({ channelId: id, level: 'critical', message: `通道 ${id} 重连 ${this.maxRetries} 次失败，已置 down` });
  }

  /** 返回本次退避序列（供测试与文档引用） */
  backoffSchedule(n = this.maxRetries): number[] {
    return Array.from({ length: n }, (_, i) => this.backoff[Math.min(i, this.backoff.length - 1)]!);
  }

  status(): ChannelRuntimeStatus[] {
    return [...this.slots.values()].map((s) => this.view(s));
  }

  private view(slot: ChannelSlot): ChannelRuntimeStatus {
    return {
      id: slot.factory.id,
      type: slot.factory.type,
      status: slot.status,
      port: slot.port,
      lastHeartbeatAt: slot.lastHeartbeatAt,
      frameCount: slot.frameCount,
      lastErrorCode: slot.lastErrorCode,
      retryCount: slot.retryCount,
    };
  }

  private setStatus(slot: ChannelSlot, status: ChannelHealth): void {
    slot.status = status;
    log.info({ channelId: slot.factory.id, status }, 'channel status changed');
    this.onStatusChange?.(this.view(slot));
  }

  private slot(id: string): ChannelSlot {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`未知通道：${id}`);
    return slot;
  }
}
