#!/usr/bin/env node
// Fetch real Wiktionary wikitext via MediaWiki API (CC BY-SA) and save as
// raw/<lang>/*wiktionary.xml (MediaWiki-export subset for parseWiktionary).
// Throttled (3s/req) to respect rate limits. Small high-frequency slices:
// full dumps are GB-scale (see DICT_SOURCES), so we fetch top words only.
// Usage: node scripts/fetch-wiktionary.mjs [--lang=en,fr,...] [--limit=500]
// The limit applies per language; words come from must-keep + freq/<lang>.tsv.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const RAW = join(ROOT, "packages/dict-tools/raw");

const args = process.argv.slice(2);
let langs = ["en", "de", "fr", "it", "es", "ru", "ja"];
let limit = 500;
for (const a of args) {
  if (a.startsWith("--lang=")) langs = a.slice(7).split(",").map((s) => s.trim()).filter(Boolean);
  if (a.startsWith("--limit=")) limit = Math.max(1, Number(a.slice(8)) || 500);
}

// High-frequency + corpus + must-keep words per lang (titles in own wiktionary)
const WORDS = {
  en: ["cat", "dog", "house", "book", "water", "hath", "doth", "saith", "empire", "decline", "roman", "lord", "heaven", "every", "study", "language", "thought", "choose", "leaf", "fall"],
  de: ["Haus", "Katze", "Hund", "Buch", "Wasser", "Liebe", "Schule", "Welt", "Zeit", "Leben", "lesen", "schreiben", "Morgen", "Geschichte"],
  fr: ["chat", "maison", "livre", "eau", "aimer", "manger", "boire", "prendre", "parole", "histoire", "matin", "écrire"],
  it: ["gatto", "casa", "libro", "acqua", "amare", "mangiare", "bere", "scrivere", "parola", "storia", "mattina", "vecchio"],
  es: ["gato", "casa", "libro", "agua", "amar", "comer", "beber", "escribir", "palabra", "historia", "cada", "bueno"],
  ru: ["дом", "кот", "книга", "вода", "любить", "читать", "писать", "история", "время", "жизнь", "школа", "мир"],
  ja: ["猫", "家", "本", "水", "学校", "世界", "生活", "話", "書く", "読む", "行く", "見る"],
};
const WIKI_HOST = { en: "en.wiktionary.org", de: "de.wiktionary.org", fr: "fr.wiktionary.org", it: "it.wiktionary.org", es: "es.wiktionary.org", ru: "ru.wiktionary.org", ja: "ja.wiktionary.org" };
const OUT_NAME = { en: "enwiktionary.xml", de: "dewiktionary.xml", fr: "frwiktionary.xml", it: "itwiktionary.xml", es: "eswiktionary.xml", ru: "ruwiktionary.xml", ja: "jawiktionary.xml" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWikitext(host, title) {
  const q = new URLSearchParams({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", format: "json", titles: title });
  const url = `https://${host}/w/api.php?${q}`;
  const res = await fetch(url, { headers: { "User-Agent": "interlinear-reader-dict-build/0.1 (CC BY-SA attribution; contact: build)" } });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") ?? 5) * 1000;
    console.log(`  429 ${title}, waiting ${retry}ms`);
    await sleep(retry + 1000);
    return fetchWikitext(host, title);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${title}`);
  const d = await res.json();
  const pages = d?.query?.pages ?? {};
  for (const pid of Object.keys(pages)) {
    const p = pages[pid];
    if (p.missing !== undefined) return null;
    const rev = p?.revisions?.[0]?.slots?.main?.["*"];
    if (rev) return rev;
  }
  return null;
}
function escXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function frequencyWords(lang) {
  const p = join(ROOT, "packages/dict-tools/freq", `${lang}.tsv`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n")
    .map((line) => line.split("\t")[0].trim())
    .filter((word) => word && !word.startsWith("#") && /^[\p{L}][\p{L}'-]*$/u.test(word));
}

for (const lang of langs) {
  const host = WIKI_HOST[lang];
  const mustKeep = WORDS[lang] ?? [];
  const words = [...new Set([...mustKeep, ...frequencyWords(lang)])].slice(0, limit);
  console.log(`fetching ${lang} (${words.length} titles, limit=${limit}) from ${host}...`);
  mkdirSync(join(RAW, lang), { recursive: true });
  let xml = `<mediawiki>\n`;
  let ok = 0;
  for (const w of words) {
    try {
      const text = await fetchWikitext(host, w);
      await sleep(3000);
      if (!text) { console.log(`  miss ${w}`); continue; }
      xml += `<page><title>${escXml(w)}</title><revision><text xml:space="preserve">${escXml(text.slice(0, 20000))}</text></revision></page>\n`;
      ok++;
      console.log(`  ok ${w} (${text.length} chars)`);
    } catch (e) {
      console.log(`  ERR ${w}: ${e.message}`);
      await sleep(3000);
    }
  }
  xml += `</mediawiki>\n`;
  const out = join(RAW, lang, OUT_NAME[lang]);
  writeFileSync(out, xml);
  console.log(`wrote ${out} (${ok}/${words.length} pages, ${xml.length} bytes)`);
}
console.log("done.");
