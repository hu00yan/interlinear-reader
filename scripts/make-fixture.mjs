// Generates Track-D e2e fixtures. Run: node scripts/make-fixture.mjs (idempotent).
//   tests/fixtures/{lang}.txt      — 1 paragraph each, 7 source langs
//   tests/fixtures/sample-7lang.epub — 7 chapters (one per lang), stored zip
// Paragraphs mix web-mock-dict HIT words (packages/web/src/dict/mock-dict.ts)
// with one UNKNOWN word per lang (mock-LLM path). Lemmas follow the fallback
// pack rules (packages/web/src/reader/langpacks/fallback.ts).
import { mkdirSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

export const FIXTURE = {
  en: {
    text: "Time and people find a way. Xyzenigma remains unknown.",
    hit: { time: "时间" },
    unknown: "Xyzenigma",
  },
  de: {
    text: "Haus und Mann sehen die Stadt. Xyzquark bleibt unbekannt.",
    hit: { haus: "房子" },
    unknown: "Xyzquark",
  },
  fr: {
    text: "La maison et l'homme voient la ville. Xyzfromage reste inconnu.",
    hit: { maison: "房子" },
    unknown: "Xyzfromage",
  },
  it: {
    text: "La casa e l'uomo vedono la citta. Xyzformaggio resta sconosciuto.",
    hit: { casa: "房子" },
    unknown: "Xyzformaggio",
  },
  es: {
    text: "La casa y el hombre ven la ciudad. Xyzquijote queda desconocido.",
    hit: { casa: "房子" },
    unknown: "Xyzquijote",
  },
  ru: {
    text: "Дом и человек видят город. Хузматрёшка остаётся неизвестной.",
    hit: { дом: "房子" },
    unknown: "Хузматрёшка",
  },
  ja: { text: "家と人は町を見る。魑魅は未知だ。", hit: { 家: "家" }, unknown: "魑魅" },
};

mkdirSync(`${root}/tests/fixtures`, { recursive: true });
for (const [lang, f] of Object.entries(FIXTURE))
  writeFileSync(`${root}/tests/fixtures/${lang}.txt`, f.text + "\n");

// Long chapter fixture: forces multi-page in double-column rich layout (e2e).
writeFileSync(
  `${root}/tests/fixtures/en-long.txt`,
  Array.from(
    { length: 60 },
    (_, i) => `Paragraph ${i + 1}. Time and people find a way through the quiet morning light.`
  ).join("\n\n") + "\n"
);

// 7-chapter EPUB (stored entries; parsed by packages/web/src/ingest/epub.ts).
const langs = Object.keys(FIXTURE);
const files = {
  mimetype: "application/epub+zip",
  "META-INF/container.xml": `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  "OEBPS/content.opf": `<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>ILR 7-lang verify fixture</dc:title><dc:language>en</dc:language></metadata><manifest>${langs.map((l) => `<item id="${l}" href="${l}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${langs.map((l) => `<itemref idref="${l}"/>`).join("")}</spine></package>`,
};
for (const [lang, f] of Object.entries(FIXTURE)) {
  files[`OEBPS/${lang}.xhtml`] =
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${lang}</title></head><body><h1>${lang}</h1><p>${f.text}</p></body></html>`;
}
function crc32(buf) {
  const t = (crc32.t ??= (() => {
    const p = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      p[n] = c;
    }
    return p;
  })());
  let c = 0xffffffff;
  for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let off = 0;
  for (const [name, str] of Object.entries(entries)) {
    const nb = enc.encode(name);
    const db = typeof str === "string" ? enc.encode(str) : str;
    const crc = crc32(db);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true);
    lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, db.length, true);
    lh.setUint32(22, db.length, true);
    lh.setUint16(26, nb.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(Buffer.from(lh.buffer), Buffer.from(nb), Buffer.from(db));
    central.push({ nb, crc, len: db.length, off });
    off += 30 + nb.length + db.length;
  }
  const cdStart = off;
  const cdChunks = [];
  for (const e of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint32(16, e.crc, true);
    ch.setUint32(20, e.len, true);
    ch.setUint32(24, e.len, true);
    ch.setUint16(28, e.nb.length, true);
    ch.setUint32(42, e.off, true);
    cdChunks.push(Buffer.from(ch.buffer), Buffer.from(e.nb));
    off += 46 + e.nb.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length, true);
  end.setUint16(10, central.length, true);
  end.setUint32(12, off - cdStart, true);
  end.setUint32(16, cdStart, true);
  return Buffer.concat([...chunks, ...cdChunks, Buffer.from(end.buffer)]);
}
writeFileSync(`${root}/tests/fixtures/sample-7lang.epub`, zipStore(files));

// EPUB with an embedded image — exercises the rich-layout image path (img src → assets blob).
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lH5pAAAAABJRU5ErkJggg==",
  "base64"
);
const imgFiles = {
  mimetype: "application/epub+zip",
  "META-INF/container.xml": files["META-INF/container.xml"],
  "OEBPS/content.opf": `<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>ILR image fixture</dc:title><dc:language>en</dc:language></metadata><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="pic" href="pic.png" media-type="image/png"/></manifest><spine><itemref idref="ch1"/></spine></package>`,
  "OEBPS/ch1.xhtml": `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Pic</title></head><body><h1>Pic</h1><p>The small cat drinks milk.</p><p><img src="pic.png" alt="dot"/></p><p><a href="ch2.xhtml">到第二章</a></p></body></html>`,
  "OEBPS/pic.png": PNG_1PX,
};
writeFileSync(`${root}/tests/fixtures/sample-image.epub`, zipStore(imgFiles));

// Boot demo book (packages/web/public/fixtures/hello-en.epub) — the FIRST book a new
// visitor sees. 2026-11 产品复盘：玩具句（Hello world.）撑不起第一印象；换成一篇
// 有情节的小故事，且每个词都过 en→zh 词典（用真实链路验证过：segment+lemmatize 全命中），
// 不填 key 也能看到完整的逐词注释效果。结构契约：2 章 / ch1 3 段 / 标题 Hello Reader
// （verify-track-a 断言依赖，改动需同步）。
const demo = {
  mimetype: "application/epub+zip",
  "META-INF/container.xml": files["META-INF/container.xml"],
  "OEBPS/content.opf": `<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Hello Reader</dc:title><dc:language>en</dc:language><dc:identifier id="id">hello-en-fixture</dc:identifier></metadata><manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`,
  "OEBPS/ch1.xhtml": `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>The Cat in the Garden</title></head><body><h1>The Cat in the Garden</h1><p>The black cat sleeps in the garden. A small bird sings in the big tree, and the sun shines over the old house.</p><p>The cat opens one eye and watches the bird. "You sing well," she thinks, "but you are small and slow."</p><p>Then she jumps, but the bird flies away. The cat walks back hungry and a little sad.</p></body></html>`,
  "OEBPS/ch2.xhtml": `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Night and Rain</title></head><body><h1>Night and Rain</h1><p>Night comes. Rain falls on the window, and the house is quiet.</p><p>The cat drinks her milk near the door, then sleeps on the warm chair and dreams.</p><p>"Tomorrow," she thinks, "I will find a bigger garden and a better breakfast."</p></body></html>`,
};
writeFileSync(`${root}/packages/web/public/fixtures/hello-en.epub`, zipStore(demo));

console.log("fixtures: 7 txt + sample-7lang.epub + sample-image.epub + hello-en.epub");
