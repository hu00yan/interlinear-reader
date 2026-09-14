import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CachedGlossStore,
  cacheKeyForSentence,
  cacheKeyForToken,
  getDefaultStore,
  IndexedDBCacheStore,
  MemoryCacheStore,
  normalizeSentenceText,
  RemoteSharedCache,
} from "../src/cache.ts";
import { startMockServer, type MockServer } from "../src/mock-server.ts";
import { TEST_KEY } from "./helpers.ts";

let mock: MockServer;
test("setup mock", async () => {
  mock = await startMockServer();
});
after(async () => {
  await mock?.close();
});

test("normalization collapses whitespace + NFKC, preserves case", () => {
  assert.equal(normalizeSentenceText("  hello\t\n  world  "), "hello world");
  assert.equal(normalizeSentenceText("ＡＢＣ"), "ABC");
  assert.equal(normalizeSentenceText("Λόγος"), "Λόγος");
});

test("token key is sha1(lang|target|lemma|normalized sentence)", () => {
  const key = cacheKeyForToken({
    lang: "en",
    target: "zh",
    lemma: "cat",
    sentenceText: "  The   cat sits. ",
  });
  const expected = createHash("sha1")
    .update("en|zh|cat|The cat sits.", "utf8")
    .digest("hex");
  assert.equal(key, expected);
  assert.match(key, /^[0-9a-f]{40}$/);
  // context-sensitive: same lemma elsewhere => other key
  assert.notEqual(
    key,
    cacheKeyForToken({ lang: "en", target: "zh", lemma: "cat", sentenceText: "A cat naps." }),
  );
  // sentence key differs from token key space
  assert.notEqual(
    key,
    cacheKeyForSentence({ lang: "en", target: "zh", sentenceText: "The cat sits." }),
  );
});

test("memory store round-trips and evicts oldest at capacity", async () => {
  const store = new MemoryCacheStore(2);
  assert.equal(await store.get("k1"), null);
  await store.set("k1", { gloss: "猫", lemma: "cat", cachedAt: 1 });
  assert.deepEqual(await store.get("k1"), { gloss: "猫", lemma: "cat", cachedAt: 1 });
  await store.set("k2", { gloss: "狗", lemma: "dog", cachedAt: 2 });
  await store.set("k3", { gloss: "鱼", lemma: "fish", cachedAt: 3 });
  assert.equal(store.size, 2);
  assert.equal(await store.get("k1"), null);
});

test("node default store is memory (IndexedDB unsupported)", () => {
  assert.equal(IndexedDBCacheStore.isSupported(), false);
  assert.ok(getDefaultStore() instanceof MemoryCacheStore);
  assert.throws(() => new IndexedDBCacheStore(), /unavailable/);
});

test("remote read-through + idempotent write-through, never authed", async () => {
  mock.reset();
  const remote = new RemoteSharedCache({ baseUrl: mock.origin });
  const writer = new CachedGlossStore({ local: new MemoryCacheStore(), remote });
  const key = cacheKeyForToken({
    lang: "en",
    target: "zh",
    lemma: "cat",
    sentenceText: "The cat sits.",
  });
  const entry = { gloss: "猫", lemma: "cat", cachedAt: Date.now() };

  assert.equal(await writer.get(key), null); // miss everywhere
  assert.deepEqual(await writer.set(key, entry), { remoteOk: true });
  assert.deepEqual(await writer.set(key, entry), { remoteOk: true }); // idempotent redo

  const reader = new CachedGlossStore({ local: new MemoryCacheStore(), remote });
  assert.deepEqual(await reader.get(key), entry); // served by remote, backfilled local
  assert.deepEqual(await reader.local.get(key), entry);

  const cacheReqs = mock.requests.filter((r) => r.path.startsWith("/v1/gloss-cache"));
  assert.ok(cacheReqs.length >= 4, `expected >=4 cache reqs, got ${cacheReqs.length}`);
  for (const r of cacheReqs) {
    assert.equal(r.hasAuth, false, `${r.method} ${r.path} must not carry Authorization`);
    assert.ok(!r.body.includes(TEST_KEY), "key material must not appear in cache traffic");
    assert.ok(!r.path.includes(TEST_KEY), "key material must not appear in cache URL");
  }
  // idempotent: one logical value despite two PUTs
  const puts = mock.cachePuts.filter((p) => p.key === key);
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[0].entry, puts[1].entry);
});

test("remote cache refuses key material in keys", async () => {
  const remote = new RemoteSharedCache({ baseUrl: mock.origin });
  await assert.rejects(remote.get(`en|zh|${TEST_KEY}|x`), /key material/);
});
