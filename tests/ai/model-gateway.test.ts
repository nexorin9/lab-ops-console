/**
 * T12 · ModelGateway（OpenAI-compatible 单协议面 + 结构化输出 + 规则兜底 + 调用审计）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  ModelGateway,
  readModelConfig,
  chatCompletionsUrl,
  createModelCallAuditor,
  readModelCallAudit,
  FAILURE_MATRIX,
  type ModelConfig,
} from '../../src/ai/index.js';
import { CriticalStore } from '../../src/critical/index.js';
import { EnvMissingError } from '../../src/shared/errors.js';

let auditDir: string;
const config: ModelConfig = {
  baseUrl: 'http://127.0.0.1:9998/v1',
  apiKey: 'test-key',
  model: 'hospital-qwen',
  timeoutMs: 500,
};

function okFetch(content: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify({
      id: 'chatcmpl-1',
      choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }],
    }),
  })) as unknown as typeof fetch;
}

function gateway(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new ModelGateway({
    config,
    fetchImpl,
    auditor: createModelCallAuditor(auditDir),
    ...extra,
  });
}

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'lab-ai-audit-'));
});
afterEach(() => rmSync(auditDir, { recursive: true, force: true }));

describe('T12 · OpenAI-compatible 协议与配置', () => {
  it('请求体逐字段符合协议：model / messages / response_format / stream / timeout + Bearer 头', async () => {
    const f = okFetch({ candidates: [{ role: '护士', practitioner_id: 'n-1', confidence: 0.9, reason: '当班' }] });
    await gateway(f).suggestRecipients({ ward: 'ICU', testCode: 'K' });
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = (f as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]!;
    expect(url).toBe(chatCompletionsUrl(config.baseUrl));
    expect(url).toContain('/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${config.apiKey}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('hospital-qwen');
    expect(Array.isArray(body.messages)).toBe(true);
    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    expect(body.timeout).toBe(500);
  });

  it('结构化响应解析为统一 Candidate（snake_case → practitionerId）', async () => {
    const f = okFetch({ candidates: [{ role: '值班护士', practitioner_id: 'n-9', confidence: 0.88, reason: '夜班当值' }] });
    const r = await gateway(f).suggestRecipients({ ward: '急诊', role: '值班护士' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('model');
    expect(r.data[0]).toMatchObject({ role: '值班护士', practitionerId: 'n-9', confidence: 0.88, source: 'model' });
    expect(r.audit.outcome).toBe('success');
  });

  it('字段归因走同一网关并解析出 candidate_loinc', async () => {
    const f = okFetch({ candidate_loinc: '2823-3', confidence: 0.92, reason: '血钾项目' });
    const r = await gateway(f).attributeField({ deviceCode: 'K', deviceDisplay: '钾' });
    expect(r.ok).toBe(true);
    expect(r.data.candidateLoinc).toBe('2823-3');
    expect(r.data.source).toBe('model');
  });

  it('配置缺失时 readModelConfig 点名缺哪个 env，网关不阻塞主路径', () => {
    expect(() => readModelConfig({})).toThrow(EnvMissingError);
    expect(() => readModelConfig({})).toThrow(/MODELS_BASE_URL/);
    const g = new ModelGateway({ config: undefined, env: {}, auditor: createModelCallAuditor(auditDir) });
    expect(g.describe().configured).toBe(false);
  });
});

describe('T12 · 四类失败降级与审计', () => {
  it('超时 → 规则兜底，候选标 low_confidence，审计 outcome=fallback', async () => {
    const slow = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
      });
    })) as unknown as typeof fetch;
    const g = new ModelGateway({
      config: { ...config, timeoutMs: 20 }, fetchImpl: slow, auditor: createModelCallAuditor(auditDir),
    });
    const r = await g.suggestRecipients({ ward: 'ICU' });
    expect(r.ok).toBe(false);
    expect(r.source).toBe('fallback_rules');
    expect(r.lowConfidence).toBe(true);
    expect(r.data.every((c) => c.lowConfidence === true)).toBe(true);
    expect(r.errorCode).toBe(FAILURE_MATRIX.timeout.errorCode);
    expect(r.audit.outcome).toBe('fallback');
  });

  it('5xx → 按矩阵归类为 MODEL_HTTP_5XX 并降级', async () => {
    const r = await gateway(okFetch({}, 503)).suggestRecipients({ ward: 'ICU' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(FAILURE_MATRIX.http_5xx.errorCode);
    expect(r.audit.outcome).toBe('fallback');
  });

  it('返回不可解析 → 降级（不把 undefined 扩散给业务层）', async () => {
    const r = await gateway(okFetch('not-json')).suggestRecipients({ ward: 'ICU' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(FAILURE_MATRIX.unparsable.errorCode);
    expect(r.data.length).toBeGreaterThan(0);
  });

  it('结构化字段缺失 → 降级到规则', async () => {
    const r = await gateway(okFetch({ candidates: [{ role: 'nurse' }] })).suggestRecipients({ ward: 'ICU' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe(FAILURE_MATRIX.schema_mismatch.errorCode);
    expect(r.data[0]!.source).toBe('rule');
  });

  it('自定义规则兜底命中且候选不为空、标低置信度', async () => {
    const fallback = {
      suggestRecipients: () => [{
        role: '科主任', practitionerId: 'chief-1', confidence: 0.3,
        reason: '值班表命中', source: 'rule' as const, lowConfidence: true,
      }],
    };
    const r = await gateway(okFetch({}, 500), { fallback }).suggestRecipients({ ward: 'ICU' });
    expect(r.source).toBe('fallback_rules');
    expect(r.data[0]!.practitionerId).toBe('chief-1');
    expect(r.data[0]!.lowConfidence).toBe(true);
  });

  it('audit/model_calls.jsonl 每行含五字段且可回读', async () => {
    await gateway(okFetch({ candidates: [{ role: 'n', practitioner_id: 'n1', confidence: 0.7, reason: 'r' }] }))
      .suggestRecipients({ ward: 'ICU' });
    await gateway(okFetch({}, 500)).suggestRecipients({ ward: 'ICU' });
    const lines = readModelCallAudit(auditDir);
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(typeof line.model_id).toBe('string');
      expect(line.prompt_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(line.response_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof line.latency_ms).toBe('number');
      expect(['success', 'fallback', 'partial']).toContain(line.outcome);
    }
    expect(lines[1]!.outcome).toBe('fallback');
    const raw = readFileSync(join(auditDir, 'model_calls.jsonl'), 'utf-8').trim().split('\n');
    expect(raw).toHaveLength(2);
  });

  it('降级写本地 AuditEvent.outcome=partial，且不推进任何 Task 状态', async () => {
    const db = new Database(':memory:');
    const store = CriticalStore.withDb(db);
    const g = gateway(okFetch({}, 500), { criticalStore: store });
    await g.writeFallbackAudit('task-fallback-1', 'MODEL_HTTP_5XX');
    const chain = await store.queryAuditChain('task-fallback-1');
    expect(chain).toHaveLength(1);
    expect(chain[0]!.outcome).toBe('partial');
    expect(chain[0]!.reason).toBe('model_fallback');
    db.close();
  });

  it('业务层无任何厂商 SDK 依赖（src/ai 下不 import openai/anthropic SDK）', () => {
    const dir = resolve(process.cwd(), 'src/ai');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const src = readFileSync(join(dir, file), 'utf-8');
      expect(src).not.toMatch(/from\s+['"](openai|@anthropic-ai\/sdk|anthropic)['"]/);
    }
    expect(files.length).toBeGreaterThanOrEqual(5);
  });
});
