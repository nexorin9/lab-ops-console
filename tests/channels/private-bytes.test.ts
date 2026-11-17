/**
 * 厂商私有字节流协议解析测试
 *
 * 覆盖：
 * ① yaml 描述解析（字节模板 + 触发串 + 字段偏移）
 * ② 字段偏移提取正确
 * ③ 偏移越界 → 字段留空但整帧不丢（extractedCount < declaredCount 可见）
 * ④ 首/末触发字节不匹配 → 抛 PrivateBytesParseFailError
 * ⑤ GBK 字段解码正确（国内厂商仪器常见编码）
 * ⑥ yaml 缺必填项 / 字段非法 → 报错且指出缺哪项
 */

import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import iconv from 'iconv-lite';
import {
  PrivateBytesParser,
  buildPrivateBytesConfig,
  parsePrivateBytesYaml,
  parseHexByte,
} from '../../src/channels/private-bytes.js';
import { PrivateBytesParseFailError } from '../../src/shared/errors.js';

const YAML_TPL = `name: example-biochem
deviceId: DEV-PRIVATE-01
startTriggerHex: '02'
endTriggerHex: '03'
fields:
  - name: patientId
    offset: 0
    length: 8
    encoding: utf-8
  - name: potassium
    offset: 8
    length: 5
    encoding: utf-8
  - name: sodium
    offset: 13
    length: 5
    encoding: utf-8
`;

/**
 * 构造一帧：[0x02] + 8 位患者号 + 5 位钾值 + 5 位钠值 + [0x03]
 * 字段偏移与 channels/example-private-biochem.yaml 现场模板一致。
 */
function buildFrame(patientId: string, potassium: string, sodium: string): Buffer {
  const body = Buffer.concat([
    Buffer.from(patientId.padEnd(8, ' '), 'utf-8'),
    Buffer.from(potassium.padEnd(5, ' '), 'utf-8'),
    Buffer.from(sodium.padEnd(5, ' '), 'utf-8'),
  ]);
  return Buffer.concat([Buffer.from([0x02]), body, Buffer.from([0x03])]);
}

describe('channels/private-bytes', () => {
  it('yaml 描述解析：字段偏移与触发串读得出来', () => {
    const yaml = parsePrivateBytesYaml(YAML_TPL, 'example-private-biochem.yaml');
    expect(yaml.name).toBe('example-biochem');
    expect(yaml.deviceId).toBe('DEV-PRIVATE-01');
    expect(yaml.fields).toHaveLength(3);

    const cfg = buildPrivateBytesConfig(yaml);
    expect(cfg.startTrigger).toBe(0x02);
    expect(cfg.endTrigger).toBe(0x03);
    expect(cfg.fields[0]).toEqual({ name: 'patientId', offset: 0, length: 8, encoding: 'utf-8' });
  });

  it('字段偏移提取：按 yaml 描述的 offset + length 取出字段值', () => {
    const cfg = buildPrivateBytesConfig(parsePrivateBytesYaml(YAML_TPL));
    const parser = new PrivateBytesParser(cfg);

    const result = parser.parse(buildFrame('P12345', '6.8', '142'));

    expect(result.deviceId).toBe('DEV-PRIVATE-01');
    expect(result.fields.patientId).toBe('P12345');
    expect(result.fields.potassium).toBe('6.8');
    expect(result.fields.sodium).toBe('142');
    expect(result.extractedCount).toBe(3);
    expect(result.declaredCount).toBe(3);
    // 原始字节留痕（便于审计与 DLQ 回放）
    expect(result.rawHex.startsWith('02')).toBe(true);
    expect(result.rawHex.endsWith('03')).toBe(true);
  });

  it('偏移越界 → 字段留空但整帧不丢，缺口可见', () => {
    const cfg = buildPrivateBytesConfig(parsePrivateBytesYaml(YAML_TPL));
    const parser = new PrivateBytesParser(cfg);

    // 只有半个帧 → 钾值字段越界
    const short = Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from('P12345  ', 'utf-8'),
      Buffer.from('6.8', 'utf-8'),
      Buffer.from([0x03]),
    ]);
    const result = parser.parse(short);

    expect(result.fields.patientId).toBe('P12345');
    expect(result.fields.potassium).toBe('');
    expect(result.extractedCount).toBe(1);
    expect(result.declaredCount).toBe(3);
  });

  it('首/末触发字节不匹配 → 抛 PrivateBytesParseFailError', () => {
    const cfg = buildPrivateBytesConfig(parsePrivateBytesYaml(YAML_TPL));
    const parser = new PrivateBytesParser(cfg);

    expect(() => parser.parse(Buffer.from([0x09, 0x41, 0x03]))).toThrow(PrivateBytesParseFailError);
    expect(() => parser.parse(Buffer.from([0x02, 0x41, 0x09]))).toThrow(PrivateBytesParseFailError);
    expect(() => parser.parse(Buffer.from([0x02]))).toThrow(PrivateBytesParseFailError);
  });

  it('GBK 字段解码正确（国内厂商仪器常见编码）', () => {
    const yaml = parsePrivateBytesYaml(
      `name: gbk-private
deviceId: DEV-PRIVATE-GBK
startTriggerHex: '02'
endTriggerHex: '03'
fields:
  - name: testName
    offset: 0
    length: 4
    encoding: gbk
`,
    );
    const parser = new PrivateBytesParser(buildPrivateBytesConfig(yaml));

    // 帧体里的中文检验项目名用 GBK 编码（4 字节：钾 + 空格 + 空格 + 空格）
    const gbkBytes = iconv.encode('钾   ', 'gbk');
    const frame = Buffer.concat([Buffer.from([0x02]), gbkBytes, Buffer.from([0x03])]);

    const result = parser.parse(frame);

    expect(result.fields.testName).toBe('钾');
    // 同一串字节按 UTF-8 解会乱码 —— 说明编码字段真的生效
    expect(iconv.encode('钾   ', 'gbk').toString('utf-8')).not.toBe('钾');
  });

  it('yaml 缺必填项 / 字段非法 → 报错并指出缺哪项', () => {
    expect(() => parsePrivateBytesYaml('deviceId: X\nfields: []\n', 'bad.yaml')).toThrow(
      PrivateBytesParseFailError,
    );
    expect(() => parsePrivateBytesYaml('name: X\n', 'bad.yaml')).toThrow(/缺少必填项/);

    // offset 非法 → 构造配置时报错
    const bad = parsePrivateBytesYaml(
      `name: X
deviceId: D
startTriggerHex: '02'
endTriggerHex: '03'
fields:
  - name: f1
    offset: -1
    length: 4
`,
      'bad.yaml',
    );
    expect(() => buildPrivateBytesConfig(bad)).toThrow(/offset/);
  });

  it('parseHexByte 接受 0x 前缀与裸十六进制，非法值报错', () => {
    expect(parseHexByte('0x02')).toBe(2);
    expect(parseHexByte('1c')).toBe(0x1c);
    expect(() => parseHexByte('zz')).toThrow(PrivateBytesParseFailError);
  });
});
