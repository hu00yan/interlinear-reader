#!/usr/bin/env node
// 构建时把 packages/web/public/dict 下超限的整包 .dict 切成 .dict.00/.dict.01… 分片。
// 根因：Pages 单文件 25MB 上限（en/en.dict 25.3MB 直接部署失败）；切后每片 ≤20MB，
// web loader 按 whole -> .00 -> .01 … 顺序拼接（见 dict-loader.ts loadPair）。
// 只动 web 构建副本：根 public/dict 保持整包（R2 canonical + dict-proof 用整包）。
import { readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dictRoot = join(here, '..', 'public', 'dict');
const LIMIT = 20 * 1024 * 1024;

let split = 0;
for (const lang of readdirSync(dictRoot)) {
  const dir = join(dictRoot, lang);
  let files;
  try {
    if (!statSync(dir).isDirectory()) continue;
    files = readdirSync(dir);
  } catch { continue; }
  for (const f of files.filter((x) => x.endsWith('.dict') && !/\.\d+$/.test(x))) {
    const p = join(dir, f);
    const size = statSync(p).size;
    if (size <= LIMIT) continue;
    const lines = readFileSync(p, 'utf8').split('\n');
    // 按行均分，保证每片 < LIMIT（含行尾换行）。
    const bytes = Buffer.byteLength(readFileSync(p));
    const n = Math.ceil(bytes / LIMIT);
    const per = Math.ceil(lines.length / n);
    for (let i = 0; i < n; i++) {
      const part = lines.slice(i * per, (i + 1) * per).join('\n');
      const name = `${f}.${String(i).padStart(2, '0')}`;
      writeFileSync(join(dir, name), part);
      console.log(`split-dict: ${lang}/${name} ${(Buffer.byteLength(part) / 1024 / 1024).toFixed(1)}MB`);
    }
    rmSync(p); // 整包下线（Pages 发不上去），loader 走分片；R2 留整包 canonical。
    split++;
  }
}
console.log(split ? `split-dict: ${split} 个超限整包已切分` : 'split-dict: 无超限整包');
