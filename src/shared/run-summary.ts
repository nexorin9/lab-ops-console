/**
 * RunSummary —— 5 分钟窗口运行摘要（信息科运维抓手 + 飞检时说明系统健康度）
 *
 * 统计：入站帧 / 解析成功 / DLQ / 危急值 / FHIR 失败 / 模型降级 / 推送失败 /
 *       限速拒绝 / 字典命中 / 字典未命中。窗口到期自动汇总一条结构化日志并开新窗口，
 * 累计总数不重置。
 */

import { createLogger, type AppLogger } from './logger.js';

export type SummaryEvent =
  | 'inbound_frame'
  | 'parsed_ok'
  | 'dlq'
  | 'critical'
  | 'fhir_failure'
  | 'model_fallback'
  | 'push_failure'
  | 'rate_limited'
  | 'dictionary_hit'
  | 'dictionary_miss';

const EVENT_KEYS: SummaryEvent[] = [
  'inbound_frame', 'parsed_ok', 'dlq', 'critical', 'fhir_failure',
  'model_fallback', 'push_failure', 'rate_limited', 'dictionary_hit', 'dictionary_miss',
];

export type SummaryCounts = Record<SummaryEvent, number>;

export interface SummarySnapshot {
  startedAt: string;
  windowMs: number;
  window: SummaryCounts;
  totals: SummaryCounts;
  /** 字典命中率（百分比，保留 1 位小数；无样本时 0） */
  dictionaryHitRate: number;
  flushes: number;
}

function emptyCounts(): SummaryCounts {
  return Object.fromEntries(EVENT_KEYS.map((k) => [k, 0])) as SummaryCounts;
}

export interface RunSummaryOptions {
  windowMs?: number;
  now?: () => number;
  logger?: AppLogger;
  /** 窗口到期回调（面板 WS 推一次摘要） */
  onFlush?: (snapshot: SummarySnapshot) => void;
}

export const DEFAULT_SUMMARY_WINDOW_MS = 5 * 60 * 1000;

export class RunSummary {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly logger: AppLogger;
  private readonly onFlush?: (snapshot: SummarySnapshot) => void;
  private window: SummaryCounts = emptyCounts();
  private totals: SummaryCounts = emptyCounts();
  private windowStartedAt: number;
  private flushes = 0;

  constructor(opts: RunSummaryOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_SUMMARY_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger ?? createLogger('shared.run-summary');
    this.onFlush = opts.onFlush;
    this.windowStartedAt = this.now();
  }

  record(event: SummaryEvent, count = 1): void {
    this.maybeFlush();
    this.window[event] += count;
    this.totals[event] += count;
  }

  recordMany(events: Partial<SummaryCounts>): void {
    for (const [k, v] of Object.entries(events)) {
      if (v) this.record(k as SummaryEvent, v);
    }
  }

  /** 窗口到期则汇总并归零（保留 totals） */
  maybeFlush(): SummarySnapshot | null {
    if (this.now() - this.windowStartedAt < this.windowMs) return null;
    const snapshot = this.snapshot();
    this.logger.info({ window: snapshot.window, totals: snapshot.totals, flushes: this.flushes + 1 }, '运行摘要（5 分钟窗口）');
    this.flushes += 1;
    this.window = emptyCounts();
    this.windowStartedAt = this.now();
    this.onFlush?.(snapshot);
    return snapshot;
  }

  /** 面板可读接口（GET /api/summary） */
  snapshot(): SummarySnapshot {
    const hits = this.window.dictionary_hit;
    const misses = this.window.dictionary_miss;
    const total = hits + misses;
    return {
      startedAt: new Date(this.windowStartedAt).toISOString(),
      windowMs: this.windowMs,
      window: { ...this.window },
      totals: { ...this.totals },
      dictionaryHitRate: total === 0 ? 0 : Math.round((hits / total) * 1000) / 10,
      flushes: this.flushes,
    };
  }
}
