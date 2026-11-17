/**
 * pino 结构化 JSON 日志 —— 绑定 requestId / channelId / fhirResourceType / taskId 等上下文字段
 *
 * 设计原则：
 * - stdout 输出 JSON（便于 ELK / Loki / 文件归档）
 * - 字段命名稳定：time / level / msg / component / requestId / channelId / taskId / fhirResourceType
 * - 支持子 logger：createLogger(component) 返回绑定 component 字段的 child
 * - 支持 child() 再绑定：child().withContext({requestId}) 链式绑定请求级字段
 */

import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { redactContext } from './redact.js';

const BASE_LEVEL = process.env.LOG_LEVEL ?? 'info';

const baseOptions: LoggerOptions = {
  level: BASE_LEVEL,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { pid: process.pid },
};

let rootLogger: PinoLogger | null = null;

function getRoot(): PinoLogger {
  if (!rootLogger) rootLogger = pino(baseOptions);
  return rootLogger;
}

/** 用于测试 —— 重置根 logger（test logger.test.ts 用） */
export function _resetRootLogger(): void {
  rootLogger = null;
}

/** 用于测试 —— 注入自定义 logger */
export function _setRootLogger(logger: PinoLogger): void {
  rootLogger = logger;
}

export type LogContext = {
  requestId?: string;
  channelId?: string;
  taskId?: string;
  fhirResourceType?: string;
  fhirResourceId?: string;
  modelName?: string;
  [k: string]: unknown;
};

export interface AppLogger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  fatal(obj: object | string, msg?: string): void;
  child(bindings: LogContext): AppLogger;
  withContext(ctx: LogContext): AppLogger;
}

/**
 * 创建一个绑定 component 的子 logger。
 * component: 模块名（如 'Hl7Server' / 'FhirWriter' / 'critical.state-machine'）
 */
export function createLogger(component: string): AppLogger {
  const root = getRoot().child({ component });
  return wrap(root);
}

/** pino.Logger → AppLogger（保持 chain 性） */
function wrap(p: PinoLogger): AppLogger {
  const redactIfObject = (obj: object | string): object | string =>
    typeof obj === 'object' && obj !== null ? redactContext(obj) : obj;
  return {
    debug: (obj, msg) => p.debug(redactIfObject(obj), msg),
    info: (obj, msg) => p.info(redactIfObject(obj), msg),
    warn: (obj, msg) => p.warn(redactIfObject(obj), msg),
    error: (obj, msg) => p.error(redactIfObject(obj), msg),
    fatal: (obj, msg) => p.fatal(redactIfObject(obj), msg),
    child: (b) => wrap(p.child(b)),
    withContext: (b) => wrap(p.child(b)),
  };
}

/**
 * 标准结构化日志字段 —— 上层业务在写日志时优先用这些 key
 */
export const LogField = {
  REQUEST_ID: 'requestId',
  CHANNEL_ID: 'channelId',
  TASK_ID: 'taskId',
  FHIR_RESOURCE_TYPE: 'fhirResourceType',
  FHIR_RESOURCE_ID: 'fhirResourceId',
  MODEL_NAME: 'modelName',
  DURATION_MS: 'durationMs',
  OUTCOME: 'outcome',
  STRUCTURED_OK: 'structuredOk',
} as const;
