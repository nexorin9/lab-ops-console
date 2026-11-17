/**
 * 危急值 tool 基础设施 —— 对齐源仓库 `registerTool(name, { inputSchema }, handler)` 模式
 *
 * 代码证据（github_ref/medplum/packages/server/src/mcp/server.ts）：
 * - `getMcpServer()` 里用 `server.registerTool(name, { inputSchema: { ... z.object ... } }, handler)`
 * - handler 内做结构化入参校验后的业务动作，并带 OAuth bearer 转发到 FHIR R4 REST
 *
 * 本产品只复刻「结构化入参 + 注册 + handler + 出站转发」这一机制，不引入 MCP SDK，
 * 注册面收敛到危急值闭环的三个动作；所有调用（含被拒）强制写 AuditEvent 四字段。
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { CriticalStore, CriticalTaskRow } from '../store.js';
import type { TaskStateMachine, TaskState } from '../Task-state-machine.js';
import { BaseError, ErrorCode, isBaseError } from '../../shared/errors.js';
import { buildTask, buildAuditEvent, type TaskStatus, type AuditOutcome as FhirAuditOutcome } from '../../fhir/resources/index.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('critical.tools');

/** FHIR 出站端口（FhirWriter 结构兼容；测试可注入内存替身） */
export interface FhirWritePort {
  writeResource(input: {
    resourceType: string;
    body: Record<string, unknown>;
    idempotencyKey?: string;
    skipIfNoneExist?: boolean;
  }): Promise<{ id: string; resourceType?: string }>;
  read(resourceType: string, id: string): Promise<Record<string, unknown> | null>;
}

export interface ToolContext {
  store: CriticalStore;
  stateMachine: TaskStateMachine;
  writer?: FhirWritePort;
  /** AuditEvent.source（默认 lab-ops-console） */
  source?: string;
  /** 时钟注入（测试用） */
  now?: () => string;
}

export interface ToolSpec<I> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

/** tool 入参校验失败（结构化错误，不推进任何状态） */
export class ToolValidationError extends BaseError {
  constructor(message: string, context: Record<string, unknown> = {}) {
    super(ErrorCode.AUDIT_FIELD_MISSING, message, context);
  }
}

/**
 * registerTool —— 与源产品同构的注册入口。
 * 返回带 `call()` 的 tool 对象：call 先跑 zod schema，再进 handler；
 * 任何失败都写 denied AuditEvent（四字段齐备），并保证状态不推进。
 */
export function registerTool<I>(
  name: string,
  spec: { description: string; inputSchema: z.ZodType<I> },
  handler: ToolSpec<I>['handler'],
): ToolSpec<I> & { call(raw: unknown, ctx: ToolContext): Promise<Record<string, unknown>> } {
  const tool: ToolSpec<I> = { name, description: spec.description, inputSchema: spec.inputSchema, handler };
  return Object.assign(tool, {
    async call(raw: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
      const parsed = spec.inputSchema.safeParse(raw);
      if (!parsed.success) {
        const taskId = typeof raw === 'object' && raw !== null && 'task_id' in raw
          ? String((raw as Record<string, unknown>).task_id ?? 'unknown')
          : 'unknown';
        await writeDeniedAudit(ctx, taskId, 'system/lab-ops-console', 'missing_audit', {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          tool: name,
        });
        throw new ToolValidationError(`tool ${name} 入参校验失败`, {
          tool: name,
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      try {
        return await handler(parsed.data, ctx);
      } catch (err) {
        // 状态机被拒时自己已写 denied；这里按 dedupeKey 幂等补一条总账，
        // 保证「任何 tool 失败都能在审计链里被倒查」，且不会重复计数。
        const input = parsed.data as Record<string, unknown>;
        const taskId = String(input.task_id ?? 'unknown');
        const code = isBaseError(err) ? err.code : 'TOOL_ERROR';
        await writeDeniedAudit(ctx, taskId, String(input.practitioner_id ?? 'system/lab-ops-console'), code, {
          tool: name,
          error: err instanceof Error ? err.message : String(err),
        }, `tool:${name}:${taskId}:${code}`);
        throw err;
      }
    },
  });
}

/** 写一条 denied 审计（四字段强制齐备，支持 dedupeKey 幂等） */
export async function writeDeniedAudit(
  ctx: ToolContext,
  taskId: string,
  agent: string,
  reason: string,
  context: Record<string, unknown> = {},
  dedupeKey?: string,
): Promise<void> {
  await ctx.store.writeAudit({
    task_id: taskId,
    agent,
    recorded: (ctx.now?.() ?? new Date().toISOString()),
    source: ctx.source ?? 'lab-ops-console',
    outcome: 'denied',
    reason,
    context,
    ...(dedupeKey ? { dedupeKey } : {}),
  });
}

/** 业务 Task 状态 → FHIR R4 Task.status（两处状态集一致，保留显式映射防漂移） */
export function toFhirTaskStatus(state: TaskState): TaskStatus {
  const allowed: TaskStatus[] = ['requested', 'received', 'in-progress', 'completed', 'cancelled', 'rejected'];
  return allowed.includes(state as TaskStatus) ? (state as TaskStatus) : 'requested';
}

/** 把任意院内 ID 规整成 FHIR 相对引用允许的字符集 */
export function toFhirId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9\-.]/g, '-').slice(0, 64) || 'unknown';
}

/** 操作人 → Practitioner 相对引用 */
export function practitionerRef(practitionerId: string): string {
  return `Practitioner/${toFhirId(practitionerId)}`;
}

/**
 * FHIR 出站回写：一条 Task + 一条 AuditEvent。
 * 失败不吞：写不进院内端点时抛错，由调用方兜底（主状态已在本地事务内推进）。
 */
export async function writeTaskAndAudit(
  ctx: ToolContext,
  task: CriticalTaskRow,
  opts: {
    agent: string;
    action: string;
    outcome: FhirAuditOutcome;
    notes?: Array<{ text: string; time?: string }>;
    ownerRef?: string;
  },
): Promise<{ taskWritten: boolean; auditWritten: boolean }> {
  if (!ctx.writer) return { taskWritten: false, auditWritten: false };
  const recorded = ctx.now?.() ?? new Date().toISOString();
  const fhirTask = buildTask({
    id: toFhirId(task.id),
    status: toFhirTaskStatus(task.status as TaskState),
    forReference: `Patient/${toFhirId(task.patient_id)}`,
    focusReference: task.focus_diagnostic_id,
    ownerReference: opts.ownerRef,
    reasonText: task.reason_text ?? undefined,
    notes: opts.notes,
    lastModified: recorded,
  });
  await ctx.writer.writeResource({
    resourceType: 'Task',
    body: fhirTask as unknown as Record<string, unknown>,
    skipIfNoneExist: true,
  });

  const audit = buildAuditEvent({
    id: `audit-${toFhirId(task.id)}-${randomUUID().slice(0, 8)}`,
    agentReference: practitionerRef(opts.agent),
    recorded,
    outcome: opts.outcome,
    outcomeDesc: opts.action,
    entityReference: `Task/${toFhirId(task.id)}`,
    typeCode: opts.action,
  });
  await ctx.writer.writeResource({
    resourceType: 'AuditEvent',
    body: audit as unknown as Record<string, unknown>,
    skipIfNoneExist: true,
  });
  log.info({ taskId: task.id, action: opts.action, outcome: opts.outcome }, 'FHIR Task/AuditEvent written');
  return { taskWritten: true, auditWritten: true };
}
