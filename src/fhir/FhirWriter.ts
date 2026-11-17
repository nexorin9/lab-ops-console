/**
 * FhirWriter — FHIR R4 写入器
 *
 * 设计原则：
 * - 单协议 REST + Bearer Auth + If-None-Exist（不绑厂商 SDK，与医院网关解耦）
 * - URL allowlist（防 SSRF）：只能写白名单内的 baseUrl（必填）
 * - 幂等：同 accessionIdentifier 走 If-None-Exist，第二次写服务端应识别 not-found → 已存在直接成功
 * - 5xx 指数退避 3 次（1s/2s/4s）后抛 FhirServerFailError 并入 DLQ（原始字节留底）
 * - 4xx 直接抛 FhirValidationFailError（不重试）
 * - 401：刷新凭据后重试一次；刷新仍失败 / 再遇 401 → 直接报错，不做重试风暴
 * - 每次请求都带 bearer（凭据取不到就不发请求，避免无凭据空转）
 * - writeBatch 走行级失败隔离：单个 resource 失败不影响其他
 * - write() 写完回读校验（写进去 ≠ 读得出来）
 *
 * 与源仓库 fhir-request 转发工具对齐的设计点：
 * - 按 method 拼 /fhir/R4/{type}/{id} 路径（与院内 FHIR R4 端点一致）
 * - bearer token + baseUrl concat（走纯 fetch，不绑厂商客户端）
 * - URL allowlist 取代通用 SSRF guard（只允许写院内已登记的端点）
 */

import type { Database as DB } from 'better-sqlite3';
import { z } from 'zod';
import {
  AuthTokenExpiredError,
  AuthTokenInvalidError,
  AuthTokenMissingError,
  FhirBatchPartialFailError,
  FhirServerFailError,
  FhirValidationFailError,
  FhirWriteFailError,
  FhirContractViolationError,
  isBaseError,
  type ErrorContext,
} from '../shared/errors.js';
import { type ContractValidatorLike, FHIR_CONTRACT_VIOLATION } from './validate.js';
import { extractAccession, type OutboxSink } from './outbox.js';
import { OidcClient, readOidcConfigFromEnv, type OidcConfig } from './oidc-client.js';
import {
  HEADER_IF_NONE_EXIST,
  buildIfNoneExistHeader,
} from './idempotency.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('fhir.FhirWriter');

export interface FhirWriterConfig {
  /** FHIR R4 端点 base URL（如 https://lis.example.com/fhir/R4） */
  baseUrl: string;
  /** OIDC 客户端配置（OAuth2 client-credentials 模式） */
  oidc?: OidcConfig;
  /** 静态 bearer token（院内网关已签发 token 时用；来自 env 的 *_TOKEN 凭据位） */
  staticToken?: string;
  /** URL allowlist —— SSRF guard；baseUrl 必须命中其一 */
  urlAllowlist: string[];
  /** 默认请求超时 ms */
  requestTimeoutMs?: number;
  /** 5xx 指数退避最大次数 */
  maxRetries?: number;
  /** 自定义 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** SQLite —— 可选，写失败可入 DLQ */
  dlq?: DLQEntry[];
  /**
   * 持久化死信落点（DLQ）—— 5xx 重试耗尽后写入 dlq_messages 表。
   * 结构上与 channels/DLQ 的 DLQ 类兼容（duck typing），业务层不直接依赖 channels 模块。
   */
  dlqSink?: DlqSink;
  /** 写进 DLQ 的通道标识（默认 'fhir-write'） */
  dlqChannelName?: string;
  /**
   * T20 · 本地 FHIR R4 契约校验器。注入后 writeResource 在发 HTTP 请求「之前」校验，
   * 不通过抛 FhirContractViolationError 并把原始资源写入 DLQ（error_code=FHIR_CONTRACT_VIOLATION）。
   * 不注入时保持原有行为，便于既有调用方平滑迁移。
   */
  contractValidator?: ContractValidatorLike;
  /** T21 · 写失败资源落本地待上传队列（FhirWriter 失败路径接线） */
  outboxSink?: OutboxSink;
}

export interface WriteResourceInput {
  /** FHIR resourceType（Observation / DiagnosticReport / Specimen / Device / Task / AuditEvent） */
  resourceType: string;
  /** resource body（已构造的 FHIR 对象） */
  body: Record<string, unknown>;
  /** 幂等键（可由 buildAccessionIdentifier 产出） */
  idempotencyKey?: string;
  /** 跳过 If-None-Exist 头（用于 update 场景，T17 详情） */
  skipIfNoneExist?: boolean;
  /** 额外 context，写日志用 */
  context?: ErrorContext;
}

export interface WriteResult {
  id: string;
  resourceType: string;
  status: number;
  location?: string;
}

/** write() 的返回：写入 + 回读校验的结果 */
export interface WriteVerifiedResult extends WriteResult {
  /** 回读是否命中（写进去 ≠ 读得出来，这一步是可核对的关键） */
  verified: boolean;
  /** 回读到的资源体（未校验时为 null） */
  resource: Record<string, unknown> | null;
}

export interface WriteOptions {
  /** 幂等键（accessionIdentifier）—— 走 If-None-Exist 头 */
  idempotencyKey?: string;
  /** 是否回读校验（默认 true） */
  verify?: boolean;
  /** 错误上下文（写进结构化错误 / DLQ） */
  context?: ErrorContext;
}

const ALLOWED_RESOURCE_TYPES = new Set([
  'Observation',
  'DiagnosticReport',
  'Specimen',
  'Device',
  'Task',
  'AuditEvent',
  'Patient',
  'Practitioner',
]);

const WriteResourceBodySchema = z.object({
  resourceType: z.string().refine((t) => ALLOWED_RESOURCE_TYPES.has(t), {
    message: 'resourceType 不在白名单内',
  }),
});

interface FetchLike {
  (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    status: number;
    headers: { get(k: string): string | null };
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

export interface DLQEntry {
  resource_type: string;
  resource_id?: string;
  error_code: string;
  error_message: string;
  raw_bytes: Buffer;
  received_at: string;
  retry_count: number;
}

/**
 * DLQ 落点 —— 与 channels/DLQ 的 DLQ 类结构兼容（duck typing）。
 * 写成接口而非直接 import classes，是为了让 fhir 层不反向依赖 channels 层。
 */
export interface DlqSink {
  enqueue(input: {
    channelName: string;
    errorCode: string;
    errorMessage?: string;
    rawBytes: Buffer | Uint8Array;
  }): unknown;
}

/**
 * validateUrl — 校验 URL 是否命中 allowlist；不在白名单抛错
 */
export function isUrlAllowed(baseUrl: string, allowlist: string[]): boolean {
  try {
    const u = new URL(baseUrl);
    const origin = `${u.protocol}//${u.host}`;
    return allowlist.some((allowed) => {
      try {
        const a = new URL(allowed);
        return a.host === u.host && a.protocol === u.protocol;
      } catch {
        return allowed === origin;
      }
    });
  } catch {
    return false;
  }
}

export class FhirWriter {
  private readonly oidc: OidcClient | null;
  private readonly staticToken: string | null;
  private readonly baseUrl: string;
  private readonly allowlist: string[];
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;
  private dlqBuffer: DLQEntry[];
  private readonly dlqSink: DlqSink | null;
  private readonly dlqChannelName: string;
  private readonly contractValidator: ContractValidatorLike | null;
  private readonly outboxSink: OutboxSink | null;
  /** 已入过 DLQ 的错误对象 —— 防止同一条失败被重复入队（原始字节重复落盘） */
  private readonly dlqEnqueued = new WeakSet<object>();

  constructor(config: FhirWriterConfig) {
    if (!config.baseUrl) {
      throw new FhirWriteFailError('FhirWriter.baseUrl 必填', { field: 'baseUrl' });
    }
    if (!config.oidc && !config.staticToken) {
      throw new FhirWriteFailError('FhirWriter.oidc 或 staticToken 必填其一（凭据位）', {
        field: 'oidc',
      });
    }
    if (!config.urlAllowlist || config.urlAllowlist.length === 0) {
      throw new FhirWriteFailError('FhirWriter.urlAllowlist 不能为空（SSRF guard）', { field: 'urlAllowlist' });
    }
    if (!isUrlAllowed(config.baseUrl, config.urlAllowlist)) {
      throw new FhirWriteFailError('FhirWriter.baseUrl 未命中 URL allowlist', {
        baseUrl: config.baseUrl,
        allowlist: config.urlAllowlist,
      });
    }
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.oidc = config.oidc ? new OidcClient(config.oidc) : null;
    this.staticToken = config.staticToken ?? null;
    this.allowlist = config.urlAllowlist;
    this.timeoutMs = config.requestTimeoutMs ?? 8_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.fetchImpl = (config.fetchImpl as unknown as FetchLike) ?? (globalThis.fetch as unknown as FetchLike);
    this.dlqBuffer = config.dlq ?? [];
    this.dlqSink = config.dlqSink ?? null;
    this.dlqChannelName = config.dlqChannelName ?? 'fhir-write';
    this.contractValidator = config.contractValidator ?? null;
    this.outboxSink = config.outboxSink ?? null;
  }

  /**
   * writeResource — 单条 FHIR 资源写入
   * 幂等：如果提供 idempotencyKey，加 `If-None-Exist` 头（服务端若已存在则返回 200 + 既有 ID）
   * 401：自动 refreshOnce 重试一次
   * 4xx：抛 FhirValidationFailError（不重试）
   * 5xx：抛 FhirServerFailError（调用方入 DLQ）
   */
  async writeResource(input: WriteResourceInput): Promise<WriteResult> {
    const bodyParse = WriteResourceBodySchema.safeParse({ resourceType: input.resourceType });
    if (!bodyParse.success) {
      throw new FhirValidationFailError('FhirWriter.resourceType 不在白名单', {
        issues: bodyParse.error.issues,
      });
    }
    const body = this.assembleBody(input);
    if (!body.id) {
      throw new FhirValidationFailError('FhirWriter body.id 必填', { resourceType: input.resourceType });
    }
    // T20 · 写入前置契约校验：脏资源不发给院内 FHIR 端点，直接拒绝并留底
    if (this.contractValidator) {
      const report = this.contractValidator.validate(body);
      if (!report.ok) {
        const err = new FhirContractViolationError(
          `FHIR 契约校验失败：${report.violations.map((v) => `${v.path} ${v.code}`).join('; ')}`,
          {
            errorCode: FHIR_CONTRACT_VIOLATION,
            resourceType: input.resourceType,
            resourceId: String(body.id),
            violations: report.violations,
          },
        );
        this.pushDLQ(body, input.resourceType, err);
        throw err;
      }
    }
    const url = `${this.baseUrl}/${input.resourceType}/${encodeURIComponent(String(body.id))}`;
    const headers = this.buildHeaders(input);
    let lastError: Error | null = null;
    let refreshedAfter401 = false;
    /** 401 刷新凭据后额外放行的请求次数（最多 1）—— 凭据刷新不是数据重试 */
    let authRetryBudget = 0;
    /** 退避序号（网络失败 / 5xx 共用）—— 保证退避序列恒为 1s / 2s / 4s */
    let retrySeq = 0;
    /** 已收到的 5xx 响应数（错误消息里的「第 N 次」按这个算，不受 401 补发影响） */
    let serverFailCount = 0;

    // 传输预算：网络失败 / 5xx 最多重试 maxRetries 次（= maxRetries+1 次请求）。
    // 401 刷新后的补发额外放行一次，**不占**上面的传输预算 ——
    // 否则 401 恰好落在最后一次尝试上时，刷新拿到的新 token 还没用上就退出循环了，
    // 这次写入也会被误报成「5xx 重试用尽」（把凭据问题当成服务端故障，运维跑错流程）。
    for (let attempt = 0; attempt < this.maxRetries + 1 + authRetryBudget; attempt++) {
      // 每次请求都带 OAuth2 bearer —— 与院内网关一致（凭据取不到就不发请求）
      try {
        headers.Authorization = await this.bearer();
      } catch (err) {
        // 凭据问题不是数据问题：直接报错，不重试（也不入 DLQ）
        throw this.asAuthError(err, { url, resourceType: input.resourceType });
      }

      let resp: Awaited<ReturnType<FhirWriter['fetchWithTimeout']>>;
      try {
        resp = await this.fetchWithTimeout(url, { method: 'PUT', headers, body: JSON.stringify(body) });
      } catch (err) {
        // 网络层失败（超时 / 连接断开）→ 退避重试
        lastError = new FhirWriteFailError(
          `FHIR 网络失败：${(err as Error).message}`,
          { url, attempt },
          err,
        );
        if (retrySeq < this.maxRetries) {
          await sleep(backoffMs(retrySeq));
          retrySeq += 1;
          continue;
        }
        break;
      }

      if (resp.status === 401) {
        if (refreshedAfter401) {
          // 刷新过仍被拒 → 凭据无效，直接报错，不再重试（不静默重试风暴）
          const authErr = new AuthTokenExpiredError('FHIR 端点连续返回 401：凭据刷新后仍被拒', {
            url,
            resourceType: input.resourceType,
            bodyId: String(body.id),
          });
          this.pushDLQ(body, input.resourceType, authErr);
          throw authErr;
        }
        refreshedAfter401 = true;
        try {
          await this.refreshOnce(input.context ?? {});
        } catch (err) {
          // 刷新失败 → 直接报错（401 不重试）
          const authErr = this.asAuthError(err, { url, resourceType: input.resourceType });
          this.pushDLQ(body, input.resourceType, authErr);
          throw authErr;
        }
        // 用新 token 补发一次 —— 这次补发不占传输重试预算（见上面的循环说明）
        authRetryBudget = 1;
        continue;
      }

      if (resp.status === 200 || resp.status === 201) {
        const location = resp.headers.get('Location') ?? undefined;
        // 幂等命中时 Location 指向既有资源（id 可能不同于本次 body.id）：
        // 返回服务端实际落库 / 命中的 id，调用方才知道这次写被并到了哪条资源上
        const effectiveId = idFromLocation(location) ?? String(body.id);
        return {
          id: effectiveId,
          resourceType: input.resourceType,
          status: resp.status,
          location,
        };
      }

      if (resp.status >= 400 && resp.status < 500) {
        // 4xx 是契约/数据问题：不重试（重试也不会变），交给上层按错误码处理。
        // 但「服务端拒收」= 这份标本没进院内库 —— 原始字节必须留底，
        // 否则检验科那边永远看不到这份结果（失败不静默改数据）。
        // 错误码用 FHIR_VALIDATION_FAIL，运维侧可按错误码过滤，与 5xx 的可重试死信区分开。
        const text = await resp.text().catch(() => '');
        const err = new FhirValidationFailError(
          `FHIR ${resp.status}: ${text.slice(0, 200)}`,
          { url, status: resp.status, resourceType: input.resourceType, bodyId: String(body.id) },
        );
        this.pushDLQ(body, input.resourceType, err);
        throw err;
      }

      // 5xx → 退避重试（1s / 2s / 4s）
      serverFailCount += 1;
      const text = await resp.text().catch(() => '');
      lastError = new FhirServerFailError(
        `FHIR 5xx 第 ${serverFailCount} 次：${text.slice(0, 200)}`,
        { url, status: resp.status, attempt },
      );
      if (retrySeq < this.maxRetries) {
        await sleep(backoffMs(retrySeq));
        retrySeq += 1;
        continue;
      }
      break;
    }

    // 重试用尽 → 入 DLQ 再抛（失败不静默改数据：原始字节留底，可回放）
    const finalError = lastError ?? new FhirServerFailError('FHIR 写入重试用尽', { url, resourceType: input.resourceType });
    this.pushDLQ(body, input.resourceType, finalError);
    throw finalError;
  }

  /**
   * read —— GET 回读（写入后校验 / 面板调试用）
   * 404 → 返回 null（资源不存在）；401 → 刷新一次后重试一次；其他 4xx/5xx → 抛错。
   */
  async read(resourceType: string, id: string, context: ErrorContext = {}): Promise<Record<string, unknown> | null> {
    const url = `${this.baseUrl}/${resourceType}/${encodeURIComponent(id)}`;
    let refreshed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let headers: Record<string, string> = { Accept: 'application/fhir+json' };
      try {
        headers.Authorization = await this.bearer();
      } catch (err) {
        throw this.asAuthError(err, { url, resourceType });
      }
      let resp: Awaited<ReturnType<FhirWriter['fetchWithTimeout']>>;
      try {
        resp = await this.fetchWithTimeout(url, { method: 'GET', headers });
      } catch (err) {
        throw new FhirWriteFailError(
          `FHIR 回读网络失败：${(err as Error).message}`,
          { url, attempt },
          err,
        );
      }
      if (resp.status === 401 && !refreshed) {
        refreshed = true;
        try {
          await this.refreshOnce(context);
        } catch (err) {
          throw this.asAuthError(err, { url, resourceType });
        }
        continue;
      }
      if (resp.status === 404) return null;
      if (resp.status === 401) {
        throw new AuthTokenExpiredError('FHIR 回读返回 401：凭据无效', { url, resourceType });
      }
      if (resp.status >= 400) {
        const text = await resp.text().catch(() => '');
        throw new FhirValidationFailError(
          `FHIR 回读 ${resp.status}: ${text.slice(0, 200)}`,
          { url, status: resp.status, resourceType },
        );
      }
      const json = (await resp.json()) as Record<string, unknown>;
      return json;
    }
    throw new AuthTokenExpiredError('FHIR 回读连续返回 401', { url, resourceType });
  }

  /**
   * write —— 写一条资源并回读校验
   * 「写进去」不等于「读得出来」：写完必须 GET 命中同一 id，否则视为写入失败（抛错，不静默）。
   */
  async write(
    resourceType: string,
    body: Record<string, unknown>,
    opts: WriteOptions = {},
  ): Promise<WriteVerifiedResult> {
    const written = await this.writeResource({
      resourceType,
      body,
      idempotencyKey: opts.idempotencyKey,
      context: opts.context,
    });
    if (opts.verify === false) {
      return { ...written, verified: false, resource: null };
    }
    // 幂等命中时服务端返回既有资源的 Location（id 可能不同于本次 body.id）
    const readId = idFromLocation(written.location) ?? written.id;
    const resource = await this.read(resourceType, readId, opts.context);
    const verified =
      !!resource &&
      String(resource.id ?? '') === readId &&
      String(resource.resourceType ?? '') === resourceType;
    if (!verified) {
      throw new FhirWriteFailError('FHIR 写入后回读校验失败（写进去但读不回来）', {
        resourceType,
        id: readId,
        location: written.location,
      });
    }
    return { ...written, id: readId, verified: true, resource };
  }

  /**
   * writeBatch — 批量写
   *
   * 行级失败隔离：一行失败不影响同批其余行（每行独立走 writeResource 的
   * 重试 / 幂等 / DLQ 逻辑），失败行汇总后抛 FhirBatchPartialFailError。
   *
   * 失败行**必须**能定位到「哪一行、什么资源、什么原因」：
   * 批量写的是一份标本的 Observation + DiagnosticReport 组合，
   * 只报「这批失败了」的话，检验科不知道是哪一项检验没进院内库。
   *
   * 不静默改数据：失败行已在 writeResource 内入 DLQ（原始字节留底，可回放）。
   */
  async writeBatch(inputs: WriteResourceInput[]): Promise<WriteResult[]> {
    const successes: WriteResult[] = [];
    const failures: Array<{
      index: number;
      resourceType: string;
      id: string;
      errorCode: string;
      error: string;
    }> = [];
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index]!;
      try {
        const r = await this.writeResource(input);
        successes.push(r);
      } catch (err) {
        const id = input.body && typeof input.body === 'object' && input.body !== null && 'id' in input.body
          ? String((input.body as Record<string, unknown>).id ?? '')
          : '';
        const message = err instanceof Error ? err.message : String(err);
        const errorCode = isBaseError(err) ? err.code : 'FHIR_WRITE_FAIL';
        failures.push({ index, resourceType: input.resourceType, id, errorCode, error: message });
      }
    }
    if (failures.length > 0) {
      throw new FhirBatchPartialFailError(
        `batch 写入 ${successes.length} 成功 / ${failures.length} 失败`,
        {
          successCount: successes.length,
          failureCount: failures.length,
          failures: failures.slice(0, 5),
          failedIndexes: failures.map((f) => f.index),
          successIds: successes.map((s) => s.id),
        },
      );
    }
    return successes;
  }

  /** 取 DLQ 缓存（测试用） */
  drainDLQ(): DLQEntry[] {
    const out = this.dlqBuffer.slice();
    this.dlqBuffer = [];
    return out;
  }

  /** 写入失败 → DLQ（保留原始 body 字节，可回放可核对） */
  private pushDLQ(body: Record<string, unknown>, resourceType: string, err: Error): void {
    // 同一条失败只入队一次（原始字节重复落盘会让 DLQ 条数对不上）
    if (this.dlqEnqueued.has(err)) return;
    this.dlqEnqueued.add(err);
    const rawBytes = Buffer.from(JSON.stringify(body));
    const errorCode = isBaseError(err) ? err.code : 'FHIR_WRITE_FAIL';
    // T21 · 同一失败资源同步落本地待上传表（与 DLQ 留底互补：DLQ 供排障，outbox 供按序重放）
    if (this.outboxSink) {
      try {
        this.outboxSink.enqueue({
          accessionIdentifier: extractAccession(body),
          resourceType,
          ...(body.id ? { resourceId: String(body.id) } : {}),
          body,
          errorCode,
          errorMessage: err.message,
        });
      } catch (outboxErr) {
        log.error({ err_message: (outboxErr as Error).message, resourceType }, 'FHIR 写失败资源落待上传队列失败');
      }
    }
    this.dlqBuffer.push({
      resource_type: resourceType,
      resource_id: body.id ? String(body.id) : undefined,
      error_code: errorCode,
      error_message: err.message,
      raw_bytes: rawBytes,
      received_at: new Date().toISOString(),
      retry_count: this.maxRetries,
    });
    // 持久化落点（channels/DLQ）—— 5xx 重试耗尽的资源真正进 dlq_messages 表，
    // 不只留在内存缓冲里（失败不静默改数据：留底、可按序回放）
    if (this.dlqSink) {
      try {
        this.dlqSink.enqueue({
          channelName: this.dlqChannelName,
          errorCode,
          errorMessage: err.message,
          rawBytes,
        });
      } catch (dlqErr) {
        // DLQ 落盘失败不能盖掉原始错误（原始错误由调用方处理）
        log.error(
          { err_message: (dlqErr as Error).message, resourceType },
          'FHIR 写入失败入 DLQ 时落盘失败',
        );
      }
    }
  }

  /** 凭据类错误统一归口（不混进数据类错误码） */
  private asAuthError(err: unknown, context: ErrorContext): Error {
    if (isBaseError(err) && err.code.startsWith('AUTH_TOKEN')) return err;
    return new AuthTokenInvalidError(`FHIR 凭据获取失败：${(err as Error).message}`, context, err);
  }

  /** 取 bearer —— 静态 token 优先，否则走 OAuth2 client-credentials */
  private async bearer(): Promise<string> {
    if (this.staticToken) return `Bearer ${this.staticToken}`;
    return this.oidc!.getBearer();
  }

  /** 401 后刷新凭据；静态 token 模式无 token 端点可刷新 → 直接报错 */
  private async refreshOnce(context: ErrorContext): Promise<void> {
    if (!this.oidc) {
      throw new AuthTokenExpiredError('FHIR 端点返回 401：静态 bearer token 已失效（需换发新 token）', context);
    }
    await this.oidc.refreshOnce(context);
  }

  private buildHeaders(input: WriteResourceInput): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/fhir+json',
      Accept: 'application/fhir+json',
    };
    if (input.idempotencyKey && !input.skipIfNoneExist) {
      headers[HEADER_IF_NONE_EXIST] = buildIfNoneExistHeader(input.idempotencyKey);
    }
    return headers;
  }

  /**
   * 装配 body —— 若 idempotencyKey 存在，自动加 identifier 字段便于服务端检索
   * 不破坏调用方原有 body 字段
   */
  private assembleBody(input: WriteResourceInput): Record<string, unknown> {
    const body: Record<string, unknown> = { ...input.body, resourceType: input.resourceType };
    if (input.idempotencyKey && !input.skipIfNoneExist && this.supportsIdentifier(input.resourceType)) {
      const existing = Array.isArray(body.identifier) ? body.identifier as Array<{ system?: string; value?: string }> : [];
      // 若已有同系统 identifier，不重复添加
      const has = existing.some((e) => e.system === 'urn:lab-ops-console:accession' && e.value === input.idempotencyKey);
      if (!has) {
        body.identifier = [
          ...existing,
          { system: 'urn:lab-ops-console:accession', value: input.idempotencyKey },
        ];
      }
    }
    return body;
  }

  /** FHIR R4 大多数 resource 支持 identifier；这里仅白名单 */
  private supportsIdentifier(resourceType: string): boolean {
    return ['Observation', 'DiagnosticReport', 'Specimen', 'Device', 'Task', 'Patient', 'Practitioner'].includes(resourceType);
  }

  private async fetchWithTimeout(url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    headers: { get(k: string): string | null };
    text(): Promise<string>;
    json(): Promise<unknown>;
  }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const fetchFn = this.fetchImpl as unknown as (input: string, init?: unknown) => Promise<{
        status: number;
        ok: boolean;
        headers: { get(k: string): string | null };
        text(): Promise<string>;
        json(): Promise<unknown>;
      }>;
      const resp = await fetchFn(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: ctrl.signal,
      });
      return resp;
    } finally {
      clearTimeout(timer);
    }
  }
}

function backoffMs(attempt: number): number {
  // 1s / 2s / 4s
  const base = 1000 * Math.pow(2, attempt);
  return Math.min(base, 8000);
}

/** 从 Location 头取资源 id（幂等命中时 Location 指向既有资源） */
function idFromLocation(location?: string): string | undefined {
  if (!location) return undefined;
  const idx = location.lastIndexOf('/');
  if (idx < 0 || idx === location.length - 1) return undefined;
  return decodeURIComponent(location.slice(idx + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 工厂函数 —— 从 env 构造（生产代码用）
 */
export function createFhirWriter(opts: {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  urlAllowlist: string[];
  dlqSink?: DlqSink;
  contractValidator?: ContractValidatorLike;
}): FhirWriter {
  return new FhirWriter({
    baseUrl: opts.baseUrl,
    urlAllowlist: opts.urlAllowlist,
    contractValidator: opts.contractValidator,
    oidc: {
      tokenEndpoint: opts.tokenUrl,
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      scope: opts.scope,
    },
    dlqSink: opts.dlqSink,
  });
}

/** 工厂函数 —— 从测试替身 fetch 实例化（给测试与本地 fhir-stub 用） */
export function createFhirWriterWithFetch(opts: {
  baseUrl: string;
  urlAllowlist: string[];
  oidc: OidcConfig;
  fetchImpl?: typeof fetch;
  dlq?: DLQEntry[];
  dlqSink?: DlqSink;
}): FhirWriter {
  return new FhirWriter({
    baseUrl: opts.baseUrl,
    urlAllowlist: opts.urlAllowlist,
    oidc: opts.oidc,
    fetchImpl: opts.fetchImpl,
    dlq: opts.dlq,
    dlqSink: opts.dlqSink,
  });
}

/**
 * 工厂函数 —— 静态 bearer token 模式
 * 院内网关已签发 token 时（env 的 LIS_FHIR_TOKEN / FHIR_TOKEN 凭据位）走这条：
 * 不做 OAuth2 往返，但仍然每次请求带 Authorization 头 + URL allowlist 校验。
 */
export function createFhirWriterWithToken(opts: {
  baseUrl: string;
  token: string;
  urlAllowlist: string[];
  requestTimeoutMs?: number;
  maxRetries?: number;
  dlqSink?: DlqSink;
  contractValidator?: ContractValidatorLike;
}): FhirWriter {
  return new FhirWriter({
    baseUrl: opts.baseUrl,
    urlAllowlist: opts.urlAllowlist,
    contractValidator: opts.contractValidator,
    staticToken: opts.token,
    requestTimeoutMs: opts.requestTimeoutMs,
    maxRetries: opts.maxRetries,
    dlqSink: opts.dlqSink,
  });
}

/**
 * 工厂函数 —— 从环境变量构造（生产路径）
 *
 * 优先 OAuth2 client-credentials（凭据位 `<PREFIX>_OAUTH_*`），
 * 没配 OAuth2 时回退到静态 token（`<PREFIX>_TOKEN`）。
 * 两条路都要求 URL allowlist —— SSRF guard 不因「凭据来自 env」而放松。
 *
 * 例：
 *   createFhirWriterFromEnv({ prefix: 'LIS_FHIR', baseUrl: 'https://lis.../fhir/R4' })
 */
export function createFhirWriterFromEnv(opts: {
  prefix: string;
  baseUrl: string;
  urlAllowlist: string[];
  requestTimeoutMs?: number;
  maxRetries?: number;
  dlqSink?: DlqSink;
  contractValidator?: ContractValidatorLike;
  env?: NodeJS.ProcessEnv;
}): FhirWriter {
  const env = opts.env ?? process.env;
  const staticToken = (env[`${opts.prefix}_TOKEN`] ?? '').trim();
  const hasOAuth = !!env[`${opts.prefix}_OAUTH_TOKEN_URL`];

  if (hasOAuth) {
    return new FhirWriter({
      baseUrl: opts.baseUrl,
      urlAllowlist: opts.urlAllowlist,
      oidc: readOidcConfigFromEnv(opts.prefix, env),
      contractValidator: opts.contractValidator,
      requestTimeoutMs: opts.requestTimeoutMs,
      maxRetries: opts.maxRetries,
      dlqSink: opts.dlqSink,
    });
  }

  if (!staticToken) {
    throw new AuthTokenMissingError(
      `FHIR 出站凭据缺失：${opts.prefix}_OAUTH_TOKEN_URL 或 ${opts.prefix}_TOKEN 至少配置一项`,
      { prefix: opts.prefix },
    );
  }
  return new FhirWriter({
    baseUrl: opts.baseUrl,
    urlAllowlist: opts.urlAllowlist,
    staticToken,
    contractValidator: opts.contractValidator,
    requestTimeoutMs: opts.requestTimeoutMs,
    maxRetries: opts.maxRetries,
    dlqSink: opts.dlqSink,
  });
}

/** 注入 push_queue 表（持久化 DLQ —— T20 推送队列复用） */
export function writeDLQToSqlite(db: DB, entry: DLQEntry): void {
  db.prepare(`
    INSERT INTO push_queue (task_id, channel, payload, status, retry_count, last_error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `dlq:${entry.resource_type}:${entry.resource_id ?? 'unknown'}`,
    'fhir',
    entry.raw_bytes.toString('utf-8'),
    'failed',
    entry.retry_count,
    `${entry.error_code}: ${entry.error_message}`,
  );
}
