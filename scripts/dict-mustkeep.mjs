#!/usr/bin/env node
// must-keep proof: cat/Gibbon/KJV高频必须进 + 古英表保留 + 语料零缺词.
// Reads built shards from public/dict (file host, no server) via getGloss dual-try.
// Usage: node scripts/dict-mustkeep.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getGloss, clearMisses } from "../packages/dict-loader/src/index.mjs";
import { cacheClear } from "../packages/dict-loader/src/cache.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function makeFileHost() {
  return async (url) => {
    const m = url.match(/\/dict\/([a-z]+)\/(.+)\.dict$/);
    if (!m) return { ok: false, status: 404, text: async () => "" };
    try {
      const t = readFileSync(join(root, "public/dict", m[1], `${m[2]}.dict`), "utf8");
      return { ok: true, text: async () => t };
    } catch { return { ok: false, status: 404, text: async () => "" }; }
  };
}
// [lang, target, lemma, note]
const MUST = [
  // cat family (mock-dict 高频, 跨7语言)
  ["en", "zh", "cat", "cat/猫"], ["en", "zh", "cats", "cats/复数"],
  ["de", "zh", "Katze", "Katze/猫"], ["fr", "zh", "chat", "chat/猫"],
  ["es", "zh", "gato", "gato/猫"], ["it", "zh", "gatto", "gatto/猫"],
  ["ru", "zh", "кот", "кот/猫"], ["ja", "zh", "猫", "猫/猫"],
  // KJV archaic (browser-2samuel 断言 hath/doth/saith 有中文)
  ["en", "zh", "hath", "KJV hath"], ["en", "zh", "doth", "KJV doth"],
  ["en", "zh", "saith", "KJV saith"], ["en", "zh", "thou", "KJV thou"],
  ["en", "zh", "thee", "KJV thee"], ["en", "zh", "verily", "KJV verily"],
  // Gibbon 高频 (Decline and Fall 学术词)
  ["en", "zh", "empire", "Gibbon empire"], ["en", "zh", "decline", "Gibbon decline"],
  ["en", "zh", "roman", "Gibbon roman"], ["en", "zh", "senate", "Gibbon senate"],
  ["en", "zh", "legion", "Gibbon legion"], ["en", "zh", "province", "Gibbon province"],
  // KJV 高频 (lord/god/heaven…)
  ["en", "zh", "lord", "KJV lord"], ["en", "zh", "god", "KJV god"],
  ["en", "zh", "heaven", "KJV heaven"], ["en", "zh", "king", "KJV king"],
];
cacheClear(); clearMisses();
const fetchImpl = makeFileHost();
let fail = 0;
for (const [lang, target, lemma, note] of MUST) {
  const r = await getGloss(lang, target, lemma, { baseUrl: "", fetchImpl, tryStem: true });
  const ok = r.status === "hit" && r.gloss.length > 0;
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} must-keep ${lang}→${target} ${lemma} (${note}): ${r.status} ${JSON.stringify(r.gloss[0] ?? null)}`);
}
// corpus missing list (dual-try, zh+en) — target >95% (expect 0 missing after回炉)
const { segment, lemmatize } = await import("../packages/lang-packs/src/index.mjs");
const { normalizeLemma } = await import("../packages/dict-loader/src/shard.mjs");
const { TRACK_B_LANGS } = await import("../packages/dict-loader/src/shard.mjs");
console.log("\n--- corpus missing list (should be empty) ---");
let totalMiss = 0;
for (const lang of TRACK_B_LANGS) {
  const text = readFileSync(join(root, "packages/dict-tools/corpus", `${lang}.txt`), "utf8");
  const toks = segment(lang, text);
  const pack = await import(`../packages/lang-packs/src/${lang}.mjs`);
  const stopNorm = new Set([...pack.stopwords].map((s) => normalizeLemma(lang, s)));
  const misses = [];
  const seen = new Set();
  for (const t of toks) {
    if (!t || /^[^\p{L}\p{M}\p{N}]+$/u.test(t)) continue;
    let l; try { l = lemmatize(lang, t); } catch { l = t; }
    const orig = normalizeLemma(lang, t), stem = normalizeLemma(lang, l);
    if (!orig || stopNorm.has(orig) || stopNorm.has(stem)) continue;
    const k = `${orig}|${stem}`;
    if (seen.has(k)) continue; seen.add(k);
    for (const target of ["zh", "en"]) {
      const r = await getGloss(lang, target, t, { baseUrl: "", fetchImpl, lemmatize: (x) => lemmatize(lang, x) });
      if (r.status !== "hit") { misses.push(`${t}(${orig}/${stem})→${target}`); totalMiss++; }
    }
  }
  console.log(`${lang}: ${misses.length ? "MISS " + misses.join(", ") : "OK (0 missing)"}`);
}
console.log(fail || totalMiss ? `\nMUSTKEEP FAIL (must=${fail}, corpus-miss=${totalMiss})` : "\nMUSTKEEP OK: cat/Gibbon/KJV in + corpus 0 missing");
process.exit(fail || totalMiss ? 1 : 0);
