/**
 * private-bytes —— 厂商私有字节流协议解析器
 *
 * 设计原则：
 * - 用 yaml 描述协议：startTrigger / endTrigger / 字段偏移 + 类型 + 编码
 * - 单条 yaml 对应一台仪器；不通则入 DLQ
 * - 字段提取：偏移 + 长度（字节）；编码（utf-8 / hex / gb18030）影响读出的字符串
 * - 命中失败 / 偏移越界 → 抛 PrivateBytesParseFailError（上层 ByteStreamChannel 入 DLQ）
 *
 * yaml 示例：
 * ```yaml
 * name: example-biochem
 * deviceId: DEV-001
 * startTriggerHex: '02'
 * endTriggerHex: '03'
 * fields:
 *   - name: patientId
 *     offset: 4
 *     length: 8
 *     encoding: utf-8
 *   - name: potassium
 *     offset: 12
 *     length: 6
 *     encoding: utf-8
 * ```
 */

import { Buffer } from 'node:buffer';
import { parse as parseYaml } from 'yaml';
import iconv from 'iconv-lite';
import {
  PrivateBytesParseFailError,
} from '../shared/errors.js';

export type PrivateBytesFieldEncoding = 'utf-8' | 'hex' | 'gb18030' | 'gbk';

export interface PrivateBytesField {
  name: string;
  /** 字段在帧内的字节偏移（从 startTrigger 起算） */
  offset: number;
  /** 字段长度（字节） */
  length: number;
  /** 编码（默认 utf-8） */
  encoding?: PrivateBytesFieldEncoding;
}

export interface PrivateBytesConfig {
  name: string;
  deviceId: string;
  /** 起始字节（字节值 0-255 或十六进制字符串 "0x02"） */
  startTrigger: number;
  /** 结束字节 */
  endTrigger: number;
  fields: PrivateBytesField[];
}

export interface PrivateBytesParseResult {
  configName: string;
  deviceId: string;
  fields: Record<string, string>;
  /** 提取成功的字段数（用于观测字段归因命中率） */
  extractedCount: number;
  /** 总声明字段数 */
  declaredCount: number;
  /** 原始字节 hex（便于审计） */
  rawHex: string;
}

export interface PrivateBytesYamlInput {
  name: string;
  deviceId: string;
  startTriggerHex: string;
  endTriggerHex: string;
  fields: PrivateBytesField[];
}

/** 把 '0x02' / '02' / '2' 解析成 0-255 的整数 */
export function parseHexByte(value: string): number {
  const trimmed = value.trim().toLowerCase().replace(/^0x/, '');
  const n = parseInt(trimmed, 16);
  if (Number.isNaN(n) || n < 0 || n > 255) {
    throw new PrivateBytesParseFailError(
      `startTrigger/endTrigger 必须为 0x00–0xFF 之间的字节`,
      { value },
    );
  }
  return n;
}

/** 把 hex 字符串解析成 Buffer（默认 utf-8 即把整个串当成字节序列） */
export function decodeField(
  buf: Buffer,
  encoding: PrivateBytesFieldEncoding = 'utf-8',
): string {
  switch (encoding) {
    case 'utf-8':
      return buf.toString('utf-8');
    case 'hex':
      return buf.toString('hex');
    case 'gbk':
    case 'gb18030': {
      // 国内厂商仪器大量用 GBK / GB18030 发检验项目名。
      // 解码失败不抛错（上游会把整帧送 DLQ），退化为 UTF-8 尽力而为。
      try {
        return iconv.decode(buf, encoding);
      } catch {
        return buf.toString('utf-8');
      }
    }
  }
}

/**
 * 从 yaml 描述构造运行时配置（hex → byte）
 */
export function buildPrivateBytesConfig(yaml: PrivateBytesYamlInput): PrivateBytesConfig {
  if (!yaml.name || !yaml.deviceId) {
    throw new PrivateBytesParseFailError(
      '私有协议 yaml 必须声明 name 与 deviceId',
      { name: yaml.name, deviceId: yaml.deviceId },
    );
  }
  // 注：yaml 装载路径已由 channel-loader 的 zod schema 保证 fields 非空
  // （z.array(PrivateFieldSchema).min(1)）；这里只校验字段自身的合法性。
  if (!Array.isArray(yaml.fields)) {
    throw new PrivateBytesParseFailError('私有协议 yaml 缺少 fields 数组', { name: yaml.name });
  }
  for (const field of yaml.fields) {
    if (!field.name) {
      throw new PrivateBytesParseFailError('私有协议字段缺 name', { name: yaml.name });
    }
    if (!Number.isInteger(field.offset) || field.offset < 0) {
      throw new PrivateBytesParseFailError(
        `私有协议字段 ${field.name} 的 offset 必须是非负整数`,
        { name: yaml.name, field: field.name, offset: field.offset },
      );
    }
    if (!Number.isInteger(field.length) || field.length < 0) {
      throw new PrivateBytesParseFailError(
        `私有协议字段 ${field.name} 的 length 必须是非负整数`,
        { name: yaml.name, field: field.name, length: field.length },
      );
    }
  }
  return {
    name: yaml.name,
    deviceId: yaml.deviceId,
    startTrigger: parseHexByte(yaml.startTriggerHex),
    endTrigger: parseHexByte(yaml.endTriggerHex),
    fields: yaml.fields,
  };
}

/**
 * 解析私有协议 yaml —— 「字节模板 + 触发串 + 字段偏移」的现场描述文件。
 *
 * 现场模板举例：
 * ```yaml
 * name: example-biochem
 * deviceId: DEV-001
 * startTriggerHex: '02'
 * endTriggerHex: '03'
 * fields:
 *   - name: patientId
 *     offset: 4
 *     length: 8
 *     encoding: utf-8
 * ```
 */
export function parsePrivateBytesYaml(
  raw: string,
  fileName = 'private.yaml',
): PrivateBytesYamlInput {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new PrivateBytesParseFailError(
      `私有协议 yaml 语法错误：${(err as Error)?.message ?? String(err)}`,
      { file: fileName },
      err,
    );
  }
  if (!doc || typeof doc !== 'object') {
    throw new PrivateBytesParseFailError('私有协议 yaml 内容为空或不是对象', { file: fileName });
  }
  const obj = doc as Record<string, unknown>;
  const missing = ['name', 'deviceId', 'startTriggerHex', 'endTriggerHex'].filter(
    (k) => typeof obj[k] !== 'string' || (obj[k] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new PrivateBytesParseFailError(
      `私有协议 yaml 缺少必填项：${missing.join('、')}`,
      { file: fileName, fields: missing },
    );
  }
  if (!Array.isArray(obj.fields)) {
    throw new PrivateBytesParseFailError('私有协议 yaml 缺少 fields 数组', {
      file: fileName,
      fields: ['fields'],
    });
  }
  return {
    name: obj.name as string,
    deviceId: obj.deviceId as string,
    startTriggerHex: obj.startTriggerHex as string,
    endTriggerHex: obj.endTriggerHex as string,
    fields: obj.fields as PrivateBytesField[],
  };
}

/**
 * PrivateBytesParser —— 解析一段已切好帧的原始字节
 * 帧结构：[startTrigger] [fields ...] [endTrigger]
 */
export class PrivateBytesParser {
  constructor(private readonly config: PrivateBytesConfig) {}

  parse(raw: Buffer): PrivateBytesParseResult {
    if (raw.length < 2) {
      throw new PrivateBytesParseFailError(
        '私有协议帧字节数过少',
        { name: this.config.name, length: raw.length },
      );
    }
    if (raw[0] !== this.config.startTrigger) {
      throw new PrivateBytesParseFailError(
        '私有协议帧首字节与 startTrigger 不一致',
        { name: this.config.name, start: this.config.startTrigger, got: raw[0] },
      );
    }
    if (raw[raw.length - 1] !== this.config.endTrigger) {
      throw new PrivateBytesParseFailError(
        '私有协议帧末字节与 endTrigger 不一致',
        { name: this.config.name, end: this.config.endTrigger, got: raw[raw.length - 1] },
      );
    }

    const out: Record<string, string> = {};
    let extractedCount = 0;
    for (const field of this.config.fields) {
      const start = 1 + field.offset; // 跳过 startTrigger
      const end = start + field.length;
      if (start < 0 || end > raw.length - 1) {
        // 偏移越界 → 字段留空，不抛错（让解析继续；上层可观测到 declaredCount > extractedCount）
        out[field.name] = '';
        continue;
      }
      const slice = raw.subarray(start, end);
      out[field.name] = decodeField(slice, field.encoding ?? 'utf-8').trim();
      extractedCount++;
    }

    return {
      configName: this.config.name,
      deviceId: this.config.deviceId,
      fields: out,
      extractedCount,
      declaredCount: this.config.fields.length,
      rawHex: raw.toString('hex'),
    };
  }
}
