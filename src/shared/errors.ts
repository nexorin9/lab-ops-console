/**
 * 结构化错误体系 —— 14 类错误码 + ErrorCode 枚举
 *
 * 设计原则：
 * - 每条错误都有唯一 code（字符串枚举），便于上层精确处理 / 监控告警 / 飞检审计
 * - 全部继承 BaseError，保留 cause 链 + context 字段
 * - 可序列化：toJSON() 输出稳定字段供日志 / 响应体消费
 */

export const ErrorCode = {
  HL7_PARSE_FAIL: 'HL7_PARSE_FAIL',
  HL7_FRAME_INVALID: 'HL7_FRAME_INVALID',
  HL7_ENCODING_FAIL: 'HL7_ENCODING_FAIL',
  HL7_ACK_UNMATCHED: 'HL7_ACK_UNMATCHED',
  HL7_ACK_TIMEOUT: 'HL7_ACK_TIMEOUT',
  DEVICE_NOT_ALLOWED: 'DEVICE_NOT_ALLOWED',
  ASTM_PARSE_FAIL: 'ASTM_PARSE_FAIL',
  PRIVATE_BYTES_PARSE_FAIL: 'PRIVATE_BYTES_PARSE_FAIL',
  FHIR_WRITE_FAIL: 'FHIR_WRITE_FAIL',
  FHIR_VALIDATION_FAIL: 'FHIR_VALIDATION_FAIL',
  FHIR_SERVER_FAIL: 'FHIR_SERVER_FAIL',
  FHIR_BATCH_PARTIAL_FAIL: 'FHIR_BATCH_PARTIAL_FAIL',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_SCHEMA_INVALID: 'MODEL_SCHEMA_INVALID',
  MODEL_NETWORK_FAIL: 'MODEL_NETWORK_FAIL',
  MODEL_UNAVAILABLE_FALLBACK: 'MODEL_UNAVAILABLE_FALLBACK',
  MODEL_PROMPT_RENDER_FAIL: 'MODEL_PROMPT_RENDER_FAIL',
  DLQ_ENQUEUE: 'DLQ_ENQUEUE',
  TASK_INVALID_TRANSITION: 'TASK_INVALID_TRANSITION',
  AUDIT_FIELD_MISSING: 'AUDIT_FIELD_MISSING',
  AUDIT_DENIED: 'AUDIT_DENIED',
  AUTH_TOKEN_MISSING: 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  ENV_MISSING: 'ENV_MISSING',
  CHANNEL_CONFIG_ERROR: 'CHANNEL_CONFIG_ERROR',
  EXPORT_FIELD_MISSING: 'EXPORT_FIELD_MISSING',
  // —— T16 入站背压 / T17 ASTM 会话 / T18 编码与脏数据 ——
  RATE_LIMITED: 'RATE_LIMITED',
  ASTM_FRAME_SEQUENCE_GAP: 'ASTM_FRAME_SEQUENCE_GAP',
  ASTM_HANDSHAKE_TIMEOUT: 'ASTM_HANDSHAKE_TIMEOUT',
  ENCODING_AMBIGUOUS: 'ENCODING_AMBIGUOUS',
  FIELD_TRUNCATED: 'FIELD_TRUNCATED',
  FIELD_MISSING: 'FIELD_MISSING',
  FRAME_MALFORMED: 'FRAME_MALFORMED',
  // —— T19 字典 / T20 契约 / T21 待上传 / T24 升级 / T28 补推 / T36 部署 ——
  DICTIONARY_INVALID: 'DICTIONARY_INVALID',
  FHIR_CONTRACT_VIOLATION: 'FHIR_CONTRACT_VIOLATION',
  FHIR_OUTBOX_REPLAY_LIMIT: 'FHIR_OUTBOX_REPLAY_LIMIT',
  ESCALATION_TIMEOUT: 'ESCALATION_TIMEOUT',
  PUSH_REDELIVERY_LIMIT: 'PUSH_REDELIVERY_LIMIT',
  CHANNEL_BIND_FAIL: 'CHANNEL_BIND_FAIL',
  FHIR_CREDENTIAL_EXPIRED: 'FHIR_CREDENTIAL_EXPIRED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误上下文 —— 任意可序列化键值 */
export type ErrorContext = Record<string, unknown>;

export interface SerializedError {
  name: string;
  code: ErrorCodeValue;
  message: string;
  context: ErrorContext;
  cause?: string;
  stack?: string;
}

/**
 * 基础结构化错误类。所有自定义错误都继承它。
 * - code: 错误码（来自 ErrorCode 枚举）
 * - context: 任意键值上下文，便于日志检索
 * - cause: 原始错误（如果是包装自其他错误）
 */
export class BaseError extends Error {
  public readonly code: ErrorCodeValue;
  public readonly context: ErrorContext;
  public override readonly cause?: unknown;

  constructor(code: ErrorCodeValue, message: string, context: ErrorContext = {}, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    this.cause = cause;
    // 保留 V8 stack 中原始构造点
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): SerializedError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      cause: this.cause instanceof Error ? this.cause.message : String(this.cause ?? ''),
      stack: this.stack,
    };
  }

  /** 供 pino logger 使用 */
  toLogFields(): Record<string, unknown> {
    return {
      err_name: this.name,
      err_code: this.code,
      err_message: this.message,
      err_context: this.context,
      err_cause: this.cause instanceof Error ? this.cause.message : undefined,
    };
  }
}

// ============= 14 类结构化错误 =============

/** HL7 帧解析失败（VT/FS/CR 缺失、字段分隔错乱等） */
export class Hl7ParseFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.HL7_PARSE_FAIL, message, context, cause);
  }
}

/** HL7 帧不合法（VT/FS 缺失、长度异常） */
export class Hl7FrameInvalidError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.HL7_FRAME_INVALID, message, context, cause);
  }
}

/** HL7 编码失败（iconv-lite 无法转换 GBK 等） */
export class Hl7EncodingFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.HL7_ENCODING_FAIL, message, context, cause);
  }
}

/** ASTM E1394 记录解析失败 */
export class AstmParseFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.ASTM_PARSE_FAIL, message, context, cause);
  }
}

/**
 * 设备不在授权白名单 —— 报文直接拒收。
 * 与解析失败区分开：这类报文重发多少次都不会变好，不该进重试队列。
 */
export class DeviceNotAllowedError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.DEVICE_NOT_ALLOWED, message, context, cause);
  }
}

/** 厂商私有字节流协议解析失败 */
export class PrivateBytesParseFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.PRIVATE_BYTES_PARSE_FAIL, message, context, cause);
  }
}

/** FHIR 资源 POST 失败（网络/服务端 5xx） */
export class FhirWriteFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.FHIR_WRITE_FAIL, message, context, cause);
  }
}

/** FHIR 资源 schema 校验失败（4xx） */
export class FhirValidationFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.FHIR_VALIDATION_FAIL, message, context, cause);
  }
}

/** FHIR 服务端 5xx（指数退避 3 次后入 DLQ） */
export class FhirServerFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.FHIR_SERVER_FAIL, message, context, cause);
  }
}

/** FHIR 批量写部分失败（含成功/失败行计数） */
export class FhirBatchPartialFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.FHIR_BATCH_PARTIAL_FAIL, message, context, cause);
  }
}

/** ModelGateway 调用超时 */
export class ModelTimeoutError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.MODEL_TIMEOUT, message, context, cause);
  }
}

/** ModelGateway 响应结构化校验失败 */
export class ModelSchemaInvalidError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.MODEL_SCHEMA_INVALID, message, context, cause);
  }
}

/** ModelGateway 网络层失败（DNS / TCP / TLS） */
export class ModelNetworkFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.MODEL_NETWORK_FAIL, message, context, cause);
  }
}

/** ModelGateway 不可达，已降级到 rules-fallback（low_confidence） */
export class ModelUnavailableFallbackError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.MODEL_UNAVAILABLE_FALLBACK, message, context, cause);
  }
}

/** ModelGateway prompt 渲染失败（模板占位符缺失等） */
export class ModelPromptRenderFailError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.MODEL_PROMPT_RENDER_FAIL, message, context, cause);
  }
}

/** DLQ 入队失败（SQLite 写盘失败） */
export class DlqEnqueueError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.DLQ_ENQUEUE, message, context, cause);
  }
}

/** Task 状态机非法转换 */
export class TaskInvalidTransitionError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.TASK_INVALID_TRANSITION, message, context, cause);
  }
}

/** AuditEvent 四字段缺失 */
export class AuditFieldMissingError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.AUDIT_FIELD_MISSING, message, context, cause);
  }
}

/** AuditEvent denied 索引命中（飞检倒查入口） */
export class AuditDeniedError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.AUDIT_DENIED, message, context, cause);
  }
}

/** OAuth2 token 缺失（凭据未配置） */
export class AuthTokenMissingError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.AUTH_TOKEN_MISSING, message, context, cause);
  }
}

/** OAuth2 token 过期（401 触发刷新） */
export class AuthTokenExpiredError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.AUTH_TOKEN_EXPIRED, message, context, cause);
  }
}

/** OAuth2 token 无效（非过期 401 / 解析失败） */
export class AuthTokenInvalidError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.AUTH_TOKEN_INVALID, message, context, cause);
  }
}

/** 必填环境变量缺失 */
export class EnvMissingError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.ENV_MISSING, message, context, cause);
  }
}

/** 通道 yaml 配置 schema 校验失败 */
export class ChannelConfigError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.CHANNEL_CONFIG_ERROR, message, context, cause);
  }
}

/** 闭环台账导出字段缺失 */
export class ExportFieldMissingError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.EXPORT_FIELD_MISSING, message, context, cause);
  }
}

/** FHIR R4 资源本地契约校验不通过（拒绝写入，原始资源进 DLQ） */
export class FhirContractViolationError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.FHIR_CONTRACT_VIOLATION, message, context, cause);
  }
}

/** 待上传队列重放超过上限，转人工队列 */
export class FhirOutboxReplayLimitError extends BaseError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super(ErrorCode.FHIR_OUTBOX_REPLAY_LIMIT, message, context, cause);
  }
}

/**
 * 工具：根据 code 找到对应的错误类（用于 catch 块统一处理）
 */
export function isBaseError(err: unknown): err is BaseError {
  return err instanceof BaseError;
}

/**
 * 工具：任意错误 → BaseError（包装非结构化错误）
 */
export function wrapError(err: unknown, fallbackCode: ErrorCodeValue = ErrorCode.FHIR_WRITE_FAIL): BaseError {
  if (isBaseError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BaseError(fallbackCode, message, { original: 'wrapped' }, err);
}

/**
 * 错误码元数据表 —— 飞检/运维/监控的统一口径。
 * 每个错误码都有：分类（category）、严重度（severity）、人读描述（description）。
 * 飞检倒查时按 code 检索，运维告警按 severity 分级，监控面板按 category 聚合。
 */
export type ErrorSeverity = 'fatal' | 'error' | 'warn' | 'info';

export interface ErrorCodeMeta {
  category: string;
  severity: ErrorSeverity;
  description: string;
}

export const ERROR_CODE_TABLE: Record<ErrorCodeValue, ErrorCodeMeta> = {
  HL7_PARSE_FAIL: { category: 'ingest', severity: 'warn', description: 'HL7 帧解析失败（VT/FS/CR 缺失、字段分隔错乱）' },
  HL7_FRAME_INVALID: { category: 'ingest', severity: 'warn', description: 'HL7 帧不合法（长度异常或非法控制字符）' },
  HL7_ENCODING_FAIL: { category: 'ingest', severity: 'warn', description: 'HL7 编码失败（iconv-lite 无法转换 GBK 等）' },
  HL7_ACK_UNMATCHED: { category: 'ingest', severity: 'info', description: '收到无法对应 pending 的 ACK' },
  HL7_ACK_TIMEOUT: { category: 'ingest', severity: 'warn', description: 'sendAndWait 等待 ACK 超时' },
  DEVICE_NOT_ALLOWED: { category: 'ingest', severity: 'warn', description: '设备不在授权白名单，报文直接拒收' },
  ASTM_PARSE_FAIL: { category: 'ingest', severity: 'warn', description: 'ASTM E1394 记录解析失败' },
  PRIVATE_BYTES_PARSE_FAIL: { category: 'ingest', severity: 'warn', description: '厂商私有字节流协议解析失败' },
  FHIR_WRITE_FAIL: { category: 'fhir', severity: 'error', description: 'FHIR 资源写回网络层失败（重试耗尽）' },
  FHIR_VALIDATION_FAIL: { category: 'fhir', severity: 'error', description: 'FHIR 资源 schema 校验失败（4xx，不重试）' },
  FHIR_SERVER_FAIL: { category: 'fhir', severity: 'error', description: 'FHIR 服务端 5xx（指数退避 3 次后入 DLQ）' },
  FHIR_BATCH_PARTIAL_FAIL: { category: 'fhir', severity: 'error', description: 'FHIR 批量写部分失败（含成功/失败行计数）' },
  FHIR_CONTRACT_VIOLATION: { category: 'fhir', severity: 'error', description: 'FHIR R4 本地契约校验不通过，拒绝写入' },
  FHIR_OUTBOX_REPLAY_LIMIT: { category: 'fhir', severity: 'warn', description: '待上传队列重放超过上限，转人工队列' },
  FHIR_CREDENTIAL_EXPIRED: { category: 'fhir', severity: 'error', description: 'FHIR 出站凭据已过期' },
  MODEL_TIMEOUT: { category: 'model', severity: 'warn', description: '模型调用超时，降级到规则兜底' },
  MODEL_SCHEMA_INVALID: { category: 'model', severity: 'warn', description: '模型响应结构化校验失败' },
  MODEL_NETWORK_FAIL: { category: 'model', severity: 'warn', description: '模型网络层失败（DNS/TCP/TLS）' },
  MODEL_UNAVAILABLE_FALLBACK: { category: 'model', severity: 'warn', description: '模型不可达，已降级到规则兜底' },
  MODEL_PROMPT_RENDER_FAIL: { category: 'model', severity: 'warn', description: '模型 prompt 渲染失败（占位符缺失）' },
  DLQ_ENQUEUE: { category: 'infra', severity: 'error', description: '死信入队失败（SQLite 写盘失败）' },
  TASK_INVALID_TRANSITION: { category: 'critical', severity: 'error', description: '危急值 Task 状态机非法转换' },
  AUDIT_FIELD_MISSING: { category: 'audit', severity: 'error', description: 'AuditEvent 四字段缺失（台账强校验）' },
  AUDIT_DENIED: { category: 'audit', severity: 'warn', description: 'AuditEvent denied 索引命中（飞检倒查入口）' },
  AUTH_TOKEN_MISSING: { category: 'auth', severity: 'error', description: 'OAuth2 token 缺失（凭据未配置）' },
  AUTH_TOKEN_EXPIRED: { category: 'auth', severity: 'error', description: 'OAuth2 token 过期（401 触发刷新）' },
  AUTH_TOKEN_INVALID: { category: 'auth', severity: 'error', description: 'OAuth2 token 无效（非过期 401/解析失败）' },
  ENV_MISSING: { category: 'config', severity: 'error', description: '必填环境变量缺失' },
  CHANNEL_CONFIG_ERROR: { category: 'config', severity: 'error', description: '通道 yaml 配置 schema 校验失败' },
  CHANNEL_BIND_FAIL: { category: 'config', severity: 'error', description: '通道绑定失败' },
  EXPORT_FIELD_MISSING: { category: 'export', severity: 'error', description: '闭环台账导出字段缺失' },
  RATE_LIMITED: { category: 'ingest', severity: 'warn', description: '入站限速拒绝（令牌桶耗尽）' },
  ASTM_FRAME_SEQUENCE_GAP: { category: 'ingest', severity: 'warn', description: 'ASTM 会话帧序号缺口' },
  ASTM_HANDSHAKE_TIMEOUT: { category: 'ingest', severity: 'warn', description: 'ASTM 会话握手超时' },
  ENCODING_AMBIGUOUS: { category: 'ingest', severity: 'warn', description: '编码识别歧义（GBK/UTF-8 共存）' },
  FIELD_TRUNCATED: { category: 'ingest', severity: 'warn', description: '字段超长被截断' },
  FIELD_MISSING: { category: 'ingest', severity: 'warn', description: '必填字段缺失' },
  FRAME_MALFORMED: { category: 'ingest', severity: 'warn', description: '整帧字段级脏数据，标记后照常写、原始字节留 DLQ' },
  DICTIONARY_INVALID: { category: 'dictionary', severity: 'warn', description: '检验项目字典条目非法' },
  ESCALATION_TIMEOUT: { category: 'critical', severity: 'error', description: '危急值升级超时（科主任/医务科）' },
  PUSH_REDELIVERY_LIMIT: { category: 'critical', severity: 'warn', description: '通知补推超过上限' },
};

/** 取错误码元数据；未知 code 回退到未知口径（不抛错，便于兼容未来新增） */
export function getErrorCodeMeta(code: ErrorCodeValue | string): ErrorCodeMeta {
  return ERROR_CODE_TABLE[code as ErrorCodeValue]
    ?? { category: 'unknown', severity: 'warn', description: `未知错误码：${code}` };
}

/** 全量错误码（供测试断言错误码表完整性） */
export const ALL_ERROR_CODES: ErrorCodeValue[] = Object.keys(ErrorCode) as ErrorCodeValue[];
