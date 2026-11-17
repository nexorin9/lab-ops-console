/**
 * 把浏览器面板静态资源复制到 dist/gateway/static，供 `node dist/index.js` 直接服务。
 * 纯 Node 实现（不依赖 cp/robocopy），Windows 工控机同样可跑。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'gateway', 'static');
const dest = join(root, 'dist', 'gateway', 'static');

if (!existsSync(src)) {
  process.stderr.write(`静态资源目录不存在：${src}\n`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
process.stdout.write(`静态资源已复制：${src} → ${dest}\n`);
