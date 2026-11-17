/**
 * T25 · 值班表规则兜底与候选接收人（≥6 条）
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OncallRoster, shiftCovers } from '../../src/critical/oncall.js';
import { ModelGateway } from '../../src/ai/ModelGateway.js';
import type { Candidate } from '../../src/ai/types.js';

const SAMPLE = resolve(__dirname, '../../channels/oncall-sample.yaml');
// 不带 Z：班次窗口按医院本地时间解释（shiftCovers 用 getHours()），测试与生产口径一致
const at = (hhmm: string) => new Date(`2026-11-08T${hhmm}:00`);

function roster(overrides: Record<string, unknown> = {}): OncallRoster {
  const r = new OncallRoster({ path: SAMPLE, now: () => at('10:00'), ...overrides });
  r.load();
  return r;
}

describe('T25 · 班次窗口与跨零点', () => {
  it('版本 / 生效日期 / 来源可读，3 个病区加载成功', () => {
    const r = roster();
    expect(r.version).toBe('2026.11.1');
    expect(r.effectiveDate).toBe('2026-11-01');
    expect(r.source).toContain('脱敏');
    expect(r.wardCount).toBe(3);
    expect(r.isDegraded).toBe(false);
  });

  it('shiftCovers 跨零点窗口正确（22:00-06:00 覆盖 23:30 与 05:00，不覆盖 10:00）', () => {
    expect(shiftCovers('22:00', '06:00', at('23:30'))).toBe(true);
    expect(shiftCovers('22:00', '06:00', at('05:00'))).toBe(true);
    expect(shiftCovers('22:00', '06:00', at('10:00'))).toBe(false);
    expect(shiftCovers('06:00', '22:00', at('10:00'))).toBe(true);
  });

  it('跨零点班次命中夜班候选：23:30 返回 ICU 夜班而非白班', () => {
    const r = roster();
    const result = r.lookup('ICU', at('23:30'));
    expect(result.matchedWard).toBe(true);
    expect(result.shiftLabel).toBe('22:00-06:00');
    expect(result.degraded).toBe(false);
    expect(result.candidates.map((c) => c.practitionerId)).toEqual(['PR-ICU-N1', 'PR-ICU-N2']);
  });

  it('凌晨 05:00 仍归夜班，06:00 切到白班（交班边界不误判）', () => {
    const r = roster();
    expect(r.lookup('ICU', at('05:00')).candidates[0]!.practitionerId).toBe('PR-ICU-N1');
    expect(r.lookup('ICU', at('06:00')).candidates[0]!.practitionerId).toBe('PR-ICU-D1');
  });

  it('按 role 过滤候选；角色缺失回退默认角色并标 low_confidence', () => {
    const r = roster();
    const filtered = r.lookup('ICU', at('10:00'), '组长');
    expect(filtered.candidates).toHaveLength(1);
    expect(filtered.candidates[0]!.practitionerId).toBe('PR-ICU-D2');
    const miss = r.lookup('ICU', at('10:00'), '不存在角色');
    expect(miss.degraded).toBe(true);
    expect(miss.candidates.length).toBeGreaterThan(0);
    expect(miss.candidates[0]!.lowConfidence).toBe(true);
    expect(miss.candidates[0]!.role).toBe('不存在角色');
  });
});

describe('T25 · 缺项降级与统一候选结构', () => {
  it('病区不在值班表 → 回退默认角色且 low_confidence，不返回空候选', () => {
    const r = roster();
    const result = r.lookup('不存在的病区', at('10:00'));
    expect(result.matchedWard).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0]).toMatchObject({
      role: '病区默认值班护士',
      practitionerId: 'PR-DEFAULT-NURSE',
      source: 'rule',
      lowConfidence: true,
    });
    expect(result.candidates[0]!.confidence).toBeLessThan(0.5);
  });

  it('值班表文件缺失 / 格式非法 → 降级但仍给出非空低置信度候选', () => {
    const missing = new OncallRoster({ path: '/tmp/definitely-not-exist-oncall.yaml' });
    expect(missing.load().ok).toBe(false);
    expect(missing.isDegraded).toBe(true);
    expect(missing.lookup('ICU', at('10:00')).candidates.length).toBeGreaterThan(0);

    const bad = new OncallRoster({ text: 'source: 缺字段\nwards: []' });
    expect(bad.load().ok).toBe(false);
    const c = bad.suggestRecipients({ ward: 'ICU', at: at('10:00').toISOString() });
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.lowConfidence).toBe(true);
  });

  it('班次窗口有缺口时不返回空候选（回退默认角色）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oncall-'));
    try {
      const text = [
        'source: 测试值班表',
        "version: '1'",
        "effectiveDate: '2026-01-01'",
        'defaultRole: 默认护士',
        'defaultPractitionerId: PR-DEF',
        'wards:',
        '  - ward: ICU',
        '    shifts:',
        "      - start: '08:00'",
        "        end: '09:00'",
        '        entries:',
        '          - role: 早班护士',
        '            practitionerId: PR-1',
      ].join('\n');
      const r = new OncallRoster({ text });
      r.load();
      const result = r.lookup('ICU', at('15:00'));
      expect(result.degraded).toBe(true);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.role).toBe('默认护士');
      expect(result.candidates[0]!.lowConfidence).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('候选与模型共用 Candidate 结构（source=rule / confidence 数值 / reason 非空）', () => {
    const r = roster();
    const candidates: Candidate[] = r.suggestRecipients({ ward: '急诊', at: at('02:00').toISOString() });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.source).toBe('rule');
      expect(typeof c.confidence).toBe('number');
      expect(c.reason.length).toBeGreaterThan(0);
      expect(c.practitionerId.length).toBeGreaterThan(0);
    }
    expect(candidates[0]!.practitionerId).toBe('PR-ER-N1');
  });

  it('注入 ModelGateway 后模型不可达仍返回值班表候选，且全部标 low_confidence', async () => {
    const r = roster();
    const gw = new ModelGateway({
      config: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', timeoutMs: 50 },
      fetchImpl: (async () => { throw new Error('模型端点不可达'); }) as unknown as typeof fetch,
      fallback: r,
    });
    const result = await gw.suggestRecipients({ ward: 'ICU', at: at('23:30').toISOString() });
    expect(result.ok).toBe(false);
    expect(result.source).toBe('fallback_rules');
    expect(result.lowConfidence).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.every((c) => c.lowConfidence === true)).toBe(true);
    expect(result.data[0]!.practitionerId).toBe('PR-ICU-N1');
  });

  it('统计计数：lookups / fallbacks 与实际调用一致', () => {
    const r = roster();
    r.lookup('ICU', at('10:00'));
    r.lookup('不存在', at('10:00'));
    r.suggestRecipients({ ward: '急诊', at: at('02:00').toISOString() });
    const s = r.stats();
    expect(s.lookups).toBe(3);
    expect(s.fallbacks).toBe(1);
    expect(s.degraded).toBe(false);
  });
});
