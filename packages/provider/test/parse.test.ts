import test from "node:test";
import assert from "node:assert/strict";
import { parseGlossContent, GlossParseError } from "../src/parse.ts";
import { enChapter } from "./helpers.ts";

test("parses canonical sentences shape", () => {
  const out = parseGlossContent(
    JSON.stringify({
      sentences: [
        { id: "s1", glosses: [{ i: 0, lemma: "cat", gloss: "猫" }] },
        { id: "s2", glosses: [{ i: 1, lemma: "bark", gloss: "吠" }] },
      ],
    }),
    enChapter(),
  );
  assert.equal(out["s1"][0].gloss, "猫");
  assert.equal(out["s1"][0].source, "llm");
  assert.equal(out["s2"][0].gloss, "吠");
});

test("parses record shape + fenced + prose-wrapped JSON", () => {
  const record = parseGlossContent(
    JSON.stringify({ s1: [{ i: 2, lemma: "mat", gloss: "垫子" }] }),
    enChapter(),
  );
  assert.equal(record["s1"][0].gloss, "垫子");

  const fenced = parseGlossContent(
    "```json\n" + JSON.stringify({ sentences: [{ id: "s1", glosses: [{ i: 0, lemma: "cat", gloss: "猫" }] }] }) + "\n```",
    enChapter(),
  );
  assert.equal(fenced["s1"][0].gloss, "猫");

  const prose = parseGlossContent(
    "Sure, here you go: " +
      JSON.stringify({ results: [{ id: "s2", glosses: [{ i: 0, lemma: "dog", gloss: "狗" }] }] }) +
      " hope that helps.",
    enChapter(),
  );
  assert.equal(prose["s2"][0].gloss, "狗");
});

test("falls back to plain-text lines for weak models", () => {
  const out = parseGlossContent("s1 | 0 | cat | 猫\ns1 | 1 | sit | 坐\n", enChapter());
  assert.equal(out["s1"].length, 2);
  assert.equal(out["s1"][0].gloss, "猫");
  assert.equal(out["s1"][1].gloss, "坐");
  assert.equal(out["s1"][0].source, "llm");
});

test("throws GlossParseError on garbage; ignores unknown ids; dedupes", () => {
  assert.throws(() => parseGlossContent("{{{oops not json", enChapter()), GlossParseError);
  const out = parseGlossContent(
    JSON.stringify({
      sentences: [
        {
          id: "s1",
          glosses: [
            { i: 0, lemma: "cat", gloss: "猫" },
            { i: 0, lemma: "cat", gloss: "猫2" },
          ],
        },
        { id: "nope", glosses: [{ i: 0, lemma: "x", gloss: "y" }] },
      ],
    }),
    enChapter(),
  );
  assert.equal(out["s1"].length, 1);
  assert.ok(!("nope" in out));
});
