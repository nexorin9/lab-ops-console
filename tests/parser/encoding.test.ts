/**
 * T18 · 编码探测与回退（≥4 条）
 */

import { describe, it, expect } from 'vitest';
import {
  detectEncoding,
  decodeWithFallback,
  encodeText,
  ENCODING_CANDIDATES,
  DIRTY_ENCODING_AMBIGUOUS,
} from '../../src/parser/encoding.js';

const GBK_SAMPLE = 'OBR|1||样本编号|血钾测定|急诊检验科|张三|危急';

describe('T18 · detectEncoding / decodeWithFallback', () => {
  it('GBK 报文解码出的中文正确（不出现替换字符）', () => {
    const bytes = encodeText(GBK_SAMPLE, 'gbk');
    const r = detectEncoding(bytes);
    expect(r.encoding).toBe('gbk');
    expect(r.text).toContain('血钾测定');
    expect(r.text).toContain('危急');
    expect(r.hasReplacement).toBe(false);
  });

  it('乱码字节被替换而非抛错，且候选打分记录替换比例', () => {
    const broken = Buffer.from([0x4f, 0x42, 0x58, 0x7c, 0xc0, 0xfe, 0xff, 0x81, 0x30, 0x0d]);
    expect(() => detectEncoding(broken)).not.toThrow();
    const r = detectEncoding(broken);
    expect(r.candidates).toHaveLength(ENCODING_CANDIDATES.length);
    expect(r.candidates.some((c) => c.replacementRatio > 0)).toBe(true);
    expect(typeof r.text).toBe('string');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('编码探测打分能选出正确编码（utf-8 误读 GBK 时分数更低）', () => {
    const bytes = encodeText(GBK_SAMPLE, 'gbk');
    const r = detectEncoding(bytes);
    const utf8 = r.candidates.find((c) => c.encoding === 'utf-8')!;
    const gbk = r.candidates.find((c) => c.encoding === 'gbk')!;
    expect(gbk.cjkRatio).toBeGreaterThan(utf8.cjkRatio);
    expect(gbk.score).toBeGreaterThan(utf8.score);
    expect(utf8.replacementRatio).toBeGreaterThan(0);
  });

  it('首选编码失败时自动回退，并显式记录 usedEncoding / fallbackUsed', () => {
    const bytes = encodeText(GBK_SAMPLE, 'gbk');
    const decoded = decodeWithFallback(bytes, 'utf-8');
    expect(decoded.preferredEncoding).toBe('utf-8');
    expect(decoded.usedEncoding).toBe('gbk');
    expect(decoded.fallbackUsed).toBe(true);
    expect(decoded.text).toContain('血钾测定');
  });

  it('首选编码可用时不回退，usedEncoding 等于首选', () => {
    const bytes = Buffer.from('OBR|1||K+|final', 'utf-8');
    const decoded = decodeWithFallback(bytes, 'utf-8');
    expect(decoded.fallbackUsed).toBe(false);
    expect(decoded.usedEncoding).toBe('utf-8');
    expect(decoded.text).toBe('OBR|1||K+|final');
  });

  it('纯 ASCII 文本候选同分 → 标 ambiguous（不静默挑一个编码）', () => {
    const r = detectEncoding(Buffer.from('MSH|^~\\&|LAB|A|B|20260101', 'utf-8'));
    expect(r.ambiguous).toBe(true);
    expect(r.encoding).toBe('utf-8');
    expect(DIRTY_ENCODING_AMBIGUOUS).toBe('ENCODING_AMBIGUOUS');
  });

  it('GB18030 生僻字（四字节区）可解码且不抛错', () => {
    const bytes = encodeText('检验科𠮷野样本', 'gb18030');
    const r = detectEncoding(bytes);
    expect(r.text).toContain('检验科');
    expect(r.text).toContain('𠮷');
  });
});
