import { describe, it, expect } from 'vitest';
import { ModelGateway } from '../../src/ai/ModelGateway.js';
import type { ModelConfig } from '../../src/ai/config.js';

const CONFIG: ModelConfig = {
  baseUrl: 'http://model.example/v1',
  apiKey: 'test-key',
  model: 'lab-model-1',
  timeoutMs: 1000,
};

/** 捕获请求体并返回合法 OpenAI 形状的响应 */
function mockFetch(capture: { body: any }) {
  return (async (url: string, init: any) => {
    capture.body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          candidates: [{ role: 'ICU 护士', practitioner_id: 'ICU-1', confidence: 0.9, reason: '血钾危急送 ICU' }],
        }) } }],
      }),
    };
  }) as unknown as typeof fetch;
}

describe('T29 · ModelGateway 协议兼容性（OpenAI-compatible 逐字段）', () => {
  it('请求体严格是 OpenAI chat/completions 形状', async () => {
    const capture: { body: any } = { body: null };
    const gw = new ModelGateway({ config: CONFIG, fetchImpl: mockFetch(capture) });
    await gw.suggestRecipients({ ward: 'ICU', severity: 'critical' });
    const body = capture.body;
    expect(body.model).toBe('lab-model-1');
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);
    expect(body.timeout).toBe(1000);
  });

  it('Authorization 头携带 Bearer token（不落明文到日志由 auditor 负责）', async () => {
    const captures: any[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      captures.push(init.headers);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }] }) } as any;
    }) as unknown as typeof fetch;
    const gw = new ModelGateway({ config: CONFIG, fetchImpl });
    // 触发一次调用（schema 校验会失败，但头已捕获）
    await gw.suggestRecipients({ ward: 'ICU' });
    expect(captures[0].Authorization).toBe('Bearer test-key');
  });

  it('响应体 choices[0].message.content 内 JSON 被解析为结构化对象', async () => {
    const capture: { body: any } = { body: null };
    const gw = new ModelGateway({ config: CONFIG, fetchImpl: mockFetch(capture) });
    const r = await gw.suggestRecipients({ ward: 'ICU', severity: 'critical' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('model');
    expect(r.data[0]).toMatchObject({ role: 'ICU 护士', practitionerId: 'ICU-1', confidence: 0.9, source: 'model' });
  });

  it('候选 confidence < 0.5 自动标 lowConfidence', async () => {
    const fetchImpl = (async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        candidates: [{ role: 'X', practitioner_id: 'P', confidence: 0.3, reason: 'r' }],
      }) } }] }),
    })) as unknown as typeof fetch;
    const gw = new ModelGateway({ config: CONFIG, fetchImpl });
    const r = await gw.suggestRecipients({ ward: 'ICU' });
    expect(r.data[0].lowConfidence).toBe(true);
  });

  it('describe() 不泄露 apiKey，可显示供应商形态', () => {
    const gw = new ModelGateway({ config: CONFIG });
    const d = gw.describe();
    expect(d.baseUrl).toBe('http://model.example/v1');
    expect(d.model).toBe('lab-model-1');
    expect(d.timeoutMs).toBe(1000);
    expect(d.configured).toBe(true);
    expect(JSON.stringify(d)).not.toContain('test-key');
  });
});
