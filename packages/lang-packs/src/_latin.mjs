// Shared helpers for latin-script packs (EN/DE/FR/IT/ES/RU).
// Approach: Snowball-subset suffix stripping + small irregular tables.
// NOT a full Snowball port by design (bundle budget); rules are ordered
// longest-first and guarded by minimal stem length to avoid over-stemming.

export function lowercaseFold(s) {
  return s.toLowerCase();
}

// Generic suffix stripper: tries suffixes longest-first, requires stem
// length >= minStem, and applies an optional guard/rewrite.
export function stripSuffixes(word, rules) {
  for (const [suffix, replace, minStem = 2] of rules) {
    if (word.length - suffix.length >= minStem && word.endsWith(suffix)) {
      return word.slice(0, word.length - suffix.length) + (replace ?? "");
    }
  }
  return word;
}

// Unicode word segmentation shared by EN/DE/FR/IT/ES/RU.
// Full-coverage: word runs (keeping internal apostrophes/hyphens — "l'amour",
// "mother-in-law" — so lemmatize() can decide clitic handling) plus the
// non-word runs (whitespace, punctuation, digits) between them. The
// LanguagePack contract is "segment(text)->surface[]，含标点，由调用方判断
// isWord", and concatenating the result reproduces the input exactly. Word-only
// output used to silently drop every period and comma from the rendered page.
const SEG_RE = /[\p{L}\p{M}]+(?:['’'‑‒–—-][\p{L}\p{M}]+)*|[^\p{L}\p{M}]+/gu;

export function segmentLatin(text) {
  if (!text) return [];
  const out = text.match(SEG_RE);
  return out ?? [];
}

export function applyExceptions(lower, exceptions) {
  return exceptions.get(lower) ?? null;
}
