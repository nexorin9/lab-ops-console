/** list_critical_values —— 查未完成（或指定状态）危急值 Task，支持患者 / 时间段 / 状态过滤 */

import { z } from 'zod';
import { registerTool, type ToolContext } from './types.js';
import { TASK_STATES } from '../Task-state-machine.js';

export const listCriticalValuesInputSchema = z.object({
  patient_id: z.string().min(1).optional(),
  time_range: z.object({ from: z.string().min(1), to: z.string().min(1) }).optional(),
  status: z.enum(TASK_STATES).optional(),
});

export type ListCriticalValuesInput = z.infer<typeof listCriticalValuesInputSchema>;

export const listCriticalValuesTool = registerTool(
  'list_critical_values',
  {
    description: '列出危急值闭环 Task；可按患者、检出时间段与状态过滤，默认返回全部未完成任务',
    inputSchema: listCriticalValuesInputSchema,
  },
  async (input: ListCriticalValuesInput, ctx: ToolContext) => {
    const rows = input.status
      ? await ctx.store.listByStatus(input.status, 1000)
      : await ctx.store.listAll(1000);

    const filtered = rows.filter((row) => {
      if (input.patient_id && row.patient_id !== input.patient_id) return false;
      if (input.time_range) {
        if (row.created_at < input.time_range.from || row.created_at > input.time_range.to) return false;
      }
      // 未指定 status 时只返回「未完成」的闭环步骤（completed/cancelled/rejected 属已办）
      if (!input.status && ['completed', 'cancelled', 'rejected'].includes(row.status)) return false;
      return true;
    });

    return {
      tool: 'list_critical_values',
      count: filtered.length,
      tasks: filtered.map((r) => ({
        task_id: r.id,
        id: r.id,
        patient_id: r.patient_id,
        /** 大屏只读哈希别名，避免面板把内部原始标识当展示字段 */
        patient_hash: r.patient_id,
        patientHash: r.patient_id,
        patientId: r.patient_id,
        status: r.status,
        /** T31 · 面板渲染需要展示的危急值快照（与 broadcast critical.detected 同源） */
        severity: r.focus_severity ?? 'critical',
        value: r.focus_value ?? '',
        unit: r.focus_unit ?? '',
        testCode: r.focus_test_code ?? '',
        testDisplay: r.focus_test_display ?? '',
        focus: { diagnostic_report: r.focus_diagnostic_id, observation_code: r.focus_observation_code },
        priority: r.priority,
        reason: r.reason_text,
        detected_at: r.created_at,
        detectedAt: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  },
);
