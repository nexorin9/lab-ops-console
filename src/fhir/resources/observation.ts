/**
 * FHIR R4 Observation 构造器
 *
 * field-by-field 对照 FHIR R4 spec：
 * https://hl7.org/fhir/R4/observation.html
 *
 * 用于：将仪器结果（K/Na/Cl 等）映射成 FHIR Observation 后送入 FHIR 端点。
 */

import { z } from 'zod';
import { FhirValidationFailError } from '../../shared/errors.js';

export const ObservationSchema = z.object({
  resourceType: z.literal('Observation'),
  id: z.string().optional(),
  status: z.enum(['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error']),
  code: z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })).min(1),
    text: z.string().optional(),
  }),
  subject: z.object({
    reference: z.string(),
    display: z.string().optional(),
  }),
  effectiveDateTime: z.string(),
  issued: z.string().optional(),
  valueQuantity: z.object({
    value: z.number(),
    unit: z.string(),
    system: z.string().optional(),
    code: z.string().optional(),
  }).optional(),
  valueString: z.string().optional(),
  interpretation: z.array(z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })).min(1),
  })).optional(),
  referenceRange: z.array(z.object({
    low: z.object({ value: z.number(), unit: z.string() }).optional(),
    high: z.object({ value: z.number(), unit: z.string() }).optional(),
    text: z.string().optional(),
  })).optional(),
  device: z.object({
    reference: z.string(),
    display: z.string().optional(),
  }).optional(),
});

export type FhirObservation = z.infer<typeof ObservationSchema>;

export interface BuildObservationInput {
  id?: string;
  status: FhirObservation['status'];
  code: { loinc: string; display?: string; system?: string };
  subjectReference: string;
  effectiveDateTime: string;
  value?: number;
  valueUnit?: string;
  valueString?: string;
  interpretationCode?: string;
  referenceRange?: { low?: number; high?: number; unit?: string; text?: string };
  deviceReference?: string;
}

/**
 * buildObservation — 构造 FHIR R4 Observation 对象
 * 必填字段：status / code / subject / effectiveDateTime；valueQuantity 或 valueString 二选一
 */
export function buildObservation(input: BuildObservationInput): FhirObservation {
  if (!input.subjectReference) {
    throw new FhirValidationFailError('buildObservation: subjectReference 必填', { field: 'subjectReference' });
  }
  if (!input.effectiveDateTime) {
    throw new FhirValidationFailError('buildObservation: effectiveDateTime 必填', { field: 'effectiveDateTime' });
  }
  const obj: FhirObservation = {
    resourceType: 'Observation',
    status: input.status,
    code: {
      coding: [{
        system: input.code.system ?? 'http://loinc.org',
        code: input.code.loinc,
        display: input.code.display,
      }],
    },
    subject: { reference: input.subjectReference },
    effectiveDateTime: input.effectiveDateTime,
  };
  if (input.id) obj.id = input.id;
  if (input.value !== undefined && input.valueUnit) {
    obj.valueQuantity = { value: input.value, unit: input.valueUnit };
  } else if (input.valueString !== undefined) {
    obj.valueString = input.valueString;
  }
  if (input.interpretationCode) {
    obj.interpretation = [{
      coding: [{
        system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
        code: input.interpretationCode,
        display: input.interpretationCode,
      }],
    }];
  }
  if (input.referenceRange) {
    const r = input.referenceRange;
    obj.referenceRange = [{
      low: r.low !== undefined && r.unit ? { value: r.low, unit: r.unit } : undefined,
      high: r.high !== undefined && r.unit ? { value: r.high, unit: r.unit } : undefined,
      text: r.text,
    }];
  }
  if (input.deviceReference) {
    obj.device = { reference: input.deviceReference };
  }
  return obj;
}

/** zod schema 校验入口（生产代码可在写入前再过一遍） */
export function validateObservation(obs: unknown): FhirObservation {
  const parsed = ObservationSchema.safeParse(obs);
  if (!parsed.success) {
    throw new FhirValidationFailError('Observation schema 校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}
