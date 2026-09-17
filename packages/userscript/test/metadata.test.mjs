import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("source and delivered metadata use Tampermonkey-supported HTTP(S) match patterns", async () => {
  const header = await readFile(new URL("header.txt", root), "utf8");
  const bundle = await readFile(new URL("dist/interlinear-reader.user.js", root), "utf8");
  for (const [name, text] of [
    ["header", header],
    ["bundle", bundle],
  ]) {
    const metadata = text.slice(0, text.indexOf("// ==/UserScript=="));
    const matches = [...metadata.matchAll(/^\/\/\s+@match\s+(\S+)\s*$/gm)].map((match) => match[1]);
    assert.ok(matches.length, `${name}: requires explicit match patterns`);
    for (const pattern of matches) {
      assert.match(
        pattern,
        /^(?:\*|https?):\/\/(?:\*|(?:\*\.)?[a-z\d.-]+)\/\S*$/i,
        `${name}: ${pattern} must use protocol://domain/path, not <all_urls>`
      );
    }
    assert.ok(matches.includes("*://*/*"), `${name}: covers ordinary HTTP and HTTPS pages`);
    assert.match(metadata, /^\/\/\s+@sandbox\s+DOM$/m);
    assert.match(metadata, /^\/\/\s+@grant\s+GM_getValue$/m);
  }
  assert.ok(bundle.startsWith(header), "delivered metadata must match its source");
});
