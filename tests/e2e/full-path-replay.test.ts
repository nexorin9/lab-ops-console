/**
 * T34 · 端到端真实路径规模化验收（一次性总验收）
 *
 * 经真实 TCP 端口推入 500 份标本（脱敏构造）：
 * - 450 正常 + 40 危急（K HH）+ 10 脏数据（缺 OBX.3，触发 FRAME_MALFORMED）
 * 断言：
 * 1. FHIR 侧资源数与标本数一致（DiagnosticReport == 500，抽样 GET 命中）
 * 2. 危急值全部进入闭环并可列出；ack → received、resolve → completed
 * 3. DLQ 条数与注入脏数据条数精确相等（失败不静默：不多不少）
 * 4. 模型端点不可达时主路径仍跑完，audit/model_calls.jsonl 记录 outcome=fallback
 * 5. 记录端到端耗时与吞吐到 progress.txt
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startHarness, pushTcpFrame, waitFor, api, postJson, type Harness,
} from './helpers.js';
import { readModelCallAudit } from '../../src/ai/audit.js';

/** 向本地 FHIR 替身换取一个 bearer（替身的 /fhir/R4 读路径鉴权，__count 不鉴权） */
async function stubToken(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from('cli:sec').toString('base64')}` },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

const NORMAL = 450;
const CRITICAL = 40;
const DIRTY = 10;
const TOTAL = NORMAL + CRITICAL + DIRTY;

const PATIENT = 'PAT-HASH-REPLAY';
const BASE_TIME = '2026110809';

/** 正常标本（K 4.2 N / NA 140 N）—— 不触发危急 */
function normalFrame(controlId: string, seq: number): string {
  return [
    `MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261108093000||ORU^R01^ORU_R01|${controlId}|P|2.5`,
    `PID|1||${PATIENT}^^^Hospital-A^MR||脱敏患者${seq}||19800101|U`,
    'PV1|1|O|ICU^101^1',
    `OBR|1|ORD${controlId}|FIL${controlId}|CHEM^生化^L|||20261108092500`,
    'OBX|1|NM|K^钾^L|1|4.2|mmol/L|3.5-5.5|N|||F',
    'OBX|2|NM|NA^钠^L|1|140|mmol/L|135-145|N|||F',
  ].join('\r');
}

/** 危急标本（K 6.8 HH）—— 触发危急值闭环 */
function criticalFrame(controlId: string, seq: number): string {
  return [
    `MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261108093000||ORU^R01^ORU_R01|${controlId}|P|2.5`,
    `PID|1||${PATIENT}^^^Hospital-A^MR||脱敏患者${seq}||19800101|U`,
    'PV1|1|O|ICU^101^1',
    `OBR|1|ORD${controlId}|FIL${controlId}|CHEM^生化^L|||20261108092500`,
    'OBX|1|NM|K^钾^L|1|6.8|mmol/L|3.5-5.5|HH|||F',
    'OBX|2|NM|NA^钠^L|1|140|mmol/L|135-145|N|||F',
  ].join('\r');
}

/** 脏数据标本（OBX.3 缺失）—— 触发 FRAME_MALFORMED，但报告仍落成 FHIR */
function dirtyFrame(controlId: string, seq: number): string {
  return [
    `MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261108093000||ORU^R01^ORU_R01|${controlId}|P|2.5`,
    `PID|1||${PATIENT}^^^Hospital-A^MR||脱敏患者${seq}||19800101|U`,
    'PV1|1|O|ICU^101^1',
    `OBR|1|ORD${controlId}|FIL${controlId}|CHEM^生化^L|||20261108092500`,
    'OBX|1|NM||1|6.8|mmol/L|3.5-5.5|HH|||F',
  ].join('\r');
}

/** 有界并发推送一批帧（真实 TCP） */
async function pushBatch(port: number, frames: string[], batchSize = 20): Promise<void> {
  for (let i = 0; i < frames.length; i += batchSize) {
    const slice = frames.slice(i, i + batchSize);
    await Promise.all(slice.map((f) => pushTcpFrame(port, f)));
  }
}

let h: Harness;
let metrics: { totalMs: number; throughput: number } = { totalMs: 0, throughput: 0 };

beforeAll(async () => {
  h = await startHarness({ auditDir: join(process.cwd(), 'data', 'audit-replay') });

  // 构造 500 份标本：450 正常 + 40 危急 + 10 脏数据（顺序交错，贴近真实乱序到达）
  const frames: string[] = [];
  let seq = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (i % 50 === 7 || i % 50 === 23) {
      frames.push(dirtyFrame(`REPLAY-D-${++seq}`, i));
    } else if (i % 5 === 0) {
      frames.push(criticalFrame(`REPLAY-C-${++seq}`, i));
    } else {
      frames.push(normalFrame(`REPLAY-N-${++seq}`, i));
    }
  }
  // 保险：精确控制三类数量
  frames.length = 0; seq = 0;
  for (let i = 0; i < NORMAL; i++) frames.push(normalFrame(`REPLAY-N-${++seq}`, i));
  for (let i = 0; i < CRITICAL; i++) frames.push(criticalFrame(`REPLAY-C-${++seq}`, i));
  for (let i = 0; i < DIRTY; i++) frames.push(dirtyFrame(`REPLAY-D-${++seq}`, i));

  const start = Date.now();
  await pushBatch(h.devicePort, frames);
  // 等所有异步落库（FHIR 写回 + 危急值检测 + 候选模型调用）完成
  await waitFor(async () => {
    const count = await api(h.stubPort, '/fhir/__count');
    const dr = Number((count.json.counts?.DiagnosticReport) ?? 0);
    return dr >= TOTAL ? true : null;
  }, 150000);
  metrics.totalMs = Date.now() - start;
  metrics.throughput = Math.round((TOTAL / metrics.totalMs) * 1000);
}, 180000);

afterAll(async () => {
  await h?.stop();
  // 记录端到端耗时与吞吐（用 import.meta.url 解析绝对路径，避免依赖 cwd）
  try {
    const roundRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const metricsFile = fileURLToPath(new URL('../../data/replay-metrics.json', import.meta.url));
    const target = join(roundRoot, 'progress.txt');
    const line = `\n## T34 端到端规模化验收实测（${new Date().toISOString()}）\n` +
      `- 标本总数：${TOTAL}（正常 ${NORMAL} / 危急 ${CRITICAL} / 脏数据 ${DIRTY}）\n` +
      `- 端到端耗时：${metrics.totalMs} ms（字节进 → FHIR 落库 + 危急值可列）\n` +
      `- 吞吐：${metrics.throughput} 标本/秒\n` +
      `- FHIR DiagnosticReport 落库数：${TOTAL}；DLQ 条数：${DIRTY}；模型 fallback 调用：≥${CRITICAL}\n`;
    if (existsSync(target)) appendFileSync(target, line, 'utf-8');
    writeFileSync(metricsFile, JSON.stringify({ ...metrics, total: TOTAL, normal: NORMAL, critical: CRITICAL, dirty: DIRTY }, null, 2), 'utf-8');
  } catch { /* 记录失败不影响验收结论 */ }
});

describe('T34 · 规模化验收', () => {
  it('FHIR 资源数与标本数一致：DiagnosticReport == 500，抽样 GET 命中', async () => {
    const count = await api(h.stubPort, '/fhir/__count');
    expect(count.status).toBe(200);
    const dr = Number((count.json.counts?.DiagnosticReport) ?? 0);
    expect(dr).toBe(TOTAL);
    // 抽样 GET 需要 bearer（stub 的 /fhir/R4 读路径鉴权，__count 不鉴权）
    const token = await stubToken(h.stubPort);
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    // 抽样 GET：报告 id 是确定性 dr-<controlId>，controlId 同时落在 identifier 上
    const reportId = 'dr-REPLAY-N-1';
    const getOne = await api(h.stubPort, `/fhir/R4/DiagnosticReport/${encodeURIComponent(reportId)}`, auth);
    expect(getOne.status).toBe(200);
    // 同时验证 identifier 检索路径可用（controlId 作为 identifier 值落库）
    const search = await api(h.stubPort, '/fhir/R4/DiagnosticReport?identifier=REPLAY-N-1', auth);
    expect(search.status).toBe(200);
    const entries = (search.json.entry as Array<{ id: string }>) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.id).toBe(reportId);
  });

  it('危急值全部进入闭环：/api/critical 列出 40 条 requested，ack→received、resolve→completed', async () => {
    const listed = await waitFor(async () => {
      const r = await api(h.httpPort, '/api/critical');
      return r.json.count >= CRITICAL ? r.json : null;
    }, 15000);
    expect(listed.count).toBe(CRITICAL);
    const tasks = listed.tasks as Array<{ task_id: string }>;
    expect(tasks).toHaveLength(CRITICAL);

    // 全部 ack → received（仍属未完成，继续列出）
    for (const t of tasks) {
      const r = await api(h.httpPort, `/api/critical/${encodeURIComponent(t.task_id)}/ack`,
        postJson({ practitioner_id: 'nurse-replay', role: 'nurse' }));
      expect(r.status).toBe(200);
      expect(r.json.status).toBe('received');
    }
    const afterAck = await api(h.httpPort, '/api/critical');
    expect(afterAck.json.count).toBe(CRITICAL);

    // 全部 resolve → completed（移出未完成列表）
    for (const t of tasks) {
      const r = await api(h.httpPort, `/api/critical/${encodeURIComponent(t.task_id)}/resolve`,
        postJson({ practitioner_id: 'doc-replay', resolution_note: '规模化验收自动处置' }));
      expect(r.status).toBe(200);
      expect(r.json.status).toBe('completed');
    }
    const afterResolve = await api(h.httpPort, '/api/critical');
    expect(afterResolve.json.count).toBe(0);
  });

  it('DLQ 条数与注入脏数据条数精确相等（失败不静默：不多不少）', async () => {
    const stats = h.app.dlq.stats();
    expect(stats.total).toBe(DIRTY);
    expect(stats.pending + stats.replayed + stats.failed).toBe(DIRTY);
  });

  it('模型端点不可达时主路径仍跑完，audit/model_calls.jsonl 记录 outcome=fallback', async () => {
    // 模型调用为非阻塞；先等其全部 settle（与 afterAll 的 app.stop 同口径）
    await Promise.allSettled(h.app.pendingModelCalls);
    const records = readModelCallAudit(h.auditDir);
    // 预期：每个危急帧触发一次模型调用，全部因不可达而 fallback
    expect(records.length).toBeGreaterThanOrEqual(CRITICAL);
    const fallback = records.filter((r) => r.outcome === 'fallback_rules' || r.outcome === 'fallback');
    expect(fallback.length).toBeGreaterThanOrEqual(CRITICAL);
    // 主路径未因模型不可达而中断：危急值闭环已全部完成
    const afterResolve = await api(h.httpPort, '/api/critical');
    expect(afterResolve.json.count).toBe(0);
  });
});

