/**
 * 危急值闭环 tool 注册面 —— getCriticalTools() 统一注册三个 tool。
 *
 * 与源产品 `getMcpServer()` 的对应关系：注册入口 / 结构化 inputSchema / handler 三段式，
 * 但只暴露本产品需要的三个动作，且每个调用强制 AuditEvent 四字段、失败不推进状态。
 */

import type { ToolContext, ToolSpec, FhirWritePort } from './types.js';
import {
  registerTool,
  writeDeniedAudit,
  writeTaskAndAudit,
  toFhirTaskStatus,
  toFhirId,
  practitionerRef,
  ToolValidationError,
} from './types.js';
import { listCriticalValuesTool, listCriticalValuesInputSchema } from './list-criticals.js';
import { acknowledgeCriticalValueTool, acknowledgeCriticalValueInputSchema } from './acknowledge.js';
import {
  resolveCriticalValueTool,
  resolveCriticalValueInputSchema,
  appendDiagnosticReportNote,
} from './resolve.js';

export type CriticalToolName =
  | 'list_critical_values'
  | 'acknowledge_critical_value'
  | 'resolve_critical_value';

type RegisteredTool = ToolSpec<unknown> & {
  call(raw: unknown, ctx: ToolContext): Promise<Record<string, unknown>>;
};

export interface CriticalToolRegistry {
  tools: Record<CriticalToolName, RegisteredTool>;
  names: CriticalToolName[];
  call(name: string, raw: unknown, ctx: ToolContext): Promise<Record<string, unknown>>;
}

/** 统一注册（单例结构，每次调用返回新的 registry 但复用同一批 tool 定义） */
export function getCriticalTools(): CriticalToolRegistry {
  const tools = {
    list_critical_values: listCriticalValuesTool,
    acknowledge_critical_value: acknowledgeCriticalValueTool,
    resolve_critical_value: resolveCriticalValueTool,
  } as unknown as Record<CriticalToolName, RegisteredTool>;
  return {
    tools,
    names: Object.keys(tools) as CriticalToolName[],
    async call(name: string, raw: unknown, ctx: ToolContext) {
      const tool = tools[name as CriticalToolName];
      if (!tool) throw new Error(`未注册的 tool: ${name}`);
      return tool.call(raw, ctx);
    },
  };
}

export {
  listCriticalValuesTool,
  acknowledgeCriticalValueTool,
  resolveCriticalValueTool,
  listCriticalValuesInputSchema,
  acknowledgeCriticalValueInputSchema,
  resolveCriticalValueInputSchema,
  registerTool,
  writeDeniedAudit,
  writeTaskAndAudit,
  toFhirTaskStatus,
  toFhirId,
  practitionerRef,
  ToolValidationError,
  appendDiagnosticReportNote,
  type ToolContext,
  type FhirWritePort,
};
