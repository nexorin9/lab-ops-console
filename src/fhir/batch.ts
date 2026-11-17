/**
 * T21 · 批写行级隔离 + 聚合错误
 *
 * 一行 5xx 不影响同批其他行；失败行单独进 outbox（原始资源留底），
 * 批次以聚合错误上报（行号 + 错误码 + 资源 id），让信息科知道「哪几条没进去」，
 * 而不是只知道「这批失败了」。
 */

import { FhirBatchPartialFailError, isBaseError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import { extractAccession, type OutboxSink } from './outbox.js';

const log = createLogger('fhir.batch');

export interface BatchWriteRow {
  resourceType: string;
  body: Record<string, unknown>;
  idempotencyKey?: string;
  /** 显式业务幂等键；不传时从 body.identifier 或 body.id 推导 */
  accessionIdentifier?: string;
}

export interface BatchRowFailure {
  /** 0 起行号（与输入数组下标一致） */
  row: number;
  errorCode: string;
  resourceId: string;
  message: string;
  /** 进待上传队列的 seq（未入队则 null） */
  outboxSeq: number | null;
}

export interface BatchWriteResult {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<{ row: number; ok: boolean; id?: string }>;
  failures: BatchRowFailure[];
  /** 聚合错误（有失败行时非空）；throwOnPartial=true 时改为抛出 */
  error: FhirBatchPartialFailError | null;
}

export interface FhirWriterLike {
  writeResource(input: {
    resourceType: string;
    body: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<{ id: string; status: number }>;
}

export interface WriteBatchOptions {
  /** 失败行落本地待上传队列 */
  outbox?: OutboxSink;
  /** 有失败行时是否抛聚合错误（默认 false，返回结果对象） */
  throwOnPartial?: boolean;
}

function errorCodeOf(err: unknown): string {
  return isBaseError(err) ? err.code : 'FHIR_WRITE_FAIL';
}

/**
 * 逐行写入：每行独立 try/catch，成功行照常落库；失败行进 outbox 并记录聚合明细。
 */
export async function writeBatch(
  writer: FhirWriterLike,
  rows: BatchWriteRow[],
  opts: WriteBatchOptions = {},
): Promise<BatchWriteResult> {
  const results: BatchWriteResult['results'] = [];
  const failures: BatchRowFailure[] = [];

  for (let row = 0; row < rows.length; row += 1) {
    const item = rows[row]!;
    const resourceId = typeof item.body.id === 'string' ? item.body.id : `row-${row}`;
    try {
      const written = await writer.writeResource({
        resourceType: item.resourceType,
        body: item.body,
        ...(item.idempotencyKey ? { idempotencyKey: item.idempotencyKey } : {}),
      });
      results.push({ row, ok: true, id: written.id });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const errorCode = errorCodeOf(err);
      let outboxSeq: number | null = null;
      if (opts.outbox) {
        try {
          outboxSeq = opts.outbox.enqueue({
            accessionIdentifier: item.accessionIdentifier ?? extractAccession(item.body),
            resourceType: item.resourceType,
            resourceId,
            body: item.body,
            errorCode,
            errorMessage: message,
          });
        } catch (enqueueErr) {
          log.error({ row, err: (enqueueErr as Error).message }, '失败行写待上传队列失败');
        }
      }
      failures.push({ row, errorCode, resourceId, message, outboxSeq });
      results.push({ row, ok: false });
      log.warn({ row, errorCode, resourceId }, '批写单行失败（其余行继续）');
    }
  }

  const failed = failures.length;
  const error = failed > 0
    ? new FhirBatchPartialFailError(
        `批写部分失败：${failed}/${rows.length} 行未写入（行号 ${failures.map((f) => f.row).join(', ')}）`,
        { total: rows.length, succeeded: rows.length - failed, failed, failures },
      )
    : null;

  if (error && opts.throwOnPartial) throw error;
  return { total: rows.length, succeeded: rows.length - failed, failed, results, failures, error };
}
