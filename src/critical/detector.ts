/**
 * critical.detector —— 危急值识别
 *
 * 输入：ParserResult（含 criticalFlags 与 observations）
 * 输出：CriticalDetection { flags, severity, summary }
 *
 * 设计原则：
 * - 解析层（parser）已经在 OBX.8 / OBX.5 阈值上识别出一组 candidate flags
 * - 本模块再做二次判定：
 *   ① 按 reason ('abnormal_flag' / 'threshold_exceeded') 聚合
 *   ② 同 patient + 同 testCode + 5 分钟窗口去重（防内爆）
 *   ③ 选最高严重度（abnormal_flag > threshold_exceeded）
 *   ④ 返回 CriticalDetection（含 flags + severity + 一句话描述）
 * - 不阻塞主路径；解析层抛错时 detector 仍能基于 partial ParserResult 工作
 */

import type { ParserResult } from '../parser/fhir-types.js';
import { CRITICAL_THRESHOLDS } from '../parser/field-mapper.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('critical.detector');

/** 严重度档位 —— 用于推送优先级 + 大屏亮红框逻辑 */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** 单条识别的危急值（已去重 + 已分级） */
export interface IdentifiedCriticalFlag {
  observationId?: string;
  patientId: string;
  testCode: string;
  testDisplay: string;
  value: string;
  unit?: string;
  reason: 'abnormal_flag' | 'threshold_exceeded';
  severity: Severity;
  detail: string;
  /** 用于去重的指纹（patient + testCode + 5 分钟窗口） */
  dedupeKey: string;
}

export interface CriticalDetection {
  /** 至少 1 条 criticalFlag 时算 true（false 表示正常样本） */
  hasCritical: boolean;
  /** 最高严重度（无 flags 时 = 'low'） */
  severity: Severity;
  /** 已去重的危急值清单 */
  flags: IdentifiedCriticalFlag[];
  /** 一句话描述（面板 / 推送展示用） */
  summary: string;
}

/** 5 分钟窗口去重（毫秒） */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * 计算 dedupeKey —— patient + testCode + 时间桶（5 分钟对齐）
 * 注：本函数纯函数，不依赖外部时间，便于测试
 */
export function makeDedupeKey(patientId: string, testCode: string, observedAt: number, windowMs: number = DEDUPE_WINDOW_MS): string {
  const bucket = Math.floor(observedAt / windowMs);
  return `${patientId}::${testCode.toUpperCase()}::${bucket}`;
}

/**
 * 把 abnormal_flag 字符串 → severity
 * HH / LL = critical（仪器 push 直接标记）
 * AA = critical（仪器判定危急）
 * H / L = high（单向偏离正常范围）
 * A = medium（异常但未达危急）
 * N / 空 = low
 */
export function severityFromAbnormalFlag(flag: string): Severity {
  const f = flag.toUpperCase();
  if (f === 'HH' || f === 'LL' || f === 'AA') return 'critical';
  if (f === 'H' || f === 'L') return 'high';
  if (f === 'A') return 'medium';
  return 'low';
}

/**
 * 已被识别的异常标记码（决定 severityFromAbnormalFlag 走哪个分支）
 */
const RECOGNIZED_ABNORMAL_CODES = new Set(['HH', 'LL', 'AA', 'H', 'L', 'A', 'N']);

/**
 * 从 detail 文本里取回仪器打的异常标记码。
 *   HL7 v2      → OBX.8=HH
 *   ASTM E1394  → 4R.7=HH
 *   私有协议     → abnormal_flag=HH / abn=HH
 * 取不到返回 null —— 调用方按「不降级」处理（见 severityForFlag）。
 */
export function extractAbnormalFlag(detail: string): string | null {
  if (!detail) return null;
  const patterns = [
    /OBX\.8\s*=\s*([A-Za-z]{1,2})/,                       // HL7 v2 OBX-8
    /4R\.7\s*=\s*([A-Za-z]{1,2})/,                         // ASTM E1394 4R.7
    /(?:abnormal[_\s-]*flag|abn)\s*[:=]\s*([A-Za-z]{1,2})/i, // 私有协议通用写法
  ];
  for (const p of patterns) {
    const m = detail.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/**
 * 单条 flag 的 severity 判定。
 * 关键取舍：reason='abnormal_flag' 意味着**仪器已把这条标成危急**，
 * 因此标记码解析不出来（或不认识）时按 critical 处理 —— 宁可升级不可漏；
 * 反之若把解析失败当作 medium/down，护士站大屏不会亮红框，等于漏报危急值。
 */
function severityForFlag(flag: ParserResult['criticalFlags'][number]): Severity {
  if (flag.reason !== 'abnormal_flag') {
    return severityFromThreshold(flag.testCode);
  }
  const raw = extractAbnormalFlag(flag.detail);
  if (!raw || !RECOGNIZED_ABNORMAL_CODES.has(raw)) {
    return 'critical';
  }
  return severityFromAbnormalFlag(raw);
}

/**
 * 把 threshold_exceeded reason → severity
 * 仅当 testCode 在已知危急项时 = critical；否则 = high
 */
export function severityFromThreshold(testCode: string): Severity {
  // parser 用的是内置 CRITICAL_THRESHOLDS，超阈 = critical
  // 这里按 code 是否在常见危急项做更细的判定（避免把未列入阈值表的都算 critical）
  const criticalCodes = new Set(['K', 'NA', 'CA', 'GLU', 'HGB', 'WBC', 'PLT']);
  return criticalCodes.has(testCode.toUpperCase()) ? 'critical' : 'high';
}

/** severity 排序权重（用于比较 / 取更高档位） */
const severityRank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** 取较高严重度 */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank[a] >= severityRank[b] ? a : b;
}

/**
 * 取患者标识 —— 优先报告 subject，缺失时退回标本号。
 *
 * 为何不直接用 'unknown-patient' 兜底：去重键 = 患者 + 检验项 + 5 分钟窗口，
 * 一旦所有无 subject 的报告共用同一个患者键，**不同患者的危急值会被并成一条**，
 * 护士站大屏上其中一位患者的危急值就此消失。标本号唯一，可安全作为兜底维度。
 */
export function resolvePatientId(result: ParserResult): string {
  const ref = result.diagnosticReport.subject?.reference;
  if (ref) return ref.replace(/^Patient\//, '');
  const accession = result.specimen?.accessionIdentifier?.value
    ?? result.specimen?.identifier?.[0]?.value
    ?? result.specimens?.[0]?.accessionIdentifier?.value
    ?? result.specimens?.[0]?.identifier?.[0]?.value;
  return accession ? `accession:${accession}` : 'unknown-patient';
}

/**
 * detect —— 主入口
 * 输入 ParserResult（已含 criticalFlags 候选） → 输出 CriticalDetection
 *
 * 关键设计：
 * - 不重新跑阈值判定（已在 parser 做）
 * - 做去重 + 严重度聚合 + 一句话 summary
 * - 无 criticalFlag 时仍返回 hasCritical=false + severity='low' + 空 flags 数组（便于上游统一处理）
 */
export function detect(result: ParserResult, options: { now?: number } = {}): CriticalDetection {
  const now = options.now ?? Date.now();
  const patientId = resolvePatientId(result);

  const seen = new Map<string, IdentifiedCriticalFlag>();

  for (const flag of result.criticalFlags) {
    const severity = severityForFlag(flag);

    const key = makeDedupeKey(patientId, flag.testCode, now);
    const existing = seen.get(key);
    if (existing) {
      // 同 dedupe key：合并为一条，严重度取更高的一侧。
      // 严重度取自哪一条，值 / 观察 id / 来源就取哪一条 —— 否则会出现
      // 「severity=critical 但展示的是另一行的数值」，护士看到的值与分级对不上。
      const higher = severityRank[severity] > severityRank[existing.severity];
      const merged: IdentifiedCriticalFlag = higher
        ? {
            ...flag,
            patientId,
            severity,
            dedupeKey: key,
            detail: `${existing.detail}；${flag.detail}`,
          }
        : {
            ...existing,
            severity: maxSeverity(existing.severity, severity),
            detail: `${existing.detail}；${flag.detail}`,
          };
      seen.set(key, merged);
    } else {
      seen.set(key, {
        observationId: flag.observationId,
        patientId,
        testCode: flag.testCode,
        testDisplay: flag.testDisplay,
        value: flag.value,
        unit: flag.unit,
        reason: flag.reason,
        severity,
        detail: flag.detail,
        dedupeKey: key,
      });
    }
  }

  const flags = [...seen.values()];
  if (flags.length === 0) {
    return {
      hasCritical: false,
      severity: 'low',
      flags: [],
      summary: '',
    };
  }

  const severity = flags.reduce<Severity>((acc, f) => maxSeverity(acc, f.severity), 'low');
  const summary = flags.length === 1
    ? `${flags[0].testDisplay || flags[0].testCode} ${flags[0].value}${flags[0].unit ?? ''}（${flags[0].reason === 'abnormal_flag' ? '仪器标记' : '超阈值'}）`
    : `${flags.length} 项危急：${flags.slice(0, 3).map((f) => f.testCode).join('、')}${flags.length > 3 ? ' …' : ''}`;

  log.debug({ patientId, severity, count: flags.length }, 'critical detect');

  return {
    hasCritical: true,
    severity,
    flags,
    summary,
  };
}