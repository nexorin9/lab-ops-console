/**
 * 模型网关与规则兜底共用的数据结构。
 * 候选接收人无论来自模型还是值班表，都用同一份结构，便于面板合并去重与人工采纳。
 */

/** 统一候选接收人结构（T25 值班表与 T12 模型共用） */
export interface Candidate {
  role: string;
  practitionerId: string;
  confidence: number;
  reason: string;
  source: 'model' | 'rule';
  lowConfidence?: boolean;
}

/** 字段归因候选（仪器码 → LOINC） */
export interface FieldAttribution {
  candidateLoinc: string;
  confidence: number;
  reason: string;
  source: 'model' | 'rule';
  lowConfidence?: boolean;
}

/** 候选接收人查询条件 */
export interface RecipientQuery {
  ward: string;
  role?: string;
  at?: string;
  testCode?: string;
  severity?: string;
}

/** 字段归因查询条件 */
export interface AttributionQuery {
  deviceCode: string;
  deviceDisplay: string;
  unit?: string;
}

/** 确定性规则兜底提供者（T25 的 OncallDirectory 实现此接口） */
export interface FallbackProvider {
  suggestRecipients(query: RecipientQuery): Candidate[];
  attributeField?(query: AttributionQuery): FieldAttribution;
}

/** 网关统一返回：来源可追溯、降级显式标注 */
export interface GatewayResult<T> {
  ok: boolean;
  source: 'model' | 'rule' | 'fallback_rules';
  data: T;
  lowConfidence: boolean;
  errorCode?: string;
  fallbackReason?: string;
  audit: {
    modelId: string;
    promptHash: string;
    responseHash: string;
    latencyMs: number;
    outcome: string;
  };
}

/** 合并模型候选与规则候选，按 practitionerId 去重（模型优先，同人取高置信度） */
export function mergeCandidates(model: Candidate[], rule: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const c of [...rule, ...model]) {
    const key = `${c.role}::${c.practitionerId}`;
    const prev = map.get(key);
    if (!prev || c.confidence > prev.confidence) map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}
