#!/usr/bin/env node
// build-dict: seeds (+ optional raw dumps) -> sharded public/dict/{lang}/{shard}.dict(.br)
// The release format is compact line-oriented TSV: lemma<TAB>zh<TAB>en.
// JSON is used only in memory while merging/validating sources.
// Usage:
//   npm run build:dict -- --lang=en,ja [--raw=packages/dict-tools/raw] [--out=public/dict]
//     [--freq=<freq.tsv|json>] [--maxEntries=N] [--strict]
// Reproducible: sorted keys, stable stringify, fixed brotli/gzip params.
// Exit non-zero on unknown lang. Prints per-lang entry/shard/byte table.
// Track B contract (single source): LANGS + shard rule live in
// packages/dict-loader/src/shard.mjs (TRACK_B_LANGS/SHARD_RULE); this file
// only re-exports/reads them so the contract can never fork (B1).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync, gunzipSync, constants } from "node:zlib";
import { shardFor, TRACK_B_LANGS, TRACK_B_TARGETS, SHARD_RULE } from "../../dict-loader/src/shard.mjs";
import { cleanEntries, mergeEntryMaps } from "./clean.mjs";
import { SOURCES, parseTsv, parseEcdictCsv, parseFreedictTei, parseJmdict, parseWiktionary } from "./sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const ALL_LANGS = TRACK_B_LANGS;
const USAGE = `build-dict [--lang=en,ja] [--raw=<dir>] [--out=<dir>] [--freq=<file>] [--maxEntries=N] [--strict]`;

function parseArgs(argv) {
  const out = { lang: null, raw: join(HERE, "..", "raw"), out: join(ROOT, "public", "dict"), freq: null, maxEntries: null, strict: false };
  // `npm run build:dict --lang=en,ja` arrives via npm_config_* env; also accept direct flags.
  const extra = [];
  if (process.env.npm_config_lang) extra.push(`--lang=${process.env.npm_config_lang}`);
  if (process.env.npm_config_raw) extra.push(`--raw=${process.env.npm_config_raw}`);
  if (process.env.npm_config_out) extra.push(`--out=${process.env.npm_config_out}`);
  if (process.env.npm_config_freq) extra.push(`--freq=${process.env.npm_config_freq}`);
  if (process.env.npm_config_maxentries) extra.push(`--maxEntries=${process.env.npm_config_maxentries}`);
  if (process.env.npm_config_strict) extra.push("--strict");
  for (const a of [...extra, ...argv]) {
    if (a === "--") continue; // npm separator: `npm run build:dict -- --lang=…`
    if (a.startsWith("--lang=")) out.lang = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--lang" && argv.length) { /* value consumed by npm; see bare-token fallback below */ }
    else if (a.startsWith("--raw=")) out.raw = a.slice(6);
    else if (a.startsWith("--out=")) out.out = a.slice(6);
    else if (a.startsWith("--freq=")) out.freq = a.slice(7);
    else if (a.startsWith("--maxEntries=")) {
      const n = Number(a.slice(13));
      if (!Number.isInteger(n) || n <= 0) { console.error(`invalid --maxEntries: ${a}\n${USAGE}`); process.exit(2); }
      out.maxEntries = n;
    } else if (a === "--strict") out.strict = true;
    else if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    // npm v11 quirk: `npm run build:dict --lang=en,ja` arrives as bare `en,ja`.
    else if (/^[a-z,]+$/.test(a) && a.split(",").every((t) => ALL_LANGS.includes(t))) {
      out.lang = a.split(",").map((s) => s.trim()).filter(Boolean);
    }
    else { console.error(`unknown arg: ${a}\n${USAGE}`); process.exit(2); }
  }
  return out;
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function loadSeed(lang) {
  const p = join(HERE, "..", "seeds", `${lang}.seed.json`);
  if (!existsSync(p)) return new Map();
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const rows = Object.entries(raw).map(([lemma, v]) => ({ lemma, zh: v.zh ?? [], en: v.en ?? [] }));
  return cleanEntries(lang, rows);
}

// Read a raw file (transparent .gz) -> { text, innerName }.
function readRawText(p) {
  const buf = readFileSync(p);
  if (p.endsWith(".gz")) {
    // B2: .gz dead end fixed — JMdict_e.gz / wiktionary .xml.gz / any .gz
    // is gunzipped in-process (no temp files, no network).
    const inner = basename(p).replace(/\.gz$/, "");
    return { text: gunzipSync(buf).toString("utf8"), innerName: inner };
  }
  return { text: buf.toString("utf8"), innerName: basename(p) };
}

// B2: dispatch by content + filename so *wiktionary.xml never walks
// parseFreedictTei. Order: explicit JMdict name -> wiktionary name/content
// -> TEI content -> fallback by extension.
function parseRawFile(lang, filename, text) {
  const lower = filename.toLowerCase();
  const isJmdictName = lower.includes("jmdict");
  const isWiktName = lower.includes("wiktionary");
  if (isJmdictName) {
    return parseJmdict(text, lower.includes("_zh") || lower.includes("zh") ? "chi" : "eng");
  }
  if (isWiktName || text.includes("<page>") || text.includes("<page ")) {
    return parseWiktionary(text, lang);
  }
  if (lower.endsWith(".tsv")) return parseTsv(text);
  if (lower.endsWith(".csv")) return parseEcdictCsv(text);
  if (lower.endsWith(".tei") || text.includes("<TEI") || (text.includes("<entry") && text.includes("<orth"))) {
    return parseFreedictTei(text);
  }
  if (lower.endsWith(".xml")) {
    // Unknown .xml: sniff content (TEI vs wiktionary) instead of assuming TEI.
    if (text.includes("<keb>") || text.includes("<reb>")) {
      return parseJmdict(text, lower.includes("_zh") ? "chi" : "eng");
    }
    return parseWiktionary(text, lang);
  }
  if (lower.endsWith(".json")) {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : Object.entries(j).map(([lemma, v]) => ({ lemma, zh: v.zh ?? [], en: v.en ?? [] }));
  }
  throw new Error(`unsupported raw format: ${filename}`);
}

function loadRaw(lang, rawDir) {
  const maps = [];
  const seenVerify = [];
  const dir = join(rawDir, lang);
  if (!existsSync(dir)) return { maps, seenVerify };
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    // Track VERIFY-licensed inputs for --strict (see SOURCES license field).
    const srcFor = (SOURCES[lang] ?? []).find((s) => (s.raw ?? "").endsWith(f) || (s.raw ?? "").endsWith(f.replace(/\.gz$/, "")));
    if (srcFor && /VERIFY/.test(srcFor.license ?? "")) seenVerify.push(`${lang}/${f} (${srcFor.name})`);
    try {
      const { text, innerName } = readRawText(p);
      let rows;
      if (f.endsWith(".tsv") || innerName.endsWith(".tsv")) rows = parseTsv(text);
      else if (f.endsWith(".csv") || innerName.endsWith(".csv")) rows = parseEcdictCsv(text);
      else if (f.endsWith(".json") || innerName.endsWith(".json")) {
        const j = JSON.parse(text);
        rows = Array.isArray(j) ? j : Object.entries(j).map(([lemma, v]) => ({ lemma, zh: v.zh ?? [], en: v.en ?? [] }));
      } else {
        rows = parseRawFile(lang, innerName, text);
      }
      maps.push(cleanEntries(lang, rows));
      console.log(`  raw: ${lang}/${f} -> ${rows.length} rows`);
    } catch (e) {
      console.warn(`  raw SKIP ${lang}/${f}: ${e.message}`);
    }
  }
  return { maps, seenVerify };
}

// Frequency ranking for --maxEntries trimming (SIZES 预算裁剪):
// 1) explicit --freq file (tsv `lemma\\tcount` or json {lemma:count}),
// 2) else corpus token counts (segment on packages/dict-tools/corpus),
// 3) else alphabetical (deterministic fallback).
async function loadFreqRanks(lang, freqFile) {
  if (freqFile) {
    const raw = readFileSync(freqFile, "utf8");
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        const m = new Map();
        for (const [k, v] of Object.entries(j)) m.set(String(k), Number(v) || 0);
        return m;
      }
    } catch { /* not json -> try tsv */ }
    const m = new Map();
    for (const line of raw.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [lemma, count] = line.split("\t");
      if (!lemma) continue;
      m.set(lemma.trim(), Number((count ?? "").trim()) || 0);
    }
    return m;
  }
  // Corpus-derived counts (lazy lang-packs import; build-only, never bundled).
  try {
    const { segment, lemmatize } = await import("../../lang-packs/src/index.mjs");
    const { normalizeLemma } = await import("../../dict-loader/src/shard.mjs");
    const cp = join(HERE, "..", "corpus", `${lang}.txt`);
    if (!existsSync(cp)) return new Map();
    const text = readFileSync(cp, "utf8");
    const toks = segment(lang, text);
    const m = new Map();
    for (const t of toks) {
      let l = t;
      try { l = lemmatize(lang, t); } catch { /* */ }
      const k = normalizeLemma(lang, l) || normalizeLemma(lang, t);
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  } catch { return new Map(); }
}

function trimByFreq(merged, freqRanks, maxEntries) {
  if (!maxEntries || merged.size <= maxEntries) return { trimmed: merged, dropped: 0 };
  const scored = [...merged.keys()].map((k) => ({ k, s: freqRanks.get(k) ?? 0 }));
  // High freq first; ties alphabetical for determinism.
  scored.sort((a, b) => (b.s - a.s) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const keep = new Set(scored.slice(0, maxEntries).map((x) => x.k));
  const out = new Map();
  for (const [k, v] of merged) if (keep.has(k)) out.set(k, v);
  return { trimmed: out, dropped: merged.size - out.size };
}

async function buildLang(lang, rawDir, outDir, opts) {
  const seed = loadSeed(lang);
  const { maps: raws, seenVerify } = loadRaw(lang, rawDir);
  if (opts.strict && seenVerify.length) {
    console.error(`STRICT FAIL: VERIFY-licensed raw inputs need manual license confirmation, refusing to ship:\n - ${seenVerify.join("\n - ")}\nRemove them or rebuild without --strict (see DICT_SOURCES.md).`);
    process.exit(3);
  }
  let merged = mergeEntryMaps([seed, ...raws]);
  let trimNote = "";
  if (opts.maxEntries) {
    const ranks = await loadFreqRanks(lang, opts.freq);
    const { trimmed, dropped } = trimByFreq(merged, ranks, opts.maxEntries);
    merged = trimmed;
    if (dropped) trimNote = ` (trimmed ${dropped} low-freq, kept top ${opts.maxEntries})`;
  }
  const langDir = join(outDir, lang);
  mkdirSync(langDir, { recursive: true });
  // One immutable asset per source→target pair. Remove all previous shard layouts.
  for (const f of readdirSync(langDir)) {
    if (f === "manifest.json") continue;
    try { unlinkSync(join(langDir, f)); } catch { /* */ }
  }
  const pairStats = {};
  for (const target of TRACK_B_TARGETS) {
    const entries = Object.fromEntries([...merged]
      .filter(([, entry]) => (entry[target] ?? []).length)
      .map(([lemma, entry]) => [lemma, entry[target]]));
    const lines = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))
      .map(([lemma, glosses]) => `${lemma}\t${glosses.join("\x1f")}`);
    const body = lines.join("\n") + (lines.length ? "\n" : "");
    const dp = join(langDir, `${target}.dict`);
    writeFileSync(dp, body);
    const br = brotliCompressSync(Buffer.from(body), { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
    writeFileSync(dp + ".br", br);
    pairStats[target] = { entries: lines.length, dictBytes: Buffer.byteLength(body), brBytes: br.length };
  }
  const manifest = {
    lang, entries: merged.size, targets: TRACK_B_TARGETS,
    sources: (SOURCES[lang] ?? []).map((s) => ({ name: s.name, license: s.license, url: s.url })),
    builtWith: "seeds" + (raws.length ? `+raw(${raws.length} files)` : " (offline)") + (trimNote || ""),
    format: "pair-first: dict/{lang}/{target}.dict.br; lemma\\tglosses; glosses separated by U+001F; UTF-8",
    shardRule: "none (one object per language pair)",
  };
  writeFileSync(join(langDir, "manifest.json"), stableStringify(manifest));
  return { lang, entries: merged.size, shards: 2, pairStats, jsonBytes: Object.values(pairStats).reduce((n, x) => n + x.dictBytes, 0), brBytes: Object.values(pairStats).reduce((n, x) => n + x.brBytes, 0), gzBytes: 0 };
}

const args = parseArgs(process.argv.slice(2));
const langs = args.lang ?? ALL_LANGS;
for (const l of langs) {
  if (!ALL_LANGS.includes(l)) { console.error(`unknown lang: ${l} (expected ${ALL_LANGS.join(",")})`); process.exit(2); }
}
console.log(`build:dict langs=[${langs.join(",")}] out=${args.out}${args.maxEntries ? ` maxEntries=${args.maxEntries}` : ""}${args.freq ? ` freq=${args.freq}` : ""}${args.strict ? " --strict" : ""}`);
const results = [];
for (const l of langs) results.push(await buildLang(l, args.raw, args.out, args));
// sizes.json (overall, for SIZES table + R2 upload check)
const sizesPath = join(args.out, "sizes.json");
let prev = {};
try { prev = existsSync(sizesPath) ? JSON.parse(readFileSync(sizesPath, "utf8")) : {}; } catch { prev = {}; }
for (const r of results) prev[r.lang] = r;
writeFileSync(sizesPath, JSON.stringify(prev, null, 2) + "\n");

const pad = (s, n) => String(s).padEnd(n);
console.log("lang  entries  shards   json(B)   br(B)  gz(B)");
for (const r of results) {
  console.log(`${pad(r.lang, 5)} ${pad(r.entries, 8)} ${pad(r.shards, 7)} ${pad(r.jsonBytes, 9)} ${pad(r.brBytes, 7)} ${r.gzBytes}`);
}
console.log("done.");
