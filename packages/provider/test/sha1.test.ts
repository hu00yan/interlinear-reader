import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha1Hex } from "../src/sha1.ts";

test("sha1 matches node:crypto vectors", () => {
  const vectors = [
    "",
    "abc",
    "lang|target|lemma|sentence",
    "en|zh|cat|The cat sits.",
    "el|zh|λόγος|Ἐν ἀρχῇ ἦν ὁ λόγος",
    "a".repeat(1000),
  ];
  for (const v of vectors) {
    const expected = createHash("sha1").update(v, "utf8").digest("hex");
    assert.equal(sha1Hex(v), expected, JSON.stringify(v.slice(0, 32)));
  }
});

test("sha1 output is 40 lowercase hex chars", () => {
  assert.match(sha1Hex("x"), /^[0-9a-f]{40}$/);
});
