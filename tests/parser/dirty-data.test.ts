/**
 * T18 · 脏数据字段级容错（≥4 条）
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeDelimitedFrame,
  sanitizeFrame,
  FieldErrorStats,
  DIRTY_DATA_ERROR_CODES,
} from '../../src/parser/dirty-data.js';

describe('T18 · sanitizeDelimitedFrame', () => {
  it('超长字段按上限截断并标 truncated，错误 path 精确到字段', () => {
    const long = 'X'.repeat(300);
    const r = sanitizeDelimitedFrame(`OBX|1|NM|K+^血钾|${long}|mmol/L`, {
      segment: 'OBX', segmentIndex: 2, maxFieldLength: 32,
    });
    expect(r.truncated).toBe(true);
    expect(r.fields[4]).toHaveLength(32);
    expect(r.fields[4]).toBe('X'.repeat(32));
    expect(r.dropped).toBe(false); // 绝不丢整帧
    const issue = r.issues.find((i) => i.code === DIRTY_DATA_ERROR_CODES.FIELD_TRUNCATED);
    expect(issue?.path).toBe('OBX[2].4');
    expect(issue?.valueLength).toBe(300);
  });

  it('缺分隔符的字段留空且不抛错', () => {
    expect(() => sanitizeDelimitedFrame('OBR|1', { expectedFields: 6 })).not.toThrow();
    const r = sanitizeDelimitedFrame('OBR|1', { expectedFields: 6 });
    expect(r.fields).toHaveLength(6);
    expect(r.fields.slice(2)).toEqual(['', '', '', '']);
    expect(r.dropped).toBe(false);
    expect(r.malformed).toBe(false);
  });

  it('必填字段缺失标 missing=true 并产出 FIELD_MISSING', () => {
    const r = sanitizeDelimitedFrame('OBX|1|NM|||mmol/L', {
      segment: 'OBX', segmentIndex: 1,
      requiredIndexes: [3, 4],
    });
    expect(r.missing).toBe(true);
    const missing = r.issues.filter((i) => i.code === DIRTY_DATA_ERROR_CODES.FIELD_MISSING);
    expect(missing.map((i) => i.path)).toEqual(['OBX[1].3', 'OBX[1].4']);
    expect(r.dropped).toBe(false);
  });

  it('空帧 / 结构损坏 → FRAME_MALFORMED 且 dropped=true（交 DLQ）', () => {
    const empty = sanitizeDelimitedFrame('   ');
    expect(empty.malformed).toBe(true);
    expect(empty.dropped).toBe(true);
    expect(empty.issues[0]!.code).toBe(DIRTY_DATA_ERROR_CODES.FRAME_MALFORMED);
    const broken = sanitizeDelimitedFrame('x');
    expect(broken.dropped).toBe(true);
  });

  it('编码不明确时附加 ENCODING_AMBIGUOUS 问题但不阻断字段', () => {
    const r = sanitizeDelimitedFrame('OBX|1|NM|K+|6.8', { encodingAmbiguous: true });
    expect(r.issues[0]!.code).toBe(DIRTY_DATA_ERROR_CODES.ENCODING_AMBIGUOUS);
    expect(r.fields).toHaveLength(5);
    expect(r.dropped).toBe(false);
  });
});

describe('T18 · 整帧容错与字段级错误计数聚合', () => {
  it('多段帧中一段超长不导致整帧丢弃，问题聚合到 path 带段名', () => {
    const frame = [
      'MSH|^~\\&|LAB|A|B|20260101||ORU^R01|1|P|2.5',
      `OBX|1|NM|K+|${'9'.repeat(400)}|mmol/L`,
      'OBR|1||ACC-001',
    ].join('\r');
    const r = sanitizeFrame(frame, { maxFieldLength: 64 });
    expect(r.dropped).toBe(false);
    expect(r.segments).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.issues.some((i) => i.path.startsWith('OBX['))).toBe(true);
  });

  it('FieldErrorStats 按错误码 / path 聚合，计数与注入问题数一致', () => {
    const stats = new FieldErrorStats();
    const a = sanitizeDelimitedFrame(`OBX|1|NM|${'A'.repeat(120)}`, {
      segment: 'OBX', segmentIndex: 1, maxFieldLength: 20, requiredIndexes: [5],
    });
    const b = sanitizeDelimitedFrame('', { segment: 'OBR', segmentIndex: 2 });
    const c = sanitizeDelimitedFrame('OBR|1||ACC-001');
    stats.addFrame(a);
    stats.addFrame(b);
    stats.addFrame(c);

    const snap = stats.snapshot();
    expect(snap.total).toBe(a.issues.length + b.issues.length + c.issues.length);
    expect(snap.framesWithIssues).toBe(2);
    expect(snap.droppedFrames).toBe(1);
    expect(snap.byCode[DIRTY_DATA_ERROR_CODES.FIELD_TRUNCATED]).toBe(1);
    expect(snap.byCode[DIRTY_DATA_ERROR_CODES.FIELD_MISSING]).toBe(1);
    expect(snap.byCode[DIRTY_DATA_ERROR_CODES.FRAME_MALFORMED]).toBe(1);
    expect(snap.byPath['OBX[1].3']).toBe(1);
  });
});
