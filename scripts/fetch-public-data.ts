/**
 * T14 · 公开语料拉取（可选底座），断网 / 超时 / 未配置一律降级到本地确定性合成器。
 *
 * 约定：无论成功与否退出码都是 0 —— 数据工场不能因为外网不通就把整条流水线卡死。
 * 失败时打印中文降级原因并写 data/public/fallback.json 留痕。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TIMEOUT_MS = 5_000;

export async function fetchPublicData(opts: {
  url?: string | null;
  outDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<{ source: 'public' | 'local-synthetic'; reason: string }> {
  const url = opts.url ?? process.env.PUBLIC_DATA_URL ?? '';
  const outDir = opts.outDir ?? join(process.env.DATA_DIR ?? './data', 'public');
  mkdirSync(outDir, { recursive: true });

  if (!url.trim()) {
    const reason = 'PUBLIC_DATA_URL 未配置，降级到本地固定 seed 合成器';
    writeFileSync(join(outDir, 'fallback.json'), `${JSON.stringify({ source: 'local-synthetic', reason }, null, 2)}\n`, 'utf-8');
    process.stdout.write(`[数据工场] ${reason}\n`);
    return { source: 'local-synthetic', reason };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    writeFileSync(join(outDir, 'sample-corpus.txt'), text, 'utf-8');
    writeFileSync(join(outDir, 'source.json'), `${JSON.stringify({ source: 'public', url, bytes: text.length }, null, 2)}\n`, 'utf-8');
    process.stdout.write(`[数据工场] 公开语料已拉取：${text.length} 字节（仅作对照底座，样本仍由本地合成器产出）\n`);
    return { source: 'public', reason: '公开语料已拉取' };
  } catch (err) {
    const reason = `公开语料拉取失败（${err instanceof Error ? err.message : String(err)}），降级到本地固定 seed 合成器`;
    writeFileSync(join(outDir, 'fallback.json'), `${JSON.stringify({ source: 'local-synthetic', reason, url }, null, 2)}\n`, 'utf-8');
    process.stdout.write(`[数据工场] ${reason}\n`);
    return { source: 'local-synthetic', reason };
  } finally {
    clearTimeout(timer);
  }
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('fetch-public-data.ts');
if (isDirectRun) {
  fetchPublicData().then(() => process.exit(0)).catch(() => process.exit(0));
}
