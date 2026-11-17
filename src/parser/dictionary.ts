/**
 * T19 · 检验项目字典（可维护资产，不是硬编码常量）
 *
 * 文件头带 source / version / effectiveDate；多份字典按生效日期择一（最新且已生效）。
 * 命中与未命中逐条记账；未命中输出 low_confidence 规则候选，可交 ModelGateway 归因，
 * 人工确认后回写为新的 yaml 条目（重启即生效）。命中率直接写运行摘要。
 *
 * 容错：单份格式非法的字典只记错误，不阻塞其余字典加载。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { createLogger } from '../shared/logger.js';

const log = createLogger('parser.dictionary');

export const DictionaryItemSchema = z.object({
  instrument_code: z.string().min(1),
  instrument_name: z.string().min(1),
  loinc: z.string().min(1),
  unit: z.string().min(1),
  local_code: z.string().min(1),
});

export const DictionaryFileSchema = z.object({
  source: z.string().min(1),
  version: z.string().min(1),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z.array(DictionaryItemSchema).min(1),
});

export type DictionaryItem = z.infer<typeof DictionaryItemSchema>;
export type DictionaryFile = z.infer<typeof DictionaryFileSchema>;

export interface DictionaryLoadError {
  file: string;
  message: string;
}

export interface DictionaryLoadResult {
  loaded: DictionaryFile[];
  errors: DictionaryLoadError[];
  active: DictionaryFile | null;
}

export interface LowConfidenceCandidate {
  code: string;
  local_code: string;
  source: 'rule' | 'model';
  low_confidence: true;
  reason: string;
  confidence: number;
}

export interface DictionaryLookupResult {
  code: string;
  hit: boolean;
  item?: DictionaryItem;
  /** 未命中时给面板的可采纳候选（低置信度，不冒充确定结果） */
  candidates: LowConfidenceCandidate[];
}

export interface DictionaryStats {
  total: number;
  hits: number;
  misses: number;
  /** 百分比，保留 1 位小数 */
  hitRate: number;
  byChannel: Record<string, { total: number; hits: number; misses: number; hitRate: number }>;
  missesByCode: Record<string, number>;
}

/** 模型归因接口（与 ModelGateway.attribute 形状一致，业务层只依赖这个小面） */
export interface AttributionPort {
  attributeUnknownCode(input: {
    code: string;
    instrumentName?: string;
    unit?: string;
  }): Promise<{ local_code?: string; reason?: string; confidence?: number } | null>;
}

export interface DictionaryStoreOptions {
  /** 指定字典文件路径列表（优先） */
  paths?: string[];
  /** 或指定目录，扫描 dictionary-*.yaml */
  dir?: string;
  /** 运行摘要打点（dictionary_hit / dictionary_miss） */
  summary?: { record(event: string, count?: number): void };
  /** 未命中兜底归因（可注入 ModelGateway；不注入时只给规则候选） */
  attributor?: AttributionPort;
  /** 判定生效日期用的时钟（可注入做多版本测试） */
  now?: () => Date;
}

function parseDictionary(text: string, file: string): DictionaryFile {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new Error(`YAML 解析失败：${(err as Error).message}`);
  }
  const parsed = DictionaryFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ');
    throw new Error(`字典格式非法（${file}）：${detail}`);
  }
  return parsed.data;
}

export class DictionaryStore {
  private readonly paths: string[];
  private readonly summary?: { record(event: string, count?: number): void };
  private readonly attributor?: AttributionPort;
  private readonly now: () => Date;
  private files: DictionaryFile[] = [];
  private fileByVersion = new Map<string, string>();
  private activeFile: DictionaryFile | null = null;
  private index = new Map<string, DictionaryItem>();
  private errors: DictionaryLoadError[] = [];
  private total = 0;
  private hits = 0;
  private misses = 0;
  private channelCounts = new Map<string, { total: number; hits: number; misses: number }>();
  private missCodes = new Map<string, number>();
  private pendingAttributions = new Map<string, Promise<LowConfidenceCandidate>>();

  constructor(opts: DictionaryStoreOptions = {}) {
    this.summary = opts.summary;
    this.attributor = opts.attributor;
    this.now = opts.now ?? (() => new Date());
    if (opts.paths?.length) {
      this.paths = opts.paths.map((p) => resolve(p));
    } else {
      const dir = resolve(opts.dir ?? 'channels');
      this.paths = existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => (f.endsWith('.yaml') || f.endsWith('.yml')) && f.startsWith('dictionary-'))
            .sort()
            .map((f) => join(dir, f))
        : [];
    }
  }

  /** 加载全部字典；单份非法只记错误，其余照常生效 */
  load(): DictionaryLoadResult {
    this.files = [];
    this.fileByVersion.clear();
    this.errors = [];
    for (const path of this.paths) {
      try {
        const dict = parseDictionary(readFileSync(path, 'utf-8'), path);
        this.files.push(dict);
        this.fileByVersion.set(dict.version, path);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        this.errors.push({ file: path, message });
        log.warn({ file: path }, `字典加载失败（不阻塞其余字典）：${message}`);
      }
    }
    this.chooseActive();
    return { loaded: [...this.files], errors: [...this.errors], active: this.activeFile };
  }

  /** 按 effectiveDate 择一：取已生效（<= now）中最新的一份；没有已生效则取最早一份 */
  private chooseActive(): void {
    const nowMs = this.now().getTime();
    const eligible = this.files
      .map((d) => ({ d, t: new Date(`${d.effectiveDate}T00:00:00Z`).getTime() }))
      .sort((a, b) => b.t - a.t);
    const chosen = eligible.find((e) => e.t <= nowMs) ?? eligible[eligible.length - 1];
    this.activeFile = chosen?.d ?? null;
    this.index = new Map(
      (this.activeFile?.items ?? []).map((item) => [item.instrument_code.toUpperCase(), item]),
    );
  }

  get active(): DictionaryFile | null { return this.activeFile; }
  get version(): string { return this.activeFile?.version ?? ''; }
  get effectiveDate(): string { return this.activeFile?.effectiveDate ?? ''; }
  get source(): string { return this.activeFile?.source ?? ''; }
  get loadErrors(): DictionaryLoadError[] { return [...this.errors]; }
  get size(): number { return this.index.size; }

  /** 查字典；命中 / 未命中都逐条记账并写运行摘要 */
  lookup(instrumentCode: string, opts: { channelId?: string; instrumentName?: string; unit?: string; runAttribution?: boolean } = {}): DictionaryLookupResult {
    const code = (instrumentCode ?? '').trim().toUpperCase();
    this.total += 1;
    const bucket = this.channelCounts.get(opts.channelId ?? '*') ?? { total: 0, hits: 0, misses: 0 };
    bucket.total += 1;
    const item = this.index.get(code);

    if (item) {
      this.hits += 1;
      bucket.hits += 1;
      this.summary?.record('dictionary_hit');
      this.channelCounts.set(opts.channelId ?? '*', bucket);
      return { code, hit: true, item, candidates: [] };
    }

    this.misses += 1;
    bucket.misses += 1;
    this.missCodes.set(code, (this.missCodes.get(code) ?? 0) + 1);
    this.summary?.record('dictionary_miss');
    this.channelCounts.set(opts.channelId ?? '*', bucket);

    // 确定性规则候选：不返回空候选，但明确标 low_confidence
    const ruleCandidate: LowConfidenceCandidate = {
      code,
      local_code: `UNMAPPED-${code}`,
      source: 'rule',
      low_confidence: true,
      confidence: 0,
      reason: '字典未命中，需人工确认后新增 yaml 条目',
    };
    const candidates: LowConfidenceCandidate[] = [ruleCandidate];

    if (opts.runAttribution !== false && this.attributor) {
      let pending = this.pendingAttributions.get(code);
      if (!pending) {
        pending = this.attributor
          .attributeUnknownCode({ code, ...(opts.instrumentName ? { instrumentName: opts.instrumentName } : {}), ...(opts.unit ? { unit: opts.unit } : {}) })
          .then((r) => r ? {
            code,
            local_code: r.local_code ?? `SUGGEST-${code}`,
            source: 'model' as const,
            low_confidence: true as const,
            confidence: Math.min(1, Math.max(0, r.confidence ?? 0)),
            reason: r.reason ?? '模型归因建议，待人工确认',
          } : ruleCandidate)
          .catch(() => ruleCandidate);
        this.pendingAttributions.set(code, pending);
      }
    }
    return { code, hit: false, candidates };
  }

  /** 取模型归因结果（异步兜底，供面板呈现「可采纳 / 可忽略」候选） */
  async attributionFor(code: string): Promise<LowConfidenceCandidate | null> {
    const normalized = code.trim().toUpperCase();
    return (await this.pendingAttributions.get(normalized)) ?? null;
  }

  stats(): DictionaryStats {
    const byChannel: DictionaryStats['byChannel'] = {};
    for (const [id, c] of this.channelCounts) {
      byChannel[id] = {
        ...c,
        hitRate: c.total === 0 ? 0 : Math.round((c.hits / c.total) * 1000) / 10,
      };
    }
    return {
      total: this.total,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.total === 0 ? 0 : Math.round((this.hits / this.total) * 1000) / 10,
      byChannel,
      missesByCode: Object.fromEntries(this.missCodes),
    };
  }

  /** 未命中条目汇总（按出现次数倒序） */
  missedCodes(): Array<{ code: string; count: number }> {
    return [...this.missCodes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  }

  /**
   * 人工确认后回写为新的 yaml 条目。写回指定文件（默认当前生效字典所在文件），
   * 重启 / reload() 即生效；不直接改内存索引，避免「改了文件但没重启」产生口径分歧。
   */
  confirm(code: string, item: DictionaryItem, targetPath?: string): { file: string; items: number } {
    const path = targetPath ?? (this.activeFile ? this.fileByVersion.get(this.activeFile.version) : undefined) ?? this.paths[0];
    if (!path) throw new Error('没有可写回的字典文件');
    const dict = parseDictionary(readFileSync(path, 'utf-8'), path);
    const normalized: DictionaryItem = { ...item, instrument_code: (item.instrument_code || code).toUpperCase() };
    const existing = dict.items.findIndex((i) => i.instrument_code.toUpperCase() === normalized.instrument_code);
    if (existing >= 0) dict.items[existing] = normalized;
    else dict.items.push(normalized);
    writeFileSync(path, YAML.stringify(dict), 'utf-8');
    log.info({ file: path, code: normalized.instrument_code, items: dict.items.length }, '人工确认的字典条目已回写');
    return { file: path, items: dict.items.length };
  }

  /** 回写后重新加载（模拟「改 yaml 重启即生效」） */
  reload(): DictionaryLoadResult { return this.load(); }
}
