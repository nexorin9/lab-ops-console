/**
 * T23 · 危急值阈值表与判定策略（≥8 条）
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  CriticalThresholdEvaluator,
  THRESHOLD_ALERT_CODE,
  convertToBaseUnit,
  type ThresholdAlert,
} from '../../src/critical/thresholds.js';

const SAMPLE = resolve(__dirname, '../../channels/critical-thresholds.yaml');

function make(overrides: Record<string, unknown> = {}) {
  const alerts: ThresholdAlert[] = [];
  const evaluator = new CriticalThresholdEvaluator({
    path: SAMPLE,
    onAlert: (a) => alerts.push(a),
    ...overrides,
  });
  return { evaluator, alerts };
}

describe('T23 · 阈值表加载与单位换算', () => {
  it('阈值表 version / effectiveDate / source 可读，10 条条目含危急上下限与来源标注', () => {
    const { evaluator } = make();
    const r = evaluator.load();
    expect(r.ok).toBe(true);
    expect(evaluator.version).toBe('2026.11.1');
    expect(evaluator.effectiveDate).toBe('2026-11-01');
    expect(evaluator.source).toContain('脱敏');
    expect(evaluator.size).toBe(10);
    expect(evaluator.isDegraded).toBe(false);
  });

  it('单位换算后判定结果与原单位一致（GLU 36 mg/dL == 2.0 mmol/L 均判危急）', () => {
    const { evaluator } = make();
    evaluator.load();
    const mgdl = evaluator.evaluate({ code: 'GLU', value: 36, unit: 'mg/dL' });
    const mmol = evaluator.evaluate({ code: 'GLU', value: 2.0, unit: 'mmol/L' });
    expect(mgdl.converted).toBe(true);
    expect(mgdl.comparedValue).toBeCloseTo(2.0, 5);
    expect(mgdl.critical).toBe(true);
    expect(mmol.critical).toBe(true);
    expect(mgdl.severity).toBe(mmol.severity);
  });

  it('单位换算后落在参考区间内不判危急（GLU 90 mg/dL == 5.0 mmol/L）', () => {
    const { evaluator } = make();
    evaluator.load();
    const v = evaluator.evaluate({ code: 'GLU', value: 90, unit: 'mg/dL' });
    expect(v.comparedValue).toBeCloseTo(5.0, 5);
    expect(v.critical).toBe(false);
    expect(v.severity).toBe('low');
  });

  it('convertToBaseUnit 覆盖 HGB / CR / 一价离子，未知换算返回 null（不猜）', () => {
    expect(convertToBaseUnit('HGB', 6, 'g/dL')?.value).toBe(60);
    expect(convertToBaseUnit('CR', 2, 'mg/dL')?.value).toBeCloseTo(176.8, 5);
    expect(convertToBaseUnit('K', 6.8, 'mEq/L')?.value).toBe(6.8);
    expect(convertToBaseUnit('K', 6.8, 'mmol/L')).toBeNull();
    expect(convertToBaseUnit('XYZ', 1, 'mg/dL')).toBeNull();
  });

  it('危急下限与上限分别判定（K 2.5 / K 7.0 均判 critical）', () => {
    const { evaluator } = make();
    evaluator.load();
    expect(evaluator.evaluate({ code: 'K', value: 2.5, unit: 'mmol/L' }).critical).toBe(true);
    expect(evaluator.evaluate({ code: 'K', value: 7.0, unit: 'mmol/L' }).critical).toBe(true);
    const mid = evaluator.evaluate({ code: 'K', value: 4.5, unit: 'mmol/L' });
    expect(mid.critical).toBe(false);
    expect(mid.severity).toBe('low');
    const highOnly = evaluator.evaluate({ code: 'K', value: 6.0, unit: 'mmol/L' });
    expect(highOnly.critical).toBe(false);
    expect(highOnly.severity).toBe('high');
  });
});

describe('T23 · 标记与阈值冲突 / 安全降级', () => {
  it('仪器标 HH 但阈值判定正常 → 取更严重一侧（critical）且 conflict 计数 +1', () => {
    const { evaluator, alerts } = make();
    evaluator.load();
    const v = evaluator.evaluate({ code: 'K', value: 4.5, unit: 'mmol/L', instrumentFlag: 'HH' });
    expect(v.conflict).toBe(true);
    expect(v.critical).toBe(true);
    expect(v.severity).toBe('critical');
    expect(v.source).toBe('instrument');
    expect(evaluator.stats().conflicts).toBe(1);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it('阈值超危急上限但仪器标 N → 仍取更严重一侧（critical）且 conflict 计数 +1', () => {
    const { evaluator } = make();
    evaluator.load();
    const v = evaluator.evaluate({ code: 'K', value: 6.8, unit: 'mmol/L', instrumentFlag: 'N' });
    expect(v.conflict).toBe(true);
    expect(v.critical).toBe(true);
    expect(v.source).toBe('threshold');
    expect(evaluator.stats().conflicts).toBe(1);
  });

  it('两者一致时不计冲突；不在阈值表内的项目只看仪器标记', () => {
    const { evaluator } = make();
    evaluator.load();
    const agree = evaluator.evaluate({ code: 'K', value: 6.8, unit: 'mmol/L', instrumentFlag: 'HH' });
    expect(agree.conflict).toBe(false);
    expect(agree.source).toBe('both');
    const unknown = evaluator.evaluate({ code: 'XYZ', value: 1, unit: 'x', instrumentFlag: 'HH' });
    expect(unknown.critical).toBe(true);
    expect(unknown.source).toBe('instrument');
    expect(evaluator.stats().conflicts).toBe(0);
  });

  it('阈值表缺失 → 降级告警而非静默放行，仪器标记仍判危急', () => {
    const { evaluator, alerts } = make({ path: '/tmp/definitely-not-exist-thresholds.yaml' });
    const load = evaluator.load();
    expect(load.ok).toBe(false);
    expect(evaluator.isDegraded).toBe(true);
    const v = evaluator.evaluate({ code: 'K', value: 4.5, unit: 'mmol/L', instrumentFlag: 'HH' });
    expect(v.degraded).toBe(true);
    expect(v.source).toBe('degraded');
    expect(v.critical).toBe(true);
    expect(v.reason).toContain('降级');
    expect(alerts.some((a) => a.code === THRESHOLD_ALERT_CODE)).toBe(true);
    expect(evaluator.stats().degraded).toBe(1);
  });

  it('阈值表格式非法 → 降级并发告警，且普通值不会被误判为危急', () => {
    const { evaluator, alerts } = make({ text: 'source: 缺字段\nitems: []' });
    expect(evaluator.load().ok).toBe(false);
    expect(evaluator.isDegraded).toBe(true);
    const v = evaluator.evaluate({ code: 'K', value: 4.5, unit: 'mmol/L' });
    expect(v.degraded).toBe(true);
    expect(v.critical).toBe(false);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it('统计计数与注入事件一致（evaluations / critical / conflicts / converted / degraded）', () => {
    const { evaluator } = make();
    evaluator.load();
    evaluator.evaluate({ code: 'GLU', value: 36, unit: 'mg/dL' });       // critical + converted
    evaluator.evaluate({ code: 'K', value: 4.5, unit: 'mmol/L', instrumentFlag: 'HH' }); // critical + conflict
    evaluator.evaluate({ code: 'K', value: 4.5, unit: 'mmol/L' });       // low
    const s = evaluator.stats();
    expect(s.evaluations).toBe(3);
    expect(s.critical).toBe(2);
    expect(s.conflicts).toBe(1);
    expect(s.converted).toBe(1);
    expect(s.degraded).toBe(0);
  });
});
