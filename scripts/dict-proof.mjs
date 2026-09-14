// R2-layout proof: exercises the REAL dict loader (packages/dict-loader,
// the code path that reads deployed shards) against /dict over HTTP.
// Discovers one real lemma per lang from disk first, so dict rebuilds by
// Track B never break this step. Miss path asserts {status:"miss"} (LLM queue).
// ja 核验（LLM 为主，不编造）：ja->en 常用词命中；ja->zh 缺词明确 miss（永不回退 en），
// 由调用方直送 LLM（见 web notice + 点词/点句入口）。
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getGloss } from "../packages/dict-loader/src/index.mjs";
import { TRACK_B_LANGS as LANGS } from "../packages/dict-loader/src/shard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.env.ILR_BASE ?? "http://127.0.0.1:5173";

const fetchImpl = (url, init) => fetch(new URL(url, base).toString(), init);
const rows = [];
let fail = 0;
for (const lang of LANGS) {
  const dir = join(root, "public/dict", lang);
  const readPair = (target) => {
    const p = join(dir, `${target}.dict`);
    const rows = readFileSync(p, "utf8").split("\n").filter(Boolean).map((line) => {
      const [key, gloss = ""] = line.split("\t");
      return { key, gloss };
    });
    return rows.find((entry) => entry.gloss) ?? null;
  };
  const zhEntry = readPair("zh");
  const enEntry = readPair("en");
  const lemma = zhEntry?.key ?? enEntry?.key ?? null;
  if (!lemma) { console.log(`FAIL ${lang}: no entries on disk`); fail++; continue; }
  const zh = await getGloss(lang, "zh", zhEntry?.key ?? lemma, { fetchImpl, baseUrl: "" });
  const en = await getGloss(lang, "en", enEntry?.key ?? lemma, { fetchImpl, baseUrl: "" });
  const okZh = zh.status === "hit" && zh.gloss.length > 0;
  const okEn = en.status === "hit" && en.gloss.length > 0;
  const miss = await getGloss(lang, "zh", "xyznonexistlemma", { fetchImpl, baseUrl: "" });
  const okMiss = miss.status === "miss";
  const ok = okZh && okEn && okMiss;
  if (!ok) fail++;
  rows.push({ lang, lemma, zh: zh.gloss[0] ?? null, en: en.gloss[0] ?? null, ok });
  console.log(`${ok ? "PASS" : "FAIL"} dict ${lang}: lemma=${lemma} zh=${JSON.stringify(zh.gloss[0] ?? null)} en=${JSON.stringify(en.gloss[0] ?? null)} miss=${miss.status}`);
}

// ja->en 核验 + ja->zh 缺词直调 LLM（不编造）：
// - 家/世界 (seed+JMdict 双源) zh/en 双命中；
// - 行動 (JMdict_e 仅英文) en 命中、zh 明确 miss（永不回退 en，调用方送 LLM）。
{
  const opt = { fetchImpl, baseUrl: "" };
  const jaChecks = [
    { lemma: "家", target: "en", expect: "hit", note: "ja->en 常用词" },
    { lemma: "家", target: "zh", expect: "hit", note: "ja->zh 种子词" },
    { lemma: "世界", target: "en", expect: "hit", note: "ja->en 常用词" },
    { lemma: "行動", target: "en", expect: "hit", note: "ja->en JMdict_e" },
    { lemma: "行動", target: "zh", expect: "miss", note: "ja->zh 缺词走LLM(不编造/不回退en)" },
    { lemma: "投票", target: "zh", expect: "miss", note: "ja->zh 缺词走LLM" },
  ];
  for (const c of jaChecks) {
    const r = await getGloss("ja", c.target, c.lemma, opt);
    const ok = r.status === c.expect && (c.expect === "miss" ? r.gloss.length === 0 : r.gloss.length > 0);
    if (!ok) fail++;
    console.log(`${ok ? "PASS" : "FAIL"} dict ja ${c.note}: ${c.lemma}->${c.target} ${r.status} ${JSON.stringify(r.gloss[0] ?? null)} (scripts/dict-proof.mjs)`);
  }
  // miss 必须进 LLM 队列（getMisses 有入口），且 zh 缺词永不透出 en 串味。
  const { getMisses } = await import("../packages/dict-loader/src/index.mjs");
  const misses = getMisses().map((m) => `${m.lang}:${m.target}:${m.lemma}`);
  const hasJaZhMiss = misses.some((m) => m === "ja:zh:行動");
  console.log(`${hasJaZhMiss ? "PASS" : "FAIL"} dict ja miss进LLM队列: ${hasJaZhMiss ? "ja:zh:行動已记录" : `队列缺 ja:zh:行動 [${misses.slice(-6).join(",")}]`} (packages/dict-loader/src/index.mjs:60)`);
  if (!hasJaZhMiss) fail++;
}
if (fail) { console.error(`DICT-PROOF FAIL (${fail})`); process.exit(1); }
console.log(`DICT-PROOF OK: 7 langs x zh/en hit + miss (via ${base}/dict)`);
