/**
 * FHIR R4 Task 构造器（危急值闭环用）
 *
 * field-by-field 对照 FHIR R4 spec：
 * https://hl7.org/fhir/R4/task.html
 *
 * - 用于：将危急值闭环的状态机推进点写成 FHIR Task，便于外部 LIS / 医务系统统一检索
 * - focus 指向 DiagnosticReport.id + Observation.code，避免重复 Task
 * - 8 个状态机字段（intent / priority / focus / for / owner / requester / reasonCode / note）
 *   与 src/critical/Task-state-machine.ts 的本地状态机一一对齐，
 *   本模块只负责「本地状态 → FHIR Task 字段」这一个方向的映射，反向由状态机负责
 */

import { z } from 'zod';
import { FhirValidationFailError } from '../../shared/errors.js';

export const TASK_STATUSES = [
  'requested',
  'received',
  'accepted',
  'in-progress',
  'completed',
  'cancelled',
  'failed',
  'rejected',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskSchema = z.object({
  resourceType: z.literal('Task'),
  id: z.string().optional(),
  identifier: z.array(z.object({
    system: z.string(),
    value: z.string(),
  })).optional(),
  status: z.enum(TASK_STATUSES),
  intent: z.enum(['unknown', 'proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option']),
  priority: z.enum(['routine', 'urgent', 'asap', 'stat']).optional(),
  code: z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })),
    text: z.string().optional(),
  }).optional(),
  focus: z.object({ reference: z.string() }).optional(),
  for: z.object({ reference: z.string() }).optional(),
  encounter: z.object({ reference: z.string() }).optional(),
  authoredOn: z.string().optional(),
  lastModified: z.string().optional(),
  requester: z.object({ reference: z.string().optional(), display: z.string().optional() }).optional(),
  owner: z.object({ reference: z.string(), display: z.string().optional() }).optional(),
  reasonCode: z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })).optional(),
    text: z.string().optional(),
  }).optional(),
  note: z.array(z.object({ text: z.string(), time: z.string().optional() })).optional(),
});

export type FhirTask = z.infer<typeof TaskSchema>;

export interface BuildTaskInput {
  id: string;
  status: TaskStatus;
  intent?: FhirTask['intent'];
  priority?: FhirTask['priority'];
  forReference?: string;
  focusReference?: string;
  requesterReference?: string;
  ownerReference?: string;
  /** reasonCode 的文本（CodeableConcept.text） */
  reasonText?: string;
  /** reasonCode 的编码（CodeableConcept.coding）—— 院内系统按编码检索时需要 */
  reasonCoding?: { system: string; code: string; display?: string };
  notes?: Array<{ text: string; time?: string }>;
  authoredOn?: string;
  lastModified?: string;
}

/**
 * 相对引用格式校验 —— FHIR R4 Reference 形如 `ResourceType/id`（可带 `|version`）
 * 提前拦下拼错的引用（如 `Patient` 少了 id、空串），否则服务端会 400，
 * 而 400 是不重试的 —— 一条引用写错 = 整份报告进不了院内库。
 */
const RELATIVE_REFERENCE_RE = /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\|[A-Za-z0-9\-.]{1,64})?$/;

function assertReference(value: string | undefined, field: string): void {
  if (value === undefined) return;
  if (!RELATIVE_REFERENCE_RE.test(value)) {
    throw new FhirValidationFailError(
      `buildTask: ${field} 不是合法的 FHIR 相对引用（应为 ResourceType/id）`,
      { field, value },
    );
  }
}

export function buildTask(input: BuildTaskInput): FhirTask {
  if (!input.id) {
    throw new FhirValidationFailError('buildTask: id 必填', { field: 'id' });
  }
  assertReference(input.forReference, 'forReference');
  assertReference(input.focusReference, 'focusReference');
  assertReference(input.requesterReference, 'requesterReference');
  assertReference(input.ownerReference, 'ownerReference');
  const task: FhirTask = {
    resourceType: 'Task',
    id: input.id,
    status: input.status,
    intent: input.intent ?? 'order',
  };
  if (input.priority) task.priority = input.priority;
  if (input.forReference) task.for = { reference: input.forReference };
  if (input.focusReference) task.focus = { reference: input.focusReference };
  if (input.requesterReference) task.requester = { reference: input.requesterReference };
  if (input.ownerReference) task.owner = { reference: input.ownerReference };
  if (input.reasonText || input.reasonCoding) {
    const reason: { coding?: Array<{ system: string; code: string; display?: string }>; text?: string } = {};
    if (input.reasonCoding) {
      reason.coding = [{
        system: input.reasonCoding.system,
        code: input.reasonCoding.code,
        display: input.reasonCoding.display,
      }];
    }
    if (input.reasonText) reason.text = input.reasonText;
    task.reasonCode = reason;
  }
  if (input.authoredOn) task.authoredOn = input.authoredOn;
  if (input.lastModified) task.lastModified = input.lastModified;
  if (input.notes && input.notes.length > 0) {
    task.note = input.notes.map((n) => ({ text: n.text, time: n.time }));
  }
  return task;
}

export function validateTask(t: unknown): FhirTask {
  const parsed = TaskSchema.safeParse(t);
  if (!parsed.success) {
    throw new FhirValidationFailError('Task schema 校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}
