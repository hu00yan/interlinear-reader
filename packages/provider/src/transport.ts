// Transport seam. v1 implements Chat Completions only.
// A future Response API adapter plugs in here without touching client/modes/cache.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  /** JSON mode. Omitted for weak models / endpoints that reject it. */
  response_format?: { type: "json_object" };
}

export interface ChatResponse {
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Minimal transport surface the client depends on. */
export interface LlmTransport {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

// NOTE(reserved): ResponseApiTransport will implement the same gloss-level
// contract via POST /v1/responses with a response adapter. Not in v1 scope.
export const RESPONSE_API_RESERVED = "POST /v1/responses adapter (v2, not implemented)";
