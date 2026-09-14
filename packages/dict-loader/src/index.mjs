// getGloss(lang, target, lemma, opt): shard lazy-load + cache + miss marking.
// Stable contract for web / provider (Track C):
//   import { getGloss, prefetchShards, getMisses, clearMisses } from "@interlinear/dict-loader";
// Returns:
//   { status: "hit",  gloss: string[], cached: boolean, shard }   — dict has target gloss
//   { status: "miss", gloss: [],      cached: boolean, shard }   — Track C sends these to LLM
// Rules: 缺词直走 LLM、不经英语中转 — a zh miss NEVER falls back to en
// (and vice versa); both targets are looked up from the same shard entry.
// Lookup order (B3 双试 原形+词干 + 原形单数回退): normalized original FIRST,
// then normalized stem (when a lemmatizer is supplied via opt.lemmatize or
// opt.tryStem), then a last-resort singular of the original (fr maisons->maison:
// -ons 结尾的名词复数与动词 1 复同形，lemmatize 按动词还原则必错，单数回退兜底)。
// Rationale: stemmers over-strip base forms (de schule->schul, en time->tim),
// so single-stem lookup misses base entries; dual-try keeps both paths hit.
// Web wiring (which lemmatizer instance to pass) is owned by Track A;
// Track B only guarantees this dual-try contract + roundtrip tests.

import { normalizeLemma, shardFor, TRACK_B_LANGS, TRACK_B_TARGETS } from "./shard.mjs";
import { cacheGet, cacheSet } from "./cache.mjs";

export const SUPPORTED_LANGS = TRACK_B_LANGS;
export const SUPPORTED_TARGETS = TRACK_B_TARGETS;

const inflight = new Map(); // `${lang}/${shard}` -> Promise<object|null>
const misses = []; // [{lang,target,lemma,at}] — drained by Track C LLM queue
const MAX_MISSES = 2000;

function baseUrl(opt) {
  return (opt?.baseUrl ?? "/").replace(/\/$/, "");
}

async function fetchPair(lang, target, opt) {
  const key = `${lang}/${target}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const fetchImpl = opt?.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) return null;
    try {
      const res = await fetchImpl(`${baseUrl(opt)}/dict/${lang}/${target}.dict`, { headers: { Accept: "text/plain" } });
      if (!res.ok) return null;
      const out = {};
      for (const line of (await res.text()).split("\n")) {
        if (!line) continue;
        const [lemma, gloss = ""] = line.split("\t");
        if (lemma) out[lemma] = gloss ? gloss.split("\x1f") : [];
      }
      return out;
    } catch { return null; }
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

export function recordMiss(lang, target, lemma) {
  if (misses.length >= MAX_MISSES) misses.shift();
  misses.push({ lang, target, lemma, at: new Date().toISOString() });
}

export function getMisses() {
  return [...misses];
}

export function clearMisses() {
  misses.length = 0;
}

export async function getGloss(lang, target, lemma, opt = {}) {
  if (!SUPPORTED_LANGS.includes(lang)) throw new Error(`unsupported lang: ${lang}`);
  if (!SUPPORTED_TARGETS.includes(target)) throw new Error(`unsupported target: ${target}`);
  const key = normalizeLemma(lang, lemma);
  if (!key) return { status: "miss", gloss: [], cached: false, shard: "misc" };
  // Pair-first contract: one target-specific asset per language. Load it once;
  // all morphology candidates are looked up in the same in-memory map.
  const cachedPair = await cacheGet(lang, target);
  const wasCached = !!cachedPair.data;
  const pair = cachedPair.data ?? await fetchPair(lang, target, opt);
  const data = pair ?? null;
  if (pair && !wasCached) await cacheSet(lang, target, pair);
  // B3: resolve stem key when a lemmatizer is available. Prefer explicit
  // opt.lemmatize (Track A wiring); opt.tryStem lazily imports lang-packs.
  let stemKey = null;
  let lemmatizeFn = typeof opt?.lemmatize === "function" ? opt.lemmatize : null;
  if (!lemmatizeFn && opt?.tryStem) {
    try {
      const packs = await import("../../lang-packs/src/index.mjs");
      lemmatizeFn = (t) => packs.lemmatize(lang, t);
    } catch { lemmatizeFn = null; }
  }
  if (lemmatizeFn) {
    try {
      const stem = lemmatizeFn(lemma);
      if (stem) {
        const nk = normalizeLemma(lang, stem);
        if (nk && nk !== key) stemKey = nk;
      }
    } catch { stemKey = null; }
  }
  let sgKey = null;
  if (["en", "de", "fr", "it", "es"].includes(lang) && key.length > 3 && /[sx]$/.test(key)) {
    const cand = key.slice(0, -1);
    if (cand !== key && cand !== stemKey) sgKey = cand;
  }
  const keysToTry = stemKey ? [key, stemKey] : [key];
  if (sgKey && !keysToTry.includes(sgKey)) keysToTry.push(sgKey);
  for (const k of keysToTry) {
    const gloss = data?.[k] ?? [];
    if (gloss.length) return { status: "hit", gloss, cached: wasCached, shard: "all", key: k };
  }
  recordMiss(lang, target, lemma);
  return { status: "miss", gloss: [], cached: false, shard: "all" };
}

// Warm one complete source→target dictionary asset.
export async function prefetchShards(lang, targets = TRACK_B_TARGETS, opt = {}) {
  const out = [];
  for (const target of new Set(targets)) {
    const cached = await cacheGet(lang, target);
    if (cached.data) { out.push({ target, cached: true }); continue; }
    const data = await fetchPair(lang, target, opt);
    if (data) { await cacheSet(lang, target, data); out.push({ target, cached: false }); }
    else out.push({ target, cached: false, missing: true });
  }
  return out;
}
