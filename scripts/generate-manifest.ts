/**
 * 数据工场 manifest —— 记录来源、条数、seed、协议分布与生成时间锚点。
 *
 * 时间锚点按 seed 确定性推导（不取墙钟），保证同 seed 两次生成的产物逐字节一致，
 * 让 sha256 对照成为可复核的确定性验收，而不是「看起来差不多」。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_TIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export interface ManifestCounts {
  specimens: number;
  critical: number;
  dirty: {
    total: number;
    gbkMixed: number;
    missingRequired: number;
    /** 会被入站层拦进 DLQ 的脏帧数（失败不静默，逐条可对账） */
    dlqExpected: number;
  };
  duplicate: number;
}

export interface StreamManifest {
  source: 'public' | 'local-synthetic';
  seed: number;
  specimens: number;
  critical: number;
  dirty: ManifestCounts['dirty'];
  duplicate: number;
  protocols: Record<string, number>;
  criticalRate: number;
  generatedAt: string;
  files: string[];
}

export interface WriteManifestInput {
  outDir: string;
  source?: 'public' | 'local-synthetic';
  seed: number;
  counts: ManifestCounts;
  criticalRate: number;
  files: string[];
}

export function writeManifest(input: WriteManifestInput): StreamManifest {
  const manifest: StreamManifest = {
    source: input.source ?? 'local-synthetic',
    seed: input.seed,
    specimens: input.counts.specimens,
    critical: input.counts.critical,
    dirty: input.counts.dirty,
    duplicate: input.counts.duplicate,
    protocols: {
      'hl7-oru-r01': input.counts.specimens,
      'astm-e1394': input.counts.specimens,
      'private-bytes': input.counts.specimens,
    },
    criticalRate: input.criticalRate,
    generatedAt: new Date(BASE_TIME_MS + input.seed * 1000).toISOString(),
    files: input.files,
  };
  mkdirSync(input.outDir, { recursive: true });
  writeFileSync(join(input.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return manifest;
}
