#!/usr/bin/env node
// 构建前把词典整包备齐到 packages/web/public/dict，使 `vite build` 产物自带 dist/dict/*。
// 来源优先级（每个 lang×target 独立决定）：
//   1) 根 public/dict/{lang}/{target}.dict（build:dict 刚产出的最新数据，本地开发常用）
//   2) R2 公开源 canonical 整包 {R2}/dict/{lang}/{target}.dict.br（服务端下载 +
//      zlib brotli 解压——无 CORS/编码回显问题；对象可能是纯文本旧版，按字节嗅探分流）
// 2026-11-07 起词典产物不入 git（仓库体积），CF Pages 构建靠 2) 从 R2 自取。
// 幂等可重跑；单个语言对失败只告警不中断（build-check 仍是硬门，缺 shards 会拦）。
import { brotliDecompressSync } from "node:zlib";
import { cpSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const src = join(webRoot, "..", "..", "public", "dict");
const dst = join(webRoot, "public", "dict");
const R2_PUBLIC =
  process.env.VITE_R2_PUBLIC || "https://pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev";
const LANGS = ["en", "de", "fr", "it", "es", "ru", "ja"];
const TARGETS = ["zh", "en"];

mkdirSync(dst, { recursive: true });

/** R2 .br 对象 → TSV 文本。旧对象可能是未压缩纯文本（2026-09 上传无 content-encoding），
 * 新对象是真 brotli——按可打印性嗅探（\t=9 分隔、\x1f=31 多释义分隔、\n=10 换行均合法），
 * 不做无谓解压；嗅探不过再试 brotli。 */
function decodeBrObject(buf) {
  const head = buf.subarray(0, 256);
  const printable = head.every(
    (b) => b === 9 || b === 10 || b === 13 || b === 31 || (b >= 32 && b < 127) || b >= 128
  );
  if (printable && head.includes(9)) return buf.toString("utf8");
  return brotliDecompressSync(buf).toString("utf8");
}

async function fromR2(lang, target) {
  const url = `${R2_PUBLIC}/dict/${lang}/${target}.dict.br`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status !== 404) console.warn(`copy-dict: R2 ${lang}/${target} HTTP ${res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const text = decodeBrObject(buf);
    if (!text.includes("\t")) {
      console.warn(`copy-dict: R2 ${lang}/${target} 对象非 TSV（${buf.length}B）`);
      return null;
    }
    return text;
  } catch (e) {
    console.warn(`copy-dict: R2 ${lang}/${target} 拉取失败：${String(e).slice(0, 120)}`);
    return null;
  }
}

let copied = 0;
let fetched = 0;
const failed = [];

for (const lang of LANGS) {
  for (const target of TARGETS) {
    for (const flavor of ["", ".core"]) {
      const local = join(src, lang, `${target}${flavor}.dict`);
      if (existsSync(local)) {
        mkdirSync(join(dst, lang), { recursive: true });
        cpSync(local, join(dst, lang, `${target}${flavor}.dict`));
        copied++;
        continue;
      }
      const text = await fromR2(lang, `${target}${flavor}`);
      if (text !== null) {
        mkdirSync(join(dst, lang), { recursive: true });
        writeFileSync(join(dst, lang, `${target}${flavor}.dict`), text);
        fetched++;
        continue;
      }
      // core 缺失可容忍（loader 自动降级全量直载）；整包缺失才进 failed 名单。
      if (!flavor) failed.push(`${lang}/${target}`);
    }
  }
}
console.log(
  `copy-dict: 本地复制 ${copied} 个 + R2 拉取 ${fetched} 个` +
    (failed.length ? `；缺失 ${failed.join(", ")}（build-check 会拦）` : "") +
    ` -> packages/web/public/dict`
);
