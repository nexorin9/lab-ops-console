/**
 * T23 · 危急值阈值表与判定策略
 *
 * 不能只认仪器打的危急标记：有的仪器不标，有的把危急写在参考区间外。
 * 判定顺序：单位换算 → 比阈值 → 与仪器标记合并（冲突取更严重一侧并计 conflict）。
 * 阈值表缺失 / 加载失败 → 安全降级「只认仪器标记 + 告警」，绝不静默放行。
 *
 * 阈值表随字典进 git，护士长改完重启即生效。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { createLogger } from '../shared/logger.js';
import { severityFromAbnormalFlag, maxSeverity, type Severity } from './detector.js';

const log = createLogger('critical.thresholds');

export const THRESHOLD_ALERT_CODE = 'CRITICAL_THRESHOLD_DEGRADED';

export const ThresholdItemSchema = z.object({
  code: z.string().min(1),
  display: z.string().min(1),
  unit: z.string().min(1),
  low: z.number(),
  high: z.number(),
  criticalLow: z.number(),
  criticalHigh: z.number(),
  source: z.string().min(1),
});

export const ThresholdTableSchema = z.object({
  source: z.string().min(1),
  version: z.string().min(1),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(ThresholdItemSchema).min(1),
});

export type ThresholdItem = z.infer<typeof ThresholdItemSchema>;
export type ThresholdTable = z.infer<typeof ThresholdTableSchema>;

/**
 * 单位换算到阈值表的基准单位。
 * 只登记院内真实会遇到的换算，不搞通用量纲引擎（避免过度设计与误换算）。
 */
export const UNIT_CONVERSIONS: Record<string, Record<string, number>> = {
  GLU: { 'mg/dl': 1 / 18 },          // mg/dL → mmol/L
  CA: { 'mg/dl': 0.25 },              // mg/dL → mmol/L
  BUN: { 'mg/dl': 0.357 },            // mg/dL → mmol/L
  HGB: { 'g/dl': 10 },                // g/dL → g/L
  CR: { 'mg/dl': 88.4 },              // mg/dL → umol/L
  K: { 'meq/l': 1 },                  // mEq/L ≈ mmol/L（一价离子）
  NA: { 'meq/l': 1 },
  CL: { 'meq/l': 1 },
  WBC: { '10^3/ul': 1 },              // 10^3/µL == 10^9/L
  PLT: { '10^3/ul': 1 },
};

/** 把测值换算到阈值表基准单位；未知换算显式返回 null（不猜） */
export function convertToBaseUnit(code: string, value: number, fromUnit?: string): { value: number; unit: string; converted: boolean } | null {
  const table = UNIT_CONVERSIONS[code.toUpperCase()];
  const normalized = (fromUnit ?? '').trim().toLowerCase();
  if (!normalized || !table) return null;
  const factor = table[normalized];
  if (factor === undefined) return null;
  return { value: value * factor, unit: 'base', converted: factor !== 1 };
}

export interface ThresholdEvaluateInput {
  code: string;
  value: number;
  unit?: string;
  /** 仪器打的异常标记（HH / LL / H / L / A / N …） */
  instrumentFlag?: string;
}

export interface ThresholdVerdict {
  code: string;
  critical: boolean;
  severity: Severity;
  /** 判定依据：阈值 / 仪器标记 / 两者一致 / 降级路径 */
  source: 'threshold' | 'instrument' | 'both' | 'degraded' | 'none';
  reason: string;
  conflict: boolean;
  /** 换算后的测值（未换算则等于原值） */
  comparedValue: number;
  converted: boolean;
  degraded: boolean;
  threshold?: ThresholdItem;
}

export interface ThresholdAlert {
  code: string;
  message: string;
  at: string;
}

export interface ThresholdEvaluatorOptions {
  path?: string;
  /** 直接传 YAML 文本（测试 / 内嵌配置用） */
  text?: string;
  now?: () => Date;
  onAlert?: (alert: ThresholdAlert) => void;
}

export interface ThresholdStats {
  evaluations: number;
  critical: number;
  conflicts: number;
  converted: number;
  degraded: number;
}

export class CriticalThresholdEvaluator {
  private readonly path: string;
  private readonly inlineText?: string;
  private readonly now: () => Date;
  private readonly onAlert?: (alert: ThresholdAlert) => void;
  private table: ThresholdTable | null = null;
  private index = new Map<string, ThresholdItem>();
  private degraded = false;
  private loadError = '';
  private readonly counters: ThresholdStats = {
    evaluations: 0, critical: 0, conflicts: 0, converted: 0, degraded: 0,
  };

  constructor(opts: ThresholdEvaluatorOptions = {}) {
    this.path = resolve(opts.path ?? 'channels/critical-thresholds.yaml');
    this.inlineText = opts.text;
    this.now = opts.now ?? (() => new Date());
    this.onAlert = opts.onAlert;
  }

  private alert(message: string): void {
    const a: ThresholdAlert = { code: THRESHOLD_ALERT_CODE, message, at: this.now().toISOString() };
    log.warn({ errorCode: THRESHOLD_ALERT_CODE }, message);
    this.onAlert?.(a);
  }

  /** 加载并校验阈值表；失败置降级态并发告警，绝不静默 */
  load(): { ok: boolean; table: ThresholdTable | null; error: string } {
    try {
      const text = this.inlineText ?? (existsSync(this.path) ? readFileSync(this.path, 'utf-8') : null);
      if (text === null || text.trim().length === 0) {
        throw new Error(`阈值表文件不存在或为空：${this.path}`);
      }
      const parsed = ThresholdTableSchema.safeParse(YAML.parse(text));
      if (!parsed.success) {
        throw new Error(`阈值表格式非法：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      }
      this.table = parsed.data;
      this.index = new Map(parsed.data.items.map((i) => [i.code.toUpperCase(), i]));
      this.degraded = false;
      this.loadError = '';
      return { ok: true, table: parsed.data, error: '' };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.table = null;
      this.index.clear();
      this.degraded = true;
      this.loadError = message;
      this.alert(`阈值表加载失败，判定降级为「只认仪器标记」：${message}`);
      return { ok: false, table: null, error: message };
    }
  }

  get isDegraded(): boolean { return this.degraded; }
  get version(): string { return this.table?.version ?? ''; }
  get effectiveDate(): string { return this.table?.effectiveDate ?? ''; }
  get source(): string { return this.table?.source ?? ''; }
  get loadErrorMessage(): string { return this.loadError; }
  get size(): number { return this.index.size; }
  stats(): ThresholdStats { return { ...this.counters }; }

  /** 仪器标记 → 是否判危急（HH / LL / AA 视为危急） */
  private instrumentCritical(flag?: string): boolean {
    if (!flag) return false;
    return severityFromAbnormalFlag(flag) === 'critical';
  }

  evaluate(input: ThresholdEvaluateInput): ThresholdVerdict {
    this.counters.evaluations += 1;
    const code = (input.code ?? '').trim().toUpperCase();
    const instrumentCritical = this.instrumentCritical(input.instrumentFlag);
    const threshold = this.index.get(code);
    let comparedValue = input.value;
    let converted = false;

    // ---- 降级路径：只认仪器标记，且必须发告警 ----
    if (this.degraded || !this.table) {
      if (!this.degraded) { this.degraded = true; this.loadError = '阈值表未加载'; }
      this.counters.degraded += 1;
      this.alert(`阈值表不可用，按仪器标记判定 ${code}（原因：${this.loadError}）`);
      if (instrumentCritical) this.counters.critical += 1;
      return {
        code,
        critical: instrumentCritical,
        severity: instrumentCritical ? 'critical' : 'low',
        source: 'degraded',
        reason: `阈值表不可用，已降级为只认仪器标记（${this.loadError}）`,
        conflict: false,
        comparedValue,
        converted: false,
        degraded: true,
      };
    }

    // ---- 单位换算（同单位直接用；未知换算不猜测，按原值比阈值并标注）----
    if (threshold && input.unit && input.unit.trim().toLowerCase() !== threshold.unit.trim().toLowerCase()) {
      const conv = convertToBaseUnit(code, input.value, input.unit);
      if (conv) {
        comparedValue = conv.value;
        converted = conv.converted;
        if (converted) this.counters.converted += 1;
      }
    }

    // ---- 阈值判定 ----
    let thresholdSeverity: Severity = 'low';
    let thresholdReason = '';
    if (threshold) {
      if (comparedValue <= threshold.criticalLow || comparedValue >= threshold.criticalHigh) {
        thresholdSeverity = 'critical';
        thresholdReason = `${comparedValue} 超出危急上下限 [${threshold.criticalLow}, ${threshold.criticalHigh}]`;
      } else if (comparedValue < threshold.low || comparedValue > threshold.high) {
        thresholdSeverity = 'high';
        thresholdReason = `${comparedValue} 超出参考区间 [${threshold.low}, ${threshold.high}]`;
      } else {
        thresholdReason = `${comparedValue} 在参考区间内`;
      }
    } else {
      thresholdReason = `项目 ${code} 不在阈值表内`;
    }

    const instrumentSeverity: Severity = input.instrumentFlag
      ? severityFromAbnormalFlag(input.instrumentFlag)
      : 'low';
    const thresholdCritical = thresholdSeverity === 'critical';
    const conflict = !!input.instrumentFlag && threshold !== undefined && instrumentCritical !== thresholdCritical;
    if (conflict) {
      this.counters.conflicts += 1;
      this.alert(`${code} 仪器标记与阈值判定冲突：标记=${input.instrumentFlag}（危急=${instrumentCritical}），阈值=${thresholdReason}（危急=${thresholdCritical}），已取更严重一侧`);
    }

    // ---- 取更严重一侧 ----
    const severity = maxSeverity(thresholdSeverity, instrumentSeverity);
    const critical = severity === 'critical';
    if (critical) this.counters.critical += 1;

    return {
      code,
      critical,
      severity,
      source: !input.instrumentFlag ? 'threshold'
        : !threshold ? 'instrument'
          : instrumentSeverity === thresholdSeverity ? 'both' : (severity === instrumentSeverity ? 'instrument' : 'threshold'),
      reason: conflict
        ? `冲突已取更严重一侧：${thresholdReason}；仪器标记=${input.instrumentFlag}`
        : [thresholdReason, input.instrumentFlag ? `仪器标记=${input.instrumentFlag}` : ''].filter(Boolean).join('；'),
      conflict,
      comparedValue,
      converted,
      degraded: false,
      ...(threshold ? { threshold } : {}),
    };
  }
}
