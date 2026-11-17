/**
 * 模型调用审计 —— audit/model_calls.jsonl 逐行记录可核对元数据。
 * 每行固定五字段：model_id / prompt_hash / response_hash / latency_ms / outcome。
 * 不落 prompt 原文与患者信息，避免审计文件本身成为泄漏面。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_AUDIT_DIR = 'audit';
export const AUDIT_FILENAME = 'model_calls.jsonl';

export interface ModelCallAuditRecord {
  model_id: string;
  prompt_hash: string;
  response_hash: string;
  latency_ms: number;
  outcome: string;
  /** 附加诊断字段（不参与五字段契约） */
  prompt_name?: string;
  error_code?: string;
  source?: string;
  ts?: string;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ModelCallAuditor {
  write(record: ModelCallAuditRecord): void;
  path: string;
}

/** 创建 JSONL 审计器；dir 可注入（测试写临时目录，不污染仓库） */
export function createModelCallAuditor(dir: string = DEFAULT_AUDIT_DIR): ModelCallAuditor {
  const path = join(dir, AUDIT_FILENAME);
  return {
    path,
    write(record) {
      mkdirSync(dirname(path), { recursive: true });
      const line = JSON.stringify({
        model_id: record.model_id,
        prompt_hash: record.prompt_hash,
        response_hash: record.response_hash,
        latency_ms: record.latency_ms,
        outcome: record.outcome,
        ...(record.prompt_name ? { prompt_name: record.prompt_name } : {}),
        ...(record.error_code ? { error_code: record.error_code } : {}),
        ...(record.source ? { source: record.source } : {}),
        ts: record.ts ?? new Date().toISOString(),
      });
      appendFileSync(path, `${line}\n`, 'utf-8');
    },
  };
}

/** 读取全部审计行（验收脚本 / 对照测试用） */
export function readModelCallAudit(dir: string = DEFAULT_AUDIT_DIR): ModelCallAuditRecord[] {
  const path = join(dir, AUDIT_FILENAME);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ModelCallAuditRecord);
}
