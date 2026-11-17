/**
 * 集中读取所有凭据位 env —— 必填项缺失抛 EnvMissingError（含字段名），
 * 选填项给默认值；返回强类型化配置对象。
 *
 * 设计原则：
 * - 不直接读 process.env（除非调用 readEnv 内部），便于测试注入
 * - 必填项缺失抛结构化错误（含字段名 + 提示）
 * - 选填项给默认值
 * - 配置项命名按子系统分组（DEVICE_*, LIS_FHIR_*, FHIR_*, NOTIFY_*, MODELS_*, SERIAL_*, SHUTDOWN_TIMEOUT_MS, DATA_DIR, LOG_LEVEL）
 */

import { EnvMissingError } from './errors.js';

export interface ModelsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface FhirConfig {
  baseUrl: string;
  token: string;
}

export interface LisFhirConfig {
  baseUrl: string;
  token: string;
}

export interface DeviceConfig {
  listenPort: number;
  encoding: 'utf-8' | 'gbk' | 'gb18030';
}

export interface SerialConfig {
  port: string | null;
  baudRate: number;
}

export interface AppEnv {
  // —— 必填 ——
  device: DeviceConfig;
  lisFhir: LisFhirConfig;
  fhir: FhirConfig;
  models: ModelsConfig;
  // —— 选填 ——
  notifyWebhookUrl: string | null;
  serial: SerialConfig;
  dataDir: string;
  logLevel: string;
  shutdownTimeoutMs: number;
  httpPort: number;
}

const DEFAULT_DEVICE_ENCODING: AppEnv['device']['encoding'] = 'utf-8';
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_DATA_DIR = './data';
const DEFAULT_LOG_LEVEL = 'info';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_MODELS_TIMEOUT_MS = 8_000;
const DEFAULT_BAUD_RATE = 9600;

function readRequired(name: string, errorMessage?: string): string {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') {
    throw new EnvMissingError(
      errorMessage ?? `必填环境变量 ${name} 未设置`, { envName: name },
    );
  }
  return value;
}

function readOptional(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return defaultValue;
  return value;
}

function readOptionalNull(name: string): string | null {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return null;
  return value;
}

function readInt(name: string, defaultValue: number, opts: { required?: boolean } = {}): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') {
    if (opts.required) {
      throw new EnvMissingError(`必填环境变量 ${name} 未设置`, { envName: name });
    }
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new EnvMissingError(`环境变量 ${name} 非整数`, { envName: name, raw });
  }
  return parsed;
}

/**
 * 读取所有 env，返回强类型化 AppEnv。
 * 必填项缺失时抛 EnvMissingError（含字段名）。
 * 可被测试用 process.env 注入覆盖。
 */
export function readEnv(): AppEnv {
  // —— DEVICE ——
  const deviceListenPort = readInt('DEVICE_LISTEN_PORT', 2575, { required: true });
  const deviceEncodingRaw = readOptional('DEVICE_ENCODING', DEFAULT_DEVICE_ENCODING);
  const allowedEncodings: AppEnv['device']['encoding'][] = ['utf-8', 'gbk', 'gb18030'];
  if (!allowedEncodings.includes(deviceEncodingRaw as AppEnv['device']['encoding'])) {
    throw new EnvMissingError(
      `DEVICE_ENCODING 必须是 ${allowedEncodings.join('/')} 之一`, { envName: 'DEVICE_ENCODING', raw: deviceEncodingRaw },
    );
  }
  const device: DeviceConfig = {
    listenPort: deviceListenPort,
    encoding: deviceEncodingRaw as AppEnv['device']['encoding'],
  };

  // —— LIS FHIR ——
  const lisFhir: LisFhirConfig = {
    baseUrl: readRequired('LIS_FHIR_BASE_URL'),
    token: readRequired('LIS_FHIR_TOKEN'),
  };

  // —— FHIR（医院 FHIR 端点，写回与审计目标）——
  const fhir: FhirConfig = {
    baseUrl: readRequired('FHIR_BASE_URL'),
    token: readRequired('FHIR_TOKEN'),
  };

  // —— MODELS（OpenAI-compatible 单一协议）——
  const models: ModelsConfig = {
    baseUrl: readRequired('MODELS_BASE_URL'),
    apiKey: readRequired('MODELS_API_KEY'),
    model: readRequired('MODELS_MODEL'),
    timeoutMs: readInt('MODELS_TIMEOUT_MS', DEFAULT_MODELS_TIMEOUT_MS),
  };

  // —— NOTIFY webhook 兜底 ——
  const notifyWebhookUrl = readOptionalNull('NOTIFY_WEBHOOK_URL');

  // —— SERIAL ——
  const serial: SerialConfig = {
    port: readOptionalNull('SERIAL_PORT'),
    baudRate: readInt('SERIAL_BAUD_RATE', DEFAULT_BAUD_RATE),
  };

  // —— 应用运行时配置 ——
  const httpPort = readInt('HTTP_PORT', DEFAULT_HTTP_PORT);
  const dataDir = readOptional('DATA_DIR', DEFAULT_DATA_DIR);
  const logLevel = readOptional('LOG_LEVEL', DEFAULT_LOG_LEVEL);
  const shutdownTimeoutMs = readInt('SHUTDOWN_TIMEOUT_MS', DEFAULT_SHUTDOWN_TIMEOUT_MS);

  return {
    device,
    lisFhir,
    fhir,
    models,
    notifyWebhookUrl,
    serial,
    dataDir,
    logLevel,
    shutdownTimeoutMs,
    httpPort,
  };
}

/**
 * 工具：注入 env 后调用 readEnv（测试用）
 * 注意：必须保留原值用于测试收尾还原
 */
export function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

/** 列出所有必填项 —— 用于 .env.example 注释生成 */
export const REQUIRED_ENV_KEYS = [
  'DEVICE_LISTEN_PORT',
  'LIS_FHIR_BASE_URL',
  'LIS_FHIR_TOKEN',
  'FHIR_BASE_URL',
  'FHIR_TOKEN',
  'MODELS_BASE_URL',
  'MODELS_API_KEY',
  'MODELS_MODEL',
] as const;

/** 列出所有选填项 —— 用于 .env.example 注释生成 */
export const OPTIONAL_ENV_KEYS = [
  'DEVICE_ENCODING',
  'NOTIFY_WEBHOOK_URL',
  'SERIAL_PORT',
  'SERIAL_BAUD_RATE',
  'HTTP_PORT',
  'DATA_DIR',
  'LOG_LEVEL',
  'SHUTDOWN_TIMEOUT_MS',
  'MODELS_TIMEOUT_MS',
] as const;
