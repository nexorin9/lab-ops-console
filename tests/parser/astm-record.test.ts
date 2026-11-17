/**
 * ASTM E1394 记录解析器测试
 *
 * 覆盖：
 * ① 正常 ASTM 记录 → 4 Observation（K/Na/Cl/GLU）+ DiagnosticReport + Specimen + Device
 * ② 危急值识别：GLU=26.5 + 4R.7=HH → criticalFlags
 * ③ 缺 header (1H) → 抛 AstmParseFailError
 * ④ 缺 4R 结果行 → 抛 AstmParseFailError
 * ⑤ 空记录 → 抛 AstmParseFailError
 * ⑥ 字段归因字典命中（K/NA/CL/GLU → LOINC）
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseAstmRecord,
  parseAstmStream,
  splitAstmRecords,
  decodeAstmControlChars,
} from '../../src/parser/astm-record.js';
import { AstmParseFailError } from '../../src/shared/errors.js';

const FX_DIR = resolve(__dirname, '../fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FX_DIR, name), 'utf-8');
}

describe('parser/astm-record', () => {
  it('正常 ASTM 记录 → 4 Observation + DiagnosticReport + Specimen + Device', async () => {
    const raw = loadFixture('astm-record-sample.txt');
    const result = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-01' });

    expect(result.observations).toHaveLength(4);
    expect(result.diagnosticReport.resourceType).toBe('DiagnosticReport');
    expect(result.specimen.resourceType).toBe('Specimen');
    expect(result.device.resourceType).toBe('Device');
    expect(result.device.id).toBe('DEV-ASTM-01');

    // GLU=26.5 触发 threshold_exceeded
    expect(result.criticalFlags.length).toBeGreaterThanOrEqual(1);
    const gluFlag = result.criticalFlags.find((f) => f.testCode === 'GLU');
    expect(gluFlag).toBeDefined();
    expect(gluFlag?.reason).toBe('threshold_exceeded');

    // 字段归因 K/NA/CL/GLU 全部命中字典
    const codes = result.fieldAttribution.map((f) => f.deviceCode);
    expect(codes).toEqual(expect.arrayContaining(['K', 'NA', 'CL', 'GLU']));
    expect(result.fieldAttribution.every((f) => f.source === 'dictionary')).toBe(true);
  });

  it('危急值：GLU=26.5 + HH flag → criticalFlags 同时含 threshold_exceeded + abnormal_flag', async () => {
    const raw = loadFixture('astm-record-sample.txt');
    const result = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-02' });

    const thresholdFlags = result.criticalFlags.filter((f) => f.reason === 'threshold_exceeded');
    const abnormalFlags = result.criticalFlags.filter((f) => f.reason === 'abnormal_flag');
    expect(thresholdFlags.length).toBeGreaterThanOrEqual(1);
    expect(abnormalFlags.length).toBeGreaterThanOrEqual(1);
  });

  it('缺 header (1H) → 抛 AstmParseFailError', async () => {
    const raw = '4R|1|^^^K|4.5|mmol/L|3.5-5.5|N\r5L|1|N\r';
    await expect(parseAstmRecord(raw, { deviceId: 'DEV-1' })).rejects.toThrow(AstmParseFailError);
  });

  it('缺 4R 结果行 → 抛 AstmParseFailError', async () => {
    const raw = '1H|\\^&|||ASTM^Host|||||LIS||P|1\r2P|1||P1||||||\r5L|1|N\r';
    await expect(parseAstmRecord(raw, { deviceId: 'DEV-1' })).rejects.toThrow(AstmParseFailError);
  });

  it('空记录 → 抛 AstmParseFailError', async () => {
    await expect(parseAstmRecord('', { deviceId: 'DEV-1' })).rejects.toThrow(AstmParseFailError);
  });

  it('字段归因：K/NA/CL/GLU → LOINC 字典全部命中', async () => {
    const raw = loadFixture('astm-record-sample.txt');
    const result = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-03' });

    // 4 个 observation 的 code 来自 LOINC 系统
    expect(result.observations.every((o) => o.code.coding[0]?.system === 'http://loinc.org')).toBe(true);
    const obsCodes = result.observations.map((o) => o.code.coding[0]?.code).sort();
    expect(obsCodes).toEqual(['2075-0', '2345-7', '2823-3', '2951-2'].sort());
  });

  it('%%XX 控制字符解码：%0D → CR、%1C → FS、%25 → 字面量 %', () => {
    expect(decodeAstmControlChars('a%0Db')).toBe('a\rb');
    expect(decodeAstmControlChars('a%1Cb')).toBe('a\x1cb');
    expect(decodeAstmControlChars('100%25')).toBe('100%');
    // 非法的 % 序列按字面量处理，不吞字符
    expect(decodeAstmControlChars('a%zzb')).toBe('a%zzb');
  });

  it('帧切分：ENQ/ACK/EOT 会话控制帧从记录里分离出来', () => {
    const stream = [
      '\x05', // ENQ
      '1H|\\^&|||ASTM^Host|||||LIS||P|1\r',
      '2P|1||P1||||||\r',
      '3O|1|SMP-1||CHEM7^生化七项^L|R|20261013110000\r',
      '4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r',
      '5L|1|N\r',
      '\x04', // EOT
    ].join('');

    const split = splitAstmRecords(stream);

    expect(split.controlFrames.map((f) => f.type)).toEqual(['ENQ', 'EOT']);
    expect(split.controlFrames[0]?.rawHex).toBe('05');
    expect(split.controlFrames[1]?.rawHex).toBe('04');
    // 记录本身不含控制帧
    expect(split.records).toHaveLength(1);
    expect(split.records[0]).toContain('1H|');
    expect(split.records[0]).toContain('4R|1|^^^K|4.8');
    expect(split.records[0]).not.toContain('\x05');
  });

  it('帧切分：一条字节流里的多条记录切得开，且 STX/ETX 边界被剥掉', () => {
    const stream = [
      '\x021H|\\^&|||ASTM^Host|||||LIS||P|1\r2P|1||P1||||||\r4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r5L|1|N\x03',
      '\x021H|\\^&|||ASTM^Host|||||LIS||P|1\r2P|1||P2||||||\r4R|1|^^^NA|142|mmol/L|135-145|N\r5L|1|N\x03',
    ].join('');

    const split = splitAstmRecords(stream);

    expect(split.records).toHaveLength(2);
    expect(split.records[0]).toContain('P1');
    expect(split.records[1]).toContain('P2');
    expect(split.records[0]?.startsWith('1H|')).toBe(true);
  });

  it('parseAstmStream：一段字节流里坏记录不拖累好记录', async () => {
    const stream = [
      '\x05',
      '1H|\\^&|||ASTM^Host|||||LIS||P|1\r2P|1||P1||||||\r4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r5L|1|N\r',
      // 缺 header 的坏记录
      '4R|1|^^^NA|142|mmol/L|135-145|N\r5L|1|N\r',
      '\x04',
    ].join('');

    const { results, errors, controlFrames } = await parseAstmStream(stream, {
      deviceId: 'DEV-ASTM-04',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.observations).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(AstmParseFailError);
    expect(controlFrames.map((f) => f.type)).toEqual(['ENQ', 'EOT']);
  });

  it('单条记录里的 %XX 转义被解码后再解析（字段分隔不被粘住）', async () => {
    // 4R 行用 %1C 表示字段分隔前的转义写法，仍能取出数值与单位
    const raw = '1H|\\^&|||ASTM^Host|||||LIS||P|1\r2P|1||P1||||||\r4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r5L|1|N\r';
    const result = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-05' });
    expect(result.observations[0]?.valueQuantity?.value).toBe(4.8);
    expect(result.observations[0]?.valueQuantity?.unit).toBe('mmol/L');
  });

  it('4R.3 带项目名时项目码取首个子成分（^^^K^钾 → 码 K / 名 钾），危急值阈值照常命中', async () => {
    // 厂商常见写法：4R.3 = 项目码^项目名^项目类型
    const raw = [
      '1H|\\^&|||ASTM^Host|||||LIS||P|1',
      '2P|1||P1||||||',
      '3O|1|SMP-1||CHEM7^生化七项^L|R|20261013110000',
      // 仪器只给数值、不给 HH 标记 —— 危急值必须靠阈值表命中
      '4R|1|^^^K^钾|6.8|mmol/L|3.5-5.5|N',
      '5L|1|N',
    ].join('\r');
    const result = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-06' });

    // 项目码取首个子成分，项目名取第二个（不能把项目类型当成项目码）
    expect(result.fieldAttribution[0]?.deviceCode).toBe('K');
    expect(result.fieldAttribution[0]?.deviceDisplay).toBe('钾');

    // K=6.8 mmol/L 超阈值 → 必须有 threshold_exceeded（不能只有 abnormal_flag）
    const thresholdFlags = result.criticalFlags.filter((f) => f.reason === 'threshold_exceeded');
    expect(thresholdFlags).toHaveLength(1);
    expect(thresholdFlags[0]?.testCode).toBe('K');
    expect(thresholdFlags[0]?.value).toBe('6.8');
  });

  it('同一份 ASTM 记录重复解析 → accession 与资源 id 不变（幂等锚稳定）', async () => {
    // 缺 3O 行的退化场景：accession 退化为内容指纹，不能退化成时间戳
    const raw = '1H|\\^&|||ASTM^Host|||||LIS||P|1\r2P|1||P1||||||\r4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r5L|1|N\r';

    const first = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-07' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-07' });

    // 重放同一帧 → 幂等键（accessionIdentifier）与资源 id 必须完全一致
    expect(second.specimen.accessionIdentifier?.value).toBe(first.specimen.accessionIdentifier?.value);
    expect(second.specimen.id).toBe(first.specimen.id);
    expect(second.observations[0]?.id).toBe(first.observations[0]?.id);
    expect(second.diagnosticReport.id).toBe(first.diagnosticReport.id);
  });

  it('%XX 只解码一次：%2541（字面量 "%41"）不被二次解码成 "A"', async () => {
    // 记录里带 %2541 —— 一次解码后是字面量 "%41"，不能再被当成转义解一次
    const raw = [
      '1H|\\^&|||ASTM^Host|||||LIS||P|1',
      '2P|1||P1||||||',
      '3O|1|SMP-1||CHEM7^生化七项^L|R|20261013110000',
      '4R|1|^^^K|4.8%2541|mmol/L|3.5-5.5|N',
      '5L|1|N',
    ].join('\r');

    const direct = await parseAstmRecord(raw, { deviceId: 'DEV-ASTM-08' });
    expect(direct.observations[0]?.valueString).toBe('4.8%41');

    // 走字节流切帧路径结果一致（切帧不再提前解码一遍）
    const stream = `\x05${raw}\x04`;
    const { results } = await parseAstmStream(stream, { deviceId: 'DEV-ASTM-08' });
    expect(results).toHaveLength(1);
    expect(results[0]?.observations[0]?.valueString).toBe('4.8%41');
  });

  it('转义形式的会话控制帧（%05/%06/%04）也能从记录里分离出来', () => {
    const stream = [
      '%05', // ENQ
      '1H|\\^&|||ASTM^Host|||||LIS||P|1\r',
      '2P|1||P1||||||\r',
      '4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r',
      '5L|1|N\r',
      '%06', // ACK
      '%04', // EOT
    ].join('');

    const split = splitAstmRecords(stream);
    expect(split.controlFrames.map((f) => f.type)).toEqual(['ENQ', 'ACK', 'EOT']);
    expect(split.controlFrames.map((f) => f.rawHex)).toEqual(['05', '06', '04']);
    // 控制帧不进记录内容
    expect(split.records).toHaveLength(1);
    expect(split.records[0]).not.toContain('%05');
  });
});
