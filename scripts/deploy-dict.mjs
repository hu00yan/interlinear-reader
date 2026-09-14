// R2 dict uploader — Track B scope only (B1 按 track 分流).
// Uploads Track B's PREBUILT .br shards — R2 is the canonical store AND the
// public read origin (r2.dev, no Worker): web loader falls back to it when
// same-origin whole/chunks are missing (see dict-loader.ts loadPair).
//   npm run deploy:dict        -> DRY-RUN: object table + totals, no network
//   npm run deploy:dict:live   -> `wrangler r2 object put` each .br object
// Layout: dict/{lang}/{target}.dict.br (one object per language pair).
// Track fork (see DICT_SOURCES.md §契约分叉): Track B owns
// en,de,fr,it,es,ru,ja; public/dict/{el,zh} (and sizes.json/coverage.json)
// belong to other tracks and are SKIPPED here, never uploaded, never
// required. This script uploads only the 14 pair assets discovered on disk.
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { TRACK_B_LANGS } from "../packages/dict-loader/src/shard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.includes("--live");
const dictRoot = join(root, "public/dict");

export const TRACK = "B";
export { TRACK_B_LANGS };

export function objectTable() {
  const rows = [];
  if (!existsSync(dictRoot)) return rows;
  for (const lang of readdirSync(dictRoot)) {
    // B1 shunt: only Track B langs upload; foreign dirs/files
    // (el, zh, sizes.json, coverage.json, …) are other tracks' — skip.
    if (!TRACK_B_LANGS.includes(lang)) continue;
    let dir;
    try {
      const st = statSync(join(dictRoot, lang));
      if (!st.isDirectory()) continue;
      dir = readdirSync(join(dictRoot, lang));
    } catch { continue; }
    if (!Array.isArray(dir)) continue;
    for (const f of dir.filter((x) => x.endsWith(".dict.br")).sort()) {
      const st = statSync(join(dictRoot, lang, f));
      rows.push({ key: `dict/${lang}/${f}`, br: st.size });
    }
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function skippedForeign() {
  // For docs/CI: which entries under public/dict are NOT Track B (skipped).
  if (!existsSync(dictRoot)) return [];
  return readdirSync(dictRoot).filter((x) => !TRACK_B_LANGS.includes(x));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = objectTable();
  const langs = new Set(rows.map((r) => r.key.split("/")[1]));
  const total = rows.reduce((a, r) => a + r.br, 0);
  const skipped = skippedForeign();
  if (live) {
    for (const r of rows) {
      console.log(`put ilr-dict-v2/${r.key} (${r.br} B)`);
      execFileSync("wrangler", ["r2", "object", "put", `ilr-dict-v2/${r.key}`,
        "--remote", "--file", join(dictRoot, r.key.slice("dict/".length)),
        "--content-type", "text/plain; charset=utf-8", "--content-encoding", "br"], { stdio: "inherit" });
    }
    console.log(`LIVE upload done: ${rows.length} objects, ${langs.size} langs, ${total} B.`);
    if (skipped.length) console.log(`skipped non-TrackB: ${skipped.join(", ")} (owned by other tracks, see DICT_SOURCES.md)`);
  } else {
    console.log(`DRY-RUN (no network): ${rows.length} objects, ${langs.size} langs, total br=${total} B (R2 free: 10 GB)`);
    for (const r of rows.slice(0, 5)) console.log(`  ${r.key} ${r.br} B`);
    if (rows.length > 5) console.log(`  ... +${rows.length - 5} more`);
    if (skipped.length) console.log(`  skipped non-TrackB: ${skipped.join(", ")}`);
  }
}
