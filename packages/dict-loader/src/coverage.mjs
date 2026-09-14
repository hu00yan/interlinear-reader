#!/usr/bin/env node
// coverage-report: 14-direction (7 langs x zh/en) coverage table.
// Two lenses per direction:
//   A. dict breadth: % entries having a non-empty gloss for that target.
//   B. corpus token coverage: segment(corpus) -> lemmatize -> getGloss(hit?)
// Prints a markdown table to stdout and writes public/dict/coverage.json.
// Usage: npm run report:coverage [--out=public/dict]

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
import { TRACK_B_LANGS as LANGS, TRACK_B_TARGETS as TARGETS } from "./shard.mjs";

const args = process.argv.slice(2);
let outDir = join(ROOT, "public", "dict");
for (const a of args) if (a.startsWith("--out=")) outDir = a.slice(6);

const { segment, lemmatize } = await import("../../lang-packs/src/index.mjs");
const { normalizeLemma } = await import("./shard.mjs");

function loadLangDict(lang) {
  const dir = join(outDir, lang);
  const merged = {};
  if (!existsSync(dir)) return merged;
  for (const target of TARGETS) {
    const f = `${target}.dict`;
    try {
      const rows = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
      for (const line of rows) {
        const [k, gloss = ""] = line.split("\t");
        if (k) (merged[k] ??= {})[target] = gloss ? gloss.split("\x1f") : [];
      }
    } catch { /* skip bad pair */ }
  }
  return merged;
}

function loadCorpus(lang) {
  const p = join(ROOT, "packages", "dict-tools", "corpus", `${lang}.txt`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

const rows = [];
for (const lang of LANGS) {
  const dict = loadLangDict(lang);
  const lemmas = Object.keys(dict);
  const breadth = {};
  for (const t of TARGETS) {
    breadth[t] = lemmas.length
      ? lemmas.filter((k) => (dict[k]?.[t] ?? []).length > 0).length / lemmas.length
      : 0;
  }
  // corpus lens — B3 双试(原形+词干): stemmers over-strip base forms
  // (de schule->schul, en time->tim), so a token hits when EITHER the
  // normalized original OR the normalized stem is in the dict. This mirrors
  // getGloss dual-try (see dict-loader/src/index.mjs) and keeps coverage
  // honest about runtime behaviour.
  const text = loadCorpus(lang);
  let toks = [];
  try { toks = segment(lang, text); } catch { toks = []; }
  const uniq = new Map(); // representativeKey -> { orig, stem, count }
  const hasDictEntry = (k, target) => (dict[k]?.[target] ?? []).length > 0;
  // 与 getGloss 双试+单数回退同口径（原形 → 词干 → 原形单数；verb-first，不抬高名词）。
  const sgOf = (k) => (["en", "de", "fr", "it", "es"].includes(lang) && k.length > 3 && /[sx]$/.test(k) ? k.slice(0, -1) : null);
  const hitFor = (orig, stem, target) => hasDictEntry(orig, target)
    || (stem && stem !== orig && hasDictEntry(stem, target))
    || (sgOf(orig) !== null && sgOf(orig) !== stem && hasDictEntry(sgOf(orig), target));
  for (const t of toks) {
    if (!t || /^[^\p{L}\p{M}\p{N}]+$/u.test(t)) continue;
    let l;
    try { l = lemmatize(lang, t); } catch { l = t; }
    const orig = normalizeLemma(lang, t);
    const stem = normalizeLemma(lang, l);
    const k = orig || stem;
    if (!k) continue;
    const prev = uniq.get(k);
    // key by orig (stable); keep stem alongside for dual-try lookup
    if (!prev) uniq.set(k, { orig, stem, count: 1 });
    else {
      prev.count++;
      // prefer a stem that actually hits the dict (helps debugging)
      if (stem && stem !== prev.stem && (dict[stem]?.zh?.length || dict[stem]?.en?.length)) prev.stem = stem;
    }
  }
  // stopword-filter for fairness: pack stopwords excluded from denominator
  // (stop keys are normalized the same way so accented forms match).
  let stop = new Set();
  try { stop = (await import(`../../lang-packs/src/${lang}.mjs`)).stopwords; } catch { /* */ }
  const stopNorm = new Set([...stop].map((s) => normalizeLemma(lang, s)));
  const content = [...uniq.values()].filter((v) => !stopNorm.has(v.orig) && !stopNorm.has(v.stem));
  const tokHits = {};
  for (const t of TARGETS) {
    const hit = content.filter((v) => hitFor(v.orig, v.stem, t)).length;
    tokHits[t] = { hit, total: content.length, rate: content.length ? hit / content.length : 0 };
  }
  rows.push({ lang, entries: lemmas.length, breadth, tokHits, tokens: toks.length, uniqContent: content.length });
}

const pct = (r) => (r * 100).toFixed(1) + "%";
console.log("| src→tgt | entries | breadth zh | breadth en | corpus tok cov zh | corpus tok cov en |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.lang}→zh | ${r.entries} | ${pct(r.breadth.zh)} | — | ${r.tokHits.zh.hit}/${r.tokHits.zh.total} (${pct(r.tokHits.zh.rate)}) | — |`);
  console.log(`| ${r.lang}→en | ${r.entries} | — | ${pct(r.breadth.en)} | — | ${r.tokHits.en.hit}/${r.tokHits.en.total} (${pct(r.tokHits.en.rate)}) |`);
}
const report = {
  builtAt: new Date().toISOString(),
  directions: 14,
  rows: rows.map((r) => ({
    lang: r.lang, entries: r.entries, tokens: r.tokens, uniqContent: r.uniqContent,
    zh: { breadth: +r.breadth.zh.toFixed(4), corpus: { ...r.tokHits.zh, rate: +r.tokHits.zh.rate.toFixed(4) } },
    en: { breadth: +r.breadth.en.toFixed(4), corpus: { ...r.tokHits.en, rate: +r.tokHits.en.rate.toFixed(4) } },
  })),
};
writeFileSync(join(outDir, "coverage.json"), JSON.stringify(report, null, 2) + "\n");
console.error(`\nwrote ${join(outDir, "coverage.json")}`);
