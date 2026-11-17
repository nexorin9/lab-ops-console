/**
 * field-mapper —— 仪器码 → LOINC 字段归因
 *
 * 设计原则：
 * - 优先查内置字典（确定性，命中 ≥0.85 confidence）
 * - 字典未命中 → 调 ModelGateway.suggestLoinc() 兜底（ai_role=assist，命中 0–1 confidence）
 * - ModelGateway 不可达 → 标 low_confidence + 仍返回候选；不阻塞主路径
 * - 任何来源的命中都允许在 sqlite 落盘（callers 负责 T5 写回；本层只返回结构化结果）
 *
 * 内置字典覆盖常见生化 / 血细胞 / 免疫项目的仪器内部码 → LOINC 主码映射。
 * 这是医院场景的最小可信基线：钾 / 钠 / 氯 / 钙 / 葡萄糖 / 血红蛋白等。
 */

import { ModelUnavailableFallbackError } from '../shared/errors.js';

export interface LoincSuggestion {
  loinc: string;
  display: string;
  /** 0–1，≥0.85 视为高置信 */
  confidence: number;
  source: 'dictionary' | 'model' | 'fallback';
  /**
   * 是否为低置信结果（字典未命中 + 模型兜底不可用）。
   * 低置信结果仍返回（不阻塞主路径），但面板与审计会标出来等人确认。
   */
  lowConfidence: boolean;
  /** 解释（模型返回时用） */
  reason?: string;
}

export interface ModelGatewayLike {
  suggestLoinc(input: {
    deviceCode: string;
    deviceDisplay: string;
    context: { deviceId: string; panelCode?: string };
  }): Promise<LoincSuggestion>;
}

export interface FieldMapperOptions {
  /** 字典查表命中阈值；≥ 此值直接返回，不再调 model */
  dictionaryThreshold?: number;
  /** model 命中阈值（一般 0.5 即可，0.5 以下标 low_confidence） */
  modelAcceptThreshold?: number;
}

/** 内置字典：常见生化 + 血细胞 + 免疫项目 */
const BUILTIN_DICTIONARY: Record<string, LoincSuggestion> = {
  // 生化
  K: { loinc: '2823-3', display: 'Potassium [Moles/volume] in Serum or Plasma', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  NA: { loinc: '2951-2', display: 'Sodium [Moles/volume] in Serum or Plasma', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  CL: { loinc: '2075-0', display: 'Chloride [Moles/volume] in Serum or Plasma', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  CA: { loinc: '17861-6', display: 'Calcium [Moles/volume] in Serum or Plasma', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  GLU: { loinc: '2345-7', display: 'Glucose [Moles/volume] in Serum or Plasma', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  BUN: { loinc: '3094-0', display: 'Urea nitrogen [Mass/volume] in Serum or Plasma', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  CR: { loinc: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma', confidence: 0.92, source: 'dictionary', lowConfidence: false },
  ALT: { loinc: '1742-6', display: 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma', confidence: 0.92, source: 'dictionary', lowConfidence: false },
  AST: { loinc: '1920-8', display: 'Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma', confidence: 0.92, source: 'dictionary', lowConfidence: false },
  // 血细胞
  WBC: { loinc: '6690-2', display: 'Leukocytes [#/volume] in Blood by Automated count', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  RBC: { loinc: '789-8', display: 'Erythrocytes [#/volume] in Blood by Automated count', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  HGB: { loinc: '718-7', display: 'Hemoglobin [Mass/volume] in Blood', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  HCT: { loinc: '4544-3', display: 'Hematocrit [Volume Fraction] of Blood by Automated count', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  PLT: { loinc: '777-3', display: 'Platelets [#/volume] in Blood by Automated count', confidence: 0.95, source: 'dictionary', lowConfidence: false },
  // 免疫
  HBSAG: { loinc: '5195-3', display: 'Hepatitis B virus surface Ag [Presence] in Serum', confidence: 0.9, source: 'dictionary', lowConfidence: false },
  HIV: { loinc: '5221-7', display: 'HIV 1 Ab [Presence] in Serum', confidence: 0.88, source: 'dictionary', lowConfidence: false },
  // 中文常见别称
  钾: { loinc: '2823-3', display: 'Potassium [Moles/volume] in Serum or Plasma', confidence: 0.93, source: 'dictionary', lowConfidence: false },
  钠: { loinc: '2951-2', display: 'Sodium [Moles/volume] in Serum or Plasma', confidence: 0.93, source: 'dictionary', lowConfidence: false },
  氯: { loinc: '2075-0', display: 'Chloride [Moles/volume] in Serum or Plasma', confidence: 0.93, source: 'dictionary', lowConfidence: false },
  钙: { loinc: '17861-6', display: 'Calcium [Moles/volume] in Serum or Plasma', confidence: 0.93, source: 'dictionary', lowConfidence: false },
  葡萄糖: { loinc: '2345-7', display: 'Glucose [Moles/volume] in Serum or Plasma', confidence: 0.93, source: 'dictionary', lowConfidence: false },
};

/** 危急值阈值表 —— 超出即视为 critical candidate（不直接告警，最终由 detector 决策） */
export const CRITICAL_THRESHOLDS: Record<string, { low?: number; high?: number; unit?: string }> = {
  K: { low: 2.5, high: 6.0, unit: 'mmol/L' },
  NA: { low: 120, high: 160, unit: 'mmol/L' },
  CL: { low: 80, high: 115, unit: 'mmol/L' },
  CA: { low: 1.6, high: 3.2, unit: 'mmol/L' },
  GLU: { low: 2.8, high: 25.0, unit: 'mmol/L' },
  HGB: { low: 50, high: 200, unit: 'g/L' },
  WBC: { low: 1.0, high: 30.0, unit: '10^9/L' },
  PLT: { low: 30, high: 800, unit: '10^9/L' },
};

/**
 * 字典直接查表（同步，无副作用）。
 * 命中返回 LoincSuggestion；未命中返回 null（上层决定是否调 model）。
 */
export function lookupDictionary(deviceCode: string): LoincSuggestion | null {
  const upper = deviceCode.toUpperCase().trim();
  return BUILTIN_DICTIONARY[upper] ?? null;
}

/**
 * 字段归因命中率统计 —— 信息科判断「这台仪器接得对不对」的关键指标。
 * 命中率低于 dictionaryThreshold 时，未命中项已被标 low_confidence 并走模型兜底。
 */
export interface FieldMapperStats {
  /** 累计归因条数 */
  total: number;
  /** 字典直接命中条数 */
  dictionaryHits: number;
  /** 模型兜底采纳条数 */
  modelHits: number;
  /** 未命中（low_confidence）条数 */
  misses: number;
  /** 字典命中率 0–1（total=0 时为 0） */
  hitRate: number;
}

/**
 * 字段归因主入口。
 * - 字典命中且 confidence ≥ dictionaryThreshold → 直接返回
 * - 否则调 model.suggestLoinc() 兜底
 * - model 抛错 → catch 后返回 fallback（low_confidence），不阻塞主路径
 */
export class FieldMapper {
  private readonly dictionaryThreshold: number;
  private readonly modelAcceptThreshold: number;
  private readonly counters = { total: 0, dictionaryHits: 0, modelHits: 0, misses: 0 };

  constructor(
    private readonly model: ModelGatewayLike | null,
    options: FieldMapperOptions = {},
  ) {
    this.dictionaryThreshold = options.dictionaryThreshold ?? 0.85;
    this.modelAcceptThreshold = options.modelAcceptThreshold ?? 0.5;
  }

  async mapResultCode(input: {
    deviceCode: string;
    deviceDisplay: string;
    deviceId: string;
    panelCode?: string;
  }): Promise<LoincSuggestion> {
    this.counters.total++;
    const dict = lookupDictionary(input.deviceCode);
    if (dict && dict.confidence >= this.dictionaryThreshold) {
      this.counters.dictionaryHits++;
      return { ...dict, lowConfidence: false };
    }

    // 字典未命中或低置信 → 调 model
    if (!this.model) {
      this.counters.misses++;
      return this.fallback(input.deviceCode, input.deviceDisplay, 'no_model');
    }

    try {
      const suggestion = await this.model.suggestLoinc({
        deviceCode: input.deviceCode,
        deviceDisplay: input.deviceDisplay,
        context: { deviceId: input.deviceId, panelCode: input.panelCode },
      });
      if (suggestion.confidence < this.modelAcceptThreshold) {
        this.counters.misses++;
        return { ...suggestion, source: 'fallback', lowConfidence: true };
      }
      this.counters.modelHits++;
      return { ...suggestion, source: 'model', lowConfidence: false };
    } catch (err) {
      this.counters.misses++;
      if (err instanceof ModelUnavailableFallbackError) {
        return this.fallback(input.deviceCode, input.deviceDisplay, 'model_unavailable');
      }
      // 任何其他错误也走 fallback（不阻塞主路径）
      return this.fallback(input.deviceCode, input.deviceDisplay, 'model_error');
    }
  }

  private fallback(deviceCode: string, deviceDisplay: string, reason: string): LoincSuggestion {
    return {
      loinc: 'unknown',
      display: deviceDisplay || deviceCode,
      confidence: 0,
      source: 'fallback',
      lowConfidence: true,
      reason: `${reason}: dict=miss, model=null/error`,
    };
  }

  /** 同步版 —— 仅查字典，用于测试 + critical detector（不阻塞） */
  mapResultCodeSync(input: { deviceCode: string; deviceDisplay: string }): LoincSuggestion {
    const dict = lookupDictionary(input.deviceCode);
    if (dict) return { ...dict, lowConfidence: false };
    return {
      loinc: 'unknown',
      display: input.deviceDisplay || input.deviceCode,
      confidence: 0,
      source: 'fallback',
      lowConfidence: true,
      reason: 'sync: dict=miss',
    };
  }

  /** 命中率统计快照（累计值，不随调用清零） */
  stats(): FieldMapperStats {
    const { total, dictionaryHits, modelHits, misses } = this.counters;
    const resolved = dictionaryHits + modelHits;
    return {
      total,
      dictionaryHits,
      modelHits,
      misses,
      hitRate: total === 0 ? 0 : resolved / total,
    };
  }
}

/** 危急值阈值查表 —— 纯确定性逻辑，不调 model */
export function checkCriticalThreshold(
  deviceCode: string,
  value: number,
  unit?: string,
): { critical: boolean; reason: 'low' | 'high' | null; threshold?: { low?: number; high?: number; unit?: string } } {
  const upper = deviceCode.toUpperCase().trim();
  const t = CRITICAL_THRESHOLDS[upper];
  if (!t) return { critical: false, reason: null };
  if (t.low !== undefined && value < t.low) {
    return { critical: true, reason: 'low', threshold: t };
  }
  if (t.high !== undefined && value > t.high) {
    return { critical: true, reason: 'high', threshold: t };
  }
  return { critical: false, reason: null };
}
