/**
 * channel-loader —— 加载 channels/*.yaml + zod schema 校验 + 装配对应 channel
 *
 * 设计原则：
 * - yaml schema 用 zod 校验（缺字段 / 类型错 → ChannelConfigError，报错带字段名）
 * - 三种通道类型：hl7 / bytestream / private（private 走字节流解析配置）
 * - loadAllChannels(dir)：扫描目录逐份装配
 * - **单条非法配置只报错、不阻塞其余通道** —— 现场改 yaml 时一台配错
 *   不该把其余仪器全停了；失败项逐条列出（文件 + 字段名）交给 onError
 * - 需要「任一失败即失败」时传 strict:true，抛汇总 ChannelConfigError
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ChannelConfigError, wrapError } from '../shared/errors.js';
import { Hl7Server } from './Hl7Server.js';
import { type DLQ } from './DLQ.js';
import { ByteStreamChannel } from './ByteStreamChannel.js';
import { SerialPortChannel } from './SerialPortChannel.js';
import { parseHexByte, buildPrivateBytesConfig } from './private-bytes.js';
import type { ByteStreamConfig } from './bytestream.js';

/* ----- zod schemas ----- */

const PrivateFieldSchema = z.object({
  name: z.string().min(1),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  encoding: z.enum(['utf-8', 'hex', 'gbk', 'gb18030']).optional(),
});

const AutoRespondSchema = z.object({
  patternHex: z.string().min(1),
  responseHex: z.string().min(1),
});

const BaseChannelSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** 默认 HL7 v2 MLLP 端口 */
  deviceListenPort: z.number().int().nonnegative().optional(),
  /** 通道编码 */
  encoding: z.enum(['utf-8', 'gbk', 'gb18030']).optional(),
});

const Hl7YamlSchema = BaseChannelSchema.extend({
  type: z.literal('hl7'),
  deviceListenPort: z.number().int().nonnegative(),
});

const ByteStreamYamlSchema = BaseChannelSchema.extend({
  type: z.literal('bytestream'),
  /** 串口路径（/dev/ttyUSB0） */
  serialPort: z.string().optional(),
  baudRate: z.number().int().positive().optional(),
  /** 主机 / 端口（TCP 模式，例如远程 ASTM 网关） */
  host: z.string().optional(),
  listenPort: z.number().int().nonnegative().optional(),
  startCharHex: z.string().optional(),
  endCharHex: z.string().optional(),
  autoRespond: z.array(AutoRespondSchema).optional(),
  stripSequences: z.array(z.string()).optional(),
  stripControlChars: z.boolean().optional(),
  keepControlChars: z.array(z.number().int().min(0).max(255)).optional(),
  bodyEncoding: z.enum(['hex', 'utf-8']).optional(),
});

const PrivateYamlSchema = BaseChannelSchema.extend({
  type: z.literal('private'),
  serialPort: z.string().optional(),
  baudRate: z.number().int().positive().optional(),
  host: z.string().optional(),
  listenPort: z.number().int().nonnegative().optional(),
  deviceId: z.string().min(1),
  startTriggerHex: z.string().min(1),
  endTriggerHex: z.string().min(1),
  fields: z.array(PrivateFieldSchema).min(1),
});

const ChannelYamlSchema = z.discriminatedUnion('type', [
  Hl7YamlSchema,
  ByteStreamYamlSchema,
  PrivateYamlSchema,
]);

export type Hl7YamlConfig = z.infer<typeof Hl7YamlSchema>;
export type ByteStreamYamlConfig = z.infer<typeof ByteStreamYamlSchema>;
export type PrivateYamlConfig = z.infer<typeof PrivateYamlSchema>;
export type ChannelYamlConfig = z.infer<typeof ChannelYamlSchema>;

/* ----- loader ----- */

export interface LoadOptions {
  /** 已读入的 yaml 文件（测试可注入） */
  rawYaml?: string;
  /** 文件名（用于错误消息） */
  fileName?: string;
}

export interface LoadedChannel {
  yaml: ChannelYamlConfig;
  /** 启动后的运行实例（hl7 bytestream serial private）或 private 解析器（不启 socket） */
  instance: Hl7Server | ByteStreamChannel | SerialPortChannel | PrivateChannelHandle | null;
}

export interface PrivateChannelHandle {
  yaml: PrivateYamlConfig;
  /** yaml 解析后的私有协议配置 —— 后续接 bytestream / serial 时直接喂给 parser */
  privateConfig: ReturnType<typeof buildPrivateBytesConfig>;
}

/** 单条配置加载失败的结构化描述 —— 逐条报错，列出具体字段名 */
export interface ChannelLoadError {
  /** 出错的文件名 */
  file: string;
  /** 错误码（统一为 CHANNEL_CONFIG_ERROR） */
  code: string;
  /** 错误摘要（中文） */
  message: string;
  /** 出错的字段路径列表（如 ['deviceListenPort']、['type']） */
  fields: string[];
}

export interface LoadChannelsOptions {
  /** 每条通道加载成功后回调 */
  onChannel?: (ch: LoadedChannel) => void;
  /** 每条配置加载失败后回调（逐条报错，不阻塞其余通道） */
  onError?: (err: ChannelLoadError) => void;
  /**
   * 严格模式：任一文件失败即抛汇总 ChannelConfigError。
   * 默认 false —— 单条非法配置只报错，不阻塞其余通道（现场改 yaml 的常态）。
   */
  strict?: boolean;
  /**
   * 共享死信队列实例 —— 所有通道的解析失败都进这一份 DLQ，
   * 面板与运维查的是同一张表（默认走 getDLQ() 全局单例）。
   */
  dlq?: DLQ;
}

export interface LoadChannelsResult {
  /** 成功加载的通道 */
  channels: LoadedChannel[];
  /** 加载失败的配置（逐条，含字段名） */
  errors: ChannelLoadError[];
}


/**
 * 加载单个 yaml 文件（字符串）。
 * schema 校验失败抛 ChannelConfigError（含失败字段路径）
 */
export function loadChannelYaml(input: string | LoadOptions): ChannelYamlConfig {
  const raw = typeof input === 'string' ? input : input.rawYaml ?? '';
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new ChannelConfigError(
      'yaml 解析失败',
      { fileName: typeof input === 'object' ? input.fileName : undefined },
      err,
    );
  }
  const result = ChannelYamlSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ChannelConfigError(
      `yaml schema 校验失败：${issue?.path?.join('.') ?? '?'} - ${issue?.message ?? 'unknown'}`,
      {
        fileName: typeof input === 'object' ? input.fileName : undefined,
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    );
  }
  return result.data;
}

/**
 * HL7 yaml → Hl7Server（不启动；调用方决定何时 start）
 * dlq：共享死信队列实例（不传则走 getDLQ() 全局单例）
 */
export function buildHl7Server(yaml: Hl7YamlConfig, dlq?: DLQ): Hl7Server {
  return new Hl7Server(yaml.name, {
    encoding: yaml.encoding ?? 'utf-8',
    ...(dlq ? { dlq } : {}),
  });
}

/**
 * ByteStream yaml → ByteStreamConfig（与 ByteStreamChannel 组装时用）
 * 默认走 TCP 模式（host + listenPort）；若给 serialPort 则改走 serialport
 */
export function buildByteStreamConfig(yaml: ByteStreamYamlConfig): ByteStreamConfig {
  const startChar = yaml.startCharHex ? parseHexByte(yaml.startCharHex) : -1;
  const endChar = yaml.endCharHex ? parseHexByte(yaml.endCharHex) : -1;
  if (startChar === -1 || endChar === -1) {
    throw new ChannelConfigError(
      'bytestream yaml 必须同时声明 startCharHex + endCharHex',
      { name: yaml.name, startChar, endChar },
    );
  }
  const autoRespond = (yaml.autoRespond ?? []).map((r) => ({
    patternHex: r.patternHex,
    responseHex: r.responseHex,
  }));
  return {
    startChar,
    endChar,
    autoRespond: (autoRespond ?? []).flatMap((rule) => {
      try {
        const pattern = Buffer.from(rule.patternHex.replace(/^0x/, ''), 'hex');
        const response = Buffer.from(rule.responseHex.replace(/^0x/, ''), 'hex');
        if (pattern.length === 0 || response.length === 0) return [];
        return [{ pattern, response }];
      } catch {
        return [];
      }
    }),
    stripSequences: (yaml.stripSequences ?? []).map((s) => {
      try {
        return Buffer.from(s.replace(/^0x/, ''), 'hex');
      } catch {
        return Buffer.alloc(0);
      }
    }),
    stripControlChars: yaml.stripControlChars ?? false,
    keepControlChars: yaml.keepControlChars ?? [],
    bodyEncoding: yaml.bodyEncoding ?? 'hex',
    ignoreResponse: false,
  };
}

/** Private yaml → PrivateChannelHandle（仅构造配置，不启 socket） */
export function buildPrivateChannelHandle(yaml: PrivateYamlConfig): PrivateChannelHandle {
  const pc = buildPrivateBytesConfig({
    name: yaml.name,
    deviceId: yaml.deviceId,
    startTriggerHex: yaml.startTriggerHex,
    endTriggerHex: yaml.endTriggerHex,
    fields: yaml.fields,
  });
  return { yaml, privateConfig: pc };
}

/**
 * 加载目录所有 *.yaml 文件并装配对应 channel。
 *
 * 关键行为：**单条非法配置只报错，不阻塞其余通道**。
 * 每条失败都带字段名（ChannelLoadError.fields），逐条交给 onError 上报；
 * 默认不抛异常（现场改 yaml 时一台配错不该把其余仪器全停了）。
 * 需要「任一失败即失败」的严格场景传 `strict: true`，会抛汇总 ChannelConfigError。
 */
export async function loadAllChannelsWithReport(
  dir: string,
  opts: LoadChannelsOptions = {},
): Promise<LoadChannelsResult> {
  // dictionary-*.yaml（T19 检验项目字典）与 critical-thresholds.yaml（T23 阈值表）
  // 都是业务配置而非通道配置，扫描通道时跳过
  const files = readdirSync(dir).filter(
    (f) => (f.endsWith('.yaml') || f.endsWith('.yml'))
      && !f.startsWith('dictionary-')
      && !f.startsWith('critical-thresholds')
      && !f.startsWith('oncall-'),
  );
  const channels: LoadedChannel[] = [];
  const errors: ChannelLoadError[] = [];

  const record = (file: string, err: unknown): void => {
    const detail = toLoadError(file, err);
    errors.push(detail);
    if (opts.onError) opts.onError(detail);
  };

  for (const file of files) {
    const filePath = join(dir, file);
    let yaml: ChannelYamlConfig;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      yaml = loadChannelYaml({ rawYaml: raw, fileName: basename(filePath) });
    } catch (err) {
      record(file, err);
      continue;
    }

    let instance: LoadedChannel['instance'] = null;
    try {
      switch (yaml.type) {
        case 'hl7': {
          instance = buildHl7Server(yaml, opts.dlq);
          break;
        }
        case 'bytestream': {
          const cfg = buildByteStreamConfig(yaml);
          const ch = new ByteStreamChannel(yaml.name, {
            encoding: yaml.encoding ?? 'utf-8',
            initialConfig: cfg,
            ...(opts.dlq ? { dlq: opts.dlq } : {}),
          });
          // 若 yaml 给了 serialPort，启动时用 serialport；否则走 TCP
          if (yaml.serialPort) {
            instance = new SerialPortChannel(yaml.name, cfg, {
              path: yaml.serialPort,
              baudRate: yaml.baudRate ?? 9600,
              encoding: yaml.encoding ?? 'utf-8',
            });
          } else if (yaml.host && yaml.listenPort !== undefined) {
            // TCP 模式的 host + listenPort 无法直接被 ByteStreamChannel 监听（它是 server-only）
            // 这里仅生成句柄，让调用方负责启动
            instance = ch;
          } else {
            record(
              file,
              new ChannelConfigError(
                'bytestream yaml 必须声明 serialPort 或 host + listenPort',
                { name: yaml.name, issues: [{ path: 'serialPort', message: '必填' }] },
              ),
            );
            continue;
          }
          break;
        }
        case 'private': {
          instance = buildPrivateChannelHandle(yaml);
          break;
        }
      }
    } catch (err) {
      record(file, err);
      continue;
    }

    const lc: LoadedChannel = { yaml, instance };
    channels.push(lc);
    if (opts.onChannel) opts.onChannel(lc);
  }

  if (opts.strict && errors.length > 0) {
    throw new ChannelConfigError(
      `加载 channels 时 ${errors.length} 个文件失败`,
      { errors: errors.map((e) => ({ file: e.file, msg: e.message, fields: e.fields })) },
    );
  }

  return { channels, errors };
}

/**
 * 加载目录所有 *.yaml 文件（便捷入口）。
 * 返回成功装配的通道；失败项通过 onError 逐条上报。
 */
export async function loadAllChannels(
  dir: string,
  opts: LoadChannelsOptions | ((ch: LoadedChannel) => void) = {},
): Promise<LoadedChannel[]> {
  const normalized: LoadChannelsOptions =
    typeof opts === 'function' ? { onChannel: opts } : opts;
  const result = await loadAllChannelsWithReport(dir, normalized);
  return result.channels;
}

/** 异常 → ChannelLoadError（尽量带出具体字段名） */
function toLoadError(file: string, err: unknown): ChannelLoadError {
  const context = (err as { context?: Record<string, unknown> }).context ?? {};
  const issues = Array.isArray(context.issues)
    ? (context.issues as Array<{ path?: string; message?: string }>)
    : [];
  const fields = issues
    .map((i) => (i?.path ? String(i.path) : ''))
    .filter((p) => p.length > 0);
  const code = typeof context.code === 'string' ? context.code : 'CHANNEL_CONFIG_ERROR';
  return {
    file,
    code,
    message: (err as Error)?.message ?? String(err),
    fields: fields.length > 0 ? fields : ['<yaml>'],
  };
}


/** Schema 直接导出供测试使用 */
export const schemas = {
  ChannelYamlSchema,
  Hl7YamlSchema,
  ByteStreamYamlSchema,
  PrivateYamlSchema,
};

export { wrapError as _wrapErrorInternal };
