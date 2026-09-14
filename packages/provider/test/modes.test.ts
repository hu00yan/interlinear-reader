import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/client.ts";
import { CachedGlossStore, MemoryCacheStore } from "../src/cache.ts";
import { orchestrate, UserAbortedError } from "../src/modes.ts";
import { startMockServer, type MockServer } from "../src/mock-server.ts";
import { enChapter, mapDict, throwingLlm, TEST_KEY } from "./helpers.ts";

let mock: MockServer;
test("setup mock", async () => {
  mock = await startMockServer();
});
after(async () => {
  await mock?.close();
});

const dict = () => mapDict({ cat: ["猫", "猫科动物"], sit: ["坐"], dog: ["狗"] });

function llm() {
  return createClient({
    baseUrl: mock.url,
    apiKey: TEST_KEY,
    model: "mock-model",
    baseDelayMs: 5,
  });
}

test("Mode B: dict + cache only, never touches the LLM", async () => {
  mock.reset();
  const bad = throwingLlm();
  const { glosses, stats } = await orchestrate({
    mode: "B",
    lang: "en",
    target: "zh",
    sentences: enChapter(),
    dict: dict(),
    cache: new MemoryCacheStore(),
    llm: bad,
  });
  assert.equal(bad.calls(), 0);
  assert.equal(mock.chatRequests.length, 0);
  assert.equal(glosses["s1"][0].gloss, "猫");
  assert.equal(glosses["s1"][0].source, "dict");
  // unknown word in pure-dict mode: lemma fallback flagged as miss
  assert.equal(glosses["s1"][2].dictMiss, true);
  assert.equal(glosses["s1"][2].gloss, "mat");
  assert.equal(stats.fromDict, 3);
  assert.equal(stats.dictMiss, 2);
});

test("Mode A: cache-first; misses (even dict-less) go straight to LLM", async () => {
  mock.reset();
  const cache = new CachedGlossStore({ local: new MemoryCacheStore() });
  const first = await orchestrate({
    mode: "A",
    lang: "en",
    target: "zh",
    sentences: [enChapter()[0]],
    dict: dict(),
    cache,
    llm: llm(),
  });
  // mat has no dict entry: straight to LLM composition, not dropped
  assert.equal(first.glosses["s1"].find((g) => g.lemma === "mat")?.gloss, "MOCK:mat");
  assert.equal(first.stats.fromLlm, 3);
  assert.equal(mock.chatRequests.length, 1);

  // second tap is fully cached: zero new LLM calls
  const second = await orchestrate({
    mode: "A",
    lang: "en",
    target: "zh",
    sentences: [enChapter()[0]],
    dict: dict(),
    cache,
    llm: llm(),
  });
  assert.equal(mock.chatRequests.length, 1);
  assert.equal(second.stats.fromCache, 3);
  assert.equal(second.stats.fromLlm, 0);
  assert.equal(second.glosses["s1"][0].source, "cache");
});

test("Mode C: refusal aborts before any LLM spend", async () => {
  mock.reset();
  const bad = throwingLlm();
  await assert.rejects(
    orchestrate({
      mode: "C",
      lang: "en",
      target: "zh",
      sentences: enChapter(),
      dict: dict(),
      cache: new MemoryCacheStore(),
      llm: bad,
      confirmChapter: () => false,
    }),
    UserAbortedError,
  );
  assert.equal(bad.calls(), 0);
  assert.equal(mock.chatRequests.length, 0);
});

test("Mode C: confirm + per-chapter cap + progress + cache write", async () => {
  mock.reset();
  const seen: Array<{ sentenceCount: number; tokenCount: number }> = [];
  const progress: Array<[number, number]> = [];
  const chapter = [...enChapter(), ...enChapter(), ...enChapter()].map((s, k) => ({
    ...s,
    id: `c${k}`,
  }));
  const cache = new CachedGlossStore({ local: new MemoryCacheStore() });
  const { glosses, stats } = await orchestrate({
    mode: "C",
    lang: "en",
    target: "zh",
    sentences: chapter,
    dict: dict(),
    cache,
    llm: llm(),
    confirmChapter: (info) => {
      seen.push({ sentenceCount: info.sentenceCount, tokenCount: info.tokenCount });
      return true;
    },
    maxSentencesPerChapter: 4,
    batchSize: 2,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(stats.truncated, 2);
  assert.equal(stats.sentences, 4);
  assert.deepEqual(seen, [{ sentenceCount: 4, tokenCount: 10 }]);
  assert.deepEqual(progress[progress.length - 1], [4, 4]);
  assert.equal(glosses["c0"][0].gloss, "MOCK:cat");
  assert.ok(stats.fromLlm > 0);

  // rerun the kept prefix: served from cache, no new chat requests
  const before = mock.chatRequests.length;
  const again = await orchestrate({
    mode: "C",
    lang: "en",
    target: "zh",
    sentences: chapter.slice(0, 4),
    dict: dict(),
    cache,
    llm: llm(),
    confirmChapter: () => true,
  });
  assert.equal(mock.chatRequests.length, before);
  assert.equal(again.stats.fromLlm, 0);
});
