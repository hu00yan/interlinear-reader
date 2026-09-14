import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getGloss, clearMisses } from "../src/index.mjs";
import { cacheClear } from "../src/cache.mjs";
import { normalizeLemma, shardFor, TRACK_B_LANGS } from "../src/shard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

const { segment, lemmatize } = await import("../../lang-packs/src/index.mjs");
const langPacks = await import("../../lang-packs/src/index.mjs");

test("B1: LANGS single-source — loader/packs agree on Track B set", async () => {
  assert.deepEqual([...TRACK_B_LANGS], ["en", "de", "fr", "it", "es", "ru", "ja"]);
  assert.deepEqual([...langPacks.SUPPORTED_LANGS], [...TRACK_B_LANGS]);
  const { SUPPORTED_LANGS } = await import("../src/index.mjs");
  assert.deepEqual([...SUPPORTED_LANGS], [...TRACK_B_LANGS]);
});

test("B1: shard contract single-source — dict-tools re-exports loader", async () => {
  const tools = await import("../../dict-tools/src/shard.mjs");
  assert.equal(tools.shardFor, shardFor);
  assert.equal(tools.normalizeLemma, normalizeLemma);
});

// Build an in-memory static host from the real seeds so the test never
// depends on public/dict build output (deterministic, offline).
async function makeSeedHost() {
  const { cleanEntries } = await import("../../dict-tools/src/clean.mjs");
  const store = new Map(); // `${lang}/${shard}.dict` -> compact text
  for (const lang of TRACK_B_LANGS) {
    const p = join(ROOT, "packages/dict-tools/seeds", `${lang}.seed.json`);
    const raw = JSON.parse(readFileSync(p, "utf8"));
    const rows = Object.entries(raw).map(([lemma, v]) => ({ lemma, zh: v.zh ?? [], en: v.en ?? [] }));
    const merged = cleanEntries(lang, rows);
    const byShard = new Map();
    for (const [lemma, entry] of merged) {
      const s = shardFor(lang, lemma);
      if (!byShard.has(s)) byShard.set(s, {});
      byShard.get(s)[lemma] = entry;
    }
    for (const target of ["zh", "en"]) {
      const body = [...merged].filter(([, entry]) => entry[target]?.length)
        .map(([lemma, entry]) => `${lemma}\t${entry[target].join("\x1f")}`).join("\n") + "\n";
      store.set(`${lang}/${target}.dict`, body);
    }
  }
  const fetchImpl = async (url) => {
    const m = url.match(/\/dict\/([a-z]+)\/(zh|en)\.dict$/);
    if (!m) return { ok: false, status: 404, text: async () => "" };
    const body = store.get(`${m[1]}/${m[2]}.dict`);
    if (!body) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, text: async () => body };
  };
  return { fetchImpl };
}

// [lang, surface token, expected dict key after dual-try, target]
// Covers: B3 Straße blocker, irregulars, base forms the stemmer over-strips
// (en time, fr école, it amore, ru книга — all hit via 原形 fallback),
// and ja identity.
const CASES = [
  ["en", "children", "child", "zh"],
  ["en", "running", "run", "en"],
  ["en", "book", "book", "zh"],
  ["en", "time", "time", "zh"], // stem tim is wrong; 原形 must hit
  ["de", "Straße", "strasse", "en"], // B3 blocker
  ["de", "strasse", "strasse", "en"],
  ["de", "Männer", "mann", "zh"],
  ["de", "geht", "gehen", "en"],
  ["de", "schule", "schule", "zh"], // guard identity
  ["fr", "chevaux", "cheval", "en"],
  ["fr", "suis", "etre", "en"],
  ["fr", "école", "ecole", "zh"], // accent fold; stem écol wrong, 原形 hits
  ["it", "sono", "essere", "en"],
  ["it", "amore", "amore", "zh"], // stem amora wrong, 原形 hits
  ["it", "libro", "libro", "zh"],
  ["es", "tengo", "tener", "en"],
  ["es", "niño", "nino", "zh"],
  ["es", "libro", "libro", "zh"],
  ["ru", "люди", "человек", "en"],
  ["ru", "меня", "я", "en"],
  ["ru", "книга", "книга", "zh"], // stem книг wrong, 原形 hits
  ["ja", "本", "本", "zh"],
  ["ja", "読む", "読む", "en"],
  // 审计矩阵回归锁（scripts/lemma-audit.mjs 7×20）：屈折形→原形
  ["en", "houses", "house", "zh"], // STEP5 e 保留：stem house（非 hous）
  ["de", "Schulen", "schule", "zh"],
  ["de", "Straßen", "strasse", "en"],
  ["de", "gelesen", "lesen", "en"],
  ["de", "gesprochen", "sprechen", "en"],
  ["fr", "parlent", "parler", "en"],
  ["fr", "mangeons", "manger", "zh"],
  ["fr", "vont", "aller", "en"],
  ["fr", "maisons", "maison", "zh"], // -ons 动词优先，名词经原形单数回退命中
  ["it", "parlate", "parlare", "en"],
  ["it", "letto", "leggere", "en"],
  ["it", "amori", "amore", "zh"],
  ["it", "vedranno", "vedere", "en"],
  ["es", "hablamos", "hablar", "en"],
  ["es", "hablarán", "hablar", "en"],
  ["es", "comiendo", "comer", "en"],
  ["es", "dicen", "decir", "en"],
  ["ru", "книгу", "книга", "zh"],
  ["ru", "читают", "читать", "en"],
  ["ru", "хорошего", "хороший", "en"],
];

test("B3: lemmatize→normalize→getGloss roundtrip hits for all 7 langs (dual-try)", async () => {
  cacheClear();
  clearMisses();
  const host = await makeSeedHost();
  for (const [lang, token, want, target] of CASES) {
    const stem = langPacks.lemmatize(lang, token);
    const origKey = normalizeLemma(lang, token);
    const stemKey = normalizeLemma(lang, stem);
    const wantKey = normalizeLemma(lang, want);
    // At least one of 原形/词干/原形单数 must equal the dict key (documents the fix).
    const sgKey = ["en", "de", "fr", "it", "es"].includes(lang) && origKey.length > 3 && /[sx]$/.test(origKey)
      ? origKey.slice(0, -1)
      : null;
    assert.ok(origKey === wantKey || stemKey === wantKey || sgKey === wantKey,
      `${lang} ${token}: orig=${origKey} stem=${stem}->${stemKey} sg=${sgKey} want=${wantKey}`);
    const r = await getGloss(lang, target, token, {
      baseUrl: "https://static.test",
      fetchImpl: host.fetchImpl,
      lemmatize: (t) => langPacks.lemmatize(lang, t),
    });
    assert.equal(r.status, "hit", `${lang} ${token}->${wantKey} should hit (${target}), got ${JSON.stringify(r)}`);
    assert.ok(r.gloss.length > 0);
  }
});

test("B3: segment→lemmatize→getGloss on real corpus sentences (no throw, misses recorded not thrown)", async () => {
  cacheClear();
  clearMisses();
  const host = await makeSeedHost();
  const sentences = {
    en: "The children are running with books.",
    de: "Die Männer gehen mit Straße und Schule.",
    fr: "Les chevaux vont à l'école.",
    it: "Sono con amore e libro.",
    es: "Tengo un niño y un libro.",
    ru: "Люди читают книгу.",
    ja: "本を読む",
  };
  for (const lang of TRACK_B_LANGS) {
    const toks = segment(lang, sentences[lang]);
    assert.ok(toks.length > 0, `${lang} segments empty`);
    for (const t of toks) {
      const r = await getGloss(lang, "zh", t, {
        baseUrl: "https://static.test",
        fetchImpl: host.fetchImpl,
        lemmatize: (tok) => langPacks.lemmatize(lang, tok),
      });
      assert.ok(r.status === "hit" || r.status === "miss");
    }
  }
});
