import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../src/client.ts";
import { CachedGlossStore, MemoryCacheStore, RemoteSharedCache } from "../src/cache.ts";
import { orchestrate } from "../src/modes.ts";
import {
  containsKeyMaterial,
  redactApiKeyText,
  sanitizeForLog,
} from "../src/redact.ts";
import { startMockServer, type MockServer } from "../src/mock-server.ts";
import { enChapter, mapDict, TEST_KEY } from "./helpers.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let mock: MockServer;
test("setup mock", async () => {
  mock = await startMockServer();
});
after(async () => {
  await mock?.close();
});

test("provider sources never reference browser key storage", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(join(SRC, f), "utf8");
    if (/localStorage|sessionStorage/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("provider never writes the apiKey to any storage during full flows", async () => {
  mock.reset();
  const writes: string[] = [];
  const spyStorage = {
    getItem: () => null,
    setItem: (k: string, v: string) => {
      writes.push(`${k}=${v}`);
    },
    removeItem: () => {},
  };
  const g = globalThis as Record<string, unknown>;
  const prevLocal = g["localStorage"];
  const prevSession = g["sessionStorage"];
  g["localStorage"] = spyStorage;
  g["sessionStorage"] = spyStorage;
  try {
    const cache = new CachedGlossStore({
      local: new MemoryCacheStore(),
      remote: new RemoteSharedCache({ baseUrl: mock.origin }),
    });
    const client = createClient({
      baseUrl: mock.url,
      apiKey: TEST_KEY,
      model: "m",
      baseDelayMs: 5,
    });
    await orchestrate({
      mode: "A",
      lang: "en",
      target: "zh",
      sentences: enChapter(),
      dict: mapDict({ cat: ["猫"] }),
      cache,
      llm: client,
    });
    assert.deepEqual(writes, []);
    // cache at rest holds no key material either
    for (const [k, v] of cache.local.entries()) {
      assert.equal(containsKeyMaterial(k), false);
      assert.equal(containsKeyMaterial(JSON.stringify(v)), false);
    }
  } finally {
    if (prevLocal === undefined) delete g["localStorage"];
    else g["localStorage"] = prevLocal;
    if (prevSession === undefined) delete g["sessionStorage"];
    else g["sessionStorage"] = prevSession;
  }
});

test("own-domain (shared cache) traffic never carries the apiKey", async () => {
  mock.reset();
  const remote = new RemoteSharedCache({ baseUrl: mock.origin });
  const store = new CachedGlossStore({ local: new MemoryCacheStore(), remote });
  const entry = { gloss: "猫", lemma: "cat", cachedAt: Date.now() };
  await store.set("k1", entry);
  await store.get("k1"); // local hit: no remote traffic
  await store.get("missing"); // remote GET -> 404
  await store.get("missing"); // remote GET -> 404 again (nothing cached)
  const own = mock.requests.filter((r) => r.path.startsWith("/v1/gloss-cache"));
  assert.ok(own.length >= 3);
  for (const r of own) {
    assert.equal(r.hasAuth, false, `${r.method} ${r.path}`);
    assert.ok(!r.body.includes(TEST_KEY));
    assert.ok(!r.path.includes(encodeURIComponent(TEST_KEY)));
  }
});

test("client events and logs are redacted", async () => {
  mock.reset();
  const events: unknown[] = [];
  const client = createClient({
    baseUrl: mock.url,
    apiKey: TEST_KEY,
    model: "m",
    baseDelayMs: 5,
    onEvent: (e) => events.push(e),
  });
  await client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) });
  assert.ok(!JSON.stringify(events).includes(TEST_KEY));

  assert.equal(containsKeyMaterial(`Authorization: Bearer ${TEST_KEY}`), true);
  assert.equal(containsKeyMaterial("nothing secret here"), false);
  const redacted = redactApiKeyText(`key=${TEST_KEY} and Bearer ${TEST_KEY} ok`);
  assert.ok(!redacted.includes(TEST_KEY));
  assert.match(redacted, /\*\*\*REDACTED\*\*\*/);

  const clean = sanitizeForLog({
    authorization: `Bearer ${TEST_KEY}`,
    nested: { apiKey: TEST_KEY, gloss: "猫" },
    list: [`Bearer ${TEST_KEY}`],
  }) as Record<string, unknown>;
  assert.ok(!JSON.stringify(clean).includes(TEST_KEY));
  assert.equal((clean["nested"] as Record<string, unknown>)["gloss"], "猫");
});
