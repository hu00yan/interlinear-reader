// Normalization: raw source rows -> unified { lemma: { zh: [], en: [] } }.
// Rules:
// - lemma keys: latin lowercased+accent-stripped (via shard.normalizeLemma),
//   de ß->ss folded, ru ё->е folded, ja kept verbatim.
// - gloss arrays: deduped, trimmed, capped at 6 entries each (UI budget),
//   zh picks CJK-containing senses first, en picks latin senses.
// - drops empty lemmas, drops rows with neither zh nor en.

import { normalizeLemma } from "../../dict-loader/src/shard.mjs";

const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF]/;
const MAX_GLOSS = 6;

function uniqPush(arr, v) {
  v = String(v).trim().replace(/\s+/g, " ");
  if (!v || arr.includes(v) || arr.length >= MAX_GLOSS) return;
  arr.push(v);
}

export function cleanEntries(lang, rows) {
  // rows: [{ lemma, zh: string[], en: string[] }]
  const out = new Map();
  for (const r of rows ?? []) {
    const key = normalizeLemma(lang, r.lemma);
    if (!key) continue;
    let slot = out.get(key);
    if (!slot) { slot = { zh: [], en: [] }; out.set(key, slot); }
    for (const g of r.zh ?? []) if (CJK_RE.test(g) || lang === "ja") uniqPush(slot.zh, g);
    for (const g of r.zh ?? []) if (!CJK_RE.test(g) && !slot.zh.includes(g) && slot.zh.length < MAX_GLOSS && /[a-zA-Z]/.test(g)) {
      // zh column sometimes carries pinyin/english in raw dumps — keep as zh only if useful; else ignore
    }
    for (const g of r.en ?? []) uniqPush(slot.en, g);
  }
  // drop empties
  for (const [k, v] of [...out]) {
    if (v.zh.length === 0 && v.en.length === 0) out.delete(k);
  }
  return out; // Map<key, {zh,en}>
}

export function mergeEntryMaps(maps) {
  const out = new Map();
  for (const m of maps) {
    for (const [k, v] of m) {
      let slot = out.get(k);
      if (!slot) { slot = { zh: [], en: [] }; out.set(k, slot); }
      for (const g of v.zh) uniqPush(slot.zh, g);
      for (const g of v.en) uniqPush(slot.en, g);
    }
  }
  return out;
}
