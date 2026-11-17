/**
 * FHIR R4 DiagnosticReport 构造器
 *
 * field-by-field 对照 FHIR R4 spec：
 * https://hl7.org/fhir/R4/diagnosticreport.html
 *
 * 用于：将一份标本的多 Observation 关联成一份诊断报告。
 * `contained` 字段装入关联 Observation（与 spec 推荐的 inline-contained 模式一致）。
 */

import { z } from 'zod';
import { FhirValidationFailError } from '../../shared/errors.js';
import { ObservationSchema, type FhirObservation } from './observation.js';

export const DiagnosticReportSchema = z.object({
  resourceType: z.literal('DiagnosticReport'),
  id: z.string().optional(),
  identifier: z.array(z.object({
    system: z.string(),
    value: z.string(),
  })).optional(),
  status: z.enum(['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown']),
  category: z.array(z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })).min(1),
  })).optional(),
  code: z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })).min(1),
    text: z.string().optional(),
  }),
  subject: z.object({ reference: z.string() }),
  effectiveDateTime: z.string().optional(),
  issued: z.string(),
  specimen: z.array(z.object({ reference: z.string() })).optional(),
  result: z.array(z.object({ reference: z.string() })).optional(),
  contained: z.array(ObservationSchema).optional(),
  note: z.array(z.object({
    text: z.string(),
    time: z.string().optional(),
    authorReference: z.object({ reference: z.string() }).optional(),
  })).optional(),
});

export type FhirDiagnosticReport = z.infer<typeof DiagnosticReportSchema>;

export interface BuildDiagnosticReportInput {
  id?: string;
  accessionIdentifier: string;
  status?: FhirDiagnosticReport['status'];
  code?: { system?: string; loinc?: string; display?: string; text?: string };
  subjectReference: string;
  issued?: string;
  specimenReference?: string;
  observations?: Array<{ id: string; resource: FhirObservation }>;
  notes?: Array<{ text: string; time?: string; authorReference?: string }>;
}

/**
 * buildDiagnosticReport — 构造 FHIR R4 DiagnosticReport
 * - `accessionIdentifier` 同时进 resource.id 与 identifier.value，便于外部检索
 * - `observations` 若有则 inline-contained + 同时进 result[] 引用
 */
export function buildDiagnosticReport(input: BuildDiagnosticReportInput): FhirDiagnosticReport {
  if (!input.subjectReference) {
    throw new FhirValidationFailError('buildDiagnosticReport: subjectReference 必填', { field: 'subjectReference' });
  }
  const obsRefs: Array<{ reference: string }> = [];
  const contained: FhirObservation[] = [];
  for (const obs of input.observations ?? []) {
    obsRefs.push({ reference: `Observation/${obs.id}` });
    if (obs.resource.id !== obs.id) {
      contained.push({ ...obs.resource, id: obs.id } as FhirObservation);
    } else {
      contained.push(obs.resource);
    }
  }
  const report: FhirDiagnosticReport = {
    resourceType: 'DiagnosticReport',
    status: input.status ?? 'final',
    code: {
      coding: [{
        system: input.code?.system ?? 'http://loinc.org',
        code: input.code?.loinc ?? '11502-2',
        display: input.code?.display ?? 'Laboratory report',
      }],
    },
    subject: { reference: input.subjectReference },
    issued: input.issued ?? new Date().toISOString(),
    identifier: [{
      system: 'urn:lab-ops-console:accession',
      value: input.accessionIdentifier,
    }],
  };
  if (input.id) report.id = input.id;
  if (input.code?.text) report.code.text = input.code.text;
  if (obsRefs.length > 0) report.result = obsRefs;
  if (contained.length > 0) report.contained = contained;
  if (input.specimenReference) report.specimen = [{ reference: input.specimenReference }];
  if (input.notes && input.notes.length > 0) {
    report.note = input.notes.map((n) => ({
      text: n.text,
      time: n.time,
      authorReference: n.authorReference ? { reference: n.authorReference } : undefined,
    }));
  }
  return report;
}

export function validateDiagnosticReport(report: unknown): FhirDiagnosticReport {
  const parsed = DiagnosticReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new FhirValidationFailError('DiagnosticReport schema 校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}
