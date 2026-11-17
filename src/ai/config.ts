/**
 * ModelGateway 配置位 —— 只认 OpenAI-compatible 一种协议，四项全部从 env 读。
 * 业务层不得 import 任何厂商 SDK；换供应商只改 env，不改代码。
 */

import { EnvMissingError } from '../shared/errors.js';

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export const DEFAULT_MODELS_TIMEOUT_MS = 8_000;
export const MODEL_ENV_KEYS = ['MODELS_BASE_URL', 'MODELS_API_KEY', 'MODELS_MODEL', 'MODELS_TIMEOUT_MS'] as const;

/**
 * 从环境变量读配置；缺失必填项抛 EnvMissingError 并点名缺哪个 env。
 * timeout 选填，默认 8000ms。
 */
export function readModelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const missing = ['MODELS_BASE_URL', 'MODELS_API_KEY', 'MODELS_MODEL'].filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    throw new EnvMissingError(`模型网关配置缺失：${missing.join(', ')}`, { envNames: missing });
  }
  const rawTimeout = env.MODELS_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number.parseInt(rawTimeout, 10) : DEFAULT_MODELS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new EnvMissingError('MODELS_TIMEOUT_MS 必须是正整数', { envName: 'MODELS_TIMEOUT_MS', raw: rawTimeout });
  }
  return {
    baseUrl: env.MODELS_BASE_URL!.trim().replace(/\/$/, ''),
    apiKey: env.MODELS_API_KEY!.trim(),
    model: env.MODELS_MODEL!.trim(),
    timeoutMs,
  };
}

/** 拼接 chat/completions 端点（baseUrl 可能已带 /v1） */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}
