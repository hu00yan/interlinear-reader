// Track C shared types. OpenAI-compatible protocol only (Chat Completions + JSON).
// Response API is explicitly out of scope for v1; see transport.ts for the seam.

export interface Candidate {
  /** Dictionary gloss candidate injected by Track B (choice-style disambiguation). */
  gloss: string;
  pos?: string;
  source?: string;
}

export interface TokenInput {
  /** Token index within the sentence (stable, 0-based). */
  i: number;
  surface: string;
  lemma: string;
  /** Empty/missing => unknown word: goes straight to LLM composition. */
  candidates?: Candidate[];
}

export interface SentenceInput {
  id: string;
  text: string;
  tokens: TokenInput[];
}

export interface GlossItem {
  i: number;
  lemma: string;
  gloss: string;
  source: "llm";
}

export interface GlossBatchInput {
  lang: string;
  target: string;
  sentences: SentenceInput[];
}

export type GlossBatchOutput = Record<string, GlossItem[]>;

export interface PricePer1k {
  input: number;
  output: number;
}

export interface ClientOptions {
  /** OpenAI-compatible base, e.g. https://openrouter.ai/api/v1 (trailing slash ok). */
  baseUrl: string;
  /** Held in memory only. Never persisted or logged by this package. */
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  baseDelayMs?: number;
  /** Max sentences per Chat Completions call. Default 8. */
  maxSentencesPerRequest?: number;
  /** Max parallel Chat Completions calls. Default 3. */
  maxConcurrency?: number;
  /** 'auto' (default): try response_format json_object, fall back to plain text on 400. */
  jsonMode?: "auto" | "on" | "off";
  /** Extra headers (e.g. OpenRouter HTTP-Referer). Must not carry key material. */
  extraHeaders?: Record<string, string>;
  prices?: PricePer1k;
  maxCostUsd?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  onEvent?: (event: ClientEvent) => void;
}

export interface UsageInfo {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  tripped: boolean;
}

export interface ClientEvent {
  type: "request" | "retry" | "usage" | "fallback";
  attempt?: number;
  reason?: string;
  usage?: UsageInfo;
}
