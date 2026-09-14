// Local mock OpenAI-compatible endpoint for Track D e2e + our own tests.
// Deterministic: every token glosses as `MOCK:<lemma>` (or a custom prefix).
// Doubles as the "own domain" shared-cache endpoint so security tests can prove
// the apiKey never arrives there. Node-only (uses node:http).

import http from "node:http";

export type MockBehavior =
  | "ok"
  | "invalid-json"
  | "plain-text"
  | "reject-json"
  | "error500"
  | "unauthorized"
  | "flaky-once"
  | "slow";

export interface RecordedRequest {
  method: string;
  path: string;
  /** Authorization header present (value never stored). */
  hasAuth: boolean;
  headerNames: string[];
  body: string;
}

export interface MockServerOptions {
  port?: number;
  defaultBehavior?: MockBehavior;
  /** Delay for "slow" behavior. Default 1500ms. */
  delayMs?: number;
  /** Gloss template. Default "MOCK:<lemma>". */
  glossPrefix?: string;
}

export interface MockServer {
  /** Origin + /v1, usable as an LLM baseUrl. */
  url: string;
  /** Bare origin, usable as an own-domain (shared-cache) baseUrl. */
  origin: string;
  port: number;
  requests: RecordedRequest[];
  chatRequests: RecordedRequest[];
  cachePuts: Array<{ key: string; entry: unknown }>;
  setDefaultBehavior(b: MockBehavior): void;
  reset(): void;
  close(): Promise<void>;
}

interface TokenRef {
  i: number;
  lemma: string;
}

function extractSentences(bodyText: string): Array<{ id: string; tokens: TokenRef[] }> {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return [];
  }
  if (typeof body !== "object" || body === null) return [];
  const messages = (body as Record<string, unknown>)["messages"];
  if (!Array.isArray(messages)) return [];
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k] as Record<string, unknown>;
    if (m["role"] !== "user" || typeof m["content"] !== "string") continue;
    const payload = tryParseLoose(m["content"] as string);
    if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>)["sentences"])) {
      const out: Array<{ id: string; tokens: TokenRef[] }> = [];
      for (const s of (payload as Record<string, any>)["sentences"]) {
        if (typeof s?.id !== "string" || !Array.isArray(s?.tokens)) continue;
        out.push({
          id: s.id,
          tokens: s.tokens
            .filter((t: any) => Number.isInteger(t?.i))
            .map((t: any) => ({ i: t.i, lemma: String(t.lemma ?? t.surface ?? "") })),
        });
      }
      if (out.length > 0) return out;
    }
  }
  return [];
}

function extractAutoSentences(bodyText: string): Array<{ id: string; text: string }> {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return [];
  }
  if (typeof body !== "object" || body === null) return [];
  const messages = (body as Record<string, unknown>)["messages"];
  if (!Array.isArray(messages)) return [];
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k] as Record<string, unknown>;
    if (m["role"] !== "user" || typeof m["content"] !== "string") continue;
    const payload = tryParseLoose(m["content"] as string);
    if (
      payload &&
      typeof payload === "object" &&
      Array.isArray((payload as Record<string, unknown>)["sentences"]) &&
      (payload as Record<string, unknown>)["lang"] === "auto"
    ) {
      const out: Array<{ id: string; text: string }> = [];
      for (const s of (payload as Record<string, any>)["sentences"]) {
        if (typeof s?.id !== "string" || typeof s?.text !== "string") continue;
        // tokens 缺席/为空即 Auto 整句分词请求（与普通 glossBatch 区分）
        if (Array.isArray(s?.tokens) && s.tokens.length > 0) continue;
        out.push({ id: s.id, text: s.text });
      }
      if (out.length > 0) return out;
    }
  }
  return [];
}

/** Mock 分词：优先 Intl.Segmenter word（含 CJK/阿语），回退空白切分。只保留词类，标点/空白丢弃。 */
function segmentTextForMock(text: string): string[] {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "word" });
    const parts = [...seg.segment(text)].filter((s) => {
      const rec = s as unknown as { isWordLike?: boolean; segment: string };
      if (typeof rec.isWordLike === "boolean") return rec.isWordLike;
      return /[\p{L}\p{N}]/u.test(rec.segment);
    });
    if (parts.length > 0) return parts.map((p) => p.segment);
  } catch {
    // fall through
  }
  return text.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function tryParseLoose(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const prefix = opts.glossPrefix ?? "MOCK";
  const delayMs = opts.delayMs ?? 1500;
  let behavior: MockBehavior = opts.defaultBehavior ?? "ok";
  const requests: RecordedRequest[] = [];
  const cache = new Map<string, unknown>();
  const cachePuts: Array<{ key: string; entry: unknown }> = [];
  let flakyUsed = false;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headerNames = Object.keys(req.headers ?? {});
      const rec: RecordedRequest = {
        method: (req.method ?? "GET").toUpperCase(),
        path: req.url ?? "/",
        hasAuth: headerNames.includes("authorization"),
        headerNames,
        body,
      };
      requests.push(rec);

      const url = new URL(req.url ?? "/", "http://mock");
      const override = String(req.headers["x-mock-behavior"] ?? "") as MockBehavior;
      const active: MockBehavior =
        override !== "" ? override : behavior;

      if (
        url.pathname === "/v1/gloss-cache" ||
        url.pathname === "/gloss-cache" ||
        url.pathname === "/api/cache"
      ) {
        if (rec.method === "GET") {
          const key = url.searchParams.get("key") ?? "";
          if (cache.has(key)) {
            const value = cache.get(key);
            if (url.pathname === "/api/cache") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ hit: true, value }));
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ entry: value }));
            }
          } else {
            if (url.pathname === "/api/cache") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ hit: false }));
            } else {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "miss" }));
            }
          }
          return;
        }
        if (rec.method === "PUT") {
          try {
            const data = JSON.parse(body) as {
              key?: unknown;
              entry?: unknown;
              value?: unknown;
            };
            // v1 shape {key,entry}; workers shape ?key= + {value} (accept both).
            const qkey = url.searchParams.get("key");
            const putKey =
              typeof qkey === "string" && qkey !== ""
                ? qkey
                : typeof data.key === "string"
                  ? data.key
                  : null;
            const putValue =
              (data as Record<string, unknown>)["value"] !== undefined
                ? (data as Record<string, unknown>)["value"]
                : (data as Record<string, unknown>)["entry"] ?? null;
            if (typeof putKey === "string") {
              cache.set(putKey, putValue);
              cachePuts.push({ key: putKey, entry: putValue });
            } else if (url.pathname === "/api/cache") {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "missing key" }));
              return;
            }
          } catch {
            // fall through to 400
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "bad json" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname.endsWith("/chat/completions") && rec.method === "POST") {
        if (active === "reject-json" && body.includes("response_format")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "response_format unsupported" } }));
          return;
        }
        if (active === "unauthorized") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad key" } }));
          return;
        }
        if (active === "error500" || (active === "flaky-once" && !flakyUsed)) {
          flakyUsed = true;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "boom" } }));
          return;
        }
        const respond = (content: string) => {
          const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "mock",
              choices: [
                { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
              ],
              usage,
            }),
          );
        };
        if (active === "invalid-json") {
          respond("Here are your glosses (definitely not json): {{{oops");
          return;
        }
        const sentences = extractSentences(body);
        const autoSentences = sentences.length === 0 ? extractAutoSentences(body) : [];
        if (active === "plain-text") {
          if (autoSentences.length > 0) {
            const lines = autoSentences.flatMap((s) =>
              segmentTextForMock(s.text).map((w, i) => `${s.id} | ${i} | ${w} | ${prefix}:${w}`),
            );
            respond(lines.join("\n"));
            return;
          }
          const lines = sentences.flatMap((s) =>
            s.tokens.map((t) => `${s.id} | ${t.i} | ${t.lemma} | ${prefix}:${t.lemma}`),
          );
          respond(lines.join("\n"));
          return;
        }
        if (active === "slow") {
          setTimeout(() => {
            try {
              respond(JSON.stringify({ sentences: [] }));
            } catch {
              // client already gave up; ignore
            }
          }, delayMs);
          return;
        }
        // Auto 万能：整句无 token，先分词再注（mock 用 Intl.Segmenter 近似）。
        if (autoSentences.length > 0) {
          respond(
            JSON.stringify({
              sentences: autoSentences.map((s) => ({
                id: s.id,
                detectedLang: "auto",
                tokens: segmentTextForMock(s.text).map((w, i) => ({
                  i,
                  surface: w,
                  lemma: w,
                  gloss: `${prefix}:${w}`,
                })),
              })),
            }),
          );
          return;
        }
        respond(
          JSON.stringify({
            sentences: sentences.map((s) => ({
              id: s.id,
              glosses: s.tokens.map((t) => ({
                i: t.i,
                lemma: t.lemma,
                gloss: `${prefix}:${t.lemma}`,
              })),
            })),
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        origin: `http://127.0.0.1:${port}`,
        port,
        requests,
        get chatRequests() {
          return requests.filter((r) => r.path.endsWith("/chat/completions"));
        },
        cachePuts,
        setDefaultBehavior: (b: MockBehavior) => {
          behavior = b;
          if (b !== "flaky-once") flakyUsed = false;
        },
        reset: () => {
          requests.length = 0;
          cache.clear();
          cachePuts.length = 0;
          flakyUsed = false;
        },
        close: () =>
          new Promise<void>((done) => {
            try {
              (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            } catch {
              // ignore: best-effort idle socket cleanup
            }
            server.close(() => done());
          }),
      });
    });
  });
}
