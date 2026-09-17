import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  eligible,
  tokenize,
  annotate,
  restore,
  intact,
  parseDict,
  endpointURL,
  batches,
} from "../src/core.mjs";
import { boundedCache } from "../src/network.mjs";

test("annotation restores original node identity and never removes site edits", () => {
  const dom = new JSDOM("<article><p>猫は本を読む。 Hello world.</p><a>link</a></article>");
  const p = dom.window.document.querySelector("p");
  const original = p.firstChild;
  const record = annotate(original, tokenize(original.data));
  assert.equal(intact(record), true);
  assert.ok(record.host.shadowRoot.querySelector(".ilr-gloss"));
  original.data = "site updated text";
  const extra = dom.window.document.createElement("em");
  extra.textContent = "added by site";
  record.host.append(extra);
  restore([record]);
  assert.equal(p.firstChild, original);
  assert.equal(p.lastChild, extra);
  assert.equal(p.textContent, "site updated textadded by site");
});

test("skip selectors and hidden ancestors", () => {
  const dom = new JSDOM(
    '<main><p>visible</p><input value="secret"><textarea>secret</textarea><code>secret</code><div contenteditable><span>secret</span></div><div style="display:none"><p>secret</p></div><div hidden>secret</div><script>secret</script><style>.fixture { color: black; }</style><ruby>secret</ruby></main>'
  );
  const walker = dom.window.document.createTreeWalker(dom.window.document.body, 4);
  const accepted = [];
  while (walker.nextNode())
    if (eligible(walker.currentNode)) accepted.push(walker.currentNode.data);
  assert.deepEqual(accepted, ["visible"]);
});

test("tokenizer preserves punctuation and whitespace, including fallback", () => {
  for (const segmenter of [Intl.Segmenter, null]) {
    const text = "猫は本。 Hello, world!\n";
    assert.equal(
      tokenize(text, segmenter)
        .map((t) => t.text)
        .join(""),
      text
    );
  }
});

test("dictionary parsing accepts pair format, rejects HTML/binary, selects first sense", () => {
  assert.equal(parseDict("猫\t猫\x1f小猫\n").get("猫"), "猫");
  assert.throws(() => parseDict("<html>not data</html>"));
  assert.throws(() => parseDict("\ufffd\tbad"));
});

test("GM cache is bounded and LRU ordered even for oversize pairs", () => {
  const first = { lang: "ja", text: "a".repeat(100), at: 1, used: 1 };
  const second = { lang: "en", text: "b".repeat(100), at: 2, used: 2 };
  assert.deepEqual(boundedCache([first], second, 400), [second]);
  assert.deepEqual(boundedCache([first], { ...second, text: "x".repeat(400) }, 400), []);
});

test("endpoint and batching policy", () => {
  assert.equal(endpointURL("https://example.com/v1/"), "https://example.com/v1");
  assert.equal(endpointURL("http://127.0.0.1:5200/v1"), "http://127.0.0.1:5200/v1");
  for (const raw of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/?key=x",
    "javascript:alert(1)",
  ])
    assert.throws(() => endpointURL(raw));
  assert.equal(batches(Array.from({ length: 25 }, () => ({ text: "abc" }))).length, 2);
});
