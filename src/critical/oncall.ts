/**
 * T25 · 值班表规则兜底与候选接收人（完全确定性路径）
 *
 * 模型不可达时系统仍要知道「该通知谁」：按病区 + 班次时间窗 + 角色查值班表，
 * 跨零点班次正确处理（start > end 表示 [start,24:00) ∪ [00:00,end)）。
 * 值班表缺项时不返回空候选，而是回退到病区默认角色并标 low_confidence。
 *
 * 规则结果与模型结果走同一份 Candidate 结构（src/ai/types.ts），护士长在面板上
 * 看到的是一份可采纳、可忽略的候选清单，而不是一个空白。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { createLogger } from '../shared/logger.js';
import type { Candidate, FallbackProvider, RecipientQuery } from '../ai/types.js';

const log = createLogger('critical.oncall');

export const ONCALL_DEGRADED_CODE = 'ONCALL_ROSTER_DEGRADED';

const EntrySchema = z.object({
  role: z.string().min(1),
  practitionerId: z.string().min(1),
});
const ShiftSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  entries: z.array(EntrySchema).min(1),
});
const WardSchema = z.object({
  ward: z.string().min(1),
  shifts: z.array(ShiftSchema).min(1),
});
export const OncallRosterSchema = z.object({
  source: z.string().min(1),
  version: z.string().min(1),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  defaultRole: z.string().min(1),
  defaultPractitionerId: z.string().min(1),
  wards: z.array(WardSchema).min(1),
});

export type OncallRosterFile = z.infer<typeof OncallRosterSchema>;

export interface OncallLookupResult {
  ward: string;
  at: string;
  matchedWard: boolean;
  shiftLabel: string | null;
  degraded: boolean;
  reason: string;
  candidates: Candidate[];
}

export interface OncallRosterOptions {
  path?: string;
  text?: string;
  now?: () => Date;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** 班次是否覆盖该时刻：跨零点（start > end）拆成两段判断 */
export function shiftCovers(start: string, end: string, at: Date): boolean {
  const mins = at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;
  const s = minutesOf(start);
  const e = minutesOf(end);
  // 结束时刻为半开区间 [start, end)：交班点归下一班，避免 06:00 同时命中夜班与白班
  if (s <= e) return mins >= s && mins < e;
  return mins >= s || mins < e;
}

export class OncallRoster implements FallbackProvider {
  private readonly path: string;
  private readonly inlineText?: string;
  private readonly now: () => Date;
  private data: OncallRosterFile | null = null;
  private degraded = false;
  private loadError = '';
  private fallbackCount = 0;
  private lookupCount = 0;

  constructor(opts: OncallRosterOptions = {}) {
    this.path = resolve(opts.path ?? 'channels/oncall-sample.yaml');
    this.inlineText = opts.text;
    this.now = opts.now ?? (() => new Date());
  }

  load(): { ok: boolean; error: string } {
    try {
      const text = this.inlineText ?? (existsSync(this.path) ? readFileSync(this.path, 'utf-8') : null);
      if (text === null || text.trim().length === 0) throw new Error(`值班表文件不存在或为空：${this.path}`);
      const parsed = OncallRosterSchema.safeParse(YAML.parse(text));
      if (!parsed.success) {
        throw new Error(`值班表格式非法：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      }
      this.data = parsed.data;
      this.degraded = false;
      this.loadError = '';
      return { ok: true, error: '' };
    } catch (err) {
      this.data = null;
      this.degraded = true;
      this.loadError = (err as Error).message ?? String(err);
      log.warn({ errorCode: ONCALL_DEGRADED_CODE }, `值班表加载失败，使用内置默认角色兜底：${this.loadError}`);
      return { ok: false, error: this.loadError };
    }
  }

  get version(): string { return this.data?.version ?? ''; }
  get effectiveDate(): string { return this.data?.effectiveDate ?? ''; }
  get source(): string { return this.data?.source ?? ''; }
  get isDegraded(): boolean { return this.degraded; }
  get wardCount(): number { return this.data?.wards.length ?? 0; }
  stats(): { lookups: number; fallbacks: number; degraded: boolean } {
    return { lookups: this.lookupCount, fallbacks: this.fallbackCount, degraded: this.degraded };
  }

  /** 默认角色兜底候选：永不返回空数组，且明确标 low_confidence */
  private fallbackCandidates(ward: string, reason: string, role?: string): Candidate[] {
    this.fallbackCount += 1;
    const d = this.data;
    const defaultRole = role ?? d?.defaultRole ?? '病区默认值班护士';
    const defaultId = d?.defaultPractitionerId ?? 'PR-DEFAULT-NURSE';
    return [{
      role: defaultRole,
      practitionerId: defaultId,
      confidence: 0.3,
      reason: `${reason}；已回退到默认角色 ${defaultRole}（需人工确认）`,
      source: 'rule',
      lowConfidence: true,
    }];
  }

  /** 按病区 + 时刻查候选；实现 FallbackProvider 的统一数据面 */
  lookup(ward: string, at: Date = this.now(), role?: string): OncallLookupResult {
    this.lookupCount += 1;
    const atIso = at.toISOString();
    const base = { ward, at: atIso, degraded: false, reason: '' };

    if (this.degraded || !this.data) {
      const reason = `值班表不可用（${this.loadError || '未加载'}）`;
      return {
        ...base, matchedWard: false, shiftLabel: null, degraded: true, reason,
        candidates: this.fallbackCandidates(ward, reason, role),
      };
    }

    const matched = this.data.wards.find((w) => w.ward === ward || w.ward.toLowerCase() === ward.toLowerCase());
    if (!matched) {
      const reason = `病区 ${ward} 不在值班表内`;
      return {
        ...base, matchedWard: false, shiftLabel: null, degraded: true, reason,
        candidates: this.fallbackCandidates(ward, reason, role),
      };
    }

    const shift = matched.shifts.find((s) => shiftCovers(s.start, s.end, at));
    if (!shift) {
      const reason = `病区 ${ward} 在 ${atIso} 无匹配班次窗口`;
      return {
        ...base, matchedWard: true, shiftLabel: null, degraded: true, reason,
        candidates: this.fallbackCandidates(ward, reason, role),
      };
    }

    let entries = shift.entries;
    if (role) {
      const filtered = entries.filter((e) => e.role === role || e.role.includes(role));
      if (filtered.length === 0) {
        const reason = `病区 ${ward} 的 ${shift.start}-${shift.end} 班次无角色 ${role}`;
        return {
          ...base, matchedWard: true, shiftLabel: `${shift.start}-${shift.end}`, degraded: true, reason,
          candidates: this.fallbackCandidates(ward, reason, role),
        };
      }
      entries = filtered;
    }

    const label = `${shift.start}-${shift.end}`;
    return {
      ...base,
      matchedWard: true,
      shiftLabel: label,
      reason: `按病区 ${ward} + 班次 ${label} 命中值班表`,
      candidates: entries.map((e, i) => ({
        role: e.role,
        practitionerId: e.practitionerId,
        confidence: Math.max(0.6, 0.9 - i * 0.1),
        reason: `值班表命中：${ward} / ${label} / ${e.role}`,
        source: 'rule' as const,
        lowConfidence: false,
      })),
    };
  }

  /** FallbackProvider 接口 —— 供 ModelGateway 直接注入 */
  suggestRecipients(query: RecipientQuery): Candidate[] {
    const at = query.at ? new Date(query.at) : this.now();
    return this.lookup(query.ward, Number.isNaN(at.getTime()) ? this.now() : at, query.role).candidates;
  }
}
