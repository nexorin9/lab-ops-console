/**
 * acknowledge_critical_value —— 护士在大屏点「已接收」
 * requested → received，写本地 AuditEvent + FHIR Task / AuditEvent 回写。
 * 非法状态（含重复 ack）由状态机拒绝并写 denied，绝不推进状态。
 */

import { z } from 'zod';
import { registerTool, writeTaskAndAudit, practitionerRef, type ToolContext } from './types.js';

export const acknowledgeCriticalValueInputSchema = z.object({
  task_id: z.string().min(1),
  practitioner_id: z.string().min(1),
  role: z.enum(['nurse', 'doctor', 'practitioner', 'system']),
});

export type AcknowledgeCriticalValueInput = z.infer<typeof acknowledgeCriticalValueInputSchema>;

export const acknowledgeCriticalValueTool = registerTool(
  'acknowledge_critical_value',
  {
    description: '护士确认接收危急值：Task.requested → received，写审计并回写 FHIR Task / AuditEvent',
    inputSchema: acknowledgeCriticalValueInputSchema,
  },
  async (input: AcknowledgeCriticalValueInput, ctx: ToolContext) => {
    const recorded = ctx.now?.() ?? new Date().toISOString();
    const result = await ctx.stateMachine.ackOnly({
      taskId: input.task_id,
      agent: {
        practitionerId: input.practitioner_id,
        role: input.role === 'nurse' ? 'nurse' : input.role === 'doctor' ? 'doctor' : 'practitioner',
      },
      note: '护士站大屏已接收',
      now: recorded,
    });

    const task = result.task;
    const fhir = await writeTaskAndAudit(ctx, task, {
      agent: input.practitioner_id,
      action: 'acknowledge',
      outcome: 'success',
      ownerRef: practitionerRef(input.practitioner_id),
      notes: [{ text: `已接收（${input.role} ${input.practitioner_id}）`, time: recorded }],
    });

    return {
      tool: 'acknowledge_critical_value',
      ok: true,
      task_id: task.id,
      status: task.status,
      audit: {
        agent: result.audit.agent,
        recorded: result.audit.recorded,
        source: result.audit.source,
        outcome: result.audit.outcome,
      },
      fhir,
    };
  },
);
