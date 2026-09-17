import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractXhtml } from "../../packages/web/src/ingest/epub.ts";

const dom = new JSDOM();
globalThis.DOMParser = dom.window.DOMParser;
const xhtml = (body, title = "Chapter") =>
  `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;

describe("EPUB source extraction regressions", () => {
  it("preserves CDATA-only paragraphs and mixed text/CDATA runs", () => {
    assert.deepEqual(
      extractXhtml(
        xhtml(
          "<p><![CDATA[Visible prose & punctuation.]]></p><p>Before <![CDATA[inside]]> after.</p>"
        )
      ).paragraphs,
      ["Visible prose & punctuation.", "Before inside after."]
    );
  });

  it("keeps ruby bases but excludes fallback punctuation and all annotation containers", () => {
    const result = extractXhtml(
      xhtml(
        "<h1><ruby>日本<rt>にほん</rt></ruby></h1><p>「<ruby>日本<rp>（</rp><rt>にほん</rt><rp>）</rp></ruby>へ。」<ruby><rb>東</rb><rb>京</rb><rtc><rt>とう</rt><rt>きょう</rt></rtc><rtc>Tokyo</rtc></ruby></p>"
      )
    );
    assert.equal(result.title, "日本");
    assert.deepEqual(result.paragraphs, ["「日本へ。」東京"]);
  });

  it("emits nested blocks once in DOM order while leaving div-only prose unsupported", () => {
    assert.deepEqual(
      extractXhtml(
        xhtml(
          "<p>前。</p><blockquote>外側。<p>内側。</p>終端。</blockquote><div>DIV専用本文。</div><p>後。</p>"
        )
      ).paragraphs,
      ["前。", "外側。", "内側。", "終端。", "後。"]
    );
  });

  it("keeps list-item text around nested paragraphs exactly once", () => {
    assert.deepEqual(extractXhtml(xhtml("<ul><li>Before<p>Inside</p>After</li></ul>")).paragraphs, [
      "Before",
      "Inside",
      "After",
    ]);
  });

  it("keeps inline runs together and separates nested lists and sections", () => {
    assert.deepEqual(
      extractXhtml(
        xhtml(
          "<section><div><p>A <em>small</em> sentence.</p></div><ul><li>Outer<ul><li>Inner</li></ul>Tail</li><li>Next</li></ul></section>"
        )
      ).paragraphs,
      ["A small sentence.", "Outer", "Inner", "Tail", "Next"]
    );
  });

  it("retains heading deduplication, ignored furniture, and empty image-only extraction", () => {
    assert.deepEqual(
      extractXhtml(
        xhtml(
          "<nav><p>Nav</p></nav><h2>Chapter</h2><p>Chapter</p><p>Body</p><p>Body</p><style>style</style><script>script</script><footer>Footer</footer>"
        )
      ).paragraphs,
      ["Body"]
    );
    assert.deepEqual(
      extractXhtml(xhtml('<div><img src="picture.png" alt="Not rendered"/></div>')).paragraphs,
      []
    );
  });

  it("retains paragraph fragment fallback and tolerant HTML parsing", () => {
    assert.deepEqual(extractXhtml("<p>Fragment</p>").paragraphs, ["Fragment"]);
    assert.deepEqual(
      extractXhtml(
        "<html><body><p><ruby>日本<rp>(</rp><rt>にほん</rt><rp>)</rp></ruby>&nbsp;へ</p></body></html>"
      ).paragraphs,
      ["日本 へ"]
    );
  });
});
