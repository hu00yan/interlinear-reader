// Chat Completions client: batching, JSON-mode-first with plain-text fallback,
// retry/backoff/timeout, concurrency throttle, cost accounting + breaker.
// Browser-direct: the apiKey is only ever sent to the configured LLM baseUrl
// (Authorization header). It is never persisted, logged, or emitted in events.

import type {
  ClientEvent,
  ClientOptions,
  GlossBatchInput,
  GlossBatchOutput,
  SentenceInput,
} from "./types.ts";
import { buildGlossMessages } from "./prompt.ts";
import { GlossParseError, parseGlossContent } from "./parse.ts";
import {
  HttpError,
  TimeoutError,
  backoffDelay,
  shouldRetry,
  sleep,
} from "./retry.ts";
import { BudgetExceededError, BudgetTracker, estimateTokens } from "./budget.ts";
import { containsKeyMaterial, SENSITIVE_FIELD, sanitizeForLog } from "./redact.ts";
import type { ChatResponse } from "./transport.ts";

export { BudgetExceededError };

export function normalizeBaseUrl(raw: string): string {
  const base = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new TypeError(`baseUrl must be http(s): ${raw}`);
  }
  return base;
}

/** Append /chat/completions unless already present. */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const cur = next++;
        out[cur] = await fn(items[cur], cur);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function validateBatch(input: GlossBatchInput): void {
  if (!input || !Array.isArray(input.sentences)) {
    throw new TypeError("glossBatch: sentences must be an array");
  }
  for (const s of input.sentences) {
    if (typeof s?.id !== "string" || typeof s?.text !== "string" || !Array.isArray(s?.tokens)) {
      throw new TypeError("glossBatch: each sentence needs {id, text, tokens[]}");
    }
    for (const t of s.tokens) {
      if (!Number.isInteger(t?.i) || typeof t?.lemma !== "string") {
        throw new TypeError(`glossBatch: bad token in sentence ${s.id}`);
      }
    }
  }
}

export interface LlmClient {
  glossBatch(input: GlossBatchInput): Promise<GlossBatchOutput>;
  getUsage(): import("./types.ts").UsageInfo;
  resetBudget(): void;
  readonly model: string;
  readonly baseUrl: string;
}

export function createClient(options: ClientOptions): LlmClient {
  if (!options || typeof options.apiKey !== "string" || options.apiKey === "") {
    throw new TypeError("createClient: apiKey is required (in-memory only, never stored)");
  }
  if (typeof options.model !== "string" || options.model === "") {
    throw new TypeError("createClient: model is required");
  }
  const url = chatCompletionsUrl(options.baseUrl);
  if (options.extraHeaders) {
    for (const [k, v] of Object.entries(options.extraHeaders)) {
      if (SENSITIVE_FIELD.test(k) || containsKeyMaterial(v)) {
        throw new TypeError(`createClient: extraHeaders must not carry key material (${k})`);
      }
    }
  }

  const timeoutMs = options.timeoutMs ?? 30000;
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const chunkSize = Math.max(1, options.maxSentencesPerRequest ?? 8);
  const concurrency = Math.max(1, options.maxConcurrency ?? 3);
  const jsonSetting = options.jsonMode ?? "auto";
  const fetchImpl: typeof fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const budget = new BudgetTracker({
    maxCostUsd: options.maxCostUsd,
    maxTokens: options.maxTokens,
    prices: options.prices,
  });
  let jsonDegraded = false; // latched when an endpoint rejects response_format

  const emit = (event: ClientEvent): void => {
    try {
      options.onEvent?.(sanitizeForLog(event) as ClientEvent);
    } catch {
      // Observability must never break glossing.
    }
  };

  async function postChat(body: Record<string, unknown>): Promise<ChatResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
          ...(options.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      if (!resp.ok) throw new HttpError(resp.status, text);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new GlossParseError("model endpoint returned non-JSON envelope");
      }
      const choices = data["choices"];
      const content =
        Array.isArray(choices) &&
        choices[0] !== null &&
        typeof choices[0] === "object" &&
        (choices[0] as Record<string, unknown>)["message"] !== null &&
        typeof (choices[0] as Record<string, unknown>)["message"] === "object"
          ? ((choices[0] as Record<string, unknown>)["message"] as Record<string, unknown>)[
              "content"
            ]
          : undefined;
      if (typeof content !== "string") {
        throw new GlossParseError("model envelope has no choices[0].message.content string");
      }
      const usage = (data["usage"] ?? null) as {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
      } | null;
      return {
        content,
        promptTokens:
          typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
        completionTokens:
          typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TimeoutError(`LLM request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function glossChunk(
    lang: string,
    target: string,
    sentences: SentenceInput[],
  ): Promise<GlossBatchOutput> {
    const { system, user } = buildGlossMessages({ lang, target, sentences });
    const estIn = estimateTokens(system + user);
    const estOut = Math.max(
      16,
      sentences.reduce((n, s) => n + s.tokens.length, 0) * 8,
    );
    let last: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let useJson = jsonSetting !== "off" && (jsonSetting === "on" || !jsonDegraded);
      for (;;) {
        budget.ensure();
        emit({ type: "request", attempt });
        try {
          let resp: ChatResponse;
          try {
            resp = await postChat({
              model: options.model,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              temperature: 0,
              ...(useJson ? { response_format: { type: "json_object" } } : {}),
            });
          } catch (envelopeError) {
            if (envelopeError instanceof GlossParseError) {
              // Envelope was unparseable (non-JSON / no content string) yet the
              // call still spent budget: burn the estimate so bad output cannot
              // bypass the breaker.
              budget.record(estIn, estOut);
              emit({ type: "usage", usage: budget.snapshot() });
            }
            throw envelopeError;
          }
          // Account spend BEFORE parse: parse failures must still trip the breaker.
          budget.record(resp.promptTokens ?? estIn, resp.completionTokens ?? estOut);
          emit({ type: "usage", usage: budget.snapshot() });
          return parseGlossContent(resp.content, sentences);
        } catch (error) {
          // Weak-model / strict-endpoint fallback: one immediate plain-text retry.
          if (
            error instanceof HttpError &&
            error.status === 400 &&
            useJson &&
            jsonSetting === "auto"
          ) {
            jsonDegraded = true;
            useJson = false;
            emit({ type: "fallback", reason: "json mode rejected; retrying as plain text" });
            continue;
          }
          last = error;
          break;
        }
      }
      if (attempt >= maxRetries || !shouldRetry(last)) throw last;
      emit({
        type: "retry",
        attempt,
        reason: last instanceof Error ? last.message : String(last),
      });
      await sleep(backoffDelay(attempt, baseDelayMs));
    }
    throw last;
  }

  async function glossBatch(input: GlossBatchInput): Promise<GlossBatchOutput> {
    validateBatch(input);
    if (input.sentences.length === 0) return {};
    const parts = await mapPool(chunk(input.sentences, chunkSize), concurrency, (c) =>
      glossChunk(input.lang, input.target, c),
    );
    const merged: GlossBatchOutput = {};
    for (const part of parts) Object.assign(merged, part);
    return merged;
  }

  return {
    glossBatch,
    getUsage: () => budget.snapshot(),
    resetBudget: () => budget.reset(),
    model: options.model,
    baseUrl: normalizeBaseUrl(options.baseUrl),
  };
}
