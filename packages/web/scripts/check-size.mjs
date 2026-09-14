#!/usr/bin/env node
// 首屏 JS <60KB gzip 验收（语言包/词典不计——它们已拆分为 lang-dict/epub/llm/url-ingest 懒加载 chunk）。
// 口径诚实性：vite 默认 modulepreload 会让入口 HTML 预取懒加载块，首屏实际流量包含它们；
// 本仓已在 vite.config.ts 置 build.modulePreload=false，此处顺带断言 dist/index.html 无 modulepreload，
// 防止将来有人重开预取导致“首屏 8KB”失真（真首屏会回到 ~40KB+）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const LIMIT_KB = 60;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist', 'assets');
if (!existsSync(dist)) {
  console.error('dist/assets 不存在，先跑 vite build');
  process.exit(1);
}
// 预取断言：入口 HTML 不得预取懒加载块
const htmlPath = join(root, 'dist', 'index.html');
if (existsSync(htmlPath)) {
  const html = readFileSync(htmlPath, 'utf8');
  if (/rel="modulepreload"/.test(html)) {
    console.error('FAIL: dist/index.html 含 modulepreload（懒加载块被首屏预取，首屏口径失真）。');
    console.error('修复：保持 vite.config.ts build.modulePreload=false 后重跑 vite build。');
    process.exit(1);
  }
}
const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
const rows = files.map((f) => {
  const buf = readFileSync(join(dist, f));
  return { f, raw: buf.length, gzip: gzipSync(buf).length };
});
// 首屏 = index 入口 chunk（排除 lang-dict / epub / llm / url-ingest 懒加载块）
const lazy = /lang-dict|epub|llm|url-ingest|markdown|marked/;
const first = rows.filter((r) => !lazy.test(r.f));
const total = first.reduce((a, r) => a + r.gzip, 0);
console.log('--- chunks (gzip) ---');
for (const r of rows) console.log(`${lazy.test(r.f) ? '[lazy] ' : '[first]'}${r.f} raw=${(r.raw / 1024).toFixed(1)}KB gzip=${(r.gzip / 1024).toFixed(1)}KB`);
console.log(`首屏合计 gzip=${(total / 1024).toFixed(1)}KB（上限 ${LIMIT_KB}KB；懒加载块不计但不得被 modulepreload）`);
if (total > LIMIT_KB * 1024) {
  console.error(`FAIL: 首屏超 ${LIMIT_KB}KB gzip`);
  process.exit(1);
}
console.log('PASS');
