/**
 * T14 数据工场 —— 固定 seed 的确定性合成仪器流（不使用 Math.random）
 *
 * 产物（全部落 data/，gitignored）：
 *   data/streams/hl7-oru-r01.jsonl     HL7 v2 ORU^R01 帧
 *   data/streams/astm-e1394.jsonl      ASTM E1394 record（%XX 控制字符）
 *   data/streams/private-bytes.jsonl   厂商私有协议字节帧（hex）
 *   data/manifest.json                 来源 / 条数 / seed / 协议分布
 *
 * 用法：npm run gen:data -- --specimens 2000 --critical-rate 0.015 --seed 20261108
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { writeManifest, type ManifestCounts } from './generate-manifest.js';

export interface GenerateOptions {
  specimens: number;
  criticalRate: number;
  seed: number;
  outDir: string;
  source?: 'public' | 'local-synthetic';
}

export interface SyntheticRecord {
  seq: number;
  controlId: string;
  category: 'normal' | 'critical' | 'dirty' | 'duplicate';
  dirtyType?: 'gbk_mixed' | 'missing_required';
  encoding: 'utf-8' | 'gbk';
  /** base64 原始字节（含帧边界可由回放器自行加） */
  frameBase64: string;
  patientId: string;
  ward: string;
  testCode: string;
  testDisplay: string;
  value: string;
  unit: string;
  severity: string;
}

/** mulberry32 —— 32 位确定性 PRNG；同 seed 必然产出同一串数 */
export function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PANELS = [
  { code: 'K', display: '钾', unit: 'mmol/L', normal: 4.2, critical: 6.8, flag: 'HH' },
  { code: 'NA', display: '钠', unit: 'mmol/L', normal: 140, critical: 156, flag: 'HH' },
  { code: 'CL', display: '氯', unit: 'mmol/L', normal: 102, critical: 118, flag: 'H' },
  { code: 'GLU', display: '葡萄糖', unit: 'mmol/L', normal: 5.2, critical: 33, flag: 'HH' },
  { code: 'CA', display: '钙', unit: 'mmol/L', normal: 2.3, critical: 1.4, flag: 'LL' },
  { code: 'HGB', display: '血红蛋白', unit: 'g/L', normal: 132, critical: 58, flag: 'LL' },
];

function hl7Frame(rec: {
  controlId: string; patientId: string; ward: string;
  testCode: string; testDisplay: string; value: string; unit: string; flag: string;
  dirtyType?: 'gbk_mixed' | 'missing_required';
}): string {
  const obx3 = rec.dirtyType ? '' : `${rec.testCode}^${rec.testDisplay}^L`;
  // 脏帧刻意缺 OBX-3 必填项：解析层按字段级记账并入 DLQ（失败不静默）
  return [
    `MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261108093000||ORU^R01^ORU_R01|${rec.controlId}|P|2.5`,
    `PID|1||${rec.patientId}^^^Hospital-A^MR||合成患者||19800101|U`,
    `PV1|1|O|${rec.ward}^101^1`,
    `OBR|1|ORD${rec.controlId}|FIL${rec.controlId}|CHEM^生化^L|||20261108092500`,
    `OBX|1|NM|${obx3}|1|${rec.value}|${rec.unit}|3.5-5.5|${rec.flag}|||F`,
  ].join('\r');
}

function astmRecord(rec: SyntheticRecord): string {
  const flag = rec.severity === 'critical' ? 'HH' : 'N';
  return [
    `1H|\\^&|||LIS|||||host|||P|1|${rec.controlId}`,
    `2P|1|||${rec.patientId}||合成患者||19800101|U`,
    `3O|1|${rec.controlId}||^^^${rec.testCode}\\^^^${rec.testDisplay}|R|||||||||${rec.ward}|||||||||F`,
    `4R|1|^^^${rec.testCode}\\^^^${rec.testDisplay}|${rec.value}|${rec.unit}|||${flag}||F`,
    '5L|1|N',
  ].join('\r');
}

function privateHex(rec: SyntheticRecord): string {
  const body = `${rec.controlId}|${rec.patientId}|${rec.testCode}|${rec.value}|${rec.unit}|${rec.severity}`;
  const encoded = iconv.encode(body, 'gbk');
  return Buffer.concat([Buffer.from([0x02]), encoded, Buffer.from([0x03])]).toString('hex');
}

export function generateStreams(opts: GenerateOptions) {
  const { specimens, criticalRate, seed, outDir } = opts;
  const rand = makePrng(seed);
  const streamsDir = join(outDir, 'streams');
  mkdirSync(streamsDir, { recursive: true });

  const criticalCount = Math.max(30, Math.round(specimens * criticalRate));
  const gbkDirty = 50;
  const missingDirty = 30;
  const dirtyCount = gbkDirty + missingDirty;
  const duplicateCount = 100;

  const records: SyntheticRecord[] = [];
  for (let i = 0; i < specimens; i++) {
    const panel = PANELS[Math.floor(rand() * PANELS.length)]!;
    const isCritical = i < criticalCount;
    const isDirty = i >= criticalCount && i < criticalCount + dirtyCount;
    const dirtyIndex = i - criticalCount;
    const dirtyType: 'gbk_mixed' | 'missing_required' | undefined = isDirty
      ? (dirtyIndex < gbkDirty ? 'gbk_mixed' : 'missing_required')
      : undefined;
    const category: SyntheticRecord['category'] = isCritical ? 'critical' : isDirty ? 'dirty' : 'normal';
    const controlId = `SYN-${seed}-${String(i).padStart(6, '0')}`;
    const encoding: 'utf-8' | 'gbk' = dirtyType === 'gbk_mixed' ? 'gbk' : 'utf-8';
    const value = String(isCritical ? panel.critical : Number((panel.normal + rand() * 0.4 - 0.2).toFixed(2)));
    const frame = hl7Frame({
      controlId,
      patientId: `PAT-HASH-${String(i).padStart(6, '0')}`,
      ward: ['ICU', '急诊', '内科', '外科'][Math.floor(rand() * 4)]!,
      testCode: panel.code, testDisplay: panel.display, value,
      unit: panel.unit, flag: isCritical ? panel.flag : 'N',
      ...(dirtyType ? { dirtyType } : {}),
    });
    const bytes = encoding === 'gbk' ? iconv.encode(frame, 'gbk') : Buffer.from(frame, 'utf-8');
    records.push({
      seq: i,
      controlId,
      category,
      ...(dirtyType ? { dirtyType } : {}),
      encoding,
      frameBase64: bytes.toString('base64'),
      patientId: `PAT-HASH-${String(i).padStart(6, '0')}`,
      ward: 'ICU',
      testCode: panel.code,
      testDisplay: panel.display,
      value,
      unit: panel.unit,
      severity: isCritical ? 'critical' : 'low',
    });
  }

  // 重复 accession：从正常样本里固定取前 100 条，复制并标 duplicate（幂等压测用）
  const duplicates: SyntheticRecord[] = records
    .filter((r) => r.category === 'normal')
    .slice(0, duplicateCount)
    .map((r, i) => ({ ...r, seq: specimens + i, category: 'duplicate' as const, controlId: r.controlId }));

  const hl7Lines = [...records, ...duplicates].map((r) => JSON.stringify(r)).join('\n') + '\n';
  const astmLines = records.map((r) => JSON.stringify({ controlId: r.controlId, encoding: r.encoding, record: astmRecord(r) })).join('\n') + '\n';
  const privateLines = records.map((r) => JSON.stringify({ controlId: r.controlId, hex: privateHex(r) })).join('\n') + '\n';

  const files = ['streams/hl7-oru-r01.jsonl', 'streams/astm-e1394.jsonl', 'streams/private-bytes.jsonl'];
  writeFileSync(join(outDir, files[0]!), hl7Lines, 'utf-8');
  writeFileSync(join(outDir, files[1]!), astmLines, 'utf-8');
  writeFileSync(join(outDir, files[2]!), privateLines, 'utf-8');

  const counts: ManifestCounts = {
    specimens: records.length,
    critical: criticalCount,
    dirty: { total: dirtyCount, gbkMixed: gbkDirty, missingRequired: missingDirty, dlqExpected: dirtyCount },
    duplicate: duplicates.length,
  };
  const manifest = writeManifest({ outDir, seed, counts, criticalRate, files, ...(opts.source ? { source: opts.source } : {}) });
  return { manifest, records: [...records, ...duplicates] };
}

function parseArgs(argv: string[]): GenerateOptions {
  const value = (name: string, fallback: string): string => {
    const idx = argv.indexOf(name);
    return idx >= 0 && argv[idx + 1] ? argv[idx + 1]! : fallback;
  };
  return {
    specimens: Math.max(1, Number.parseInt(value('--specimens', '2000'), 10)),
    criticalRate: Number.parseFloat(value('--critical-rate', '0.015')),
    seed: Number.parseInt(value('--seed', '20261108'), 10),
    outDir: value('--out', process.env.DATA_DIR ?? './data'),
  };
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('generate-synthetic-stream.ts');
if (isDirectRun) {
  const opts = parseArgs(process.argv.slice(2));
  const { manifest } = generateStreams(opts);
  process.stdout.write(`数据工场已生成：${opts.outDir}\n`);
  process.stdout.write(`source=${manifest.source} specimens=${manifest.specimens} critical=${manifest.critical} ` +
    `dirty=${manifest.dirty.total} duplicate=${manifest.duplicate} seed=${manifest.seed}\n`);
}
