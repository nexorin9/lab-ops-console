/**
 * T14 · 确定性验收：同 seed 两次生成，逐文件 sha256 必须一致。
 * 退出码 0 = 一致；1 = 不一致或产物缺失。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { generateStreams } from './generate-synthetic-stream.js';

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, join(prefix, entry)));
    else out.push(join(prefix, entry));
  }
  return out.sort();
}

function hashTree(dir: string): Map<string, string> {
  return new Map(listFiles(dir).map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
}

const a = mkdtempSync(join(tmpdir(), 'lab-det-a-'));
const b = mkdtempSync(join(tmpdir(), 'lab-det-b-'));
try {
  const opts = { specimens: 200, criticalRate: 0.15, seed: 20261108 };
  generateStreams({ ...opts, outDir: a });
  generateStreams({ ...opts, outDir: b });
  const ha = hashTree(a);
  const hb = hashTree(b);
  const keys = [...new Set([...ha.keys(), ...hb.keys()])].sort();
  const diffs = keys.filter((k) => ha.get(k) !== hb.get(k));
  for (const k of keys) {
    process.stdout.write(`${ha.get(k) === hb.get(k) ? 'OK  ' : 'DIFF'} ${relative(a, k)} ${ha.get(k)?.slice(0, 16) ?? 'missing'} / ${hb.get(k)?.slice(0, 16) ?? 'missing'}\n`);
  }
  if (diffs.length > 0 || keys.length < 4) {
    process.stderr.write(`RESULT=FAIL（${diffs.length} 个文件不一致，文件数 ${keys.length}）\n`);
    process.exit(1);
  }
  process.stdout.write(`RESULT=PASS（${keys.length} 个文件同 seed 逐字节一致）\n`);
} finally {
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
}
