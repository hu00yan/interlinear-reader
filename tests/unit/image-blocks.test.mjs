import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import JSZip from "jszip";
import { extractXhtml, parseEpub, resolveEpubPath } from "../../packages/web/src/ingest/epub.ts";
import { BookImageUrls, chapterFlow, flowLength } from "../../packages/web/src/reader/blocks.ts";

const dom = new JSDOM();
globalThis.DOMParser = dom.window.DOMParser;
const doc = (body) => `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`;

test("mixed extraction preserves inline image position and repeated text across image", () => {
  const got = extractXhtml(
    doc('<p>Before<img src="../images/a.png" alt="A &amp; B"/>After</p><p>After</p>')
  );
  assert.deepEqual(got.paragraphs, ["Before", "After"]);
  assert.deepEqual(got.blocks, [
    { kind: "p", text: "Before" },
    { kind: "img", src: "../images/a.png", alt: "A & B" },
    { kind: "p", text: "After" },
  ]);
  assert.deepEqual(extractXhtml(doc('<p>Same</p><img src="a"/><p>Same</p>')).paragraphs, [
    "Same",
    "Same",
  ]);
});

test("only local archive paths resolve, including percent encoding", () => {
  assert.equal(resolveEpubPath("OPS/text/ch.xhtml", "../images/a%20b.png#x"), "OPS/images/a b.png");
  for (const src of [
    "https://example.com/a.png",
    "//example.com/a.png",
    "data:image/png,a",
    "../../../escape.png",
    "%broken",
  ])
    assert.equal(resolveEpubPath("OPS/text/ch.xhtml", src), null);
});

test("image-only spine chapters survive; external and non-image assets excluded", async () => {
  const zip = new JSZip();
  zip.file(
    "META-INF/container.xml",
    '<container><rootfile full-path="OPS/content.opf"/></container>'
  );
  zip.file(
    "OPS/content.opf",
    '<package><metadata><title>Images</title></metadata><manifest><item id="a" href="text/a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="text/b.xhtml" media-type="application/xhtml+xml"/><item id="image" href="images/a.png" media-type="image/png"/><item id="bad" href="images/b.html" media-type="text/html"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'
  );
  zip.file("OPS/text/a.xhtml", doc('<p>Before</p><img src="../images/a.png"/><p>After</p>'));
  zip.file(
    "OPS/text/b.xhtml",
    doc(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="../images/a.png"/></svg><img src="../images/b.html"/><img src="https://example.com/a.png"/>'
    )
  );
  zip.file("OPS/images/a.png", new Uint8Array([1, 2, 3]));
  zip.file("OPS/images/b.html", "<script>bad</script>");
  const book = await parseEpub(await zip.generateAsync({ type: "uint8array" }), "en");
  assert.equal(book.chapters.length, 2);
  assert.deepEqual(book.chapters[1].paragraphs, []);
  assert.equal(book.chapters[1].blocks.length, 1);
  assert.equal(book.chapters[1].title, "插图 2");
  assert.deepEqual(Object.keys(book.assets), ["OPS/images/a.png"]);
  assert.equal(book.assets["OPS/images/a.png"].type, "image/png");
});

test("flow mapping gives images an anchor but no language tokens; URLs revoke on replacement", () => {
  const book = { assets: { a: new Blob(["image"], { type: "image/png" }) } };
  const pool = new BookImageUrls();
  pool.setBook(book);
  const url = pool.get("a");
  assert.ok(url.startsWith("blob:"));
  assert.equal(pool.get("a"), url);
  const chapter = {
    paragraphs: ["Before", "After"],
    blocks: [
      { kind: "p", text: "Before" },
      { kind: "img", src: "a" },
      { kind: "p", text: "After" },
    ],
  };
  const ann = chapter.paragraphs.map((text) => ({ text, tokens: [{ surface: text }] }));
  const { flow, orig } = chapterFlow(chapter, ann, (src) => pool.get(src));
  assert.deepEqual(orig, [0, -1, 1]);
  assert.equal(flow[0], ann[0]);
  assert.equal(flow[2], ann[1]);
  assert.equal(flow[1].tokens.length, 0);
  assert.equal(flowLength(flow[1]), 1);
  pool.setBook(null);
  assert.equal(pool.get("a"), undefined);
});
