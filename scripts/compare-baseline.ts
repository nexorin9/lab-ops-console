/**
 * T29 · 与规则查表基线的字段一致率对照
 *
 * 目的：证明 ModelGateway 的模型输出与规则兜底（oncall / dictionary）共用**同一套候选契约**，
 * 业务层拿到候选后无需区分来源即可使用（spec §6「规则兜底无缝接管」）。
 *
 * 做法：用一份确定性的样例 query，分别取得「规则基线候选」与「模型形状候选」（经 ModelGateway
 * 真实协议栈解析），逐字段比对契约（字段集合 + 类型），给出一致率。
 * - 一致率 100% → RESULT=PASS（模型与规则同构）
 * - 任一候选缺字段 / 类型不符 → RESULT=FAIL，并列出差异
 *
 * 该脚本可复现：固定样例、无网络、无随机。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelGateway } from '../src/ai/ModelGateway.js';
import type { Candidate, RecipientQuery } from '../src/ai/types.js';
import type { ModelConfig } from '../src/ai/config.js';

const CONFIG: ModelConfig = { baseUrl: 'http://model.local/v1', apiKey: 'x', model: 'm', timeoutMs: 1000 };

/** 规则基线：确定性候选契约（与 oncall / dictionary 同源） */
const BASELINE_KEYS: Array<keyof Candidate> = ['role', 'practitionerId', 'confidence', 'reason', 'source', 'lowConfidence'];
const BASELINE_TYPES: Record<keyof Candidate, string> = {
  role: 'string', practitionerId: 'string', confidence: 'number', reason: 'string', source: 'string', lowConfidence: 'boolean',
};

const SAMPLE_QUERIES: RecipientQuery[] = [
  { ward: 'ICU', severity: 'critical', testCode: 'K' },
  { ward: '急诊', severity: 'critical', testCode: 'GLU' },
  { ward: 'CCU', severity: 'critical', testCode: 'TNI' },
  { ward: '儿科', severity: 'critical', testCode: 'NA' },
];

/** 规则基线候选（与 ModelGateway 规则兜底同构，作为对照基准） */
function baselineCandidates(q: RecipientQuery): Candidate[] {
  return [{
    role: `${q.ward}值班护士`,
    practitionerId: `${q.ward}-oncall`,
    confidence: 0.2,
    reason: '规则基线：默认值班角色',
    source: 'rule',
    lowConfidence: true,
  }];
}

/** mock 模型：返回与规则基线同构的结构化数据（证明同契约） */
function mockModelFetch(capture: { calls: number }) {
  return (async (_u: string, init: any) => {
    capture.calls++;
    const body = JSON.parse(init.body);
    const user = body.messages[1].content as string;
    const ward = /ICU|急诊|CCU|儿科/.exec(user)?.[0] ?? '通用';
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        candidates: [{ role: `${ward}值班护士`, practitioner_id: `${ward}-model`, confidence: 0.88, reason: '模型研判送本科室' }],
      }) } }] }),
    };
  }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  const capture = { calls: 0 };
  const gw = new ModelGateway({ config: CONFIG, fetchImpl: mockModelFetch(capture) });

  const rows: Array<Record<string, unknown>> = [];
  let consistent = 0;
  let total = 0;
  const diffs: string[] = [];

  for (const q of SAMPLE_QUERIES) {
    const baseline = baselineCandidates(q);
    const r = await gw.suggestRecipients(q);
    const model = r.data as Candidate[];
    // 逐字段比对：集合与类型
    for (let i = 0; i < Math.max(baseline.length, model.length); i++) {
      const b = baseline[i]!;
      const m = model[i]!;
      for (const key of BASELINE_KEYS) {
        total++;
        const typeOk = typeof m[key] === BASELINE_TYPES[key];
        const present = key in m;
        if (present && typeOk) consistent++;
        else diffs.push(`${q.ward}:${key} (present=${present}, typeOk=${typeOk})`);
      }
    }
    rows.push({ ward: q.ward, baselineCount: baseline.length, modelCount: model.length, modelSource: r.source });
  }

  const rate = total === 0 ? 1 : consistent / total;
  const passed = rate === 1 && diffs.length === 0;
  const report = {
    generatedAt: new Date().toISOString(),
    baselineKeys: BASELINE_KEYS,
    baselineTypes: BASELINE_TYPES,
    samples: rows,
    fieldTotal: total,
    fieldConsistent: consistent,
    consistencyRate: Number(rate.toFixed(4)),
    diffs,
    modelCalls: capture.calls,
    result: passed ? 'PASS' : 'FAIL',
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'compare-baseline.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  process.stdout.write(`[对照] 模型 vs 规则基线 字段一致率 = ${(rate * 100).toFixed(1)}% (${consistent}/${total})\n`);
  process.stdout.write(`[对照] 报告已写入 ${outPath}\n`);
  process.stdout.write(`RESULT=${passed ? 'PASS' : 'FAIL'}\n`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[对照] 运行失败：${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
