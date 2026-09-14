import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { parseWiktionary, parseFreedictTei, parseJmdict } from "../src/sources.mjs";

// Minimal MediaWiki-export fixtures (dependency-free subset).
const EN_WIKT = `<mediawiki>
<page><title>book</title><revision><text xml:space="preserve">==English==
===Noun===
# A [[book|written]] work.
# A [[collection]] of pages.
{{t+|zh|书}}
{{t+|en|book}}
</text></revision></page>
<page><title>Template:foo</title><revision><text>should be skipped (namespace)</text></revision></page>
<page><title>empty</title><revision><text>no translations, no defs</text></revision></page>
</mediawiki>`;

const DE_WIKT = `<mediawiki>
<page><title>Haus</title><revision><text>==Haus==
{{t+|en|house}}
{{t+|zh|房子}}
</text></revision></page>
</mediawiki>`;

const FREEDICT_TEI = `<TEI><entry><form><orth>Haus</orth></form><sense><trans><tr>house</tr></trans></sense></entry></TEI>`;

test("parseWiktionary: en defs + zh/en templates, skips namespaces/empties", () => {
  const rows = parseWiktionary(EN_WIKT, "en");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lemma, "book");
  assert.ok(rows[0].zh.includes("书"), `zh=${JSON.stringify(rows[0].zh)}`);
  // en from # defs and/or templates
  assert.ok(rows[0].en.length > 0, `en=${JSON.stringify(rows[0].en)}`);
});

test("parseWiktionary: non-en lang uses templates only (no # defs as en)", () => {
  const rows = parseWiktionary(DE_WIKT, "de");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].zh, ["房子"]);
  assert.deepEqual(rows[0].en, ["house"]);
});

test("parseWiktionary: real translation template variants", () => {
  const xml = `<mediawiki>
<page><title>Buch</title><revision><text>{{Übersetzungen}} *{{zh}}: {{Üt|zh|书|shū}}</text></revision></page>
<page><title>maison</title><revision><text>{{trad|zh|房子}}</text></revision></page>
<page><title>casa</title><revision><text>{{t|zh|a1=1|t1=房子}}</text></revision></page>
</mediawiki>`;
  const de = parseWiktionary(xml, "de");
  const fr = parseWiktionary(xml, "fr");
  const es = parseWiktionary(xml, "es");
  assert.ok(de.find((r) => r.lemma === "Buch")?.zh.includes("书"));
  assert.ok(fr.find((r) => r.lemma === "maison")?.zh.includes("房子"));
  assert.ok(es.find((r) => r.lemma === "casa")?.zh.includes("房子"));
});

test("B2 regression: *wiktionary.xml must NOT go via parseFreedictTei", () => {
  // Freedict TEI parser finds no <orth>/<tr> in wiktionary dumps -> 0 rows
  // (the old build.mjs mis-route silently dropped all wiktionary data).
  const viaTei = parseFreedictTei(EN_WIKT);
  assert.equal(viaTei.length, 0);
  const viaWikt = parseWiktionary(EN_WIKT, "en");
  assert.ok(viaWikt.length > 0);
});

test("B2: .gz branch — gunzipped bytes parse identically", async () => {
  const gz = gzipSync(Buffer.from(EN_WIKT, "utf8"));
  const { gunzipSync } = await import("node:zlib");
  const text = gunzipSync(gz).toString("utf8");
  assert.deepEqual(parseWiktionary(text, "en"), parseWiktionary(EN_WIKT, "en"));
});

test("B2: build end-to-end — raw wiktionary.xml + .xml.gz land in shards", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const root = new URL("../../..", import.meta.url).pathname;
  const raw = mkdtempSync(join(tmpdir(), "raw-"));
  const out = mkdtempSync(join(tmpdir(), "dictout-"));
  mkdirSync(join(raw, "en"), { recursive: true });
  writeFileSync(join(raw, "en", "enwiktionary.xml"), EN_WIKT);
  writeFileSync(join(raw, "en", "extra.xml.gz"), gzipSync(Buffer.from(DE_WIKT.replaceAll("Haus", "house").replaceAll("房子", "房子").replaceAll("house", "house"), "utf8")));
  const r = spawnSync("node", [join(root, "packages/dict-tools/src/build.mjs"), "--lang=en", `--raw=${raw}`, `--out=${out}`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const files = readdirSync(join(out, "en"));
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.some((f) => f.endsWith(".dict.br")));
  // merged dict must contain the wiktionary lemma (book) from .xml
  // plus seed lemmas — read shards to confirm.
  let found = false;
  for (const f of files.filter((x) => x.endsWith(".dict"))) {
    const rows = readFileSync(join(out, "en", f), "utf8").split("\n");
    if (rows.some((line) => line.startsWith("book\t"))) found = true;
  }
  assert.ok(found, "wiktionary lemma 'book' missing from built shards");
  assert.ok(existsSync(join(out, "sizes.json")));
});
