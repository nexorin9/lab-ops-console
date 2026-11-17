/**
 * T13 · 端到端真实路径：真实 TCP 报文 → 解析 / FHIR 写回 → 面板接口 → ack → resolve → 审计
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, makeCriticalFrame, pushTcpFrame, waitFor, api, postJson, type Harness } from './helpers.js';

let h: Harness;
let seq = 0;
const nextId = () => `CTRL-T13-${++seq}-${Date.now()}`;

beforeAll(async () => { h = await startHarness({ wallboardToken: 'wall-token-test' }); });
afterAll(async () => { await h?.stop(); });

describe('T13 · 网关与危急值闭环', () => {
  it('/healthz 返回 200；/api/channels 返回真实通道状态', async () => {
    const health = await api(h.httpPort, '/healthz');
    expect(health.status).toBe(200);
    expect(health.json.status).toBe('ok');
    const channels = await api(h.httpPort, '/api/channels');
    expect(channels.status).toBe(200);
    expect(channels.json.channels).toHaveLength(1);
    expect(channels.json.channels[0]).toMatchObject({ id: 'hl7-ingest', status: 'running' });
  });

  it('真实 TCP 推入危急值 ORU^R01 → /api/critical 出现未完成危急值', async () => {
    const frame = makeCriticalFrame(nextId());
    const ack = await pushTcpFrame(h.devicePort, frame);
    expect(ack).toContain('MSA|AA');
    const found = await waitFor(async () => {
      const r = await api(h.httpPort, '/api/critical');
      return r.json.count > 0 ? r.json : null;
    });
    expect(found.count).toBeGreaterThanOrEqual(1);
    expect(found.tasks[0].status).toBe('requested');
  });

  it('ack → 状态 received 且 AuditEvent 四字段落库；FHIR Task 可回读', async () => {
    const controlId = nextId();
    const ingest = await h.app.ingestFrame(makeCriticalFrame(controlId), { controlId });
    expect(ingest.ok).toBe(true);
    expect(ingest.criticalTasks).toHaveLength(1);
    const taskId = ingest.criticalTasks[0]!;

    const r = await api(h.httpPort, `/api/critical/${encodeURIComponent(taskId)}/ack`,
      postJson({ practitioner_id: 'nurse-01', role: 'nurse' }));
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('received');

    const chain = await api(h.httpPort, `/api/critical/${encodeURIComponent(taskId)}/audit`);
    expect(chain.json.chain.length).toBeGreaterThanOrEqual(2);
    for (const ev of chain.json.chain) {
      expect(ev.agent && ev.recorded && ev.source && ev.outcome).toBeTruthy();
    }
    const task = await h.writer.read('Task', taskId);
    expect(task?.status).toBe('received');
  });

  it('resolve → completed 且 DiagnosticReport.note 累加处置备注', async () => {
    const controlId = nextId();
    const ingest = await h.app.ingestFrame(makeCriticalFrame(controlId), { controlId });
    const taskId = ingest.criticalTasks[0]!;
    await api(h.httpPort, `/api/critical/${encodeURIComponent(taskId)}/ack`,
      postJson({ practitioner_id: 'nurse-02', role: 'nurse' }));
    const r = await api(h.httpPort, `/api/critical/${encodeURIComponent(taskId)}/resolve`,
      postJson({ practitioner_id: 'doc-01', resolution_note: '已安排透析' }));
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('completed');
    expect(r.json.notes).toContain('已安排透析');

    const report = await h.writer.read('DiagnosticReport', ingest.reportId);
    expect((report?.note as Array<{ text: string }> | undefined)?.map((n) => n.text)).toContain('已安排透析');
  });

  it('跳步（未 ack 直接 resolve）被 4xx 拒绝并写 denied AuditEvent', async () => {
    const controlId = nextId();
    const ingest = await h.app.ingestFrame(makeCriticalFrame(controlId), { controlId });
    const taskId = ingest.criticalTasks[0]!;
    const r = await api(h.httpPort, `/api/critical/${encodeURIComponent(taskId)}/resolve`,
      postJson({ practitioner_id: 'doc-02', resolution_note: '直接关闭' }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    const task = await h.app.store.getTask(taskId);
    expect(task?.status).toBe('requested');
    const chain = await h.app.store.queryAuditChain(taskId);
    expect(chain.some((a) => a.outcome === 'denied')).toBe(true);
  });

  it('护士站大屏 /critical 走独立口令；面板 / 可访问', async () => {
    const denied = await fetch(`http://127.0.0.1:${h.httpPort}/critical`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`http://127.0.0.1:${h.httpPort}/critical?token=wall-token-test`);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('html');
    const panel = await fetch(`http://127.0.0.1:${h.httpPort}/`);
    expect(panel.status).toBe(200);
    expect(await panel.text()).toContain('危急值');
  });
});
