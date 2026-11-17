/**
 * 工控机环境自检（CLI doctor / scripts/install-check.sh 共用）
 * 逐项给中文结论：Node 版本、必填环境变量、目录权限、端口占用、通道配置、构建产物。
 */

import { existsSync, mkdirSync, accessSync, constants, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { REQUIRED_ENV_KEYS } from '../shared/env.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  /** 是否阻断上线（false = 仅提示） */
  blocking: boolean;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  checkPorts?: boolean;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];

  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  checks.push({
    name: 'Node 版本',
    ok: major >= 20,
    blocking: true,
    message: major >= 20
      ? `Node ${process.versions.node}（要求 ≥20）`
      : `当前 Node ${process.versions.node} 过低，请升级到 Node 20 或更高版本`,
  });

  const missing = REQUIRED_ENV_KEYS.filter((k) => !env[k]?.trim());
  checks.push({
    name: '必填环境变量',
    ok: missing.length === 0,
    blocking: true,
    message: missing.length === 0
      ? `${REQUIRED_ENV_KEYS.length} 项必填配置齐备`
      : `缺少 ${missing.length} 项：${missing.join('、')}（请在 .env 中补齐或在系统环境变量中设置）`,
  });

  const dataDir = resolve(cwd, env.DATA_DIR ?? './data');
  let dataOk = true;
  let dataMsg = `数据目录 ${dataDir} 可写`;
  try {
    mkdirSync(dataDir, { recursive: true });
    accessSync(dataDir, constants.W_OK);
  } catch (err) {
    dataOk = false;
    dataMsg = `数据目录 ${dataDir} 不可写：${(err as Error).message}`;
  }
  checks.push({ name: '数据目录权限', ok: dataOk, blocking: true, message: dataMsg });

  const channelsDir = resolve(cwd, 'channels');
  const yamlCount = existsSync(channelsDir)
    ? readdirSync(channelsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).length
    : 0;
  checks.push({
    name: '通道配置',
    ok: yamlCount > 0,
    blocking: true,
    message: yamlCount > 0 ? `发现 ${yamlCount} 份通道 yaml` : 'channels/ 下没有 yaml 配置，请至少配置一条仪器通道',
  });

  checks.push({
    name: '配置样例',
    ok: existsSync(resolve(cwd, '.env.example')),
    blocking: false,
    message: existsSync(resolve(cwd, '.env.example')) ? '.env.example 存在' : '缺少 .env.example（可选，但建议保留作配置说明）',
  });

  checks.push({
    name: '构建产物',
    ok: existsSync(resolve(cwd, 'dist/index.js')),
    blocking: false,
    message: existsSync(resolve(cwd, 'dist/index.js')) ? 'dist/index.js 已构建' : '尚未构建；上线前请执行 npm run build',
  });

  if (opts.checkPorts !== false) {
    const httpPort = Number(env.HTTP_PORT ?? 3000);
    const devicePort = Number(env.DEVICE_LISTEN_PORT ?? 2575);
    for (const [name, port] of [['面板端口', httpPort], ['仪器接入端口', devicePort]] as const) {
      const free = await portFree(port);
      checks.push({
        name,
        ok: free,
        blocking: false,
        message: free ? `${port} 可用` : `${port} 已被占用；若本服务已启动属正常，否则请检查防火墙与占用进程`,
      });
    }
  }

  return { ok: checks.filter((c) => c.blocking).every((c) => c.ok), checks };
}

/** 中文自检结论文本（CLI / shell 脚本直接打印） */
export function formatDoctor(result: DoctorResult): string {
  const lines = ['=== 工控机环境自检 ==='];
  for (const c of result.checks) {
    lines.push(`${c.ok ? '[通过]' : '[缺项]'} ${c.name}：${c.message}`);
  }
  lines.push(result.ok ? '结论： blocking 项全部通过，可以启动服务。' : '结论：存在阻断项，请按上面的中文提示逐项补齐后再启动。');
  return lines.join('\n');
}
