// End-to-end across all three modes against the mock OpenAI-compatible
// endpoint (Track D reuses this server for its own e2e).

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/client.ts";
import { CachedGlossStore, MemoryCacheStore, RemoteSharedCache } from "../src/cache.ts";
import { orchestrate } from "../src/modes.ts";
import { startMockServer, type MockServer } from "../src/mock-server.ts";
import { enChapter, mapDict, TEST_KEY } from "./helpers.ts";

let mock: MockServer;
test("setup mock", async () => {
  mock = await startMockServer();
});
after(async () => {
  await mock?.close();
});

function rig() {
  const cache = new CachedGlossStore({
    local: new MemoryCacheStore(),
    remote: new RemoteSharedCache({ baseUrl: mock.origin }),
  });
  const llm = createClient({
    baseUrl: mock.url,
    apiKey: TEST_KEY,
    model: "mock-model",
    baseDelayMs: 5,
  });
  const dict = mapDict({ cat: ["猫"], sit: ["坐"], dog: ["狗"], bark: ["吠"] });
  return { cache, llm, dict };
}

test("e2e: A taps, B stays offline, C batches the chapter", async () => {
  mock.reset();
  const { cache, llm, dict } = rig();

  // A: tap one sentence (unknown word 'mat' composed by the LLM)
  const a = await orchestrate({
    mode: "A",
    lang: "en",
    target: "zh",
    sentences: [enChapter()[0]],
    dict,
    cache,
    llm,
  });
  assert.equal(a.glosses["s1"][0].gloss, "MOCK:cat");
  assert.equal(a.glosses["s1"][2].gloss, "MOCK:mat");
  const afterA = mock.chatRequests.length;
  assert.equal(afterA, 1);

  // B: pure dict, zero HTTP to the model
  const b = await orchestrate({
    mode: "B",
    lang: "en",
    target: "zh",
    sentences: enChapter(),
    dict,
    cache,
    llm,
  });
  assert.equal(mock.chatRequests.length, afterA);
  assert.equal(b.glosses["s2"][0].source, "dict");
  assert.equal(b.glosses["s1"][0].source, "cache"); // A warmed it

  // C: whole chapter; s1+s2 fully cached, s3 is fresh and needs the model
  const s3 = {
    id: "s3",
    text: "Fish swim fast.",
    tokens: [
      { i: 0, surface: "Fish", lemma: "fish" },
      { i: 1, surface: "swim", lemma: "swim" },
    ],
  };
  const beforeC = mock.chatRequests.length;
  const c = await orchestrate({
    mode: "C",
    lang: "en",
    target: "zh",
    sentences: [...enChapter(), s3],
    dict,
    cache,
    llm,
    confirmChapter: (info) => info.sentenceCount === 3,
  });
  assert.equal(c.glosses["s2"][1].gloss, "吠"); // warmed by B, served from cache
  assert.equal(c.glosses["s2"][1].source, "cache");
  assert.equal(c.glosses["s3"][0].gloss, "MOCK:fish");
  assert.equal(c.glosses["s3"][1].gloss, "MOCK:swim");
  assert.equal(c.stats.sentences, 3);
  assert.equal(c.stats.fromLlm, 2);
  assert.equal(mock.chatRequests.length, beforeC + 1); // exactly one batch for s3

  // every gloss in every mode is assertable
  for (const r of [a, b, c]) {
    for (const items of Object.values(r.glosses)) {
      for (const g of items) assert.match(g.gloss, /^(MOCK:|猫|坐|狗|吠|mat|sit)/);
    }
  }
});
