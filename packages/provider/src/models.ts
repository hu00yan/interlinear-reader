// Supported model configurations. OpenAI-compatible protocol only:
// any endpoint serving POST {baseUrl}/chat/completions works.
// The apiKey always comes from the caller (the app keeps it in browser-side
// key storage); these helpers only shape {baseUrl, model, headers}.

import type { PricePer1k } from "./types.ts";

export type ModelProvider = "openrouter" | "deepseek" | "custom";

export interface ModelConfig {
  provider: ModelProvider;
  baseUrl: string;
  model: string;
  extraHeaders?: Record<string, string>;
  prices?: PricePer1k;
  notes: string;
}

/** OpenRouter: https://openrouter.ai/api/v1. Any model id, e.g. "deepseek/deepseek-chat". */
export function openRouterConfig(args: {
  model: string;
  siteUrl?: string;
  appName?: string;
  prices?: PricePer1k;
}): Omit<ModelConfig, "provider"> & { provider: "openrouter" } {
  const extraHeaders: Record<string, string> = {};
  if (args.siteUrl) extraHeaders["HTTP-Referer"] = args.siteUrl;
  if (args.appName) extraHeaders["X-Title"] = args.appName;
  return {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: args.model,
    ...(Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {}),
    ...(args.prices ? { prices: args.prices } : {}),
    notes: "OpenAI-compatible. Optional HTTP-Referer/X-Title rank your app on leaderboards.",
  };
}

/** DeepSeek native endpoint (OpenAI-compatible): https://api.deepseek.com */
export function deepSeekConfig(args: {
  model?: string;
  prices?: PricePer1k;
}): Omit<ModelConfig, "provider"> & { provider: "deepseek" } {
  return {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: args.model ?? "deepseek-chat",
    ...(args.prices ? { prices: args.prices } : {}),
    notes:
      "OpenAI-compatible Chat Completions. deepseek-reasoner also works but costs more " +
      "latency/tokens; JSON-mode fallback stays on.",
  };
}

/** Any relay exposing the OpenAI-compatible protocol. */
export function customRelayConfig(args: {
  baseUrl: string;
  model: string;
  extraHeaders?: Record<string, string>;
  prices?: PricePer1k;
}): Omit<ModelConfig, "provider"> & { provider: "custom" } {
  return {
    provider: "custom",
    baseUrl: args.baseUrl,
    model: args.model,
    ...(args.extraHeaders ? { extraHeaders: args.extraHeaders } : {}),
    ...(args.prices ? { prices: args.prices } : {}),
    notes: "Any OpenAI-compatible relay. The client appends /chat/completions when missing.",
  };
}

/** Copy-pasteable examples (placeholder keys; the real key stays in browser-side key storage). */
export const MODEL_CONFIG_EXAMPLES = {
  openrouter: {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    extraHeaders: { "HTTP-Referer": "https://example.com", "X-Title": "Interlinear Reader" },
  },
  deepseek: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
  customRelay: {
    provider: "custom",
    baseUrl: "https://relay.example.com/v1",
    model: "gpt-4o-mini",
  },
} as const;
