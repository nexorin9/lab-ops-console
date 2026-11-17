/**
 * 两个固定 prompt —— 候选接收人建议 + 字段归因兜底。
 *
 * 责任边界：模型只输出「候选 / 建议」，绝不输出 Task.status 或处置结论；
 * 结构化输出用 zod 校验，字段缺失按失败处理并降级到规则查表。
 */

import { z } from 'zod';

/** 模型输出（snake_case 与 prompt 契约一致，网关内部再映射到统一 Candidate） */
export const RecipientResponseSchema = z.object({
  candidates: z.array(z.object({
    role: z.string().min(1),
    practitioner_id: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
  })).min(1),
});

export const AttributionResponseSchema = z.object({
  candidate_loinc: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type RecipientResponse = z.infer<typeof RecipientResponseSchema>;
export type AttributionResponse = z.infer<typeof AttributionResponseSchema>;

export interface PromptTemplate {
  name: string;
  system: string;
  renderUser(variables: Record<string, string>): string;
}

/** 固定模板：只做候选接收人建议，不推进任何状态 */
export const RECIPIENT_PROMPT: PromptTemplate = {
  name: 'candidate_recipients',
  system: [
    '你是医院危急值通知的辅助排班助手。',
    '只输出候选接收人建议，不输出诊断、治疗建议，也不输出任何任务状态。',
    '严格返回 JSON 对象：{"candidates":[{"role":string,"practitioner_id":string,"confidence":number,"reason":string}]}。',
    'confidence 取 0 到 1 的小数；不确定时给低分，不得编造人员。',
  ].join(' '),
  renderUser: (v) => [
    `病区：${v.ward ?? '未指定'}`,
    `期望角色：${v.role ?? '值班护士'}`,
    `时刻：${v.at ?? new Date().toISOString()}`,
    `检验项：${v.testCode ?? '未指定'}`,
    `严重度：${v.severity ?? 'critical'}`,
    '请给出 1 到 3 位候选接收人及理由。',
  ].join('\n'),
};

/** 固定模板：仪器码 → LOINC 归因兜底 */
export const ATTRIBUTION_PROMPT: PromptTemplate = {
  name: 'field_attribution',
  system: [
    '你是检验项目字典映射助手。',
    '只输出最可能的 LOINC 编码候选与理由，不输出诊断结论。',
    '严格返回 JSON 对象：{"candidate_loinc":string,"confidence":number,"reason":string}。',
    '不确定时给低分并说明，不得编造编码。',
  ].join(' '),
  renderUser: (v) => [
    `仪器原始码：${v.deviceCode ?? ''}`,
    `仪器项目名：${v.deviceDisplay ?? ''}`,
    `单位：${v.unit ?? '未指定'}`,
    '请给出一个 LOINC 编码候选。',
  ].join('\n'),
};

export const PROMPT_TEMPLATES = {
  candidate_recipients: RECIPIENT_PROMPT,
  field_attribution: ATTRIBUTION_PROMPT,
} as const;

/** 渲染模板（缺占位符时留空串，不抛错，由后续结构化校验兜住） */
export function renderPrompt(template: PromptTemplate, variables: Record<string, string>): string {
  return template.renderUser(variables);
}
