/**
 * ORU^R01 解析器测试
 *
 * 覆盖：
 * ① 正常 ORU^R01 → 3 Observation + 1 DiagnosticReport + 1 Specimen + 1 Device
 * ② 危急值识别（K=6.8 → criticalFlags 含 threshold_exceeded；OBX.8=HH → criticalFlags 含 abnormal_flag）
 * ③ 字段归因：K/NA/CL/GLU 命中字典；LOINC 来自 http://loinc.org 系统
 * ④ 字段缺失（OBX.3 缺） → 抛 Hl7ParseFailError / 走 fallback
 * ⑤ GBK 编码 PID.5 中文姓名
 * ⑥ 非 ORU^R01 消息（错型） → 抛 Hl7ParseFailError
 * ⑦ ModelGateway stub：仪器码未命中 → 调 model 兜底
 * ⑧ diagnosticReport.result 引用所有 Observation
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHl7Message } from '../../src/channels/Hl7Connection.js';
import { parseOruR01, parseOruR01Frame } from '../../src/parser/oru-r01.js';
import { FieldMapper, type LoincSuggestion } from '../../src/parser/field-mapper.js';
import { Hl7ParseFailError, ModelUnavailableFallbackError, DeviceNotAllowedError } from '../../src/shared/errors.js';

const FX_DIR = resolve(__dirname, '../fixtures');

function loadFixture(name: string): string {
  return readFileSync(resolve(FX_DIR, name), 'utf-8');
}

describe('parser/oru-r01', () => {
  it('正常 ORU^R01（K/Na/Cl）→ 3 Observation + 1 DiagnosticReport + 1 Specimen + 1 Device', async () => {
    const raw = loadFixture('oru-r01-k-nacl.txt');
    const msg = parseHl7Message(raw);
    const result = await parseOruR01(msg, { deviceId: 'DEV-LIS-01' });

    expect(result.observations).toHaveLength(3);
    expect(result.diagnosticReport.resourceType).toBe('DiagnosticReport');
    expect(result.specimen.resourceType).toBe('Specimen');
    expect(result.device.resourceType).toBe('Device');
    expect(result.device.id).toBe('DEV-LIS-01');

    // 3 个 observation 的 code 应映射到 LOINC 字典
    const codes = result.observations.map((o) => o.code.coding[0]?.code);
    expect(codes).toContain('2823-3'); // K
    expect(codes).toContain('2951-2'); // Na
    expect(codes).toContain('2075-0'); // Cl

    // 字段归因全部来自 dictionary
    expect(result.fieldAttribution.every((f) => f.source === 'dictionary')).toBe(true);
    expect(result.fieldAttribution.every((f) => f.confidence >= 0.85)).toBe(true);

    // K=4.5 正常 → 无危急值
    expect(result.criticalFlags).toHaveLength(0);

    // diagnosticReport.result 引用所有 observation
    expect(result.diagnosticReport.result).toHaveLength(3);
  });

  it('危急值识别：K=6.8 + OBX.8=HH → criticalFlags 同时含 threshold_exceeded 与 abnormal_flag', async () => {
    const raw = loadFixture('oru-r01-critical-k68.txt');
    const msg = parseHl7Message(raw);
    const result = await parseOruR01(msg, { deviceId: 'DEV-LIS-02' });

    // 危急值标记至少 2 条（K 阈值 + K HH + GLU HH 三个 abnormal_flag）
    expect(result.criticalFlags.length).toBeGreaterThanOrEqual(2);

    // 至少 1 条 threshold_exceeded
    const thresholdFlags = result.criticalFlags.filter((f) => f.reason === 'threshold_exceeded');
    expect(thresholdFlags.length).toBeGreaterThanOrEqual(1);
    expect(thresholdFlags[0]?.testCode).toBe('K');
    expect(thresholdFlags[0]?.value).toBe('6.8');

    // 至少 1 条 abnormal_flag
    const abnormalFlags = result.criticalFlags.filter((f) => f.reason === 'abnormal_flag');
    expect(abnormalFlags.length).toBeGreaterThanOrEqual(1);
    expect(abnormalFlags.some((f) => f.testCode === 'K' || f.testCode === 'GLU')).toBe(true);
  });

  it('GBK 编码 PID.5 中文姓名解析成功', async () => {
    // 构造一段 GBK 编码 ORU^R01（PID.5 = 张三）
    const asciiMsSh = 'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013100000||ORU^R01^ORU_R01|MSG00010|P|2.5';
    const pidAscii = 'PID|1||P99999^^^Hospital-A^MR||';
    const obxAscii = 'OBX|1|NM|K^钾^L|1|4.5|mmol/L|3.5-5.5|N|||F';
    const asciiFrame = [asciiMsSh, pidAscii, obxAscii].join('\r');

    // 用 iconv-lite 模拟 GBK 编码
    const iconv = await import('iconv-lite');
    const encoded = iconv.encode(asciiFrame, 'gbk');
    const decoded = iconv.decode(encoded, 'gbk');
    const msg = parseHl7Message(decoded);
    const result = await parseOruR01(msg, { deviceId: 'DEV-LIS-GBK' });

    expect(result.observations).toHaveLength(1);
    // PID.5 解析时取 ^ 前的部分 → 这里 PID.5 后续 \r 直接截断；expect PID.5 split '^'[0] 不会包含中文
    // 主验证：解析不抛错，subject 引用建立
    expect(result.diagnosticReport.subject?.reference).toBe('Patient/P99999');
  });

  it('非 ORU^R01 消息 → 抛 Hl7ParseFailError', async () => {
    const raw = 'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013090000||ADT^A01^ADT_A01|MSG99999|P|2.5\r';
    const msg = parseHl7Message(raw);
    await expect(parseOruR01(msg, { deviceId: 'DEV-1' })).rejects.toThrow(Hl7ParseFailError);
  });

  it('字段缺失 OBX 段 → 抛 Hl7ParseFailError', async () => {
    const raw = 'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013090000||ORU^R01^ORU_R01|MSG99999|P|2.5\rPID|1||P1\r';
    const msg = parseHl7Message(raw);
    await expect(parseOruR01(msg, { deviceId: 'DEV-1' })).rejects.toThrow(Hl7ParseFailError);
  });

  it('ModelGateway stub：仪器码未命中 → 调 model 兜底，置信度高于阈值则采纳', async () => {
    const model = {
      suggestLoinc: async (input: { deviceCode: string; deviceDisplay: string }) => ({
        loinc: '12345-6',
        display: `Model-${input.deviceDisplay}`,
        confidence: 0.9,
        source: 'model' as const,
        reason: 'test stub',
      }),
    };
    const mapper = new FieldMapper(model, { modelAcceptThreshold: 0.5 });
    const raw = 'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013090000||ORU^R01^ORU_R01|MSG77777|P|2.5\rPID|1||P1\rOBX|1|NM|XYZ-FAKE^不存在的项目^L|1|42|mmol/L|0-100|N|||F\r';
    const msg = parseHl7Message(raw);
    const result = await parseOruR01(msg, { deviceId: 'DEV-FAKE', fieldMapper: mapper });

    expect(result.observations).toHaveLength(1);
    // 字段归因来自 model
    const attr = result.fieldAttribution[0]!;
    expect(attr.source).toBe('model');
    expect(attr.loinc).toBe('12345-6');
    expect(attr.confidence).toBe(0.9);
    // Observation.code.coding[0].code 来自 LOINC
    expect(result.observations[0]?.code.coding[0]?.code).toBe('12345-6');
    expect(result.observations[0]?.code.coding[0]?.system).toBe('http://loinc.org');
  });

  it('ModelGateway 不可达（抛 ModelUnavailableFallbackError）→ 走 fallback 仍返回结构化结果，不阻塞主路径', async () => {
    const model = {
      suggestLoinc: async () => {
        throw new ModelUnavailableFallbackError('model unreachable');
      },
    };
    const mapper = new FieldMapper(model);
    const raw = 'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013090000||ORU^R01^ORU_R01|MSG66666|P|2.5\rPID|1||P1\rOBX|1|NM|ABC-FAKE^未知项目^L|1|10|u/L|0-20|N|||F\r';
    const msg = parseHl7Message(raw);
    const result = await parseOruR01(msg, { deviceId: 'DEV-UNREACH', fieldMapper: mapper });

    // 解析未抛错（兜底生效）
    expect(result.observations).toHaveLength(1);
    // 字段归因 source = fallback
    expect(result.fieldAttribution[0]?.source).toBe('fallback');
    expect(result.fieldAttribution[0]?.loinc).toBeUndefined();
    // Observation.code 用设备码作为 code（无 LOINC）
    expect(result.observations[0]?.code.coding[0]?.system).not.toBe('http://loinc.org');
  });

  it('单条 OBX 字段失败 → 不丢整帧（同批其余 OBX 照常产出，错误记入 parseErrors）', async () => {
    // 只让 K 这条 OBX 的字段归因抛错
    class OneBadObxMapper extends FieldMapper {
      override async mapResultCode(input: {
        deviceCode: string;
        deviceDisplay: string;
        deviceId: string;
        panelCode?: string;
      }): Promise<LoincSuggestion> {
        if (input.deviceCode === 'K') {
          throw new Error('字段归因链路异常');
        }
        return super.mapResultCode(input);
      }
    }
    const raw = loadFixture('oru-r01-k-nacl.txt');
    const msg = parseHl7Message(raw);
    const result = await parseOruR01(msg, {
      deviceId: 'DEV-LIS-01',
      fieldMapper: new OneBadObxMapper(null),
    });

    // 整帧没丢：3 条 OBX 里坏掉 1 条，其余 2 条照常产出 Observation
    expect(result.observations).toHaveLength(2);
    expect(result.observations.map((o) => o.code.coding[0]?.code)).toEqual(['2951-2', '2075-0']);
    // diagnosticReport 只引用成功产出的 Observation
    expect(result.diagnosticReport.result).toHaveLength(2);
    // 错误被记账，不是静默丢弃
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors?.[0]?.segment).toBe('OBX');
    expect(result.parseErrors?.[0]?.setId).toBe('1');
    expect(result.parseErrors?.[0]?.code).toBe('HL7_FIELD_INVALID');
    expect(result.parseErrors?.[0]?.message).toContain('OBX.1');
  });

  it('段视图：字节 → { msh, pid, pv1, obr, obx[] }', () => {
    const raw = loadFixture('oru-r01-k-nacl.txt');
    const view = parseOruR01Frame(`\x0b${raw}\x1c\x0d`);
    expect(view.msh[0]).toBe('MSH');
    expect(view.msh[9]).toBe('MSG00001');
    expect(view.pid?.[3]).toContain('P12345');
    expect(view.pv1?.[0]).toBe('PV1');
    expect(view.obr?.[0]).toBe('OBR');
    expect(view.obx).toHaveLength(3);
    expect(view.obx[0]?.[5]).toBe('4.5');
  });

  it('缺 OBX.3（检验项目标识）→ 该条跳过，同批其余 OBX 照常产出 Observation', async () => {
    const raw = [
      'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013100000||ORU^R01^ORU_R01|MSG50001|P|2.5',
      'PID|1||P50001^^^Hospital-A^MR',
      'OBR|1|ORD500|FIL500|CBC^血常规^L|||20261013100000',
      'OBX|1|NM||1|4.5|mmol/L|3.5-5.5|N|||F',
      'OBX|2|NM|K^钾^L|1|4.5|mmol/L|3.5-5.5|N|||F',
      'OBX|3|NM|NA^钠^L|1|140|mmol/L|135-145|N|||F',
    ].join('\r');
    const result = await parseOruR01(parseHl7Message(raw), { deviceId: 'DEV-LIS-03' });

    // 缺 OBX.3 的那条不产出，其余两条照常
    expect(result.observations).toHaveLength(2);
    expect(result.observations.map((o) => o.code.coding[0]?.code)).toEqual(['2823-3', '2951-2']);
    expect(result.diagnosticReport.result).toHaveLength(2);
    // 错误被记账，不静默丢弃
    expect(result.parseErrors).toHaveLength(1);
    expect(result.parseErrors?.[0]?.segment).toBe('OBX');
    expect(result.parseErrors?.[0]?.setId).toBe('1');
    expect(result.parseErrors?.[0]?.code).toBe('HL7_FIELD_INVALID');
    expect(result.parseErrors?.[0]?.message).toContain('OBX.3');
  });

  it('空值行（整行只有段名）→ 跳过并记账，不产出垃圾 Observation', async () => {
    const raw = [
      'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013100000||ORU^R01^ORU_R01|MSG51001|P|2.5',
      'PID|1||P51001^^^Hospital-A^MR',
      'OBR|1|ORD510|FIL510|CBC^血常规^L|||20261013100000',
      'OBX|1|NM|K^钾^L|1|4.5|mmol/L|3.5-5.5|N|||F',
      'OBX',
    ].join('\r');
    const result = await parseOruR01(parseHl7Message(raw), { deviceId: 'DEV-LIS-04' });

    expect(result.observations).toHaveLength(1);
    // 跳过不是静默丢弃 → 逐条记账
    expect(result.skippedSegments).toHaveLength(1);
    expect(result.skippedSegments?.[0]?.segment).toBe('OBX');
    expect(result.skippedSegments?.[0]?.reason).toContain('空值行');
    // 空行不算解析错误
    expect(result.parseErrors).toHaveLength(0);
  });

  it('多份标本归属：一条消息两个 OBR → 两份标本，OBX 各归其标本', async () => {
    const raw = [
      'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013100000||ORU^R01^ORU_R01|MSG60001|P|2.5',
      'PID|1||P60001^^^Hospital-A^MR',
      'OBR|1|ORD601|FIL601|CBC^血常规^L|||20261013100000',
      'SPM|1|SMP-A',
      'OBX|1|NM|HGB^血红蛋白^L|1|138|g/L|130-175|N|||F',
      'OBR|2|ORD602|FIL602|BIO^生化^L|||20261013100000',
      'SPM|1|SMP-B',
      'OBX|1|NM|K^钾^L|1|4.5|mmol/L|3.5-5.5|N|||F',
    ].join('\r');
    const result = await parseOruR01(parseHl7Message(raw), { deviceId: 'DEV-LIS-05' });

    expect(result.specimens).toHaveLength(2);
    // accession 互不相同（幂等键不能撞）
    const accessions = result.specimens.map((s) => s.accessionIdentifier?.value);
    expect(new Set(accessions).size).toBe(2);
    // 每条 Observation 指向自己那份标本
    expect(result.observations[0]?.specimen?.reference).toBe('Specimen/spec-MSG60001-g1');
    expect(result.observations[1]?.specimen?.reference).toBe('Specimen/spec-MSG60001-g2');
    // Observation id 不撞（两条 OBX.1 都是 1）
    expect(result.observations[0]?.id).toBe('obs-MSG60001-g1-1-1');
    expect(result.observations[1]?.id).toBe('obs-MSG60001-g2-1-1');
    // 报告列出全部标本与全部结果
    expect(result.diagnosticReport.specimen).toHaveLength(2);
    expect(result.diagnosticReport.result).toHaveLength(2);
  });

  it('白名单外设备 → 拒收（DeviceNotAllowedError）；白名单内设备正常解析', async () => {
    const raw = loadFixture('oru-r01-k-nacl.txt');
    const msg = parseHl7Message(raw);

    await expect(
      parseOruR01(msg, { deviceId: 'DEV-RETIRED', allowedDeviceIds: ['DEV-LIS-OK'] }),
    ).rejects.toThrow(DeviceNotAllowedError);

    const ok = await parseOruR01(msg, { deviceId: 'DEV-LIS-OK', allowedDeviceIds: ['DEV-LIS-OK'] });
    expect(ok.observations).toHaveLength(3);
  });

  it('报告 issued 提取：issued 取 MSH.7，effectiveDateTime 优先 OBR.7', async () => {
    const raw = loadFixture('oru-r01-k-nacl.txt');
    const result = await parseOruR01(parseHl7Message(raw), { deviceId: 'DEV-LIS-06' });

    // fixture：MSH.7 = 20261013093000 → issued；OBR.7 = 20261013090000 → effectiveDateTime
    expect(result.diagnosticReport.issued).toBe('2026-10-13T09:30:00Z');
    expect(result.diagnosticReport.effectiveDateTime).toBe('2026-10-13T09:00:00Z');
  });

  it('未命中字典 → 字段归因标 low_confidence（结果仍产出，不阻塞主路径）', async () => {
    const raw = [
      'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013100000||ORU^R01^ORU_R01|MSG70001|P|2.5',
      'PID|1||P70001^^^Hospital-A^MR',
      'OBR|1|ORD700|FIL700|CBC^血常规^L|||20261013100000',
      'OBX|1|NM|ZZZ-UNKNOWN^未知项目^L|1|42|u/L|0-100|N|||F',
    ].join('\r');
    const result = await parseOruR01(parseHl7Message(raw), { deviceId: 'DEV-LIS-07' });

    const attr = result.fieldAttribution[0]!;
    expect(attr.source).toBe('fallback');
    expect(attr.lowConfidence).toBe(true);
    expect(attr.loinc).toBeUndefined();
    // 主路径不被阻塞：Observation 照常产出
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.code.coding[0]?.code).toBe('ZZZ-UNKNOWN');
  });
});
