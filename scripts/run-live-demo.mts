/**
 * T37 · 真实运行演示服务（仅启动，不推数据）
 *
 * 起真实 FHIR 替身 + 真实 TCP 通道 + 真实 HTTP/WS 网关，导出真实端口
 * （含 devicePort 供截图脚本用真实 TCP 推帧），保持运行直到 SIGTERM。
 * 数据推送与状态驱动交由 shoot.py 完成，以保证面板 WS 事件在页面加载后实时触发。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from '../tests/e2e/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const shotDir = resolve(here, '../docs/screenshots');
mkdirSync(shotDir, { recursive: true });

const WALLBOARD_TOKEN = 'demo-wallboard-2026';
const AUDIT_DIR = '/tmp/lab-shots-audit';

async function main(): Promise<void> {
  const h = await startHarness({ wallboardToken: WALLBOARD_TOKEN, auditDir: AUDIT_DIR });

  writeFileSync(
    resolve(shotDir, 'capture-ports.json'),
    JSON.stringify(
      { httpPort: h.httpPort, devicePort: h.devicePort, stubPort: h.stubPort, wallboardToken: WALLBOARD_TOKEN },
      null,
      2,
    ),
  );

  // eslint-disable-next-line no-console
  console.log(`READY http=${h.httpPort} device=${h.devicePort} stub=${h.stubPort} token=${WALLBOARD_TOKEN}`);

  const shutdown = async (): Promise<void> => {
    try { await h.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
  setInterval(() => {}, 1000);
}

main().catch((err: Error) => {
  process.stderr.write(`[run-live-demo] 失败：${err.stack ?? err.message}\n`);
  process.exit(1);
});
