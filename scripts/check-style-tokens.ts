/**
 * T30 · 面板样式契约守护脚本（可跑，不靠人眼）
 *
 * 校验：
 * 1. tokens.css 定义了全部必需 token（配色 / 字号 / 间距 / 圆角 / 阴影 / 字体栈）；
 * 2. 危急态「不依赖颜色」——必须同时定义形状变量（--critical-bar / --critical-glyph）
 *    且存在 .critical::before 用图形符号（▲）；
 * 3. index.html 与 wallboard.html 都引用了 tokens.css。
 *
 * 任一不满足 → 退出码 1，并列出缺失项；满足 → RESULT=PASS。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(ROOT, 'src/gateway/static/tokens.css');
const PANEL = join(ROOT, 'src/gateway/static/index.html');
const WALL = join(ROOT, 'src/gateway/static/wallboard.html');

const REQUIRED_VARS = [
  '--c-primary', '--c-bg', '--c-surface', '--c-border', '--c-text', '--c-text-muted',
  '--c-critical', '--c-critical-bg', '--c-warn', '--c-ok', '--c-info',
  '--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-xxl',
  '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5', '--sp-6',
  '--radius-sm', '--radius-md', '--radius-lg',
  '--shadow-1', '--shadow-2',
  '--font-sans', '--font-mono',
  '--critical-bar', '--critical-glyph',
];

function check(): boolean {
  let ok = true;
  const missing: string[] = [];
  if (!existsSync(TOKENS)) { console.error('[样式] 缺失 tokens.css'); return false; }
  const css = readFileSync(TOKENS, 'utf-8');
  for (const v of REQUIRED_VARS) {
    if (!new RegExp(`\\${v}\\s*:`).test(css)) { missing.push(v); ok = false; }
  }
  // 危急态不依赖颜色：形状符号必须存在且被 ::before 使用
  if (!/\.critical::before/.test(css) || !css.includes('--critical-glyph')) {
    console.error('[样式] 危急态缺少形状/符号指示（色觉障碍不可辨）'); ok = false;
  }
  if (missing.length) console.error(`[样式] tokens.css 缺失变量：${missing.join(', ')}`);

  for (const f of [PANEL, WALL]) {
    if (!existsSync(f)) { console.error(`[样式] 缺失 ${f}`); ok = false; continue; }
    const html = readFileSync(f, 'utf-8');
    if (!html.includes('tokens.css')) {
      console.error(`[样式] ${f} 未引用 tokens.css`); ok = false;
    }
  }
  return ok;
}

const passed = check();
process.stdout.write(`[样式] token 契约校验：${passed ? 'PASS' : 'FAIL'}\n`);
process.stdout.write(`RESULT=${passed ? 'PASS' : 'FAIL'}\n`);
process.exit(passed ? 0 : 1);
