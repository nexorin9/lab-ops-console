/**
 * 通用 OAuth2 client-credentials OIDC 客户端（适配院内网关）
 *
 * 设计原则：
 * - 与 MedplumClient / 厂商 SDK 解耦；纯 fetch + AbortController
 * - token 缓存到内存（不持久化 —— 凭据安全）
 * - 提前 60s 刷新（拒绝在临界点过期）
 * - 401 触发 refreshOnce 强制重取一次
 * - 并发去重：多个调用方同时需要 token 时，只发一次获取请求（inFlight Promise）
 * - 可注入 mock fetch（测试用 `injectFetch()`）
 *
 * 配置（来自 env 或手工构造）：
 * - tokenEndpoint: POST 路径（绝对 URL 或 baseUrl 相对）
 * - clientId / clientSecret: OAuth2 client_credentials 凭据
 * - scope: 可选
 * - expiresInSkewMs: 提前刷新余量（默认 60_000 ms）
 */

import {
  AuthTokenExpiredError,
  AuthTokenInvalidError,
  AuthTokenMissingError,
  type ErrorContext,
  isBaseError,
} from '../shared/errors.js';

export interface OidcConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  expiresInSkewMs?: number;
  /** token 端点请求超时 ms（默认 8000）—— 端点挂住时不能把采集线程一起挂住 */
  timeoutMs?: number;
}

export interface OidcToken {
  access_token: string;
  token_type: string;
  expires_at: number;
  expires_in: number;
  scope?: string;
}

interface FetchLike {
  (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
    signal?: AbortSignal;
  }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

let injectedFetch: FetchLike | null = null;
/** 测试用：注入自定义 fetch（不会出现在产品代码中） */
export function injectFetch(fetchImpl: FetchLike | null): void {
  injectedFetch = fetchImpl;
}

/** 工厂：传入 token endpoint / 凭据，返回缓存型 OidcClient */
export function createOidcClient(config: OidcConfig): OidcClient {
  return new OidcClient(config);
}

/**
 * 从环境变量读取 OAuth2 client-credentials 配置
 *
 * 凭据位（凭据一律只从环境变量读，代码里不硬编码）：
 * - `<PREFIX>_OAUTH_TOKEN_URL`  token 端点（绝对 URL）
 * - `<PREFIX>_OAUTH_CLIENT_ID`  客户端 ID
 * - `<PREFIX>_OAUTH_CLIENT_SECRET` 客户端密钥
 * - `<PREFIX>_OAUTH_SCOPE`      可选，授权范围
 *
 * 例：PREFIX='LIS_FHIR' → LIS_FHIR_OAUTH_TOKEN_URL / LIS_FHIR_OAUTH_CLIENT_ID / ...
 *
 * 三项必填缺任一 → 抛 AuthTokenMissingError（含缺哪个 envName），
 * 不静默降级成「无凭据空转」—— 宁可启动即失败，也不要在院内跑出「以为写进去了其实没写」。
 */
export function readOidcConfigFromEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): OidcConfig {
  const tokenUrl = (env[`${prefix}_OAUTH_TOKEN_URL`] ?? '').trim();
  const clientId = (env[`${prefix}_OAUTH_CLIENT_ID`] ?? '').trim();
  const clientSecret = (env[`${prefix}_OAUTH_CLIENT_SECRET`] ?? '').trim();
  const scope = (env[`${prefix}_OAUTH_SCOPE`] ?? '').trim();

  const missing: string[] = [];
  if (!tokenUrl) missing.push(`${prefix}_OAUTH_TOKEN_URL`);
  if (!clientId) missing.push(`${prefix}_OAUTH_CLIENT_ID`);
  if (!clientSecret) missing.push(`${prefix}_OAUTH_CLIENT_SECRET`);
  if (missing.length > 0) {
    throw new AuthTokenMissingError(
      `OAuth2 凭据缺失：${missing.join(' / ')}`,
      { missing },
    );
  }

  return {
    tokenEndpoint: tokenUrl,
    clientId,
    clientSecret,
    scope: scope || undefined,
  };
}

/** 工厂：从环境变量构造 OidcClient（生产路径：凭据不落代码、不落配置文件） */
export function createOidcClientFromEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): OidcClient {
  return new OidcClient(readOidcConfigFromEnv(prefix, env));
}

export class OidcClient {
  private readonly config: Required<OidcConfig>;
  private cached: OidcToken | null = null;
  private inFlight: Promise<OidcToken> | null = null;
  /** 刷新请求的 in-flight —— 并发 401 只发一次刷新（否则一台仪器重连会打爆 token 端点） */
  private refreshInFlight: Promise<OidcToken> | null = null;

  constructor(config: OidcConfig) {
    if (!config.tokenEndpoint) {
      throw new AuthTokenMissingError('OidcClient.tokenEndpoint 不能为空', { field: 'tokenEndpoint' });
    }
    if (!config.clientId || !config.clientSecret) {
      throw new AuthTokenMissingError('OidcClient 凭据缺失', {
        clientId: !!config.clientId,
        clientSecret: !!config.clientSecret,
      });
    }
    this.config = {
      tokenEndpoint: config.tokenEndpoint,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      scope: config.scope ?? '',
      expiresInSkewMs: config.expiresInSkewMs ?? 60_000,
      timeoutMs: config.timeoutMs ?? 8_000,
    };
  }

  /**
   * 取 token —— 命中缓存（expires_at - now > skew）直接返回；未命中或接近过期时取新
   * 并发安全：多个调用方同时需要时只发一次 token 请求
   */
  async getToken(): Promise<OidcToken> {
    if (this.isTokenValid(this.cached)) return this.cached!;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    const token = await this.inFlight;
    this.cached = token;
    return token;
  }

  /**
   * 强制刷新一次（401 触发）
   *
   * 并发去重：多台仪器同时被 401（例如院内网关统一换密钥）时，
   * 并发 refreshOnce 只发一次 token 请求，其余等待同一个 Promise —— 否则会打爆 token 端点。
   */
  async refreshOnce(context: ErrorContext = {}): Promise<OidcToken> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.cached = null;
    this.refreshInFlight = (async () => {
      try {
        const token = await this.fetchToken();
        this.cached = token;
        return token;
      } catch (err) {
        if (isBaseError(err)) throw err;
        throw new AuthTokenInvalidError(
          `401 触发 refreshOnce 失败：${(err as Error).message}`,
          context,
          err,
        );
      } finally {
        this.refreshInFlight = null;
      }
    })();
    return this.refreshInFlight;
  }

  /** 取 fresh Bearer token 字符串（给 FhirWriter 直接拼 header） */
  async getBearer(): Promise<string> {
    const token = await this.getToken();
    return `${token.token_type || 'Bearer'} ${token.access_token}`;
  }

  private isTokenValid(t: OidcToken | null): boolean {
    if (!t) return false;
    const remaining = t.expires_at - Date.now();
    return remaining > this.config.expiresInSkewMs;
  }

  private async fetchToken(): Promise<OidcToken> {
    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    if (this.config.scope) body.set('scope', this.config.scope);
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');
    const fetchImpl = injectedFetch ?? (globalThis.fetch as unknown as FetchLike);
    if (typeof fetchImpl !== 'function') {
      throw new AuthTokenInvalidError('OidcClient.fetchToken 缺少 fetch 实现', {});
    }
    let resp: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
    try {
      resp = await fetchImpl(this.config.tokenEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // token 端点网络不可达（DNS / 连接被拒 / 超时）—— 这是「取不到 token」，
      // 不是「token 过期」。两者在上层走不同降级路径：过期 → 刷新重试一次；
      // 网络不通 → 直接报错并入 DLQ（重试无意义，等网络恢复后回放）。
      if (isBaseError(err)) throw err;
      throw new AuthTokenInvalidError(
        `OAuth2 token 端点网络失败：${(err as Error).message}`,
        { tokenEndpoint: this.config.tokenEndpoint },
        err,
      );
    }
    if (resp.status === 401) {
      clearTimeout(timer);
      throw new AuthTokenExpiredError('OAuth2 token 端点返回 401', { tokenEndpoint: this.config.tokenEndpoint });
    }
    if (!resp.ok) {
      clearTimeout(timer);
      const text = await resp.text().catch(() => '');
      throw new AuthTokenInvalidError(
        `OAuth2 token 端点 ${resp.status}：${text.slice(0, 200)}`,
        { tokenEndpoint: this.config.tokenEndpoint, status: resp.status },
      );
    }
    clearTimeout(timer);
    const json = (await resp.json()) as Record<string, unknown>;
    const access_token = String(json.access_token ?? '');
    if (!access_token) {
      throw new AuthTokenInvalidError('OAuth2 响应缺少 access_token', { keys: Object.keys(json) });
    }
    const expires_in = Number(json.expires_in ?? 3600);
    const expires_at = Date.now() + expires_in * 1000;
    return {
      access_token,
      token_type: String(json.token_type ?? 'Bearer'),
      expires_in,
      expires_at,
      scope: typeof json.scope === 'string' ? json.scope : this.config.scope,
    };
  }

  /** 测试用：清空缓存与 inFlight */
  reset(): void {
    this.cached = null;
    this.inFlight = null;
    this.refreshInFlight = null;
  }
}
