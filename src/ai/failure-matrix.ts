/**
 * 模型四类失败的语义矩阵 —— 错误码 → 降级动作 → 审计 outcome。
 * 单一事实来源：ModelGateway、测试、docs/architecture.md 都引用本表，避免口径漂移。
 */

export type FailureKind = 'timeout' | 'http_5xx' | 'unparsable' | 'schema_mismatch';

export interface FailureSemantics {
  kind: FailureKind;
  errorCode: string;
  fallbackAction: string;
  auditOutcome: string;
  description: string;
}

export const FAILURE_MATRIX: Record<FailureKind, FailureSemantics> = {
  timeout: {
    kind: 'timeout',
    errorCode: 'MODEL_TIMEOUT',
    fallbackAction: 'rules_fallback',
    auditOutcome: 'fallback',
    description: 'AbortController 超时：不重试，立即降级到值班表规则，候选标 low_confidence',
  },
  http_5xx: {
    kind: 'http_5xx',
    errorCode: 'MODEL_HTTP_5XX',
    fallbackAction: 'rules_fallback',
    auditOutcome: 'fallback',
    description: '模型服务 5xx / 网络不可达：降级到规则，审计记 fallback',
  },
  unparsable: {
    kind: 'unparsable',
    errorCode: 'MODEL_UNPARSABLE',
    fallbackAction: 'rules_fallback',
    auditOutcome: 'fallback',
    description: 'choices[0].message.content 不是合法 JSON：降级到规则',
  },
  schema_mismatch: {
    kind: 'schema_mismatch',
    errorCode: 'MODEL_SCHEMA_INVALID',
    fallbackAction: 'rules_fallback',
    auditOutcome: 'fallback',
    description: '结构化字段缺失 / 类型不符：降级到规则，不把 undefined 扩散给业务层',
  },
};

export const FAILURE_KINDS = Object.keys(FAILURE_MATRIX) as FailureKind[];

/** 业务侧统一降级结果标记 */
export const FALLBACK_AUDIT_OUTCOME = 'fallback';
export const PARTIAL_AUDIT_OUTCOME = 'partial';
export const SUCCESS_AUDIT_OUTCOME = 'success';

/** 四类失败全部映射到 low_confidence 规则候选 */
export function semanticsFor(kind: FailureKind): FailureSemantics {
  return FAILURE_MATRIX[kind];
}
