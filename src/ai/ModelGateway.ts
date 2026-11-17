/**
 * ModelGateway —— 本产品唯一的模型入口，只实现 OpenAI-compatible 一种协议。
 *
 * - 业务层不 import 任何厂商 SDK：换供应商只改 MODELS_* 四个 env
 * - 请求体：POST {baseUrl}/chat/completions，{model, messages, response_format:{type:'json_object'}, stream:false, timeout}
 * - 结构化响应：choices[0].message.content 为 JSON 字符串 → zod 校验 → 业务对象
 * - 四类失败（超时 / 5xx 或不可达 / 不可解析 / 结构化字段缺失）一律降级到规则查表兜底，
 *   候选标 low_confidence，模型调用审计记 outcome=fallback，FHIR/本地 AuditEvent 记 partial
 * - 绝不静默推进业务状态：本类只返回候选，不碰 Task.status
 */

import { z } from 'zod';
import { chatCompletionsUrl, readModelConfig, type ModelConfig } from './config.js';
import {
  PROMPT_TEMPLATES,
  RECIPIENT_PROMPT,
  ATTRIBUTION_PROMPT,
  RecipientResponseSchema,
  AttributionResponseSchema,
  renderPrompt,
  type PromptTemplate,
} from './prompt-templates.js';
import { createModelCallAuditor, sha256, type ModelCallAuditor } from './audit.js';
import { FAILURE_MATRIX, type FailureKind } from './failure-matrix.js';
import type {
  AttributionQuery,
  Candidate,
  FallbackProvider,
  FieldAttribution,
  GatewayResult,
  RecipientQuery,
} from './types.js';
import type { CriticalStore } from '../critical/store.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('ai.ModelGateway');

/** 无任何值班表时的确定性兜底：不返回空候选，标低置信度交人工确认 */
export const STATIC_FALLBACK: FallbackProvider = {
  suggestRecipients(query: RecipientQuery): Candidate[] {
    return [{
      role: query.role ?? '值班护士',
      practitionerId: 'oncall-default',
      confidence: 0.2,
      reason: '模型不可用，回退到病区默认值班角色，需人工确认',
      source: 'rule',
      lowConfidence: true,
    }];
  },
  attributeField(): FieldAttribution {
    return {
      candidateLoinc: 'UNKNOWN',
      confidence: 0.1,
      reason: '模型不可用，字典未命中，需人工确认',
      source: 'rule',
      lowConfidence: true,
    };
  },
};

export interface ModelGatewayOptions {
  /** 不传则从 env 读；读不到时所有调用直接走规则兜底（不阻塞主路径） */
  config?: ModelConfig;
  fetchImpl?: typeof fetch;
  fallback?: FallbackProvider;
  auditor?: ModelCallAuditor;
  env?: NodeJS.ProcessEnv;
  /** 本地审计链（降级时写 outcome=partial） */
  criticalStore?: CriticalStore;
  now?: () => number;
}

interface CompletionOutcome<T> {
  ok: boolean;
  data: T;
  errorCode?: string;
  failureKind?: FailureKind;
  audit: GatewayResult<T>['audit'];
}

/** 分类 HTTP/网络/解析异常 → 四类失败之一 */
export function classifyFetchError(err: unknown, signal?: AbortSignal): FailureKind {
  if (signal?.aborted || (err instanceof Error && (err.name === 'AbortError' || /timeout|abort/i.test(err.message)))) {
    return 'timeout';
  }
  return 'http_5xx';
}

export class ModelGateway {
  private readonly config: ModelConfig | null;
  private readonly fetchImpl: typeof fetch;
  private readonly fallback: FallbackProvider;
  private readonly auditor: ModelCallAuditor;
  private readonly criticalStore: CriticalStore | null;
  private readonly now: () => number;

  constructor(opts: ModelGatewayOptions = {}) {
    if (opts.config) {
      this.config = opts.config;
    } else {
      try {
        this.config = readModelConfig(opts.env ?? process.env);
      } catch (err) {
        log.warn({ err: (err as Error).message }, '模型配置缺失，全部调用走规则兜底');
        this.config = null;
      }
    }
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.fallback = opts.fallback ?? STATIC_FALLBACK;
    this.auditor = opts.auditor ?? createModelCallAuditor();
    this.criticalStore = opts.criticalStore ?? null;
    this.now = opts.now ?? Date.now;
  }

  /** 当前配置（不含 apiKey，供面板显示可替换的供应商形态） */
  describe(): { baseUrl: string; model: string; timeoutMs: number; configured: boolean } {
    return {
      baseUrl: this.config?.baseUrl ?? '',
      model: this.config?.model ?? '',
      timeoutMs: this.config?.timeoutMs ?? 0,
      configured: this.config !== null,
    };
  }

  /** 候选接收人建议（模型 → 规则兜底） */
  async suggestRecipients(query: RecipientQuery): Promise<GatewayResult<Candidate[]>> {
    const variables = {
      ward: query.ward,
      role: query.role ?? '',
      at: query.at ?? new Date(this.now()).toISOString(),
      testCode: query.testCode ?? '',
      severity: query.severity ?? 'critical',
    };
    const outcome = await this.complete(
      RECIPIENT_PROMPT,
      variables,
      RecipientResponseSchema,
      (parsed) => (parsed as z.infer<typeof RecipientResponseSchema>).candidates.map((c) => ({
        role: c.role,
        practitionerId: c.practitioner_id,
        confidence: c.confidence,
        reason: c.reason,
        source: 'model' as const,
        lowConfidence: c.confidence < 0.5,
      })),
    );

    if (outcome.ok) {
      return {
        ok: true,
        source: 'model',
        data: outcome.data,
        lowConfidence: outcome.data.every((c) => c.lowConfidence === true),
        audit: outcome.audit,
      };
    }

    const rule = this.fallback.suggestRecipients(query).map((c) => ({
      ...c, source: 'rule' as const, lowConfidence: true,
    }));
    return {
      ok: false,
      source: 'fallback_rules',
      data: rule,
      lowConfidence: true,
      errorCode: outcome.errorCode,
      fallbackReason: outcome.failureKind,
      audit: outcome.audit,
    };
  }

  /** 字段归因兜底（模型 → 规则兜底） */
  async attributeField(query: AttributionQuery): Promise<GatewayResult<FieldAttribution>> {
    const variables = {
      deviceCode: query.deviceCode,
      deviceDisplay: query.deviceDisplay,
      unit: query.unit ?? '',
    };
    const outcome = await this.complete(
      ATTRIBUTION_PROMPT,
      variables,
      AttributionResponseSchema,
      (parsed) => {
        const p = parsed as z.infer<typeof AttributionResponseSchema>;
        return {
          candidateLoinc: p.candidate_loinc,
          confidence: p.confidence,
          reason: p.reason,
          source: 'model' as const,
          lowConfidence: p.confidence < 0.5,
        };
      },
    );

    if (outcome.ok) {
      return { ok: true, source: 'model', data: outcome.data, lowConfidence: !!outcome.data.lowConfidence, audit: outcome.audit };
    }
    const rule = this.fallback.attributeField?.(query) ?? STATIC_FALLBACK.attributeField!(query);
    return {
      ok: false,
      source: 'fallback_rules',
      data: { ...rule, source: 'rule', lowConfidence: true },
      lowConfidence: true,
      errorCode: outcome.errorCode,
      fallbackReason: outcome.failureKind,
      audit: outcome.audit,
    };
  }

  /**
   * 降级时把「模型没帮上忙」写进本地审计链，outcome=partial。
   * 不推进 Task.status —— 护士与医生仍可手动 ack / resolve。
   */
  async writeFallbackAudit(taskId: string, errorCode: string): Promise<void> {
    if (!this.criticalStore) return;
    await this.criticalStore.writeAudit({
      task_id: taskId,
      agent: 'system/model-gateway',
      recorded: new Date(this.now()).toISOString(),
      source: 'lab-ops-console',
      outcome: 'partial',
      reason: 'model_fallback',
      context: { error_code: errorCode, low_confidence: true },
      dedupeKey: `model-fallback:${taskId}:${errorCode}`,
    });
  }

  /** OpenAI-compatible 单次 completion：请求 → 分类 → 解析 → 结构化校验 → 审计 */
  private async complete<S extends z.ZodTypeAny, T>(
    template: PromptTemplate,
    variables: Record<string, string>,
    schema: S,
    map: (parsed: z.infer<S>) => T,
  ): Promise<CompletionOutcome<T>> {
    const started = this.now();
    const messages = [
      { role: 'system', content: template.system },
      { role: 'user', content: renderPrompt(template, variables) },
    ];
    const promptHash = sha256(JSON.stringify(messages));
    const modelId = this.config?.model ?? 'unconfigured';
    const baseAudit = { modelId, promptHash, responseHash: sha256(''), latencyMs: 0, outcome: 'success' };

    const finish = (o: Omit<CompletionOutcome<T>, 'audit'> & { outcome: string; responseHash?: string }): CompletionOutcome<T> => {
      const audit = {
        modelId,
        promptHash,
        responseHash: o.responseHash ?? sha256(''),
        latencyMs: Math.max(0, this.now() - started),
        outcome: o.outcome,
      };
      this.auditor.write({
        model_id: audit.modelId,
        prompt_hash: audit.promptHash,
        response_hash: audit.responseHash,
        latency_ms: audit.latencyMs,
        outcome: audit.outcome,
        prompt_name: template.name,
        ...(o.errorCode ? { error_code: o.errorCode } : {}),
        source: o.ok ? 'model' : 'fallback_rules',
      });
      return {
        ok: o.ok,
        data: o.data,
        errorCode: o.errorCode,
        failureKind: o.failureKind,
        audit,
      };
    };

    if (!this.config) {
      return finish({
        ok: false, data: [] as unknown as T, errorCode: 'MODEL_CONFIG_MISSING',
        failureKind: 'http_5xx', outcome: 'fallback',
      });
    }

    const url = chatCompletionsUrl(this.config.baseUrl);
    const requestBody = {
      model: this.config.model,
      messages,
      response_format: { type: 'json_object' },
      stream: false,
      timeout: this.config.timeoutMs,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let responseText = '';
    try {
      const resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      responseText = await resp.text().catch(() => '');
      if (resp.status >= 500 || !resp.ok) {
        return finish({
          ok: false, data: [] as unknown as T, errorCode: FAILURE_MATRIX.http_5xx.errorCode,
          failureKind: 'http_5xx', outcome: 'fallback', responseHash: sha256(responseText),
        });
      }
    } catch (err) {
      const kind = classifyFetchError(err, controller.signal);
      return finish({
        ok: false, data: [] as unknown as T, errorCode: FAILURE_MATRIX[kind].errorCode,
        failureKind: kind, outcome: FAILURE_MATRIX[kind].auditOutcome, responseHash: sha256(''),
      });
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    try {
      json = JSON.parse(responseText);
    } catch {
      return finish({
        ok: false, data: [] as unknown as T, errorCode: FAILURE_MATRIX.unparsable.errorCode,
        failureKind: 'unparsable', outcome: 'fallback', responseHash: sha256(responseText),
      });
    }
    const content = (json as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return finish({
        ok: false, data: [] as unknown as T, errorCode: FAILURE_MATRIX.schema_mismatch.errorCode,
        failureKind: 'schema_mismatch', outcome: 'fallback', responseHash: sha256(responseText),
      });
    }
    let structured: unknown;
    try {
      structured = JSON.parse(content);
    } catch {
      return finish({
        ok: false, data: [] as unknown as T, errorCode: FAILURE_MATRIX.unparsable.errorCode,
        failureKind: 'unparsable', outcome: 'fallback', responseHash: sha256(responseText),
      });
    }
    const parsed = schema.safeParse(structured);
    if (!parsed.success) {
      return finish({
        ok: false, data: [] as unknown as T, errorCode: FAILURE_MATRIX.schema_mismatch.errorCode,
        failureKind: 'schema_mismatch', outcome: 'fallback', responseHash: sha256(responseText),
      });
    }
    return finish({
      ok: true, data: map(parsed.data), outcome: 'success', responseHash: sha256(responseText),
    });
  }
}

export { PROMPT_TEMPLATES };
