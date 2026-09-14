#!/usr/bin/env node
// 构建前把根 public/dict/**/*.dict 同步到 packages/web/public/dict，
// 使 `vite build` 产物自带 dist/dict/*，preview/Pages 同源可取，结束 dict-loader 的 SPA 回退 HTML 噪音。
// 根因：dist 无 /dict/* 时 /dict/en/*.dict 回 index.html（200 text/html），真词全 miss，KJV 在 5175 整页全空。
// 只复制 .dict（.br 是 R2 部署物，浏览器不读）；幂等，可重复跑。
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const src = join(webRoot, '..', '..', 'public', 'dict');
const dst = join(webRoot, 'public', 'dict');

let files = 0;
let bytes = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.dict')) continue;
    files++;
    bytes += statSync(p).size;
  }
}
try {
  walk(src);
} catch (e) {
  console.error(`copy-dict: 根词典缺失 ${src}：${String(e).slice(0, 160)}`);
  process.exit(1);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true, filter: (p) => statSync(p).isDirectory() || p.endsWith('.dict') });
console.log(`copy-dict: ${files} 个 .dict，共 ${(bytes / 1024).toFixed(0)}KB -> packages/web/public/dict`);
