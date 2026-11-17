/**
 * T18 · 脏数据容错（字段级）
 *
 * 院内仪器最常见的三类脏数据：超长字段、缺分隔符、必填缺失。
 * 策略是「标定后继续」，绝不因为一个字段坏就丢整帧；只有整帧不可恢复
 * （无分隔符 / 空帧 / 声明的段数严重不足）才标 FRAME_MALFORMED 交 DLQ。
 *
 * 所有问题都进字段级错误计数聚合，于是「这台仪器今天有多少条脏数据」
 * 是可查数字，不用人肉翻日志。
 */

import { DIRTY_ENCODING_AMBIGUOUS } from './encoding.js';

export const DIRTY_DATA_ERROR_CODES = {
  ENCODING_AMBIGUOUS: DIRTY_ENCODING_AMBIGUOUS,
  FIELD_TRUNCATED: 'FIELD_TRUNCATED',
  FIELD_MISSING: 'FIELD_MISSING',
  FRAME_MALFORMED: 'FRAME_MALFORMED',
} as const;

export type DirtyDataErrorCode = (typeof DIRTY_DATA_ERROR_CODES)[keyof typeof DIRTY_DATA_ERROR_CODES];

export interface FieldIssue {
  /** 精确到字段的路径，如 OBX[2].5 / OBR[1].3 */
  path: string;
  code: DirtyDataErrorCode;
  message: string;
  /** 被截断 / 缺失的原始值片段（脱敏后仅留长度，不落患者明文） */
  valueLength?: number;
}

export interface SanitizeOptions {
  /** 字段分隔符（HL7 默认 |，ASTM 常用 | 或 \） */
  fieldSep?: string;
  /** 单个字段最大字符数，超出截断 */
  maxFieldLength?: number;
  /** 期望字段数；不足则补空并标 missing */
  expectedFields?: number;
  /** 必填字段下标（0 起）；为空 / 缺失则标 FIELD_MISSING */
  requiredIndexes?: number[];
  /** 段名，用于拼错误 path */
  segment?: string;
  /** 段序号，用于拼错误 path */
  segmentIndex?: number;
  /** 编码探测不明确时附加的问题（由调用方传入） */
  encodingAmbiguous?: boolean;
}

export interface SanitizedFrame {
  fields: string[];
  truncated: boolean;
  missing: boolean;
  malformed: boolean;
  /** true = 不可恢复，调用方应把原始字节写入 DLQ */
  dropped: boolean;
  issues: FieldIssue[];
}

export const DEFAULT_MAX_FIELD_LENGTH = 256;

/**
 * 单个段的字段级容错。永不抛错。
 * - 超长字段 → 截断 + truncated=true + FIELD_TRUNCATED
 * - 缺分隔符 → 补空串，不丢整帧
 * - 必填缺失 → missing=true + FIELD_MISSING
 * - 空帧 / 完全无分隔符且无内容 → FRAME_MALFORMED + dropped=true
 */
export function sanitizeDelimitedFrame(raw: string, opts: SanitizeOptions = {}): SanitizedFrame {
  const sep = opts.fieldSep ?? '|';
  const max = opts.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  const segment = opts.segment ?? 'SEG';
  const index = opts.segmentIndex ?? 0;
  const issues: FieldIssue[] = [];
  const result: SanitizedFrame = {
    fields: [], truncated: false, missing: false, malformed: false, dropped: false, issues,
  };

  if (opts.encodingAmbiguous) {
    issues.push({
      path: `${segment}[${index}]`,
      code: DIRTY_DATA_ERROR_CODES.ENCODING_AMBIGUOUS,
      message: '编码候选得分接近且无中文特征，按首选编码解码并标记待人工确认',
    });
  }

  if (!raw || raw.trim().length === 0) {
    result.malformed = true;
    result.dropped = true;
    issues.push({
      path: `${segment}[${index}]`,
      code: DIRTY_DATA_ERROR_CODES.FRAME_MALFORMED,
      message: '空帧：无可用字段',
    });
    return result;
  }

  const parts = raw.split(sep);
  // 缺分隔符：不足 expectedFields 的部分补空，保留已有内容
  const expected = Math.max(opts.expectedFields ?? parts.length, parts.length);
  const fields = [...parts];
  while (fields.length < expected) fields.push('');

  const truncatedFields: number[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const value = fields[i] ?? '';
    if (value.length > max) {
      fields[i] = value.slice(0, max);
      truncatedFields.push(i);
      issues.push({
        path: `${segment}[${index}].${i}`,
        code: DIRTY_DATA_ERROR_CODES.FIELD_TRUNCATED,
        message: `字段长度 ${value.length} 超过上限 ${max}，已截断保留前 ${max} 字符`,
        valueLength: value.length,
      });
    }
  }

  const required = opts.requiredIndexes ?? [];
  for (const i of required) {
    if (i >= fields.length || (fields[i] ?? '').trim().length === 0) {
      issues.push({
        path: `${segment}[${index}].${i}`,
        code: DIRTY_DATA_ERROR_CODES.FIELD_MISSING,
        message: `必填字段 ${i} 缺失或为空`,
      });
      result.missing = true;
    }
  }

  // 完全没有分隔符且只有一个超短片段 → 视作结构损坏（但仍标字段后返回）
  if (!raw.includes(sep) && raw.replace(/[\r\n]/g, '').length < 3) {
    result.malformed = true;
    result.dropped = true;
    issues.push({
      path: `${segment}[${index}]`,
      code: DIRTY_DATA_ERROR_CODES.FRAME_MALFORMED,
      message: '帧内无字段分隔符且内容过短，判定为不可恢复帧',
    });
  }

  result.fields = fields;
  result.truncated = truncatedFields.length > 0;
  return result;
}

/** 整帧（多段）容错：逐段处理，聚合问题，不因一段坏丢整帧 */
export function sanitizeFrame(
  raw: string,
  opts: Omit<SanitizeOptions, 'segment' | 'segmentIndex'> & { segmentSeparator?: RegExp } = {},
): { segments: SanitizedFrame[]; issues: FieldIssue[]; dropped: boolean; truncated: boolean; missing: boolean } {
  const lines = raw.split(opts.segmentSeparator ?? /\r\n|\r|\n/).filter((l) => l.length > 0);
  const segments = lines.map((line, i) => {
    const seg = line.slice(0, 3).replace(/[^A-Za-z0-9]/g, '') || 'SEG';
    return sanitizeDelimitedFrame(line, { ...opts, segment: seg, segmentIndex: i });
  });
  const issues = segments.flatMap((s) => s.issues);
  return {
    segments,
    issues,
    dropped: segments.length === 0 || segments.every((s) => s.dropped),
    truncated: segments.some((s) => s.truncated),
    missing: segments.some((s) => s.missing),
  };
}

export interface FieldErrorCounts {
  total: number;
  byCode: Record<string, number>;
  byPath: Record<string, number>;
  framesWithIssues: number;
  droppedFrames: number;
}

/** 字段级错误计数聚合（按通道 / 按错误码可查） */
export class FieldErrorStats {
  private total = 0;
  private byCode: Record<string, number> = {};
  private byPath: Record<string, number> = {};
  private framesWithIssues = 0;
  private droppedFrames = 0;

  addFrame(frame: { issues: FieldIssue[]; dropped: boolean }): void {
    if (frame.issues.length > 0) this.framesWithIssues += 1;
    if (frame.dropped) this.droppedFrames += 1;
    for (const issue of frame.issues) {
      this.total += 1;
      this.byCode[issue.code] = (this.byCode[issue.code] ?? 0) + 1;
      this.byPath[issue.path] = (this.byPath[issue.path] ?? 0) + 1;
    }
  }

  snapshot(): FieldErrorCounts {
    return {
      total: this.total,
      byCode: { ...this.byCode },
      byPath: { ...this.byPath },
      framesWithIssues: this.framesWithIssues,
      droppedFrames: this.droppedFrames,
    };
  }
}
