// Budget gates (fail verify when exceeded) — Track B scope (B1 按 track 分流).
// Three columns (see SIZES.md 首屏/懒加载/缓存):
// (a) 首屏 first-screen JS gzip from the REAL web build (same rule as
//     packages/web/scripts/check-size.mjs, recomputed here for the report);
// (b) 懒加载 single lang pack (.br bytes from public/dict/sizes.json,
//     Track B langs only — el/zh owned by other tracks, skipped);
// (c) 缓存/托管 R2 total (.br sum + cache headroom note).
// This file never assumes fnv1a 00/01 shards and never reads `00.json` —
// per-lang bytes come from sizes.json (manifest/shard contract is
// packages/dict-loader/src/shard.mjs, single source).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { TRACK_B_LANGS } from "../packages/dict-loader/src/shard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAZY_RE = /lang-dict|epub|llm|url-ingest|markdown|marked/;

export const BUDGETS = {
  firstScreenJsGzip: 60 * 1024, // owner: packages/web/scripts/check-size.mjs
  // 单语言 .br 总和：种子期 200KB 已过时。真实 dumps 接入后 MB 量级是设计值
  // （见 SIZES.md §4：en≤8MB / ja≤10MB / 其余各≤3MB；首屏不含词典，运行时按需懒加载
  // 1–N 个 shard）。per-lang 上限 15MB（当前最大 ja ~13MB），R2 总量门仍卡 50MB；
  // 若总量超限再按 DICT_SOURCES.md 用 --maxEntries 词频裁剪，而非砍单语言预算。
  singleLangPackBr: 15 * 1024 * 1024,
  r2TotalBr: 50 * 1024 * 1024, // all dict .br (free tier 10GB; far below)
};

export function checkBudgets() {
  const results = [];
  const assets = join(root, "packages/web/dist/assets");
  if (!existsSync(assets)) throw new Error("packages/web/dist/assets missing — run web build first (packages/web/dist/assets)");
  let first = 0;
  const perFile = [];
  for (const f of readdirSync(assets).filter((x) => x.endsWith(".js"))) {
    const gz = gzipSync(readFileSync(join(assets, f))).length;
    perFile.push({ f, gzip: gz, lazy: LAZY_RE.test(f) });
    if (!LAZY_RE.test(f)) first += gz;
  }
  results.push({ name: "first-screen JS gzip", actual: first, budget: BUDGETS.firstScreenJsGzip, ok: first <= BUDGETS.firstScreenJsGzip, file: "packages/web/dist/assets", detail: perFile });
  const sizesPath = join(root, "public/dict/sizes.json");
  let sizes = {};
  try { sizes = existsSync(sizesPath) ? JSON.parse(readFileSync(sizesPath, "utf8")) : {}; } catch { sizes = {}; }
  let r2 = 0;
  for (const lang of TRACK_B_LANGS) {
    const s = sizes[lang];
    if (!s) continue; // not built yet — skip, never ENOENT
    r2 += s.brBytes ?? 0;
    results.push({ name: `lang pack ${lang} (.br)`, actual: s.brBytes, budget: BUDGETS.singleLangPackBr, ok: s.brBytes <= BUDGETS.singleLangPackBr, file: `public/dict/${lang}/` });
  }
  results.push({ name: "R2 total (.br, Track B only)", actual: r2, budget: BUDGETS.r2TotalBr, ok: r2 <= BUDGETS.r2TotalBr, file: "public/dict/" });
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rs = checkBudgets();
  for (const r of rs) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.actual} <= ${r.budget} (${r.file})`);
  if (rs.some((r) => !r.ok)) process.exit(1);
}
