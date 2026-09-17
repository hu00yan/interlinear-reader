import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const temp = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "ilr-mobi-unit-"));
after(() => rm(temp, { recursive: true, force: true }));
await build({
  entryPoints: ["packages/web/src/ingest/mobi.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(temp, "mobi.mjs"),
  external: ["jszip"],
});
const { parseMobi } = await import(pathToFileURL(join(temp, "mobi.mjs")));
const dom = new JSDOM();
for (const key of ["DOMParser", "XMLSerializer", "document"]) globalThis[key] = dom.window[key];
after(() => dom.window.close());

const bytes = (s) => Buffer.from(s);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const NONE = 0xffffffff;
const exth = (type, data) => Buffer.concat([u32(type), u32(data.length + 8), data]);
function header({
  version = 6,
  title = "Record title",
  exthTitle,
  compression = 1,
  encryption = 0,
  boundary,
  skel = NONE,
  frag = NONE,
  resourceStart = NONE,
} = {}) {
  const records = [exth(524, bytes("en"))];
  if (exthTitle) records.push(exth(503, bytes(exthTitle)));
  if (boundary !== undefined) records.push(exth(121, u32(boundary)));
  const ext = Buffer.concat([
    bytes("EXTH"),
    u32(12 + records.reduce((s, b) => s + b.length, 0)),
    u32(records.length),
    ...records,
  ]);
  const h = Buffer.alloc(280);
  h.writeUInt16BE(compression, 0);
  h.writeUInt16BE(1, 8);
  h.writeUInt16BE(4096, 10);
  h.writeUInt16BE(encryption, 12);
  h.write("MOBI", 16);
  h.writeUInt32BE(264, 20);
  h.writeUInt32BE(2, 24);
  h.writeUInt32BE(65001, 28);
  h.writeUInt32BE(version, 36);
  h.writeUInt32BE(h.length + ext.length, 84);
  h.writeUInt32BE(bytes(title).length, 88);
  h[95] = 9;
  for (const p of [108, 112, 192, 244, 248, 252, 260]) h.writeUInt32BE(NONE, p);
  h.writeUInt32BE(0x40, 128);
  h.writeUInt32BE(skel, 252);
  h.writeUInt32BE(frag, 248);
  h.writeUInt32BE(resourceStart, 108);
  return Buffer.concat([h, ext, bytes(title)]);
}
function pdb(records, name = "test.mobi") {
  const h = Buffer.alloc(78 + records.length * 8 + 2);
  h.write("BOOKMOBI", 60);
  h.writeUInt16BE(records.length, 76);
  let offset = h.length;
  records.forEach((r, i) => {
    h.writeUInt32BE(offset, 78 + i * 8);
    offset += r.length;
  });
  return new File([h, ...records], name);
}
// Valid PalmDOC literal runs (also protects non-ASCII UTF-8 bytes).
function palm(s) {
  const b = bytes(s),
    out = [];
  for (let i = 0; i < b.length; i += 8) {
    const run = b.subarray(i, i + 8);
    out.push(Buffer.from([run.length]), run);
  }
  return Buffer.concat(out);
}
function vl(n) {
  const out = [0x80 | (n & 127)];
  while ((n = Math.floor(n / 128))) out.unshift(n & 127);
  return Buffer.from(out);
}
// INDX/TAGX/IDXT pairs, not mocked parser results. One control byte per entry.
function index(tags, entries) {
  const tagx = Buffer.concat([
    bytes("TAGX"),
    u32(12 + (tags.length + 1) * 4),
    u32(1),
    ...tags.map(([tag, n], i) => Buffer.from([tag, n, 1 << i, 0])),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const main = Buffer.alloc(56);
  main.write("INDX");
  main.writeUInt32BE(56, 4);
  main.writeUInt32BE(1, 24);
  main.writeUInt32BE(65001, 28);
  const data = Buffer.alloc(56);
  data.write("INDX");
  data.writeUInt32BE(56, 4);
  data.writeUInt32BE(entries.length, 24);
  const values = entries.map(([name, nums]) =>
    Buffer.concat([
      Buffer.from([bytes(name).length]),
      bytes(name),
      Buffer.from([(1 << tags.length) - 1]),
      ...nums.map(vl),
    ])
  );
  const idxt = Buffer.alloc(4 + entries.length * 2);
  idxt.write("IDXT");
  let offset = 56;
  values.forEach((v, i) => {
    idxt.writeUInt16BE(offset, 4 + 2 * i);
    offset += v.length;
  });
  data.writeUInt32BE(offset, 20);
  return [Buffer.concat([main, tagx]), Buffer.concat([data, ...values, idxt])];
}
function kf8(options = {}) {
  const prefix = '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>';
  const skeleton = prefix + "</body></html>";
  const bodies = options.bodies || [
    "<h1>First KF8</h1><p>Modern first.</p>",
    "<h1>Second KF8</h1><p>Modern second.</p>",
  ];
  let offset = 0;
  const skels = [],
    frags = [],
    text = [];
  bodies.forEach((body, i) => {
    skels.push([`s${i}`, [1, offset, bytes(skeleton).length]]);
    frags.push([String(offset + bytes(prefix).length), [0, i, 0, bytes(body).length]]);
    text.push(bytes(skeleton), bytes(body));
    offset += bytes(skeleton).length + bytes(body).length;
  });
  return [
    header({ version: 8, skel: 2, frag: 4, ...options }),
    Buffer.concat(text),
    ...index(
      [
        [1, 1],
        [6, 2],
      ],
      skels
    ),
    ...index(
      [
        [2, 1],
        [4, 1],
        [6, 2],
      ],
      frags
    ),
  ];
}

describe("binary MOBI and KF8 ingestion", () => {
  it("extracts record-0 title, pagebreak chapters, selected language, ruby and nested blocks", async () => {
    const html =
      "<html><body><h1>One</h1><p><ruby>日本<rt>にほん</rt></ruby></p><blockquote>Before<p>Inside</p>After</blockquote><mbp:pagebreak/><h1>Two</h1><p>End.</p></body></html>";
    const book = await parseMobi(pdb([header(), bytes(html)]), "ja");
    assert.equal(book.title, "Record title");
    assert.equal(book.source, "mobi");
    assert.equal(book.lang, "ja");
    assert.deepEqual(
      book.chapters.map((c) => c.title),
      ["One", "Two"]
    );
    assert.deepEqual(
      book.chapters.map((c) => c.paragraphs),
      [["日本", "Before", "Inside", "After"], ["End."]]
    );
  });
  it("preserves MOBI7 and KF8 embedded images, alt and order without adding text", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64"
    );
    for (const modern of [false, true]) {
      const body =
        '<p>Before<img recindex="1" alt="Cover"/>After</p>' +
        '<img src="kindle:embed:0001?mime=image/png" alt="Again"/>' +
        '<img recindex="999"/><img recindex="0"/><img src="https://example.com/no.png"/>';
      const records = modern
        ? [...kf8({ resourceStart: 6, bodies: [body, '<img recindex="1" alt="Only"/>'] }), png]
        : [
            header({ resourceStart: 2 }),
            bytes(body + '<mbp:pagebreak/><img recindex="1" alt="Only"/>'),
            png,
          ];
      const book = await parseMobi(pdb(records), "en");
      assert.deepEqual(Object.keys(book.assets), ["mobi/image-0"]);
      assert.equal(book.assets["mobi/image-0"].type, "image/png");
      assert.deepEqual(Buffer.from(await book.assets["mobi/image-0"].arrayBuffer()), png);
      assert.deepEqual(book.chapters[0].paragraphs, ["Before", "After"]);
      assert.deepEqual(book.chapters[0].blocks, [
        { kind: "p", text: "Before" },
        { kind: "img", src: "mobi/image-0", alt: "Cover" },
        { kind: "p", text: "After" },
        { kind: "img", src: "mobi/image-0", alt: "Again" },
      ]);
      assert.deepEqual(book.chapters[1].paragraphs, []);
      assert.deepEqual(book.chapters[1].blocks, [
        { kind: "img", src: "mobi/image-0", alt: "Only" },
      ]);
    }
  });
  it("uses EXTH title and decompresses PalmDOC UTF-8 literal runs", async () => {
    const book = await parseMobi(
      pdb([header({ exthTitle: "牧歌 &amp; Test", compression: 2 }), palm("<p>日本語 body.</p>")]),
      "en"
    );
    assert.equal(book.title, "牧歌 & Test");
    assert.deepEqual(book.chapters[0].paragraphs, ["日本語 body."]);
  });
  it("reassembles KF8 skeleton/fragment sections in order and preserves CDATA", async () => {
    const book = await parseMobi(
      pdb(
        kf8({
          bodies: [
            "<h1>One</h1><p><![CDATA[Visible & intact.]]></p><p>Before <![CDATA[inside]]> after.</p>",
            "<h1>Two</h1><p>Next.</p>",
          ],
        }),
        "test.azw3"
      ),
      "en"
    );
    assert.deepEqual(
      book.chapters.map((c) => c.paragraphs),
      [["Visible & intact.", "Before inside after."], ["Next."]]
    );
  });
  it("prefers the KF8 half of combo files, including its metadata", async () => {
    const book = await parseMobi(
      pdb([
        header({ boundary: 3 }),
        bytes("<p>Legacy must not appear.</p>"),
        bytes("BOUNDARY"),
        ...kf8({ exthTitle: "Modern title" }),
      ]),
      "en"
    );
    assert.equal(book.title, "Modern title");
    assert.deepEqual(
      book.chapters.map((c) => c.paragraphs),
      [["Modern first."], ["Modern second."]]
    );
  });
  it("rejects encryption on standalone and combo KF8 headers before decompression", async () => {
    for (const encryption of [1, 2]) {
      await assert.rejects(
        parseMobi(pdb([header({ encryption }), bytes("not decrypted")]), "en"),
        /DRM/
      );
      await assert.rejects(
        parseMobi(
          pdb([
            header({ boundary: 3 }),
            bytes("<p>Legacy</p>"),
            bytes("BOUNDARY"),
            ...kf8({ encryption }),
          ]),
          "en"
        ),
        /DRM/
      );
    }
  });
  it("rejects renamed text, truncated records, bad combo boundaries and empty image-only books", async () => {
    await assert.rejects(parseMobi(new File(["Not a book"], "fake.mobi"), "en"), /BOOKMOBI/);
    await assert.rejects(
      parseMobi(pdb([header({ boundary: 99 }), bytes("<p>Old</p>")]), "en"),
      /无效/
    );
    await assert.rejects(parseMobi(pdb([Buffer.alloc(16), bytes("bad")]), "en"), /无效/);
    await assert.rejects(parseMobi(pdb([header(), bytes('<img src="x"/>')]), "en"), /未提取到正文/);
  });
  it("tolerates malformed KF8 HTML without replacing source with parsererror text", async () => {
    const book = await parseMobi(pdb(kf8({ bodies: ["<p>Visible&nbsp;prose.</p>"] })), "en");
    assert.deepEqual(book.chapters[0].paragraphs, ["Visible prose."]);
  });
  it("decompresses a minimal HUFF/CDIC dictionary stream", async () => {
    const h = header({ compression: 17480 });
    h.writeUInt32BE(2, 112);
    h.writeUInt32BE(2, 116);
    const huff = Buffer.alloc(24 + 256 * 4 + 32 * 8);
    huff.write("HUFF");
    huff.writeUInt32BE(24, 8);
    huff.writeUInt32BE(1048, 12);
    for (let i = 0; i < 256; i++) huff.writeUInt32BE((i << 8) | 0x88, 24 + i * 4); // 8-bit terminal, dictionary entry 0
    const phrase = bytes("<p>Huffman text.</p>");
    const cdic = Buffer.alloc(20);
    cdic.write("CDIC");
    cdic.writeUInt32BE(16, 4);
    cdic.writeUInt32BE(1, 8);
    cdic.writeUInt32BE(0, 12);
    cdic.writeUInt16BE(2, 16);
    cdic.writeUInt16BE(0x8000 | phrase.length, 18);
    const book = await parseMobi(
      pdb([h, Buffer.from([0]), huff, Buffer.concat([cdic, phrase])]),
      "en"
    );
    assert.deepEqual(book.chapters[0].paragraphs, ["Huffman text."]);
  });
});
