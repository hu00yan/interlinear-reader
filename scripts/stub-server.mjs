// Local harness server for `npm run verify`: serves the REAL web build
// (packages/web/dist) + dict shards (public/dict) + fixtures, and stubs:
//   /api/cache, /api/selfcheck  (same rules as workers/cache.ts)
//   /mock-llm/chat/completions  (deterministic flat lemma->gloss JSON that the
//                                real provider parser accepts; records auth)
// No network, no R2, no wrangler, zero LLM spend.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages/web/dist");
const dictRoot = join(root, "public/dict");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".dict": "text/plain; charset=utf-8", ".epub": "application/epub+zip", ".txt": "text/plain",
};
const KEY_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const mem = new Map();
let hits = 0, misses = 0;
const hitRate = () => (hits + misses === 0 ? 0 : Math.round((hits / (hits + misses)) * 10000) / 10000);

export const mockLlmRequests = []; // shared with e2e via /mock-llm/__requests

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function serveFile(res, path) {
  try {
    const data = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}

export function createStubServer(port = 0) {
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");

    // ---- deterministic mock LLM (OpenAI-compatible subset) ----
    if (u.pathname === "/mock-llm/chat/completions" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      const hasAuth = "authorization" in req.headers;
      mockLlmRequests.push({ path: u.pathname, hasAuth, body: raw.slice(0, 2000) });
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      // provider 式 glossBatch（质量金标用）：user content 为 {lang,target,sentences:[{id,tokens:[{i,lemma}]}]}
      try {
        const body = JSON.parse(raw);
        const user = (body.messages ?? []).filter((m) => m.role === "user").at(-1)?.content ?? "";
        let payload = null;
        try { payload = JSON.parse(user); } catch {
          const a = user.indexOf("{");
          const b = user.lastIndexOf("}");
          if (a >= 0 && b > a) { try { payload = JSON.parse(user.slice(a, b + 1)); } catch { /* web 协议见下 */ } }
        }
        if (payload && Array.isArray(payload.sentences) && payload.sentences.length > 0) {
          const sentences = payload.sentences
            .filter((s) => typeof s?.id === "string" && Array.isArray(s?.tokens))
            .map((s) => ({
              id: s.id,
              glosses: s.tokens
                .filter((t) => Number.isInteger(t?.i))
                .map((t) => ({ i: t.i, lemma: String(t.lemma ?? t.surface ?? ""), gloss: `MOCK:${String(t.lemma ?? t.surface ?? "")}` })),
            }));
          return json(res, 200, {
            id: "chatcmpl-harness", object: "chat.completion", model: "mock",
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ sentences }) }, finish_reason: "stop" }],
            usage,
          });
        }
      } catch { /* fall through to web 协议 */ }
      // web 式 glossSentence（Lemmas 协议）
      let lemmas = [];
      try {
        const body = JSON.parse(raw);
        const user = (body.messages ?? []).filter((m) => m.role === "user").at(-1)?.content ?? "";
        const m = user.match(/Lemmas:\s*(\[.*?\])/s);
        if (m) lemmas = JSON.parse(m[1]);
      } catch { /* -> empty map */ }
      const glosses = {};
      for (const l of lemmas) glosses[l] = `MOCK:${l}`;
      return json(res, 200, {
        id: "chatcmpl-harness", object: "chat.completion", model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(glosses) }, finish_reason: "stop" }],
        usage,
      });
    }
    if (u.pathname === "/mock-llm/models") {
      mockLlmRequests.push({ path: u.pathname, hasAuth: "authorization" in req.headers, body: "" });
      return json(res, 200, { data: [{ id: "mock" }] });
    }
    if (u.pathname === "/mock-llm/__requests") return json(res, 200, mockLlmRequests);
    if (u.pathname === "/mock-llm/__reset" && req.method === "POST") {
      mockLlmRequests.length = 0;
      return json(res, 200, { ok: true });
    }

    // ---- shared-cache stub (workers/cache.ts rules) ----
    if (u.pathname === "/api/cache") {
      const key = u.searchParams.get("key") ?? "";
      if (!KEY_RE.test(key)) return json(res, 400, { ok: false, error: "key must be hex digest (sha1 40 / sha256 64)" });
      if (req.headers["x-api-key"] || req.headers.authorization)
        return json(res, 400, { ok: false, error: "key material must not pass through Workers" });
      if (req.method === "GET") {
        if (mem.has(key)) { hits++; return json(res, 200, { hit: true, value: mem.get(key), hitRate: hitRate() }); }
        misses++;
        return json(res, 200, { hit: false, hitRate: hitRate() });
      }
      if (req.method === "PUT") {
        let raw = "";
        for await (const c of req) raw += c;
        if (raw.length > 8 * 1024) return json(res, 413, { ok: false, error: "body too large (8KB max)" });
        if (/(sk-[A-Za-z0-9]|api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9])/i.test(raw))
          return json(res, 400, { ok: false, error: "key material must not pass through Workers" });
        let body; try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: "invalid JSON" }); }
        if (body.value === undefined) return json(res, 400, { ok: false, error: "missing {value}" });
        if (mem.size >= 10_000) mem.delete(mem.keys().next().value);
        mem.set(key, body.value);
        return json(res, 200, { ok: true, hitRate: hitRate() });
      }
      return json(res, 405, { ok: false, error: "method not allowed" });
    }
    if (u.pathname === "/api/selfcheck") {
      const langs = ["en", "de", "fr", "it", "es", "ru", "ja"];
      const ok = [];
      for (const l of langs) {
        try {
          const files = await readdir(join(dictRoot, l));
          if (files.some((f) => f.endsWith(".dict"))) ok.push(`dict/${l}/`);
        } catch { /* missing */ }
      }
      return json(res, 200, {
        version: "0.1.0", langs, targets: ["zh", "en"], modes: ["A", "B", "C"],
        shardsChecked: langs.map((l) => `dict/${l}/`), shardsOk: ok,
        coverage: { note: "full per-term coverage runs in verify; see artifacts/verify-report.json" },
        cache: { hits, misses, hitRate: hitRate(), entries: mem.size },
        freeTier: { workersReqDay: "100k free", r2GB: "10 free", ttlDays: 30, maxEntries: 10000 },
      });
    }

    // ---- static: web dist first, then dict shards, then fixtures ----
    const rel = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    const candidates = [
      join(dist, rel),
      join(dictRoot, rel.replace(/^dict\//, "")),
      join(root, "tests/fixtures", rel.replace(/^fixtures\//, "")),
      join(dist, "index.html"), // SPA fallback (no client routing, but safe)
    ];
    for (const p of candidates) {
      const n = normalize(p);
      const allowed = [dist, dictRoot, join(root, "tests/fixtures")].some((a) => n === a || n.startsWith(a + "/"));
      if (!allowed) continue;
      if (existsSync(n) && !n.endsWith("/")) return serveFile(res, n);
      // serve precompressed .br transparently like R2/Pages would
      if (existsSync(n + ".br")) {
        try {
          const data = await readFile(n + ".br");
          const { brotliDecompressSync } = await import("node:zlib");
          res.writeHead(200, { "content-type": MIME[extname(n)] ?? "application/octet-stream" });
          res.end(brotliDecompressSync(data));
          return;
        } catch { /* fall through */ }
      }
    }
    res.writeHead(404); res.end("not found");
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve(srv)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const srv = await createStubServer(5173);
  console.log(`stub on http://127.0.0.1:${srv.address().port} (dist=${dist})`);
}
