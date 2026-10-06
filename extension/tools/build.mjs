// NOL Scout 构建脚本
// 内容脚本（content_scripts）不支持 ES module 的 import 语法，
// 因此把 lib/*.js 与 content/onestop-seat.js 打成一个经典脚本 content/seat-bundle.js。
//
// 用法：node tools/build.mjs   （或 npm run build）
//
// 处理规则（本项目的代码风格是刻意配合的）：
//   - 删除单行 `import ... from '...';`
//   - `export function/const/async function/class` -> 去掉 export
//   - 删除 `export { ... };` 具名导出块
//   - 整体包进 IIFE，避免污染页面全局

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PARTS = [
  'lib/nol-api.js',
  'lib/seat-engine.js',
  'lib/locator.js',
  'lib/seat-prefs.js',
  'lib/session-timer.js',
  'lib/panel-pos.js',
  'lib/captcha.js',
  'content/onestop-seat.js',
];

function stripModuleSyntax(src) {
  let out = src;
  // 去掉所有 import 语句（含多行）
  out = out.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  out = out.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  // 去掉 export { ... };
  out = out.replace(/^\s*export\s*\{[\s\S]*?\};?\s*$/gm, '');
  // 去掉行首 export 关键字
  out = out.replace(/^(\s*)export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1$2');
  return out;
}

const banner = `// ⚠️ 本文件由 tools/build.mjs 自动生成，请勿直接修改。
// 源文件：${PARTS.join(' + ')}
// 生成时间：${new Date().toISOString()}
`;

const body = PARTS.map((p) => {
  const abs = path.join(root, p);
  const src = fs.readFileSync(abs, 'utf8');
  return `// ===== ${p} =====\n${stripModuleSyntax(src)}`;
}).join('\n\n');

const out = `${banner}(() => {\n'use strict';\n${body}\n})();\n`;

const dest = path.join(root, 'content/seat-bundle.js');
fs.writeFileSync(dest, out, 'utf8');
console.log(`✓ 已生成 ${path.relative(root, dest)}（${(out.length / 1024).toFixed(1)} KB）`);
