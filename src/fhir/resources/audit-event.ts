/**
 * FHIR R4 AuditEvent 构造器（飞行检查审计链路）
 *
 * field-by-field 对照 FHIR R4 spec：
 * https://hl7.org/fhir/R4/auditevent.html
 *
 * - 四字段 agent / recorded / source / outcome 强制非空（与全局硬约束对齐，飞检倒查入口）
 * - outcome: 0 = success / 4 = minor failure / 8 = serious failure / 12 = major failure
 * - 本项目常用 outcome: 'success' | 'denied' | 'partial' | 'fallback_rules'（与本地约定的字符串映射）
 */

import { z } from 'zod';
import { AuditFieldMissingError } from '../../shared/errors.js';

export const AuditOutcomeCode = ['success', 'denied', 'partial', 'fallback_rules'] as const;
export type AuditOutcome = (typeof AuditOutcomeCode)[number];

export const AuditEventSchema = z.object({
  resourceType: z.literal('AuditEvent'),
  id: z.string().optional(),
  type: z.object({
    system: z.string(),
    code: z.string(),
    display: z.string().optional(),
  }),
  recorded: z.string().min(1, 'recorded 必填'),
  // FHIR R4 AuditEvent.outcome 是封闭值集（0/4/8/12），不是自由字符串
  outcome: z.enum(['0', '4', '8', '12']),
  outcomeDesc: z.string().optional(),
  agent: z.array(z.object({
    type: z.object({
      coding: z.array(z.object({
        system: z.string(),
        code: z.string(),
        display: z.string().optional(),
      })),
    }).optional(),
    who: z.object({ reference: z.string().optional(), display: z.string().optional() }).optional(),
    requestor: z.boolean().optional(),
    role: z.array(z.object({
      coding: z.array(z.object({
        system: z.string(),
        code: z.string(),
        display: z.string().optional(),
      })),
    })).optional(),
  })).min(1, 'agent 必填且至少 1 项'),
  source: z.object({
    site: z.string().optional(),
    observer: z.object({ reference: z.string().optional(), display: z.string().optional() }).optional(),
    type: z.array(z.object({
      coding: z.array(z.object({
        system: z.string(),
        code: z.string(),
        display: z.string().optional(),
      })),
    })).optional(),
  }).refine(
    (s) => !!(s.site && s.site.length > 0) || !!(s.observer && s.observer.reference),
    { message: 'source 必填（site 或 observer.reference 至少一项非空）' },
  ),
  entity: z.array(z.object({
    what: z.object({ reference: z.string() }).optional(),
    type: z.enum(['Organization', 'Practitioner', 'Patient', 'PractitionerRole', 'RelatedPerson', 'SystemObject', 'DocumentReference', 'Other']).optional(),
    role: z.enum(['Patient', 'Location', 'Practitioner', 'Organization', 'System', 'Subscriber', 'Object', 'Other']).optional(),
  })).optional(),
});

export type FhirAuditEvent = z.infer<typeof AuditEventSchema>;

export interface BuildAuditEventInput {
  id?: string;
  typeCode?: string;
  typeSystem?: string;
  typeDisplay?: string;
  agentReference: string;
  agentDisplay?: string;
  /** 记录来源站点（默认 'lab-ops-console'） */
  sourceSite?: string;
  /** 观察者（设备 / 系统）引用 —— 飞检倒查时用来定位「哪台机器记的」 */
  sourceObserverReference?: string;
  sourceObserverDisplay?: string;
  recorded: string;
  outcome: AuditOutcome;
  outcomeDesc?: string;
  entityReference?: string;
  entityType?: 'Patient' | 'Practitioner' | 'DocumentReference' | 'Other';
}

const FHIR_OUTCOME_MAP: Record<AuditOutcome, '0' | '4' | '8' | '12'> = {
  success: '0',
  denied: '8',
  partial: '4',
  fallback_rules: '4',
};

/**
 * buildAuditEvent — 构造 FHIR R4 AuditEvent（强制四字段非空）
 *
 * 四字段 = agent / recorded / source / outcome，任一缺失抛 AuditFieldMissingError：
 * - agent：谁做的（操作人引用）
 * - recorded：什么时候记的（ISO 时间戳）
 * - source：在哪记的（site 或 observer 至少一项）
 * - outcome：结果（success→0 / denied→8 / partial→4）
 *
 * 默认 source.site = 'lab-ops-console'（与产品名一致，便于外部检索）。
 * 注意：entity（被操作的对象）**不能**替代 source —— 两者是不同字段，
 * 早先把 entityReference 当 source 的兜底会让「来源缺失」的记录混进审计链。
 */
export function buildAuditEvent(input: BuildAuditEventInput): FhirAuditEvent {
  if (!input.agentReference) {
    throw new AuditFieldMissingError('AuditEvent.agent 缺失', { field: 'agent' });
  }
  if (!input.recorded) {
    throw new AuditFieldMissingError('AuditEvent.recorded 缺失', { field: 'recorded' });
  }
  if (!input.outcome) {
    throw new AuditFieldMissingError('AuditEvent.outcome 缺失', { field: 'outcome' });
  }
  const site = input.sourceSite?.trim() || 'lab-ops-console';
  const observerRef = input.sourceObserverReference?.trim();
  if (!site && !observerRef) {
    throw new AuditFieldMissingError('AuditEvent.source 缺失', { field: 'source' });
  }
  const evt: FhirAuditEvent = {
    resourceType: 'AuditEvent',
    type: {
      system: input.typeSystem ?? 'http://terminology.hl7.org/CodeSystem/audit-event-type',
      code: input.typeCode ?? 'rest',
      display: input.typeDisplay ?? 'RESTful Operation',
    },
    recorded: input.recorded,
    outcome: FHIR_OUTCOME_MAP[input.outcome],
    outcomeDesc: input.outcomeDesc ?? input.outcome,
    agent: [{
      who: { reference: input.agentReference, display: input.agentDisplay },
      requestor: true,
    }],
    source: {
      site,
    },
  };
  if (observerRef) {
    evt.source.observer = { reference: observerRef, display: input.sourceObserverDisplay };
  }
  if (input.id) evt.id = input.id;
  if (input.entityReference) {
    evt.entity = [{
      what: { reference: input.entityReference },
      type: input.entityType === 'Patient' ? 'Patient' : (input.entityType === 'Practitioner' ? 'Practitioner' : 'Other'),
    }];
  }
  return evt;
}

export function validateAuditEvent(ev: unknown): FhirAuditEvent {
  const parsed = AuditEventSchema.safeParse(ev);
  if (!parsed.success) {
    throw new AuditFieldMissingError('AuditEvent schema 校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}
