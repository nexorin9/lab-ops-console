/**
 * T16 · 入站速率限制与背压
 *
 * 仪器批量出结果时会短时洪峰：每通道一套令牌桶 + 有界等待队列，
 * 队列满时按「拒绝并记账」处理 —— 被拒帧写 DLQ 并标 error_code=rate_limited，
 * 同时打点计数，绝不静默丢帧。全局配额单列统计，便于区分「某台仪器太快」还是「整体过载」。
 *
 * 不变量：submitted = rejected + queued + delivered（任何时刻都可对账）。
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('channels.backpressure');

export interface TokenBucketOptions {
  /** 每秒补充令牌数 */
  ratePerSec: number;
  /** 桶容量（突发额度） */
  burst: number;
  now?: () => number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly rate: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    this.rate = Math.max(0, opts.ratePerSec);
    this.capacity = Math.max(1, opts.burst);
    this.tokens = this.capacity;
    this.now = opts.now ?? Date.now;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  /** 取 n 个令牌；不足返回 false（不阻塞） */
  tryConsume(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  get available(): number { this.refill(); return this.tokens; }
}

export class BoundedQueue<T> {
  private readonly items: T[] = [];
  private highWater = 0;
  constructor(readonly limit: number) {}

  push(item: T): boolean {
    if (this.items.length >= this.limit) return false;
    this.items.push(item);
    this.highWater = Math.max(this.highWater, this.items.length);
    return true;
  }

  shift(): T | undefined { return this.items.shift(); }
  get size(): number { return this.items.length; }
  get highWaterMark(): number { return this.highWater; }
  values(): T[] { return [...this.items]; }
}

/** DLQ 落点（与 channels/DLQ 的 enqueue 结构兼容） */
export interface RateLimitDlq {
  enqueue(input: {
    channelName: string;
    errorCode: string;
    errorMessage?: string;
    rawBytes: Buffer | Uint8Array;
  }): unknown;
}

export interface QuotaConfig {
  ratePerSec: number;
  burst: number;
  queueLimit: number;
}

export interface BackpressureOptions {
  perChannel: QuotaConfig;
  global?: QuotaConfig;
  dlq?: RateLimitDlq;
  now?: () => number;
  onReject?: (event: { channelId: string; scope: 'channel' | 'global'; reason: string }) => void;
}

export interface GateMetrics {
  submitted: number;
  delivered: number;
  queued: number;
  rejected: number;
  rateLimited: number;
  globalOverflow: number;
  queueHighWater: number;
  byChannel: Record<string, { submitted: number; rejected: number; queueDepth: number }>;
}

export interface AcceptResult {
  accepted: boolean;
  reason?: 'rate_limited' | 'queue_full' | 'global_rate_limited';
  scope?: 'channel' | 'global';
}

interface ChannelSlot {
  bucket: TokenBucket;
  queue: BoundedQueue<Uint8Array>;
  submitted: number;
  rejected: number;
  delivered: number;
}

export const RATE_LIMITED_ERROR_CODE = 'rate_limited';

export class BackpressureGate {
  private readonly opts: BackpressureOptions;
  private readonly slots = new Map<string, ChannelSlot>();
  private readonly globalBucket: TokenBucket | null;
  private readonly globalQueue: BoundedQueue<{ channelId: string; frame: Uint8Array }> | null;
  private submitted = 0;
  private rejected = 0;
  private delivered = 0;
  private rateLimited = 0;
  private globalOverflow = 0;

  constructor(opts: BackpressureOptions) {
    this.opts = opts;
    this.globalBucket = opts.global ? new TokenBucket({ ...opts.global, ...(opts.now ? { now: opts.now } : {}) }) : null;
    this.globalQueue = opts.global ? new BoundedQueue<{ channelId: string; frame: Uint8Array }>(opts.global.queueLimit) : null;
  }

  private slot(channelId: string): ChannelSlot {
    let slot = this.slots.get(channelId);
    if (!slot) {
      slot = {
        bucket: new TokenBucket({
          ratePerSec: this.opts.perChannel.ratePerSec,
          burst: this.opts.perChannel.burst,
          ...(this.opts.now ? { now: this.opts.now } : {}),
        }),
        queue: new BoundedQueue<Uint8Array>(this.opts.perChannel.queueLimit),
        submitted: 0, rejected: 0, delivered: 0,
      };
      this.slots.set(channelId, slot);
    }
    return slot;
  }

  /**
   * 帧投递前统一入口。返回 accepted=true 表示可立即处理；
   * 被限速的帧先入有界队列，队列满则写 DLQ（标 rate_limited）。
   */
  accept(channelId: string, frame: Uint8Array | string): AcceptResult {
    const bytes = typeof frame === 'string' ? Buffer.from(frame, 'utf-8') : frame;
    const slot = this.slot(channelId);
    this.submitted += 1;
    slot.submitted += 1;

    if (this.globalBucket && !this.globalBucket.tryConsume()) {
      if (this.globalQueue!.push({ channelId, frame: bytes })) {
        return { accepted: false, reason: 'global_rate_limited', scope: 'global' };
      }
      this.reject(channelId, bytes, 'global_rate_limited', 'global');
      this.globalOverflow += 1;
      return { accepted: false, reason: 'global_rate_limited', scope: 'global' };
    }

    if (!slot.bucket.tryConsume()) {
      if (slot.queue.push(bytes)) {
        return { accepted: false, reason: 'rate_limited', scope: 'channel' };
      }
      this.reject(channelId, bytes, 'queue_full', 'channel');
      return { accepted: false, reason: 'queue_full', scope: 'channel' };
    }
    slot.delivered += 1;
    this.delivered += 1;
    return { accepted: true };
  }

  private reject(channelId: string, bytes: Uint8Array, reason: string, scope: 'channel' | 'global'): void {
    const slot = this.slot(channelId);
    slot.rejected += 1;
    this.rejected += 1;
    this.rateLimited += 1;
    try {
      this.opts.dlq?.enqueue({
        channelName: channelId,
        errorCode: RATE_LIMITED_ERROR_CODE,
        errorMessage: `${scope} 背压溢出：${reason}`,
        rawBytes: Buffer.from(bytes),
      });
    } catch (err) {
      log.error({ channelId, err: (err as Error).message }, '限速溢出帧写 DLQ 失败');
    }
    log.warn({ channelId, scope, reason, errorCode: RATE_LIMITED_ERROR_CODE }, '入站帧被限速拒绝，原始字节已入 DLQ');
    this.opts.onReject?.({ channelId, scope, reason });
  }

  /** 恢复后按序消费等待队列；handle 返回 false 表示仍不可用，保留在队列中 */
  async drain(channelId: string, handle: (frame: Uint8Array) => void | Promise<void>): Promise<number> {
    const slot = this.slot(channelId);
    let count = 0;
    while (slot.queue.size > 0 && slot.bucket.tryConsume()) {
      const frame = slot.queue.shift();
      if (!frame) break;
      await handle(frame);
      slot.delivered += 1;
      this.delivered += 1;
      count += 1;
    }
    return count;
  }

  /** 全局等待队列消费 */
  async drainGlobal(handle: (channelId: string, frame: Uint8Array) => void | Promise<void>): Promise<number> {
    if (!this.globalQueue || !this.globalBucket) return 0;
    let count = 0;
    while (this.globalQueue.size > 0 && this.globalBucket.tryConsume()) {
      const item = this.globalQueue.shift();
      if (!item) break;
      await handle(item.channelId, item.frame);
      this.delivered += 1;
      this.slot(item.channelId).delivered += 1;
      count += 1;
    }
    return count;
  }

  metrics(): GateMetrics {
    const byChannel: GateMetrics['byChannel'] = {};
    let queued = 0;
    let queueHighWater = 0;
    for (const [id, slot] of this.slots) {
      byChannel[id] = { submitted: slot.submitted, rejected: slot.rejected, queueDepth: slot.queue.size };
      queued += slot.queue.size;
      queueHighWater = Math.max(queueHighWater, slot.queue.highWaterMark);
    }
    if (this.globalQueue) {
      queued += this.globalQueue.size;
      queueHighWater = Math.max(queueHighWater, this.globalQueue.highWaterMark);
    }
    return {
      submitted: this.submitted,
      delivered: this.delivered,
      queued,
      rejected: this.rejected,
      rateLimited: this.rateLimited,
      globalOverflow: this.globalOverflow,
      queueHighWater,
      byChannel,
    };
  }
}
