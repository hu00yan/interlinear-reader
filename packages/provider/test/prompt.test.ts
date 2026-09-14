import test from "node:test";
import assert from "node:assert/strict";
import { buildGlossMessages } from "../src/prompt.ts";
import { enChapter } from "./helpers.ts";

test("prompt embeds candidate glosses for choice-style disambiguation", () => {
  const sentences = enChapter();
  sentences[0].tokens[0].candidates = [
    { gloss: "猫", pos: "n." },
    { gloss: "猫科动物", source: "dict-b" },
  ];
  const { system, user } = buildGlossMessages({ lang: "en", target: "zh", sentences });
  assert.match(system, /CANDIDATES/);
  assert.match(system, /unknown to our dictionary/i);
  const payload = JSON.parse(user) as {
    lang: string;
    target: string;
    sentences: Array<{ id: string; tokens: Array<{ candidates: string[] }> }>;
  };
  assert.equal(payload.lang, "en");
  assert.equal(payload.target, "zh");
  assert.deepEqual(payload.sentences[0].tokens[0].candidates, ["猫 (n.)", "猫科动物"]);
  // candidate-less token => empty list (straight LLM composition)
  assert.deepEqual(payload.sentences[0].tokens[1].candidates, []);
});

test("prompt declares the strict JSON contract", () => {
  const { system } = buildGlossMessages({ lang: "en", target: "zh", sentences: enChapter() });
  assert.match(system, /strict JSON only/);
  assert.match(system, /"sentences"/);
});
