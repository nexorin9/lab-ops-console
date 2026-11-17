import { describe, it, expect } from 'vitest';
import {
  FAILURE_MATRIX, FAILURE_KINDS, semanticsFor,
  type FailureKind,
} from '../../src/ai/failure-matrix.js';
import { ModelGateway, classifyFetchError } from '../../src/ai/ModelGateway.js';
import type { ModelConfig } from '../../src/ai/config.js';

const CONFIG: ModelConfig = { baseUrl: 'http://model.example/v1', apiKey: 'k', model: 'm', timeoutMs: 1000 };

/** 用 mock fetch 制造四类失败 */
function failFetch(kind: 'timeout' | 'http_5xx' | 'unparsable' | 'schema_mismatch') {
  if (kind === 'timeout') {
    return (async (_u: string, init: any) => {
      init.signal?.throwIfAborted?.();
      throw new Error('The operation was aborted');
    }) as unknown as typeof fetch;
  }
  if (kind === 'http_5xx') {
    return (async () => ({ ok: false, status: 503, text: async () => 'unavailable' }) as any) as unknown as typeof fetch;
  }
  if (kind === 'unparsable') {
    return (async () => ({ ok: true, status: 200, text: async () => '{not json' }) as any) as unknown as typeof fetch;
  }
  // schema_mismatch：返回合法 JSON 但缺 candidates 字段
  return (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ foo: 1 }) } }] }) }) as any) as unknown as typeof fetch;
}

describe('T29 · 四类失败语义矩阵（错误码 / 降级 / 审计 outcome 钉死）', () => {
  it('矩阵恰好覆盖四类失败，且全部降级到规则、审计记 fallback', () => {
    expect(FAILURE_KINDS.sort()).toEqual(['http_5xx', 'schema_mismatch', 'timeout', 'unparsable'].sort());
    for (const kind of FAILURE_KINDS) {
      const s = semanticsFor(kind);
      expect(s.errorCode).toBeTruthy();
      expect(s.fallbackAction).toBe('rules_fallback');
      expect(s.auditOutcome).toBe('fallback');
    }
  });

  it('每个错误码各不相同，可单独立案追溯', () => {
    const codes = FAILURE_KINDS.map((k) => FAILURE_MATRIX[k].errorCode);
    expect(new Set(codes).size).toBe(4);
  });

  it('classifyFetchError：abort/timeout → timeout，其余网络异常 → http_5xx', () => {
    const aborted = { aborted: true } as AbortSignal;
    expect(classifyFetchError(new Error('The operation was aborted'), aborted)).toBe('timeout');
    expect(classifyFetchError(new Error('fetch failed'), undefined)).toBe('http_5xx');
  });

  it('网关对四类失败均返回 fallback_rules 候选并带对应 errorCode', async () => {
    for (const kind of FAILURE_KINDS) {
      const gw = new ModelGateway({ config: CONFIG, fetchImpl: failFetch(kind) });
      const r = await gw.suggestRecipients({ ward: 'ICU' });
      expect(r.ok).toBe(false);
      expect(r.source).toBe('fallback_rules');
      expect(r.errorCode).toBe(FAILURE_MATRIX[kind].errorCode);
      expect(r.data[0].source).toBe('rule');
      expect(r.data[0].lowConfidence).toBe(true);
    }
  });

  it('成功调用审计 outcome=success，失败调用 outcome=fallback', async () => {
    const okFetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [{ role: 'ICU 护士', practitioner_id: 'ICU-1', confidence: 0.9, reason: 'r' }] }) } }] }) }) as any) as unknown as typeof fetch;
    const gw = new ModelGateway({ config: CONFIG, fetchImpl: okFetch });
    const ok = await gw.suggestRecipients({ ward: 'ICU' });
    expect(ok.audit.outcome).toBe('success');
    // 同网关触发一次失败
    const gw2 = new ModelGateway({ config: CONFIG, fetchImpl: failFetch('timeout') });
    const bad = await gw2.suggestRecipients({ ward: 'ICU' });
    expect(bad.audit.outcome).toBe('fallback');
  });
});
