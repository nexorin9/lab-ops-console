/**
 * field-mapper 测试
 *
 * 覆盖：
 * ① 字典命中：K → 2823-3 confidence 0.95
 * ② 字典命中：NA → 2951-2
 * ③ 字典命中：中文别名（钾/钠/氯）
 * ④ 字典未命中 + model 命中：返回 model 候选（source=model）
 * ⑤ 字典未命中 + model 置信度 < 阈值：source=fallback
 * ⑥ 字典未命中 + model 抛错：source=fallback 不阻塞
 * ⑦ ModelGateway 不可达（抛 ModelUnavailableFallbackError）→ 走 fallback
 * ⑧ sync 版查字典（model=null 也能工作）
 * ⑨ 危急值阈值：K=6.8 → critical=true, reason=high；K=2.0 → critical=true, reason=low
 * ⑩ 危急值阈值：GLU=5.0 → critical=false
 */

import { describe, it, expect } from 'vitest';
import {
  FieldMapper,
  lookupDictionary,
  checkCriticalThreshold,
  type ModelGatewayLike,
} from '../../src/parser/field-mapper.js';
import { ModelUnavailableFallbackError } from '../../src/shared/errors.js';

const stubModel = (impl: ModelGatewayLike['suggestLoinc']): ModelGatewayLike => ({
  suggestLoinc: impl,
});

describe('parser/field-mapper', () => {
  it('字典命中：K → 2823-3 confidence 0.95', () => {
    const r = lookupDictionary('K');
    expect(r).not.toBeNull();
    expect(r?.loinc).toBe('2823-3');
    expect(r?.source).toBe('dictionary');
    expect(r?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('字典命中：NA → 2951-2', () => {
    const r = lookupDictionary('NA');
    expect(r?.loinc).toBe('2951-2');
  });

  it('字典命中：中文别名（钾/钠/氯）', () => {
    expect(lookupDictionary('钾')?.loinc).toBe('2823-3');
    expect(lookupDictionary('钠')?.loinc).toBe('2951-2');
    expect(lookupDictionary('氯')?.loinc).toBe('2075-0');
  });

  it('字典未命中 + model 高置信 → 采纳 model 结果（source=model）', async () => {
    const mapper = new FieldMapper(
      stubModel(async () => ({
        loinc: '99999-9',
        display: 'Unknown Test',
        confidence: 0.9,
        source: 'model',
        reason: 'inferred',
      })),
      { modelAcceptThreshold: 0.5 },
    );
    const r = await mapper.mapResultCode({
      deviceCode: 'XYZ-FAKE',
      deviceDisplay: 'XYZ-FAKE',
      deviceId: 'DEV-1',
    });
    expect(r.loinc).toBe('99999-9');
    expect(r.source).toBe('model');
  });

  it('字典未命中 + model 置信度 < 阈值 → 标 fallback（仍返回候选）', async () => {
    const mapper = new FieldMapper(
      stubModel(async () => ({
        loinc: '88888-8',
        display: 'Low Conf',
        confidence: 0.3,
        source: 'model',
      })),
      { modelAcceptThreshold: 0.5 },
    );
    const r = await mapper.mapResultCode({
      deviceCode: 'XYZ-FAKE',
      deviceDisplay: 'XYZ',
      deviceId: 'DEV-1',
    });
    expect(r.source).toBe('fallback');
    expect(r.confidence).toBe(0.3);
  });

  it('字典未命中 + model 抛普通 Error → 走 fallback 不阻塞', async () => {
    const mapper = new FieldMapper(
      stubModel(async () => {
        throw new Error('network blip');
      }),
    );
    const r = await mapper.mapResultCode({
      deviceCode: 'XYZ-FAKE',
      deviceDisplay: 'XYZ',
      deviceId: 'DEV-1',
    });
    expect(r.source).toBe('fallback');
    expect(r.loinc).toBe('unknown');
  });

  it('ModelGateway 抛 ModelUnavailableFallbackError → 走 fallback', async () => {
    const mapper = new FieldMapper(
      stubModel(async () => {
        throw new ModelUnavailableFallbackError('model down');
      }),
    );
    const r = await mapper.mapResultCode({
      deviceCode: 'XYZ-FAKE',
      deviceDisplay: 'XYZ',
      deviceId: 'DEV-1',
    });
    expect(r.source).toBe('fallback');
  });

  it('sync 版：仅查字典（model=null 也能工作）', () => {
    const mapper = new FieldMapper(null);
    const r = mapper.mapResultCodeSync({ deviceCode: 'K', deviceDisplay: '钾' });
    expect(r.source).toBe('dictionary');
    expect(r.loinc).toBe('2823-3');
  });

  it('危急值阈值：K=6.8 → critical=true, reason=high', () => {
    const r = checkCriticalThreshold('K', 6.8, 'mmol/L');
    expect(r.critical).toBe(true);
    expect(r.reason).toBe('high');
  });

  it('危急值阈值：K=2.0 → critical=true, reason=low', () => {
    const r = checkCriticalThreshold('K', 2.0, 'mmol/L');
    expect(r.critical).toBe(true);
    expect(r.reason).toBe('low');
  });

  it('危急值阈值：GLU=5.0 → critical=false', () => {
    const r = checkCriticalThreshold('GLU', 5.0, 'mmol/L');
    expect(r.critical).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('字典命中 → lowConfidence=false；未命中兜底 → lowConfidence=true', async () => {
    const mapper = new FieldMapper(null);

    const hit = await mapper.mapResultCode({
      deviceCode: 'K',
      deviceDisplay: '钾',
      deviceId: 'DEV-1',
    });
    expect(hit.lowConfidence).toBe(false);

    const miss = await mapper.mapResultCode({
      deviceCode: 'ZZZ-UNKNOWN',
      deviceDisplay: '未知项目',
      deviceId: 'DEV-1',
    });
    expect(miss.lowConfidence).toBe(true);
    expect(miss.source).toBe('fallback');
    // 未命中仍返回候选，不阻塞主路径
    expect(miss.loinc).toBe('unknown');
    expect(miss.display).toBe('未知项目');
  });

  it('模型兜底失败 → lowConfidence=true；模型高置信采纳 → lowConfidence=false', async () => {
    const failMapper = new FieldMapper(
      stubModel(async () => {
        throw new ModelUnavailableFallbackError('model down');
      }),
    );
    const failed = await failMapper.mapResultCode({
      deviceCode: 'ZZZ-UNKNOWN',
      deviceDisplay: '未知项目',
      deviceId: 'DEV-1',
    });
    expect(failed.lowConfidence).toBe(true);

    const okMapper = new FieldMapper(
      stubModel(async () => ({
        loinc: '99999-9',
        display: 'Unknown Test',
        confidence: 0.9,
        source: 'model' as const,
      })),
    );
    const adopted = await okMapper.mapResultCode({
      deviceCode: 'ZZZ-UNKNOWN',
      deviceDisplay: '未知项目',
      deviceId: 'DEV-1',
    });
    expect(adopted.lowConfidence).toBe(false);
    expect(adopted.source).toBe('model');
  });

  it('命中率统计：字典命中 / 未命中逐条记账', async () => {
    const mapper = new FieldMapper(null);
    expect(mapper.stats().total).toBe(0);
    expect(mapper.stats().hitRate).toBe(0);

    await mapper.mapResultCode({ deviceCode: 'K', deviceDisplay: '钾', deviceId: 'DEV-1' });
    await mapper.mapResultCode({ deviceCode: 'NA', deviceDisplay: '钠', deviceId: 'DEV-1' });
    await mapper.mapResultCode({ deviceCode: 'ZZZ-UNKNOWN', deviceDisplay: '?', deviceId: 'DEV-1' });

    const stats = mapper.stats();
    expect(stats.total).toBe(3);
    expect(stats.dictionaryHits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 5);
  });
});
