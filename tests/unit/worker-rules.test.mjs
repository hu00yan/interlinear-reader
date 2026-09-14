import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pins workers/cache.ts pure rules without a Workers runtime. The .ts source is
// authoritative; this test fails on drift (extracts constants by regex).
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(root, "workers/cache.ts"), "utf8");

describe("worker rules mirror", () => {
  it("KEY_RE accepts sha1-40 + sha256-64, rejects secrets", () => {
    assert.ok(src.includes("/^([0-9a-f]{40}|[0-9a-f]{64})$/"), "workers/cache.ts:KEY_RE");
    const re = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
    assert.match("a".repeat(40), re);
    assert.match("b".repeat(64), re);
    assert.doesNotMatch("sk-test-harness-key", re);
    assert.doesNotMatch("Bearer abc", re);
  });
  it("free-tier caps pinned", () => {
    const m = src.match(/MAX_ENTRIES = ([\d_]+)/);
    assert.ok(m, "MAX_ENTRIES");
    assert.equal(m[1].replaceAll("_", ""), "10000");
    assert.ok(src.includes("MAX_BODY_BYTES = 8 * 1024"), "MAX_BODY_BYTES");
    assert.ok(src.includes("TTL_SECONDS = 30 * 24 * 3600"), "TTL_SECONDS");
  });
  it("routes exist", () => {
    assert.ok(src.includes('"/api/cache"'), "GET/PUT /api/cache");
    assert.ok(src.includes('"/api/selfcheck"'), "GET /api/selfcheck");
  });
  it("hygiene guards exist", () => {
    assert.ok(src.includes("x-api-key"), "x-api-key guard");
    assert.ok(src.includes("authorization"), "authorization guard");
    assert.ok(src.includes("must not pass through Workers"), "refusal message");
  });
  it("langs/modes match locked contract (7x2 + A/B/C)", () => {
    for (const l of ["en", "de", "fr", "it", "es", "ru", "ja"]) assert.ok(src.includes(`"${l}"`), `lang ${l}`);
    for (const m of ['"A"', '"B"', '"C"']) assert.ok(src.includes(m), `mode ${m}`);
    assert.ok(src.includes('"zh"'), "target zh");
  });
});
