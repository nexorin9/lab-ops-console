/**
 * CLI —— node dist/gateway/cli.js start|status|reload|export|doctor|redeliver
 *
 * CLI 定位为运维与排障通道：日常业务在浏览器面板完成（见 README 快速开始）。
 * export 会逐行强校验 AuditEvent 四字段，缺字段直接拒绝出表并列出 taskId。
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getSqlite } from '../shared/sqlite.js';
import { CriticalStore } from '../critical/store.js';
import { buildLedger, ledgerToCsv } from '../critical/ledger.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { createLabOpsApp } from '../index.js';

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function argValue(args: string[], name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1]! : fallback;
}

function baseUrl(): string {
  return `http://127.0.0.1:${process.env.HTTP_PORT ?? 3000}`;
}

async function httpJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, init);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

async function exportLedger(args: string[]): Promise<void> {
  const month = argValue(args, '--month', new Date().toISOString().slice(0, 7));
  const target = resolve(argValue(args, '--out', `exports/close-loop-${month}.csv`));
  const db = getSqlite({ dataDir: process.env.DATA_DIR ?? './data' });
  const store = new CriticalStore(db);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const range = {
    from: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    to: new Date(Date.UTC(y, m, 1) - 1).toISOString(),
  };
  const rows = await buildLedger(store, range);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, ledgerToCsv(rows), 'utf-8');
  out(`台账已导出：${target}（${rows.length} 行，区间 ${range.from} ~ ${range.to}）`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'start': {
      const app = await createLabOpsApp();
      await app.start();
      out(`服务已启动：面板 http://127.0.0.1:${app.httpPort}/ ，护士站大屏 /critical`);
      out(`仪器接入端口：${app.devicePort}`);
      return;
    }
    case 'status': {
      try {
        const health = await httpJson('/healthz');
        const channels = await httpJson('/api/channels');
        out(JSON.stringify({ health, channels }, null, 2));
      } catch (err) {
        out(`服务未启动或不可达：${(err as Error).message}`);
        out('请先执行 node dist/index.js 或 npm start，再运行 status。');
        process.exitCode = 1;
      }
      return;
    }
    case 'reload': {
      const id = args[0];
      if (!id) { out('用法：node dist/gateway/cli.js reload <channelId>'); process.exitCode = 1; return; }
      out(JSON.stringify(await httpJson(`/api/channels/${encodeURIComponent(id)}/reload`, { method: 'POST' }), null, 2));
      return;
    }
    case 'redeliver': {
      out(JSON.stringify(await httpJson('/api/push/redeliver', { method: 'POST' }), null, 2));
      return;
    }
    case 'export': {
      await exportLedger(args);
      return;
    }
    case 'doctor': {
      const result = await runDoctor({ checkPorts: args.includes('--no-ports') ? false : true });
      out(formatDoctor(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    default: {
      out('检验仪器接入与危急值闭环系统 · 运维命令');
      out('  start                          启动常驻服务（面板 + 仪器接入）');
      out('  status                         查看健康状态与通道状态');
      out('  reload <channelId>             热重载单条通道（不影响其他仪器）');
      out('  export [--month YYYY-MM] [--out 路径]   导出本月闭环台账 CSV（强校验审计字段）');
      out('  redeliver                      人工触发断网期间通知补推');
      out('  doctor                         工控机环境自检');
    }
  }
}

main().catch((err: Error) => {
  process.stderr.write(`[cli] 命令失败：${err.stack ?? err.message}\n`);
  process.exit(1);
});
