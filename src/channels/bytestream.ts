/**
 * bytestream —— 字节流通道的核心配置 + 帧匹配器（与源仓库 medplum/packages/agent/src/bytestream.ts 同源）
 *
 * 设计原则：
 * - ByteStreamConfig：不可变，所有连接共享一份；reloadConfig 后才换
 * - ByteSequenceMatcher：每连接独立实例（避免并发连接共用同一窗口）
 * - 自动响应（autoRespond）：链路级握手，匹配后立刻回包（不等帧边界）
 * - 帧切分：startChar 起 + endChar 收；stripSequences / stripControlChars 仅清理体内
 * - keepControlChars：配合 ASTM 等记录型协议保留 CR 等不被 strip
 *
 * 适配：
 * - 不依赖 medplum/core 的 ILogger；换成 pino child logger
 * - 不引 medplum/app 接口；emit 事件交由 ByteStreamChannelConnection 决定
 */

import { createLogger } from '../shared/logger.js';
import iconv from 'iconv-lite';

export type ByteStreamBodyEncoding = 'hex' | 'utf-8';

/**
 * 按通道编码解码帧体（utf-8 / gbk / gb18030…）。
 *
 * 院内仪器的中文检验项名常以 GBK 上报，硬解成 UTF-8 会变乱码；
 * 解码失败不抛 —— 退化为 hex，避免一条脏帧打断整条采集链。
 */
export function decodeBody(body: Buffer, encoding: string): string {
  try {
    return iconv.decode(body, encoding);
  } catch {
    return body.toString('hex');
  }
}

/** 字节序列规则：匹配到 pattern 后立刻回包 response */
export type ByteSequenceRule = { readonly pattern: Buffer; readonly response: Buffer };

/** 不可变配置：所有连接共享；reload 后整体替换 */
export type ByteStreamConfig = {
  readonly startChar: number;
  readonly endChar: number;
  readonly autoRespond: readonly ByteSequenceRule[];
  readonly stripSequences: readonly Buffer[];
  readonly stripControlChars: boolean;
  readonly keepControlChars: readonly number[];
  readonly bodyEncoding: ByteStreamBodyEncoding;
  readonly ignoreResponse: boolean;
};

const log = createLogger('channels.bytestream');

/**
 * 默认 ByteStreamConfig —— 当 yaml 未指定时兜底（无 start/end 字符，无 autoRespond）
 * 这样 yaml 校验失败能抛结构化错，而不是在跑时炸掉
 */
export function defaultByteStreamConfig(): ByteStreamConfig {
  return {
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

/**
 * 把形如 '\x05\x15' 的字符串解析成 Buffer（与源仓库 parseByteSequence 同语义）
 * - 仅接受 codePoint <= 0xFF 的字节；UTF-8 多字节字符直接弃
 * - 空串返回 undefined
 */
export function parseByteSequence(decoded: string, label: string): Buffer | undefined {
  if (!decoded) {
    log.warn({ label }, `Invalid ${label}: empty byte sequence. Ignoring.`);
    return undefined;
  }
  const bytes: number[] = [];
  for (const char of decoded) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined || codePoint > 0xff) {
      log.warn({ label, decoded }, `Invalid ${label}: not a byte sequence. Ignoring.`);
      return undefined;
    }
    bytes.push(codePoint);
  }
  return Buffer.from(bytes);
}

/** 把 Buffer 渲染成 %05%15 形式（用于日志） */
export function formatByteSequence(bytes: Buffer): string {
  let formatted = '';
  for (const byte of bytes) {
    formatted += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return formatted;
}

/** 把多个值拆成条目 —— 支持重复 / 逗号分隔 */
export function splitParamEntries(rawValues: readonly string[]): string[] {
  return rawValues.flatMap((v) => v.split(','));
}

/** parseAutoRespond 形如 <pattern>:<response> 列表 */
export function parseAutoRespondRules(rawValues: readonly string[]): ByteSequenceRule[] {
  const rules: ByteSequenceRule[] = [];
  for (const entry of splitParamEntries(rawValues)) {
    const separator = entry.indexOf(':');
    if (separator === -1) continue;
    const pattern = parseByteSequence(entry.slice(0, separator), 'autoRespond pattern');
    const response = parseByteSequence(entry.slice(separator + 1), 'autoRespond response');
    if (!pattern || !response) continue;
    if (rules.some((r) => r.pattern.equals(pattern))) continue;
    rules.push({ pattern, response });
  }
  return rules;
}

/** parseByteSequences —— 收集去重后的 Buffer 列表 */
export function parseByteSequences(rawValues: readonly string[], label: string): Buffer[] {
  const sequences: Buffer[] = [];
  for (const entry of splitParamEntries(rawValues)) {
    const sequence = parseByteSequence(entry, label);
    if (sequence && !sequences.some((existing) => existing.equals(sequence))) {
      sequences.push(sequence);
    }
  }
  return sequences;
}

/** parseKeepControlChars —— 收集单字节集合 */
export function parseKeepControlChars(rawValues: readonly string[]): number[] {
  const bytes = new Set<number>();
  for (const sequence of parseByteSequences(rawValues, 'keepControlChars')) {
    for (const byte of sequence) bytes.add(byte);
  }
  return [...bytes];
}

/** 解析 bodyEncoding —— 默认 hex */
export function parseBodyEncoding(rawValue: string | null | undefined): ByteStreamBodyEncoding {
  if (!rawValue) return 'hex';
  const norm = rawValue.toLowerCase();
  if (norm === 'hex') return 'hex';
  if (norm === 'utf-8' || norm === 'utf8') return 'utf-8';
  log.warn({ rawValue }, `Invalid bodyEncoding '${rawValue}'; using 'hex'.`);
  return 'hex';
}

/** window 末尾是否匹配 pattern */
function endsWith(window: readonly number[], pattern: Buffer): boolean {
  if (window.length < pattern.length) return false;
  const offset = window.length - pattern.length;
  for (let i = 0; i < pattern.length; i++) {
    if (window[offset + i] !== pattern[i]) return false;
  }
  return true;
}

/** 空结果常量，避免每次 match 分配 */
const NO_RESPONSES: readonly Buffer[] = Object.freeze([]);

/**
 * ByteSequenceMatcher —— 单连接的滑动窗口匹配器
 * - 每连接独立实例（共享会交叉污染）
 * - window 仅保留最长规则的长度
 * - match(byte) 返回所有命中的 response；返回空数组代表无命中
 */
export class ByteSequenceMatcher {
  private readonly rules: readonly ByteSequenceRule[];
  private readonly window: number[] = [];
  private readonly windowSize: number;

  constructor(rules: readonly ByteSequenceRule[]) {
    this.rules = rules;
    this.windowSize = rules.reduce(
      (longest, rule) => Math.max(longest, rule.pattern.length),
      0,
    );
  }

  match(byte: number): readonly Buffer[] {
    if (this.windowSize === 0) return NO_RESPONSES;
    this.window.push(byte);
    if (this.window.length > this.windowSize) this.window.shift();
    let responses: Buffer[] | undefined;
    for (const { pattern, response } of this.rules) {
      if (endsWith(this.window, pattern)) {
        responses ??= [];
        responses.push(response);
      }
    }
    return responses ?? NO_RESPONSES;
  }

  /** 丢弃部分进度（如收到 startChar 帧重启时） */
  reset(): void {
    this.window.length = 0;
  }
}

/**
 * filterMessageBytes —— 清理已组装的帧体
 * - stripSequences：完整匹配删除（多字节不留残尾）
 * - stripControlChars=true：丢所有 C0 控制字节（0x00-0x1F）；keepControlChars 例外
 * - ASTM 这类记录型协议必须 keep CR，否则 strip 后无法再切记录
 */
export function filterMessageBytes(
  buffer: Buffer,
  sequences: readonly Buffer[],
  stripControlChars: boolean,
  keepControlChars: readonly number[] = [],
): Buffer {
  if (sequences.length === 0 && !stripControlChars) return buffer;

  const longestFirst =
    sequences.length > 1
      ? [...sequences].sort((a, b) => b.length - a.length)
      : sequences;

  let keepMask = 0;
  for (const byte of keepControlChars) {
    if (byte < 0x20) keepMask |= 1 << byte;
  }

  const filtered = Buffer.allocUnsafe(buffer.length);
  let written = 0;
  let i = 0;
  while (i < buffer.length) {
    let matchedLength = 0;
    for (const sequence of longestFirst) {
      if (buffer[i] !== sequence[0] || i + sequence.length > buffer.length) continue;
      let matched = true;
      for (let k = 1; k < sequence.length; k++) {
        if (buffer[i + k] !== sequence[k]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        matchedLength = sequence.length;
        break;
      }
    }
    if (matchedLength > 0) {
      i += matchedLength;
      continue;
    }
    const byte = buffer[i];
    if (!(stripControlChars && byte < 0x20 && (keepMask & (1 << byte)) === 0)) {
      filtered[written] = byte;
      written++;
    }
    i++;
  }
  return filtered.subarray(0, written);
}

/**
 * 从 yaml 友好结构构造 ByteStreamConfig（start/end 用整数而非 codePoint 字符）
 * patternHex / responseHex / stripSequence-hex 接受 '0x05' / '05' 形式，按 hex 解析
 */
export function buildByteStreamConfig(input: {
  startChar: number;
  endChar: number;
  autoRespond?: readonly { patternHex: string; responseHex: string }[];
  stripSequences?: readonly string[];
  stripControlChars?: boolean;
  keepControlChars?: readonly number[];
  bodyEncoding?: ByteStreamBodyEncoding;
  ignoreResponse?: boolean;
}): ByteStreamConfig {
  const autoRespond: ByteSequenceRule[] = (input.autoRespond ?? []).flatMap((rule) => {
    const pattern = Buffer.from(rule.patternHex.replace(/^0x/i, '').padStart(2, '0'), 'hex');
    const response = Buffer.from(rule.responseHex.replace(/^0x/i, '').padStart(2, '0'), 'hex');
    if (pattern.length === 0 || response.length === 0) return [];
    return [{ pattern, response }];
  });
  const stripSequences: Buffer[] = [];
  for (const hex of input.stripSequences ?? []) {
    const buf = Buffer.from(hex.replace(/^0x/i, '').padStart(2, '0'), 'hex');
    if (buf.length > 0) stripSequences.push(buf);
  }
  return {
    startChar: input.startChar,
    endChar: input.endChar,
    autoRespond,
    stripSequences,
    stripControlChars: input.stripControlChars ?? false,
    keepControlChars: input.keepControlChars ?? [],
    bodyEncoding: input.bodyEncoding ?? 'hex',
    ignoreResponse: input.ignoreResponse ?? false,
  };
}
