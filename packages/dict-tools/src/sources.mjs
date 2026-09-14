// Source registry: URL + license + local parser. See DICT_SOURCES.md.
// Parsers read dumps from packages/dict-tools/raw/<lang>/ and emit
// [{ lemma, zh: [], en: [] }]. Network is NEVER required for the build:
// without raw dumps the pipeline falls back to seeds/ (reproducible).

export const SOURCES = {
  en: [
    { name: "ECDICT", url: "https://github.com/skywind3000/ECDICT", license: "MIT", raw: "raw/en/ecdict.csv", parse: "ecdict" },
    { name: "Wiktionary EN dump (fallback en->en)", url: "https://dumps.wikimedia.org/enwiktionary/", license: "CC BY-SA 4.0", raw: "raw/en/enwiktionary.xml", parse: "wiktionary-en" },
    { name: "FreeDict eng->deu pivot (en glosses only)", url: "https://freedict.org/", license: "GPL-3.0+ / CC BY-SA (per dict)", raw: "raw/en/freedict-eng-deu.tei", parse: "freedict" },
    { name: "KJV archaic table (hath/doth/saith/thou…, loader双试+古英表保留)", url: "self-curated (KJV text is public domain; glosses MIT)", license: "MIT", raw: "raw/en/archaic.tsv", parse: "tsv" },
  ],
  de: [
    { name: "FreeDict deu-eng (frequency-filtered subset; full dump 517k headwords/429MB, see raw README)", url: "https://freedict.org/", license: "GPL-3.0+ / CC BY-SA (per dict)", raw: "raw/de/freedict-deu-eng.tei", parse: "freedict" },
    { name: "Wiktionary DE dump (de->zh via zh translations)", url: "https://dumps.wikimedia.org/dewiktionary/", license: "CC BY-SA 4.0", raw: "raw/de/dewiktionary.xml", parse: "wiktionary" },
    { name: "CC-CEDICT-style de-zh (community, verify license before ship)", url: "https://github.com/marmelab/dict-de-zh (mirror list; verify)", license: "VERIFY — do not ship until confirmed", raw: "raw/de/de-zh.tsv", parse: "tsv" },
    { name: "Curated zh补齐 + corpus aliases (MIT self-owned)", url: "self-curated", license: "MIT", raw: "raw/de/curated-zh.tsv", parse: "tsv" },
  ],
  fr: [
    { name: "FreeDict fra-eng", url: "https://freedict.org/", license: "GPL-3.0+ / CC BY-SA (per dict)", raw: "raw/fr/freedict-fra-eng.tei", parse: "freedict" },
    { name: "Wiktionary FR dump", url: "https://dumps.wikimedia.org/frwiktionary/", license: "CC BY-SA 4.0", raw: "raw/fr/frwiktionary.xml", parse: "wiktionary" },
    { name: "Curated zh补齐 + corpus aliases (MIT self-owned)", url: "self-curated", license: "MIT", raw: "raw/fr/curated-zh.tsv", parse: "tsv" },
  ],
  it: [
    { name: "FreeDict ita-eng", url: "https://freedict.org/", license: "GPL-3.0+ / CC BY-SA (per dict)", raw: "raw/it/freedict-ita-eng.tei", parse: "freedict" },
    { name: "Wiktionary IT dump", url: "https://dumps.wikimedia.org/itwiktionary/", license: "CC BY-SA 4.0", raw: "raw/it/itwiktionary.xml", parse: "wiktionary" },
    { name: "Curated zh补齐 + corpus aliases (MIT self-owned)", url: "self-curated", license: "MIT", raw: "raw/it/curated-zh.tsv", parse: "tsv" },
  ],
  es: [
    { name: "FreeDict spa-eng", url: "https://freedict.org/", license: "GPL-3.0+ / CC BY-SA (per dict)", raw: "raw/es/freedict-spa-eng.tei", parse: "freedict" },
    { name: "Wiktionary ES dump", url: "https://dumps.wikimedia.org/eswiktionary/", license: "CC BY-SA 4.0", raw: "raw/es/eswiktionary.xml", parse: "wiktionary" },
    { name: "Curated zh补齐 + corpus aliases (MIT self-owned)", url: "self-curated", license: "MIT", raw: "raw/es/curated-zh.tsv", parse: "tsv" },
  ],
  ru: [
    { name: "FreeDict rus-eng", url: "https://freedict.org/", license: "GPL-3.0+ / CC BY-SA (per dict)", raw: "raw/ru/freedict-rus-eng.tei", parse: "freedict" },
    { name: "Wiktionary RU dump", url: "https://dumps.wikimedia.org/ruwiktionary/", license: "CC BY-SA 4.0", raw: "raw/ru/ruwiktionary.xml", parse: "wiktionary" },
    { name: "Ru-En Edict (community, verify)", url: "https://github.com/ (verify per-file license)", license: "VERIFY — do not ship until confirmed", raw: "raw/ru/ru-en.tsv", parse: "tsv" },
    { name: "Curated zh补齐 + corpus aliases (MIT self-owned)", url: "self-curated", license: "MIT", raw: "raw/ru/curated-zh.tsv", parse: "tsv" },
  ],
  ja: [
    { name: "JMdict_e (EDRDG)", url: "https://www.edrdg.org/jmdict/edict.html", license: "CC BY-SA 4.0 (EDRDG licence)", raw: "raw/ja/JMdict_e.gz", parse: "jmdict" },
    { name: "JMdict (Japanese, for zh glosses via JMdict_zh fork — verify)", url: "https://github.com/ (JMdict zh forks; verify)", license: "VERIFY — CC BY-SA presumed, confirm before ship", raw: "raw/ja/JMdict_zh.gz", parse: "jmdict-zh" },
    { name: "Wiktionary JA dump", url: "https://dumps.wikimedia.org/jawiktionary/", license: "CC BY-SA 4.0", raw: "raw/ja/jawiktionary.xml", parse: "wiktionary" },
    { name: "Curated zh补齐 (MIT self-owned; JMdict_e is en-only)", url: "self-curated", license: "MIT", raw: "raw/ja/curated-zh.tsv", parse: "tsv" },
  ],
};

// Minimal streaming-friendly parsers for the formats above.
// Each returns [{lemma, zh:[], en:[]}]. Kept dependency-free on purpose.

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export function parseTsv(text) {
  // lemma\tzh1;zh2\ten1;en2
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [lemma, zh = "", en = ""] = line.split("\t");
    if (!lemma) continue;
    rows.push({
      lemma: lemma.trim(),
      zh: zh.split(/[;；]/).map((s) => s.trim()).filter(Boolean),
      en: en.split(/[;；]/).map((s) => s.trim()).filter(Boolean),
    });
  }
  return rows;
}

export function parseEcdictCsv(text) {
  // ECDICT columns include: word, phonetic, definition(英), translation(中), …
  // We sniff header; fallback: col0=lemma, col2=en, col3=zh.
  const rows = [];
  const lines = text.split("\n");
  const head = (lines[0] ?? "").split(",");
  const li = Math.max(0, head.findIndex((h) => /word/i.test(h)));
  let enI = head.findIndex((h) => /definition/i.test(h));
  let zhI = head.findIndex((h) => /translation/i.test(h));
  if (enI < 0) enI = 2;
  if (zhI < 0) zhI = 3;
  const splitCell = (c) => String(c ?? "").replace(/^"|"$/g, "").split(/\\n|\/n|;/).map((s) => s.trim()).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // naive CSV split respecting quotes
    const cells = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g) ?? [];
    const lemma = (cells[li] ?? "").replace(/^"|"$/g, "").trim();
    if (!lemma) continue;
    rows.push({ lemma, zh: splitCell(cells[zhI]).slice(0, 6), en: splitCell(cells[enI]).slice(0, 6) });
  }
  return rows;
}

export function parseFreedictTei(xml) {
  // TEI subset covering both FreeDict generations:
  // - legacy: <entry><form><orth>lemma</orth></form><sense><trans><tr>t</tr></trans></sense>…
  // - current (download.freedict.org src.tar.xz, e.g. fra-eng 0.4.1):
  //   <entry><form><orth>lemma</orth></form><sense><cit type="trans"><quote>t</quote></cit></sense>…
  // Only <cit type="trans"> quotes are translations; <cit type="example"> is skipped.
  const rows = [];
  const entries = xml.split(/<entry[\s>]/);
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    const orth = (e.match(/<orth[^>]*>([^<]+)<\/orth>/) ?? [])[1];
    if (!orth) continue;
    const trs = [...e.matchAll(/<tr[^>]*>([^<]+)<\/tr>/g)].map((m) => m[1].trim()).filter(Boolean);
    // Current FreeDict P5: <cit type="trans"><quote>…</quote></cit>
    for (const cit of e.matchAll(/<cit[^>]*type="trans"[^>]*>([\s\S]*?)<\/cit>/g)) {
      for (const q of cit[1].matchAll(/<quote[^>]*>([^<]+)<\/quote>/g)) {
        const t = q[1].trim();
        if (t) trs.push(t);
      }
    }
    const uniq = [...new Set(trs)].filter(Boolean);
    if (!uniq.length) continue;
    rows.push({ lemma: orth.trim(), zh: [], en: uniq.slice(0, 6) });
  }
  return rows;
}

export function parseWiktionary(xml, lang = "en") {
  // Minimal MediaWiki-export subset for *wiktionary.xml dumps:
  //   <page><title>lemma</title>…<text …>wikitext</text></page>
  // Extracts:
  // - zh: translation templates with zh as target lang, across wiktionary
  //   editions: en {{t+|zh|…}}/{{t|zh|…}}/{{l|zh|…}}, fr {{trad|zh|…}}/{{T|zh|…}},
  //   de {{Ü|zh|…}}/{{Üt|zh|…}}, es/it {{trad|zh|…}}, generic {{…|zh|…}}.
  // - en: same set with en target + (en wiktionary only) `# definition` lines
  // Deliberately a small补齐 subset (dependency-free): complex senses,
  // nested templates and non-t translations are skipped; callers cap at 6
  // via cleanEntries. Returns [{lemma, zh:[], en:[]}].
  const rows = [];
  const pages = xml.split(/<page[\s>]/);
  // Generic: any {{template|zh|gloss…}} where template name is a known
  // translation shorthand (t, trad, T, Ü, l, trans…). Case-insensitive.
  // Covers l+ (es.wiktionary cognate/translation links) and es-style
  // {{t|en|a1=1|t1=cat|a2=…|t2=…}} (gloss lives in tN= params, not 2nd arg).
  const tplRe = (code) => new RegExp(`\\{\\{\\s*[^{}|]+\\|\\s*${code}\\s*\\|([^{}]*)\\}\\}`, "gi");
  const zhTplRe = tplRe("zh");
  const enTplRe = tplRe("en");
  const pickGlosses = (text, re) => {
    const out = [];
    for (const m of text.matchAll(re)) {
      const params = m[1];
      // es-style tN= params take precedence ({{t|en|a1=1|t1=cat|…}})
      const tN = [...params.matchAll(/\bt\d+\s*=\s*([^|}]+)/gi)].map((x) => x[1].trim()).filter(Boolean);
      if (tN.length) { out.push(...tN); continue; }
      // else second param (first segment before |), skipping k=v params
      const first = params.split("|")[0].trim();
      if (!first || first.includes("=")) continue;
      out.push(first);
    }
    return out;
  };
  for (let i = 1; i < pages.length; i++) {
    const p = pages[i];
    const title = (p.match(/<title>([^<]+)<\/title>/) ?? [])[1];
    if (!title) continue;
    const lemma = title.trim();
    // Skip non-main namespaces (File:, Template:, …) and multiword titles
    // with slashes used for appendices.
    if (!lemma || lemma.includes(":") || lemma.includes("/")) continue;
    const textM = p.match(/<text[^>]*>([\s\S]*?)<\/text>/);
    if (!textM) continue;
    const text = decodeXmlEntities(textM[1]);
    const zh = pickGlosses(text, zhTplRe).filter((s) => s && s !== "zh");
    let en = pickGlosses(text, enTplRe);
    if (lang === "en") {
      // English definitions: `# gloss` lines (skip `#:` examples, `#*` lists).
      for (const line of text.split("\n")) {
        const m = line.match(/^#\s*([^:#*].*)$/);
        if (!m) continue;
        let def = m[1]
          .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, "$2") // [[a|b]] -> b
          .replace(/\{\{[^}]*\}\}/g, "") // drop inline templates
          .replace(/'''?/g, "")
          .trim();
        if (def && def.length <= 120) en.push(def);
        if (en.length >= 6) break;
      }
    }
    const zhU = [...new Set(zh)].slice(0, 6);
    const enU = [...new Set(en)].slice(0, 6);
    if (!zhU.length && !enU.length) continue;
    rows.push({ lemma, zh: zhU, en: enU });
  }
  return rows;
}

export function parseJmdict(xml, glossLang = "eng") {
  // JMdict_e: <entry><k_ele><keb>漢字</keb></k_ele><r_ele><reb>かな</reb></r_ele>
  // <sense><gloss xml:lang="eng">…</gloss></sense>. Emits BOTH keb and reb lemmas.
  // Note: JMdict_e (English-only) uses bare <gloss>…</gloss> with NO xml:lang
  // (default eng); only multilingual forks carry xml:lang="chi" etc.
  const rows = [];
  const entries = xml.split(/<entry>/);
  for (let i = 1; i < entries.length; i++) {
    const e = entries[i];
    const kebs = [...e.matchAll(/<keb>([^<]+)<\/keb>/g)].map((m) => m[1].trim());
    const rebs = [...e.matchAll(/<reb>([^<]+)<\/reb>/g)].map((m) => m[1].trim());
    const glosses = [];
    for (const gm of e.matchAll(/<gloss([^>]*)>([^<]+)<\/gloss>/g)) {
      const attrs = gm[1] ?? "";
      const text = gm[2].trim();
      if (!text) continue;
      const lm = attrs.match(/(?:xml:lang|lang)="([^"]+)"/);
      if (lm) {
        if (lm[1] !== glossLang) continue;
      } else if (glossLang !== "eng") {
        // Bare <gloss> defaults to eng; skip when asking for another lang.
        continue;
      }
      glosses.push(text);
      if (glosses.length >= 6) break;
    }
    if (!glosses.length) continue;
    const lemmas = [...new Set([...kebs, ...rebs])];
    for (const lemma of lemmas) {
      rows.push(glossLang === "eng"
        ? { lemma, zh: [], en: glosses }
        : { lemma, zh: glosses, en: [] });
    }
  }
  return rows;
}
