/**
 * 幂等键：accessionIdentifier 构造 + If-None-Exist 头构造
 *
 * 设计原则：
 * - 同一份标本（同一个设备 + 同一份 MSH.10 / 流水号）只能产生一次 FHIR 写入
 * - 走 FHIR R4 If-None-Exist 头约定（HL7 / 院内 LIS 端点必须支持）
 * - accessionIdentifier 走 Specimen.accessionIdentifier 字段（Persistence 端用）
 * - 给 FhirWriter.writeResource 作为 idempotencyKey 入参，同时给 FhirWriter 构造 URL 时回填
 *
 * 与源仓库「fhir-request」工具（github_ref/medplum/packages/server/src/mcp/server.ts）同构点：
 * 那边的做法是「按 method 拼 fhir/R4 路径 + origin 固定（防 SSRF / 防 token 外泄）+ 转发 bearer」。
 * 本模块对应其中的 **origin 固定**那一层：拼进 URL 的每一段都要先过一遍
 * 「能不能安全出现在 header / path 里」的校验，而不是直接字符串拼接。
 */

import { FhirValidationFailError } from '../shared/errors.js';

export interface AccessionInput {
  deviceId: string;
  msh10: string;
}

/** FHIR R4 identifier 的 value 长度上限（服务端与院内网关普遍按此截断） */
export const MAX_IDENTIFIER_VALUE_LENGTH = 255;

/**
 * 构造稳定 accessionIdentifier：`<deviceId>:<msh10>`
 * deviceId 与 msh10 都用 trim + 大写规范，避免两端大小写不同被误判不同样本
 */
export function buildAccessionIdentifier(input: AccessionInput): string {
  const deviceId = (input.deviceId ?? '').trim().toUpperCase();
  const msh10 = (input.msh10 ?? '').trim().toUpperCase();
  if (!deviceId || !msh10) {
    throw new FhirValidationFailError(
      'buildAccessionIdentifier: deviceId 与 msh10 不能为空',
      { deviceId: !!deviceId, msh10: !!msh10 },
    );
  }
  return `${deviceId}:${msh10}`;
}

/**
 * FHIR R4 搜索串转义
 *
 * 规范依据：FHIR R4「Searching」—— 在 search parameter 里 `|`（system|value 分隔）、
 * `,`（多值分隔）、`$`（前缀/操作符）以及 `\` 本身都是保留字符，
 * 出现在 value 里必须用反斜杠转义，否则服务端会把它当分隔符解析，
 * 导致「同一标本被判成不同标本」（幂等键失效 → 重复建报告）。
 *
 * 单趟替换（每个字符各匹配一次），天然保证 `\` 先被转义成 `\\`。
 */
export function escapeSearchValue(value: string): string {
  return value.replace(/([\\|,$])/g, '\\$1');
}

/**
 * 反向解转义 —— 服务端 / 测试替身按 FHIR 规则还原 value
 * （`\\|` → `|`、`\,` → `,`、`\$` → `$`、`\\` → `\`）
 */
export function unescapeSearchValue(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * identifier value 合法性（FHIR R4 string 类型的通用约束）
 *
 * - 非空
 * - 无首尾空白（FHIR string 不允许首尾空白）
 * - 无控制字符（控制字符根本没法安全出现在 HTTP header 里）
 * - 长度不超过 MAX_IDENTIFIER_VALUE_LENGTH
 *
 * 注意：这里**不**禁止内部空格与中文 —— 院内标本号 / 设备别名可能带这些字符，
 * 服务端能否接受由院内网关决定，不在采集侧替它做主。
 */
export function isValidIdentifierValue(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (value !== value.trim()) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return false;
  if (value.length > MAX_IDENTIFIER_VALUE_LENGTH) return false;
  return true;
}

/**
 * 校验 identifier value —— 不合法抛 FhirValidationFailError（带字段名）
 * 用于「拼进 HTTP header 之前必须先过一遍」的守门点。
 */
export function assertValidIdentifierValue(value: string, field = 'idempotencyKey'): void {
  if (!isValidIdentifierValue(value)) {
    throw new FhirValidationFailError(
      `${field} 不是合法的 FHIR identifier value（非空 / 无首尾空白 / 无控制字符 / ≤${MAX_IDENTIFIER_VALUE_LENGTH} 字符）`,
      { field, length: typeof value === 'string' ? value.length : -1 },
    );
  }
}

/**
 * 构造 If-None-Exist 头字符串（FHIR R4 规范）
 * 格式：`identifier=<system>|<value>`
 * system 固定 urn:lab-ops-console:accession，value 为 accessionIdentifier
 *
 * 例：`If-None-Exist: identifier=urn:lab-ops-console:accession|DEV001:MSG00001`
 *
 * value 里的保留字符（`|` / `,` / `$` / `\`）按 FHIR 搜索串规则转义；
 * 控制字符直接拒绝（无法安全放进 HTTP header）。
 */
export function buildIfNoneExistHeader(accessionIdentifier: string): string {
  assertValidIdentifierValue(accessionIdentifier);
  const escaped = escapeSearchValue(accessionIdentifier);
  return `identifier=${ACCESSION_SYSTEM_URI}|${escaped}`;
}

/** 取 header 名的常量（避免拼写错） */
export const HEADER_IF_NONE_EXIST = 'If-None-Exist';
/** 取 identifier system 的常量 */
export const ACCESSION_SYSTEM_URI = 'urn:lab-ops-console:accession';
