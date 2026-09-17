import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseEpub } from "../../packages/web/src/ingest/epub.ts";
import { buildEpubBlob, buildEpubFiles } from "../../packages/web/src/export/epub.ts";

const dom = new JSDOM();
globalThis.DOMParser = dom.window.DOMParser;

const pngBook = () => ({
  title: "Roundtrip Images",
  lang: "en",
  source: "fixture",
  assets: {
    "art/inline.png": new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
  },
  chapters: [
    {
      id: "ch1",
      title: "插图 1",
      paragraphs: [],
      blocks: [{ kind: "img", src: "art/inline.png", alt: "Cover" }],
    },
    {
      id: "ch2",
      title: "Mixed",
      paragraphs: ["Before words.", "After words."],
      blocks: [
        { kind: "p", text: "Before words." },
        { kind: "img", src: "art/inline.png", alt: "Inline" },
        { kind: "p", text: "After words." },
      ],
    },
  ],
});

test("buildEpubFiles emits image-only chapter XHTML with a chapter-relative img src", async () => {
  const files = await buildEpubFiles(pngBook(), [[], []], "zh");
  const ch1 = String(files.get("OEBPS/ch1.xhtml"));
  assert.match(
    ch1,
    /<img src="images\/img1\.png" alt="Cover"/,
    "image-only chapter must emit its img, relative to OEBPS/"
  );
});

test("export with images re-imports: block order and asset bytes survive the round trip", async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const book = pngBook();
  book.assets["art/inline.png"] = new Blob([png], { type: "image/png" });

  const { blob } = await buildEpubBlob(book, [[], []], "zh");
  const back = await parseEpub(new File([blob], "rt.epub"), "en");

  assert.equal(back.chapters.length, 2, "image-only chapter survives in TOC");
  const [only, mixed] = back.chapters;
  assert.deepEqual(only.paragraphs, []);
  assert.equal(only.blocks?.length, 1);
  assert.equal(only.blocks[0].kind, "img");

  assert.deepEqual(
    mixed.blocks?.map((b) => b.kind),
    ["p", "img", "p"],
    "text→img→text reading order preserved"
  );
  assert.deepEqual(mixed.paragraphs, ["Before words.", "After words."]);

  const assets = Object.entries(back.assets ?? {});
  assert.equal(assets.length, 1, "exactly one image asset, unresolved refs dropped");
  const [src, asset] = assets[0];
  assert.ok(src.endsWith(".png"), `asset path resolved against OPF base: ${src}`);
  assert.equal(asset.type, "image/png");
  assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), png, "asset bytes identical");

  // Inspect the REAL zip layout (blob.text() is compressed bytes, useless for OPF checks).
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const names = Object.keys(zip.files).sort();
  assert.ok(
    names.includes("OEBPS/images/img1.png"),
    `image entry in zip, got: ${names.join(", ")}`
  );
  const opf = await zip.file("OEBPS/content.opf").async("text");
  assert.ok(opf.includes('media-type="image/png"'), `OPF declares the image: ${opf}`);
  assert.ok(opf.includes('href="images/img1.png"'), "OPF href matches the packaged entry");
});
