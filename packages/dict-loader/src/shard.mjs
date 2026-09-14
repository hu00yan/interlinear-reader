// Pair asset contract. There is intentionally no runtime shard: each
// source→target pair is one complete .dict(.br) object.
export const TRACK_B_LANGS = ["en", "de", "fr", "it", "es", "ru", "ja"];
export const TRACK_B_TARGETS = ["zh", "en"];
export const SHARD_COUNT = 1;
export const SHARD_RULE = "fnv1a(normalized lemma) % 20";

export function normalizeLemma(lang, lemma) {
  if (lemma == null) return "";
  let s = String(lemma).trim();
  if (!s) return "";
  if (lang === "ja") return s;
  if (lang === "de") s = s.replace(/ß/g, "ss");
  s = s.toLowerCase();
  if (lang === "ru") s = s.replace(/ё/g, "е");
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function shardFor(lang, lemma) {
  const key = normalizeLemma(lang, lemma);
  let h = 2166136261;
  for (const ch of key) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return String(h % SHARD_COUNT).padStart(2, "0");
}

export function shardFile(shard) {
  return `${shard}.dict`;
}
