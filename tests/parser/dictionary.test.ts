/**
 * T19 · 检验项目字典（≥6 条）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { DictionaryStore, type DictionaryItem } from '../../src/parser/dictionary.js';

const SAMPLE_PATH = resolve(__dirname, '../../channels/dictionary-sample.yaml');

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dict-test-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeDict(name: string, data: Record<string, unknown>): string {
  const p = join(dir, name);
  writeFileSync(p, YAML.stringify(data), 'utf-8');
  return p;
}

function dict(version: string, effectiveDate: string, items: DictionaryItem[]) {
  return { source: '院内检验项目对照表（脱敏样例）', version, effectiveDate, items };
}

const ITEM: DictionaryItem = {
  instrument_code: 'K', instrument_name: '血钾', loinc: '2823-3', unit: 'mmol/L', local_code: 'LIS-K',
};

describe('T19 · DictionaryStore', () => {
  it('字典文件头 source / version / effectiveDate 可读，12 条示例条目全部加载', () => {
    const store = new DictionaryStore({ paths: [SAMPLE_PATH] });
    const r = store.load();
    expect(r.loaded).toHaveLength(1);
    expect(r.errors).toHaveLength(0);
    expect(store.version).toBe('2026.11.1');
    expect(store.effectiveDate).toBe('2026-11-01');
    expect(store.source).toContain('脱敏');
    expect(store.size).toBe(12);
  });

  it('命中返回本地码与 LOINC，未命中返回 low_confidence 候选且计数 +1', () => {
    const store = new DictionaryStore({ paths: [SAMPLE_PATH] });
    store.load();
    const hit = store.lookup('k', { channelId: 'chem-1' });
    expect(hit.hit).toBe(true);
    expect(hit.item?.local_code).toBe('LIS-K');
    expect(hit.item?.loinc).toBe('2823-3');

    const miss = store.lookup('UNKNOWN99', { channelId: 'chem-1' });
    expect(miss.hit).toBe(false);
    expect(miss.candidates).toHaveLength(1);
    expect(miss.candidates[0]!.low_confidence).toBe(true);
    expect(miss.candidates[0]!.source).toBe('rule');
    expect(store.stats().misses).toBe(1);
    expect(store.missedCodes()[0]).toEqual({ code: 'UNKNOWN99', count: 1 });
  });

  it('命中率百分比按通道与全局计算正确', () => {
    const store = new DictionaryStore({ paths: [SAMPLE_PATH] });
    store.load();
    store.lookup('K', { channelId: 'A' });
    store.lookup('NA', { channelId: 'A' });
    store.lookup('GLU', { channelId: 'A' });
    store.lookup('ZZZ', { channelId: 'A' });
    store.lookup('K', { channelId: 'B' });
    const s = store.stats();
    expect(s.total).toBe(5);
    expect(s.hits).toBe(4);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBe(80);
    expect(s.byChannel.A).toMatchObject({ total: 4, hits: 3, misses: 1, hitRate: 75 });
    expect(s.byChannel.B).toMatchObject({ total: 1, hits: 1, misses: 0, hitRate: 100 });
  });

  it('多字典文件按生效日期择一（取已生效中最新的一份）', () => {
    const old = writeDict('dictionary-old.yaml', dict('2025.1', '2025-01-01', [ITEM]));
    const newer = writeDict('dictionary-new.yaml', dict('2026.1', '2026-01-01', [
      { ...ITEM, local_code: 'LIS-K-V2' },
      { instrument_code: 'NA', instrument_name: '血钠', loinc: '2951-2', unit: 'mmol/L', local_code: 'LIS-NA' },
    ]));
    const future = join(dir, 'dictionary-future.yaml');
    writeFileSync(future, YAML.stringify(dict('2099.1', '2099-01-01', [ITEM])), 'utf-8');

    const store = new DictionaryStore({ paths: [old, newer, future], now: () => new Date('2026-11-08T00:00:00Z') });
    const r = store.load();
    expect(r.loaded).toHaveLength(3);
    expect(store.version).toBe('2026.1');
    expect(store.lookup('K').item?.local_code).toBe('LIS-K-V2');
  });

  it('格式非法的字典文件报错且不阻塞其余字典加载', () => {
    const bad = join(dir, 'dictionary-bad.yaml');
    writeFileSync(bad, 'source: 缺字段\nitems: []', 'utf-8');
    const good = join(dir, 'dictionary-good.yaml');
    writeFileSync(good, YAML.stringify(dict('2026.2', '2026-01-01', [ITEM])), 'utf-8');

    const store = new DictionaryStore({ paths: [bad, good], now: () => new Date('2026-11-08T00:00:00Z') });
    const r = store.load();
    expect(r.loaded).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.file).toBe(bad);
    expect(r.errors[0]!.message).toContain('字典格式非法');
    expect(store.lookup('K').item?.local_code).toBe('LIS-K');
  });

  it('未命中可交模型归因输出 low_confidence 候选（模型不可达时回规则候选）', async () => {
    const store = new DictionaryStore({
      paths: [SAMPLE_PATH],
      attributor: { attributeUnknownCode: async () => ({ local_code: 'LIS-XYZ', reason: '模型建议', confidence: 0.42 }) },
    });
    store.load();
    const miss = store.lookup('XYZ', { runAttribution: true });
    expect(miss.candidates[0]!.low_confidence).toBe(true);
    const attributed = await store.attributionFor('XYZ');
    expect(attributed?.source).toBe('model');
    expect(attributed?.local_code).toBe('LIS-XYZ');
    expect(attributed?.confidence).toBe(0.42);

    const broken = new DictionaryStore({
      paths: [SAMPLE_PATH],
      attributor: { attributeUnknownCode: async () => { throw new Error('模型不可达'); } },
    });
    broken.load();
    broken.lookup('QQQ', { runAttribution: true });
    expect((await broken.attributionFor('QQQ'))?.source).toBe('rule');
  });

  it('人工确认后回写 yaml，reload 即生效（改文件重启语义）', () => {
    const p = writeDict('dictionary-local.yaml', dict('2026.3', '2026-01-01', [ITEM]));
    const store = new DictionaryStore({ paths: [p], now: () => new Date('2026-11-08T00:00:00Z') });
    store.load();
    expect(store.lookup('CA').hit).toBe(false);

    const confirmed = store.confirm('CA', {
      instrument_code: 'CA', instrument_name: '血钙', loinc: '17861-6', unit: 'mmol/L', local_code: 'LIS-CA',
    });
    expect(confirmed.items).toBe(2);
    expect(readFileSync(p, 'utf-8')).toContain('LIS-CA');

    // 未 reload 时内存索引保持不变（不产生「改了文件但没重启」的口径分歧）
    expect(store.lookup('CA').hit).toBe(false);
    store.reload();
    expect(store.lookup('CA').item?.local_code).toBe('LIS-CA');
  });

  it('命中与未命中写运行摘要打点（dictionary_hit / dictionary_miss）', () => {
    const events: string[] = [];
    const store = new DictionaryStore({
      paths: [SAMPLE_PATH],
      summary: { record: (e) => events.push(e) },
    });
    store.load();
    store.lookup('K');
    store.lookup('NOPE');
    store.lookup('GLU');
    expect(events).toEqual(['dictionary_hit', 'dictionary_miss', 'dictionary_hit']);
  });
});
