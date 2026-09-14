#!/usr/bin/env node
// 词形还原 7×20 审计矩阵：segment → lemmatize → normalize → getGloss。
// - 140 个屈折形全部由 seed 词表中的原形按真实形态规则生成；脚本启动时断言
//   每个期望原形都存在于 packages/dict-tools/seeds/{lang}.seed.json（不存在即非零退出，
//   绝不编数据、绝不编 gloss）。
// - 查词走与线上一致的 TrackB 双试链（getGloss + lemmatize opt，原形+词干），
//   数据源为 seeds 经 cleanEntries 构建的内存静态托管（离线、确定性，与
//   packages/dict-loader/test/roundtrip.test.mjs 同口径）。
// - JA 例外：builtin segment 会把活用形拆成 kanji/kana 碎片（wasm 缺位时的已知局限），
//   故 JA 只审计 lemmatize→normalize→getGloss（整形输入），segment 行为另表报告。
// 用法：node scripts/lemma-audit.mjs [--compact]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const compact = process.argv.includes("--compact");

const { segment, lemmatize } = await import("../packages/lang-packs/src/index.mjs");
const { normalizeLemma } = await import("../packages/dict-loader/src/shard.mjs");
const { getGloss, clearMisses } = await import("../packages/dict-loader/src/index.mjs");
const { cacheClear } = await import("../packages/dict-loader/src/cache.mjs");

// [lang, surface, expectedLemma] — expectedLemma 必须在 seeds 内（下文硬断言）。
// EN: 复数/过去/进行/三单；DE: 复数/变格/动词；FR/IT/ES: 变位+复数；RU: 格+动词+形 adj；JA: 活用+名词。
const MATRIX = [
  // EN plural
  ["en", "books", "book"], ["en", "cities", "city"], ["en", "emperors", "emperor"],
  ["en", "provinces", "province"], ["en", "frontiers", "frontier"],
  // EN past
  ["en", "appeared", "appear"], ["en", "called", "call"], ["en", "created", "create"],
  ["en", "enjoyed", "enjoy"], ["en", "guarded", "guard"],
  // EN prog
  ["en", "running", "run"], ["en", "moving", "move"], ["en", "studying", "study"],
  ["en", "writing", "write"], ["en", "speaking", "speak"],
  // EN 3sg
  ["en", "says", "say"], ["en", "makes", "make"], ["en", "takes", "take"],
  ["en", "goes", "go"], ["en", "writes", "write"],
  // DE plural
  ["de", "Häuser", "haus"], ["de", "Männer", "mann"], ["de", "Kinder", "kind"],
  ["de", "Bücher", "buch"], ["de", "Frauen", "frau"], ["de", "Städte", "stadt"],
  ["de", "Länder", "land"], ["de", "Tage", "tag"], ["de", "Schulen", "schule"],
  ["de", "Straßen", "strasse"],
  // DE declension
  ["de", "Mannes", "mann"], ["de", "Kindes", "kind"], ["de", "Hause", "haus"],
  ["de", "Buches", "buch"], ["de", "Tages", "tag"],
  // DE verb
  ["de", "geht", "gehen"], ["de", "kommt", "kommen"], ["de", "gesehen", "sehen"],
  ["de", "gelesen", "lesen"], ["de", "gesprochen", "sprechen"],
  // FR present
  ["fr", "parlons", "parler"], ["fr", "parlez", "parler"], ["fr", "aiment", "aimer"],
  ["fr", "mangeons", "manger"], ["fr", "parlent", "parler"], ["fr", "prenons", "prendre"],
  ["fr", "vont", "aller"], ["fr", "font", "faire"],
  // FR fut/cond
  ["fr", "aimeront", "aimer"], ["fr", "parleront", "parler"],
  ["fr", "aimeraient", "aimer"], ["fr", "parleraient", "parler"],
  // FR part/gerund
  ["fr", "mangé", "manger"], ["fr", "aimée", "aimer"],
  ["fr", "parlant", "parler"], ["fr", "aimant", "aimer"],
  // FR noun plural
  ["fr", "livres", "livre"], ["fr", "hommes", "homme"],
  ["fr", "femmes", "femme"], ["fr", "maisons", "maison"],
  // IT present
  ["it", "parliamo", "parlare"], ["it", "parlate", "parlare"], ["it", "parlano", "parlare"],
  ["it", "mangiamo", "mangiare"], ["it", "mangiate", "mangiare"], ["it", "mangiano", "mangiare"],
  ["it", "prendono", "prendere"], ["it", "prendete", "prendere"],
  // IT fut/gerund
  ["it", "parleranno", "parlare"], ["it", "vedranno", "vedere"],
  ["it", "mangiando", "mangiare"], ["it", "parlando", "parlare"],
  // IT participle
  ["it", "parlato", "parlare"], ["it", "mangiato", "mangiare"],
  ["it", "letto", "leggere"], ["it", "visto", "vedere"],
  // IT noun plural
  ["it", "libri", "libro"], ["it", "case", "casa"],
  ["it", "uomini", "uomo"], ["it", "amori", "amore"],
  // ES present
  ["es", "hablamos", "hablar"], ["es", "hablan", "hablar"], ["es", "habláis", "hablar"],
  ["es", "comemos", "comer"], ["es", "comen", "comer"], ["es", "coméis", "comer"],
  ["es", "beben", "beber"], ["es", "dicen", "decir"],
  // ES gerund/future
  ["es", "hablando", "hablar"], ["es", "comiendo", "comer"],
  ["es", "hablarán", "hablar"], ["es", "comerán", "comer"],
  // ES participle
  ["es", "hablado", "hablar"], ["es", "comido", "comer"],
  ["es", "bebido", "beber"], ["es", "dicho", "decir"],
  // ES noun plural
  ["es", "casas", "casa"], ["es", "libros", "libro"],
  ["es", "hombres", "hombre"], ["es", "mujeres", "mujer"],
  // RU case
  ["ru", "дома", "дом"], ["ru", "книги", "книга"], ["ru", "книгу", "книга"],
  ["ru", "книгой", "книга"], ["ru", "книг", "книга"], ["ru", "доме", "дом"],
  ["ru", "города", "город"], ["ru", "городу", "город"], ["ru", "ночью", "ночь"],
  ["ru", "водой", "вода"], ["ru", "женой", "женщина"], ["ru", "году", "год"],
  // RU verb
  ["ru", "говорят", "говорить"], ["ru", "читают", "читать"], ["ru", "делают", "делать"],
  ["ru", "говорю", "говорить"], ["ru", "читаю", "читать"],
  // RU adj
  ["ru", "хорошего", "хороший"], ["ru", "большого", "большой"], ["ru", "новой", "новый"],
  // JA verb活用
  ["ja", "行きます", "行く"], ["ja", "行った", "行く"], ["ja", "行って", "行く"],
  ["ja", "来ます", "来る"], ["ja", "します", "する"], ["ja", "しない", "する"],
  ["ja", "見ます", "見る"], ["ja", "見た", "見る"], ["ja", "知った", "知る"],
  ["ja", "読んだ", "読む"], ["ja", "読んで", "読む"], ["ja", "食べます", "食べる"],
  // JA adj活用
  ["ja", "良かった", "良い"], ["ja", "大きく", "大きい"],
  ["ja", "小さく", "小さい"], ["ja", "新しく", "新しい"],
  // JA noun (segment+identity 基准)
  ["ja", "本", "本"], ["ja", "学校", "学校"], ["ja", "世界", "世界"], ["ja", "生活", "生活"],
];

// 不编数据守卫：期望原形必须在 seeds 内。
const seedKeys = new Map();
for (const lang of ["en", "de", "fr", "it", "es", "ru", "ja"]) {
  const raw = JSON.parse(readFileSync(join(ROOT, "packages/dict-tools/seeds", `${lang}.seed.json`), "utf8"));
  seedKeys.set(lang, new Set(Object.keys(raw)));
}
let guardFail = 0;
for (const [lang, surface, want] of MATRIX) {
  if (!seedKeys.get(lang).has(want)) {
    console.error(`GUARD FAIL: 期望原形不在 seeds 内（编数据嫌疑，拒绝审计）: ${lang} ${surface} -> ${want}`);
    guardFail++;
  }
}
if (guardFail) process.exit(1);

async function makeSeedHost() {
  const { cleanEntries } = await import("../packages/dict-tools/src/clean.mjs");
  const { shardFor } = await import("../packages/dict-loader/src/shard.mjs");
  const store = new Map();
  for (const lang of seedKeys.keys()) {
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
    for (const [s, obj] of byShard) {
      const body = Object.entries(obj).map(([lemma, entry]) =>
        `${lemma}\t${entry.zh.join("")}\t${entry.en.join("")}`).join("\n") + "\n";
      store.set(`${lang}/${s}.dict`, body);
    }
  }
  const fetchImpl = async (url) => {
    const m = url.match(/\/dict\/([a-z]+)\/(.+)\.dict$/);
    if (!m) return { ok: false, status: 404, text: async () => "" };
    const body = store.get(`${m[1]}/${m[2]}.dict`);
    if (!body) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, text: async () => body };
  };
  return { fetchImpl };
}

cacheClear();
clearMisses();
const host = await makeSeedHost();
const rows = [];
for (const [lang, surface, want] of MATRIX) {
  const seg = segment(lang, surface);
  const lemma = lemmatize(lang, surface);
  const origKey = normalizeLemma(lang, surface);
  const stemKey = normalizeLemma(lang, lemma);
  const wantKey = normalizeLemma(lang, want);
  const r = await getGloss(lang, "zh", surface, {
    baseUrl: "https://static.test",
    fetchImpl: host.fetchImpl,
    lemmatize: (t) => lemmatize(lang, t),
  });
  const hit = r.status === "hit";
  const hitVia = !hit ? "-" : (r.key === origKey ? "orig" : (r.key === stemKey ? "stem" : "other:" + r.key));
  const wantMatch = (origKey === wantKey || stemKey === wantKey) ? "y" : "MISMATCH";
  rows.push({ lang, surface, want, lemma, origKey, stemKey, hit, hitVia, wantMatch, gloss: (r.gloss ?? []).join("/") });
}

const byLang = new Map();
for (const r of rows) {
  if (!byLang.has(r.lang)) byLang.set(r.lang, []);
  byLang.get(r.lang).push(r);
}
console.log("| lang | n | hit | rate | misses |");
console.log("|---|---|---|---|---|");
let totH = 0;
for (const [lang, rs] of byLang) {
  const h = rs.filter((r) => r.hit).length;
  totH += h;
  const miss = rs.filter((r) => !r.hit).map((r) => `${r.surface}→${r.lemma}(${r.wantMatch === "y" ? "规则对" : "规则错"})`).join("；");
  console.log(`| ${lang} | ${rs.length} | ${h} | ${(h / rs.length * 100).toFixed(1)}% | ${miss || "—"} |`);
}
console.log(`\nTOTAL ${totH}/${rows.length} (${(totH / rows.length * 100).toFixed(1)}%)`);
if (!compact) {
  console.log("\n| lang | surface | want | lemma | origKey | stemKey | hit | via | gloss |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.lang} | ${r.surface} | ${r.want} | ${r.lemma} | ${r.origKey} | ${r.stemKey} | ${r.hit ? "HIT" : "MISS"} | ${r.hitVia} | ${r.gloss} |`);
  }
  // JA segment 碎片附件（已知局限：无 wasm/lexicon 时 kanji/kana run 切分）
  console.log("\nJA segment 行为（参考，不计分）：");
  for (const surface of ["本を読む", "行きます", "食べます", "学校で読む"]) {
    console.log(`- ${surface} -> [${segment("ja", surface).join(" | ")}]`);
  }
}
