/**
 * T18 · 编码探测与回退
 *
 * 院内仪器真实故障里最常见的不是协议错，而是「半个汉字」。
 * 本模块对 utf-8 / gbk / gb18030 / big5 逐个候选解码，按替换字符比例与
 * 中文可读性打分选最优；首选编码解不好时自动回退并显式记录 usedEncoding，
 * 让「这台仪器的报文今天按哪种编码读的」变成可查数字而不是靠猜。
 *
 * 硬约束：任何字节序列都不抛异常；不可解码处替换为 U+FFFD 并计入脏数据。
 */

import iconv from 'iconv-lite';

export const ENCODING_CANDIDATES = ['utf-8', 'gbk', 'gb18030', 'big5'] as const;
export type EncodingName = (typeof ENCODING_CANDIDATES)[number];

export const DIRTY_ENCODING_AMBIGUOUS = 'ENCODING_AMBIGUOUS';

export interface EncodingCandidateScore {
  encoding: EncodingName;
  text: string;
  /** 综合分：中文可读性加分，替换字符 / 生僻区 / 控制字符扣分 */
  score: number;
  replacementRatio: number;
  cjkRatio: number;
  rareCjkRatio: number;
  controlRatio: number;
}

export interface EncodingDetectionResult {
  encoding: EncodingName;
  text: string;
  score: number;
  candidates: EncodingCandidateScore[];
  /** 各候选得分过于接近且都没有中文 → 编码无法判定（不静默挑一个） */
  ambiguous: boolean;
  /** 原文含替换字符（乱码被替换而非抛错） */
  hasReplacement: boolean;
}

export interface DecodedFrame {
  text: string;
  /** 实际采用的编码 */
  usedEncoding: EncodingName;
  /** 声明的首选编码 */
  preferredEncoding: EncodingName;
  /** 是否发生了回退 */
  fallbackUsed: boolean;
  detection: EncodingDetectionResult;
}

function ratios(text: string): Pick<EncodingCandidateScore, 'replacementRatio' | 'cjkRatio' | 'rareCjkRatio' | 'controlRatio'> {
  if (!text.length) return { replacementRatio: 0, cjkRatio: 0, rareCjkRatio: 0, controlRatio: 0 };
  let replacement = 0;
  let cjk = 0;
  let rareCjk = 0;
  let control = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfffd || cp === 0x0000) replacement += 1;
    else if (cp >= 0x4e00 && cp <= 0x9fff) cjk += 1;
    else if (cp >= 0x3000 && cp <= 0x303f) cjk += 1; // 中文标点也是可读性信号
    else if ((cp >= 0x3400 && cp <= 0x4dbf) || cp > 0xffff) rareCjk += 1;
    else if (cp < 0x20 && cp !== 0x0d && cp !== 0x0a && cp !== 0x09) control += 1;
  }
  // 长度按码点计（for..of 已按码点迭代）
  const total = [...text].length || 1;
  return {
    replacementRatio: replacement / total,
    cjkRatio: cjk / total,
    rareCjkRatio: rareCjk / total,
    controlRatio: control / total,
  };
}

function scoreOf(text: string): number {
  const r = ratios(text);
  return r.cjkRatio * 3
    + (1 - r.replacementRatio) * 2
    - r.rareCjkRatio * 4
    - r.controlRatio * 2;
}

/** 逐候选解码打分选最优；永不抛错 */
export function detectEncoding(
  raw: Buffer | Uint8Array | string,
  candidates: readonly EncodingName[] = ENCODING_CANDIDATES,
): EncodingDetectionResult {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : Buffer.from(raw);
  const scored: EncodingCandidateScore[] = candidates.map((encoding) => {
    let text: string;
    try {
      text = iconv.decode(buf, encoding);
    } catch {
      text = buf.toString('utf-8');
    }
    const r = ratios(text);
    return { encoding, text, score: scoreOf(text), ...r };
  });

  // 稳定排序：同分按候选顺序（gbk 与 gb18030 常同分，优先更常见的 gbk）
  const ranked = [...scored].sort((a, b) => (b.score - a.score) || candidates.indexOf(a.encoding) - candidates.indexOf(b.encoding));
  const best = ranked[0]!;
  const second = ranked[1];
  const noChinese = best.cjkRatio === 0 && (second?.cjkRatio ?? 0) === 0;
  const ambiguous = noChinese && !!second && Math.abs(best.score - second.score) < 0.01;

  return {
    encoding: best.encoding,
    text: best.text,
    score: best.score,
    candidates: scored,
    ambiguous,
    hasReplacement: best.text.includes('\uFFFD'),
  };
}

/**
 * 首选编码失败（替换字符 / 明显更低分）时自动回退到探测出的最佳编码。
 * 回退路径显式记录 usedEncoding / fallbackUsed，便于字段级错误统计。
 */
export function decodeWithFallback(
  raw: Buffer | Uint8Array | string,
  preferred: EncodingName = 'utf-8',
  opts: { candidates?: readonly EncodingName[]; scoreMargin?: number } = {},
): DecodedFrame {
  const detection = detectEncoding(raw, opts.candidates ?? ENCODING_CANDIDATES);
  const preferredScore = detection.candidates.find((c) => c.encoding === preferred);
  const margin = opts.scoreMargin ?? 0.05;

  const preferredBad =
    !preferredScore ||
    preferredScore.replacementRatio > 0 ||
    preferredScore.score + margin < detection.score;

  const usedEncoding: EncodingName = preferredBad ? detection.encoding : preferred;
  const text = detection.candidates.find((c) => c.encoding === usedEncoding)?.text ?? detection.text;

  return {
    text,
    usedEncoding,
    preferredEncoding: preferred,
    fallbackUsed: usedEncoding !== preferred,
    detection,
  };
}

/** 把一段中文按指定编码编码回字节（测试与合成数据用） */
export function encodeText(text: string, encoding: EncodingName): Buffer {
  return iconv.encode(text, encoding);
}
