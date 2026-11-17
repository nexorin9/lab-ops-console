/**
 * FHIR R4 Specimen 构造器
 *
 * field-by-field 对照 FHIR R4 spec：
 * https://hl7.org/fhir/R4/specimen.html
 *
 * - accessionIdentifier 走 `system = urn:lab-ops-console:accession`，与 FhirWriter 的 If-None-Exist 对齐
 */

import { z } from 'zod';
import { FhirValidationFailError } from '../../shared/errors.js';

export const SpecimenSchema = z.object({
  resourceType: z.literal('Specimen'),
  id: z.string().optional(),
  identifier: z.array(z.object({
    system: z.string(),
    value: z.string(),
  })).min(1),
  status: z.enum(['available', 'unavailable', 'unsatisfactory', 'entered-in-error']).optional(),
  type: z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })).min(1),
  }).optional(),
  subject: z.object({ reference: z.string() }),
  receivedTime: z.string().optional(),
  collection: z.object({
    collectedDateTime: z.string().optional(),
    collector: z.object({ reference: z.string() }).optional(),
  }).optional(),
});

export type FhirSpecimen = z.infer<typeof SpecimenSchema>;

export interface BuildSpecimenInput {
  id?: string;
  accessionIdentifier: string;
  subjectReference: string;
  typeCode?: string;
  typeDisplay?: string;
  typeSystem?: string;
  receivedTime?: string;
  collectedDateTime?: string;
}

export function buildSpecimen(input: BuildSpecimenInput): FhirSpecimen {
  if (!input.accessionIdentifier) {
    throw new FhirValidationFailError('buildSpecimen: accessionIdentifier 必填', { field: 'accessionIdentifier' });
  }
  if (!input.subjectReference) {
    throw new FhirValidationFailError('buildSpecimen: subjectReference 必填', { field: 'subjectReference' });
  }
  const sp: FhirSpecimen = {
    resourceType: 'Specimen',
    identifier: [{
      system: 'urn:lab-ops-console:accession',
      value: input.accessionIdentifier,
    }],
    subject: { reference: input.subjectReference },
  };
  if (input.id) sp.id = input.id;
  if (input.typeCode) {
    sp.type = {
      coding: [{
        system: input.typeSystem ?? 'http://snomed.info/sct',
        code: input.typeCode,
        display: input.typeDisplay,
      }],
    };
  }
  if (input.receivedTime) sp.receivedTime = input.receivedTime;
  if (input.collectedDateTime) {
    sp.collection = { collectedDateTime: input.collectedDateTime };
  }
  return sp;
}

export function validateSpecimen(s: unknown): FhirSpecimen {
  const parsed = SpecimenSchema.safeParse(s);
  if (!parsed.success) {
    throw new FhirValidationFailError('Specimen schema 校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}
