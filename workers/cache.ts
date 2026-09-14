// workers/cache.ts — Track D: shared LLM-gloss read-through cache + selfcheck.
// Constraints (locked): Pages static + R2 dict shards + Workers cache ONLY, no DB.
// The BYOK key MUST NEVER pass through Workers (refused + e2e-sniffed).
//
// Key format (locked by web/prodiver tracks, see packages/web/src/lib/hash.ts):
//   wordCacheKey     = sha1hex(`${lang}|${target}|${lemma}|`)      -> 40 hex
//   sentenceCacheKey = sha1hex(`${lang}|${target}||${sentence}`)   -> 40 hex
// KEY_RE accepts 40-hex sha1 (current) and 64-hex sha256 (reserved). Anything
// else — notably apiKey material — is rejected with 400.
//
// R2 layout (locked by dict track, see packages/dict-loader/src/shard.mjs):
//   dict/{lang}/{shard}.json.br   (首2字符分片, prebuilt .br)
//   cache/{key}.json              (shared LLM-gloss spillover, this worker)
//
// Free-tier sizing: Workers 100k req/day; LRU cap 10_000 entries, 8KB body cap,
// 30d TTL. R2 10GB free; dict budget enforced by scripts/budget.mjs.

export interface Env {
  DICT: R2Bucket;
  VERSION?: string;
  // Optional durable hit-rate (Analytics Engine, free tier). Uncomment after:
  // `wrangler analytics-engine create ilr_zen` (see DEPLOY.md).
  // ZEN?: AnalyticsEngineDataset;
}

export const SOURCE_LANGS = ["en", "de", "fr", "it", "es", "ru", "ja"] as const;
export const TARGET_LANGS = ["zh", "en"] as const;
export const MODES = ["A", "B", "C"] as const;
export const MAX_ENTRIES = 10_000;
export const MAX_BODY_BYTES = 8 * 1024;
export const TTL_SECONDS = 30 * 24 * 3600;
// 40-hex sha1 (wordCacheKey/sentenceCacheKey) or 64-hex sha256 (reserved).
const KEY_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

interface Entry { value: unknown; exp: number }

// In-isolate LRU (per-colo hot cache). R2 backs it durably under cache/{key}.json.
const mem = new Map<string, Entry>();
let hits = 0;
let misses = 0;

function zen(kind: string, extra: Record<string, unknown> = {}) {
  // Zen log line for hit-rate dashboards (Logpush / workers logs).
  console.log(JSON.stringify({ zen: 1, kind, hits, misses, hitRate: hitRate(), ...extra }));
}

function hitRate(): number {
  const n = hits + misses;
  return n === 0 ? 0 : Math.round((hits / n) * 10000) / 10000;
}

function getMem(key: string): unknown | undefined {
  const e = mem.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now() / 1000) { mem.delete(key); return undefined; }
  mem.delete(key); mem.set(key, e); // LRU touch
  return e.value;
}

function setMem(key: string, value: unknown): void {
  if (mem.has(key)) mem.delete(key);
  while (mem.size >= MAX_ENTRIES) {
    const oldest = mem.keys().next().value as string;
    mem.delete(oldest);
  }
  mem.set(key, { value, exp: Date.now() / 1000 + TTL_SECONDS });
}

function bad(msg: string, status = 400): Response {
  return Response.json({ ok: false, error: msg }, { status });
}

async function handleCache(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const key = u.searchParams.get("key") ?? "";
  if (!KEY_RE.test(key)) {
    // Reject anything that is not an opaque hex cache key — this is also what
    // keeps apiKey material out (keys are hex digests, never tokens/secrets).
    return bad("key must be hex digest of lang|target|lemma|sentence (sha1 40 / sha256 64)", 400);
  }
  // Key-hygiene guard: refuse payloads/headers that smuggle secrets through us.
  const smuggled =
    req.headers.get("x-api-key") ?? req.headers.get("authorization") ?? "";
  if (smuggled) return bad("key material must not pass through Workers", 400);

  if (req.method === "GET") {
    const m = getMem(key);
    if (m !== undefined) { hits++; zen("cache_hit", { key: key.slice(0, 8) }); return Response.json({ hit: true, value: m, hitRate: hitRate() }); }
    try {
      const obj = await env.DICT.get(`cache/${key}.json`);
      if (obj) {
        const value = await obj.json();
        setMem(key, value);
        hits++; zen("cache_hit_r2", { key: key.slice(0, 8) });
        return Response.json({ hit: true, value, hitRate: hitRate() });
      }
    } catch { /* read-through miss */ }
    misses++; zen("cache_miss", { key: key.slice(0, 8) });
    return Response.json({ hit: false, hitRate: hitRate() });
  }

  if (req.method === "PUT") {
    let body: unknown;
    try { body = await req.json(); } catch { return bad("invalid JSON"); }
    const raw = JSON.stringify(body);
    if (raw.length > MAX_BODY_BYTES) return bad("body too large (8KB max)", 413);
    if (raw.match(/(sk-[A-Za-z0-9]|api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9])/i))
      return bad("key material must not pass through Workers", 400);
    const value = (body as { value?: unknown }).value;
    if (value === undefined) return bad("missing {value}");
    setMem(key, value);
    try {
      await env.DICT.put(`cache/${key}.json`, JSON.stringify({ value, exp: Date.now() / 1000 + TTL_SECONDS }), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (e) { console.log(JSON.stringify({ zen: 1, kind: "r2_put_failed", err: String(e) })); }
    zen("cache_put", { key: key.slice(0, 8) });
    return Response.json({ ok: true, hitRate: hitRate() });
  }
  return bad("method not allowed", 405);
}

export interface SelfCheck {
  version: string;
  langs: string[];
  targets: string[];
  modes: string[];
  shardsChecked: string[];
  shardsOk: string[];
  coverage: { note: string };
  cache: { hits: number; misses: number; hitRate: number; entries: number };
  freeTier: { workersReqDay: string; r2GB: string; ttlDays: number; maxEntries: number };
}

async function handleSelfCheck(env: Env): Promise<Response> {
  // Existence spot-check: list one object per lang prefix (cheap: 7 x limit:1).
  // Shard names follow 首2字符分片 so we ask R2 instead of hardcoding names.
  const shardsOk: string[] = [];
  const shardsChecked = SOURCE_LANGS.map((l) => `dict/${l}/`);
  await Promise.all(SOURCE_LANGS.map(async (l) => {
    try {
      const listed = await env.DICT.list({ prefix: `dict/${l}/`, limit: 1 });
      if (listed.objects.length > 0) shardsOk.push(`dict/${l}/`);
    } catch { /* missing */ }
  }));
  const body: SelfCheck = {
    version: env.VERSION ?? "0.1.0",
    langs: [...SOURCE_LANGS],
    targets: [...TARGET_LANGS],
    modes: [...MODES],
    shardsChecked,
    shardsOk,
    coverage: { note: "full per-term coverage runs in verify; see artifacts/verify-report.json" },
    cache: { hits, misses, hitRate: hitRate(), entries: mem.size },
    freeTier: { workersReqDay: "100k free", r2GB: "10 free", ttlDays: 30, maxEntries: MAX_ENTRIES },
  };
  zen("selfcheck", { ok: shardsOk.length, of: shardsChecked.length });
  return Response.json(body);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/cache") return handleCache(req, env);
    if (pathname === "/api/selfcheck") {
      if (req.method !== "GET") return bad("method not allowed", 405);
      return handleSelfCheck(env);
    }
    return bad("not found", 404);
  },
};

// Test hooks (pinned by tests/unit/worker-rules.test.mjs without a runtime).
export const __rules = { KEY_RE, MAX_ENTRIES, MAX_BODY_BYTES, TTL_SECONDS };
