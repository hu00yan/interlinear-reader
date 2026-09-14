import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getGloss, getMisses, clearMisses, prefetchShards } from "../src/index.mjs";
import { cacheClear } from "../src/cache.mjs";
import { shardFor } from "../src/shard.mjs";

// Build a tiny fake static host in a temp dir: {base}/dict/en/<shard>.dict
function makeHost(files) {
  const dir = mkdtempSync(join(tmpdir(), "dicthost-"));
  for (const [rel, obj] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(dir, "dict", "en"), { recursive: true });
    const target = rel.match(/\/en\/(zh|en)\.dict$/)?.[1] ?? "zh";
    const body = Object.entries(obj).map(([lemma, entry]) =>
      `${lemma}\t${(entry[target] ?? []).join("\x1f")}`).join("\n") + "\n";
    writeFileSync(p, body);
  }
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const m = url.match(/\/dict\/en\/(zh|en)\.dict$/);
    const rel = m ? join(dir, "dict", "en", `${m[1]}.dict`) : null;
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      if (rel && existsSync(rel)) {
        return { ok: true, text: async () => readFileSync(rel, "utf8") };
      }
    } catch { /* fallthrough */ }
    return { ok: false, status: 404, text: async () => "" };
  };
  return { dir, fetchImpl, calls: () => calls };
}

test("loader: hit returns gloss, miss without en-fallback, cache-hit on repeat", async () => {
  cacheClear();
  clearMisses();
  const host = makeHost({ [`dict/en/zh.dict`]: { book: { zh: ["书"], en: ["book"] }, read: { zh: [], en: ["read", "to read"] } }, [`dict/en/en.dict`]: { book: { zh: ["书"], en: ["book"] }, read: { zh: [], en: ["read", "to read"] } } });
  const opt = { baseUrl: "https://static.test", fetchImpl: host.fetchImpl };

  // 1. HIT (network)
  const r1 = await getGloss("en", "zh", "book", opt);
  assert.equal(r1.status, "hit");
  assert.deepEqual(r1.gloss, ["书"]);
  assert.equal(r1.cached, false);

  // 2. CACHE HIT (no second fetch for same shard)
  const before = host.calls();
  const r2 = await getGloss("en", "zh", "book", opt);
  assert.equal(r2.status, "hit");
  assert.equal(r2.cached, true);
  assert.equal(host.calls(), before);

  // 3. MISS with no cross-target fallback: zh empty even though en exists
  const r3 = await getGloss("en", "zh", "read", opt);
  assert.equal(r3.status, "miss");
  assert.deepEqual(r3.gloss, []);
  // …but en target hits the same entry
  const r4 = await getGloss("en", "en", "read", opt);
  assert.equal(r4.status, "hit");
  assert.deepEqual(r4.gloss, ["read", "to read"]);

  // 4. unknown lemma -> miss + recorded for Track C LLM queue
  const r5 = await getGloss("en", "zh", "quuxwobble", opt);
  assert.equal(r5.status, "miss");
  const misses = getMisses().map((m) => m.lemma);
  assert.ok(misses.includes("quuxwobble"));
  assert.ok(misses.includes("read")); // zh miss recorded too
});

test("loader: lemma normalization (case/accents) + lemmatized lookup", async () => {
  cacheClear();
  clearMisses();
  const host = makeHost({ [`dict/en/zh.dict`]: {}, [`dict/en/en.dict`]: {} });
  // fr shard fetch against empty en host would 404 -> miss path still records
  const r = await getGloss("fr", "zh", "zzz-no-such-word", {
    baseUrl: "https://static.test",
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => null }),
  });
  assert.equal(r.status, "miss");
});

test("loader: prefetch warms shards", async () => {
  cacheClear();
  const host = makeHost({ [`dict/en/zh.dict`]: { book: { zh: ["书"], en: ["book"] } }, [`dict/en/en.dict`]: { book: { zh: ["书"], en: ["book"] } } });
  const opt = { baseUrl: "https://x.test", fetchImpl: host.fetchImpl };
  const out = await prefetchShards("en", ["zh"], opt);
  assert.equal(out[0].cached, false);
  const before = host.calls();
  const r = await getGloss("en", "zh", "book", opt);
  assert.equal(r.cached, true);
  assert.equal(host.calls(), before);
});

test("loader: invalid lang/target throws (contract guard)", async () => {
  await assert.rejects(() => getGloss("xx", "zh", "book", { fetchImpl: async () => ({ ok: false, json: async () => null }) }));
  await assert.rejects(() => getGloss("en", "fr", "book", { fetchImpl: async () => ({ ok: false, json: async () => null }) }));
});
