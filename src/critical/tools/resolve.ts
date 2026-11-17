/**
 * resolve_critical_value —— 医生点「已处置」并写处置备注
 * received → in-progress → completed（严格不跳步），DiagnosticReport.note 累加备注，
 * FHIR Task / AuditEvent 回写。备注缺失或状态不符一律拒绝并留 denied 审计。
 */

import { z } from 'zod';
import { registerTool, writeTaskAndAudit, practitionerRef, type ToolContext } from './types.js';
import { TaskInvalidTransitionError } from '../../shared/errors.js';

export const resolveCriticalValueInputSchema = z.object({
  task_id: z.string().min(1),
  practitioner_id: z.string().min(1),
  resolution_note: z.string().min(1),
});

export type ResolveCriticalValueInput = z.infer<typeof resolveCriticalValueInputSchema>;

/** 在 FHIR DiagnosticReport.note 上累加一条处置备注（读 → 追加 → 按 id 回写） */
export async function appendDiagnosticReportNote(
  ctx: ToolContext,
  reportRef: string,
  note: { text: string; time: string; authorReference?: string },
): Promise<{ reportId: string; notes: string[] }> {
  if (!ctx.writer) return { reportId: reportRef, notes: [] };
  const parts = reportRef.split('/');
  const reportId = parts.length > 1 ? parts.slice(1).join('/') : reportRef;
  const existing = await ctx.writer.read('DiagnosticReport', reportId);
  const base: Record<string, unknown> = existing ?? {
    resourceType: 'DiagnosticReport',
    id: reportId,
    status: 'final',
    code: { text: '检验报告' },
    subject: { reference: 'Patient/unknown' },
    issued: note.time,
  };
  const previous = Array.isArray(base.note) ? base.note as Array<Record<string, unknown>> : [];
  const merged = [
    ...previous,
    { text: note.text, time: note.time, ...(note.authorReference ? { authorReference: { reference: note.authorReference } } : {}) },
  ];
  await ctx.writer.writeResource({
    resourceType: 'DiagnosticReport',
    body: { ...base, id: reportId, resourceType: 'DiagnosticReport', note: merged },
    skipIfNoneExist: true,
  });
  return { reportId, notes: merged.map((n) => String(n.text ?? '')) };
}

export const resolveCriticalValueTool = registerTool(
  'resolve_critical_value',
  {
    description: '医生处置危急值：received → in-progress → completed，处置备注累加进 DiagnosticReport.note',
    inputSchema: resolveCriticalValueInputSchema,
  },
  async (input: ResolveCriticalValueInput, ctx: ToolContext) => {
    const recorded = ctx.now?.() ?? new Date().toISOString();
    const agent = {
      practitionerId: input.practitioner_id,
      role: 'doctor' as const,
    };
    const current = await ctx.store.getTask(input.task_id);
    if (!current) throw new TaskInvalidTransitionError('Task 不存在', { taskId: input.task_id });
    if (!['received', 'in-progress'].includes(current.status)) {
      // 走通用校验，让它落下 denied 审计（直接 completed 属跳步）
      await ctx.stateMachine.transition({
        taskId: input.task_id,
        fromState: current.status as 'requested',
        toState: 'completed',
        agent,
        now: recorded,
      });
    }

    if (current.status === 'received') {
      await ctx.stateMachine.transition({
        taskId: input.task_id,
        fromState: 'received',
        toState: 'in-progress',
        agent,
        reason: 'treatment_started',
        note: input.resolution_note,
        now: recorded,
      });
    }
    const final = await ctx.stateMachine.transition({
      taskId: input.task_id,
      fromState: 'in-progress',
      toState: 'completed',
      agent,
      reason: 'resolved',
      note: input.resolution_note,
      now: recorded,
    });

    const noteResult = await appendDiagnosticReportNote(ctx, final.task.focus_diagnostic_id, {
      text: input.resolution_note,
      time: recorded,
      authorReference: practitionerRef(input.practitioner_id),
    });
    const fhir = await writeTaskAndAudit(ctx, final.task, {
      agent: input.practitioner_id,
      action: 'resolve',
      outcome: 'success',
      ownerRef: practitionerRef(input.practitioner_id),
      notes: [{ text: input.resolution_note, time: recorded }],
    });

    return {
      tool: 'resolve_critical_value',
      ok: true,
      task_id: final.task.id,
      status: final.task.status,
      diagnostic_report: noteResult.reportId,
      notes: noteResult.notes,
      audit: {
        agent: final.audit.agent,
        recorded: final.audit.recorded,
        source: final.audit.source,
        outcome: final.audit.outcome,
      },
      fhir,
    };
  },
);
