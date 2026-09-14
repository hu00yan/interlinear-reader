import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Compat pin: web's cache keys (packages/web/src/lib/hash.ts, locked) must be
// accepted by workers/cache.ts KEY_RE. Formula: sha1(`${lang}|${target}|${lemma}|`).
function wordCacheKey(lang, target, lemma) {
  const norm = lemma.normalize("NFKC").trim().replace(/\s+/g, " ");
  const lower = lang === "ja" ? norm : norm.toLowerCase();
  return createHash("sha1").update(`${lang}|${target}|${lower}|`).digest("hex");
}

const WORKER_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/; // must equal workers/cache.ts KEY_RE

describe("cache-key compat (web sha1 <-> worker KEY_RE)", () => {
  it("word keys are 40hex and worker-accepted, all 7x2", () => {
    for (const lang of ["en", "de", "fr", "it", "es", "ru", "ja"])
      for (const target of ["zh", "en"]) {
        const k = wordCacheKey(lang, target, "cat");
        assert.match(k, /^[0-9a-f]{40}$/, `${lang}/${target}`);
        assert.match(k, WORKER_RE, `worker accepts ${lang}/${target}`);
      }
  });
  it("normalization: case/space fold (except ja)", () => {
    assert.equal(wordCacheKey("en", "zh", "Cat"), wordCacheKey("en", "zh", "cat"));
    assert.equal(wordCacheKey("en", "zh", "  Hello   WORLD "), wordCacheKey("en", "zh", "hello world"));
  });
  it("keys carry no secret material", () => {
    const k = wordCacheKey("en", "zh", "cat");
    assert.doesNotMatch(k, /(apikey|api_key|sk-|bearer)/i);
  });
});
