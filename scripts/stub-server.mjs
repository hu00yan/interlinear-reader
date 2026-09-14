// Local harness server for `npm run verify`: serves the REAL web build
// (packages/web/dist) + dict shards (public/dict) + fixtures, and stubs:
//   /mock-llm/chat/completions  (deterministic flat lemma->gloss JSON that the
//                                real provider parser accepts; records auth)
// No network, no Worker, zero LLM spend. R2 公开桶只在生产兜底里出现，
// 本地 harness 不碰（同源整包/分片即全量）。
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
        // 两种 sentences 协议共存：
        // - provider golden（packages/provider）：sentences:[{id,tokens:[{i,lemma}]}] → 回 glosses:[{i,lemma,gloss}]
        // - web 批量（glossBatchPage，A/C 模式回填）：sentences:[{id,text,lemmas:[...]}] → 回 {id:{lemma:gloss}}
        if (payload && Array.isArray(payload.sentences) && payload.sentences.length > 0) {
          if (payload.sentences.some((s) => Array.isArray(s?.lemmas))) {
            const mapped = {};
            for (const s of payload.sentences) {
              if (typeof s?.id !== "string" || !Array.isArray(s.lemmas)) continue;
              const m = {};
              for (const l of s.lemmas) m[String(l)] = `MOCK:${String(l).toLowerCase()}`;
              mapped[s.id] = m;
            }
            return json(res, 200, {
              id: "chatcmpl-harness", object: "chat.completion", model: "mock",
              choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(mapped) }, finish_reason: "stop" }],
              usage,
            });
          }
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
