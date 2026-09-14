// Public surface of @interlinear/provider (Track C).

export type {
  Candidate,
  TokenInput,
  SentenceInput,
  GlossItem,
  GlossBatchInput,
  GlossBatchOutput,
  PricePer1k,
  ClientOptions,
  UsageInfo,
  ClientEvent,
} from "./types.ts";

export {
  createClient,
  normalizeBaseUrl,
  chatCompletionsUrl,
  BudgetExceededError,
  type LlmClient,
} from "./client.ts";

export { buildGlossMessages, GLOSS_JSON_SHAPE } from "./prompt.ts";
export { parseGlossContent, GlossParseError } from "./parse.ts";

export {
  TimeoutError,
  HttpError,
  isRetryableStatus,
  shouldRetry,
  backoffDelay,
  withTimeout,
  retryable,
  sleep,
} from "./retry.ts";

export {
  BudgetTracker,
  estimateTokens,
  type BudgetCaps,
} from "./budget.ts";

export {
  normalizeSentenceText,
  cacheKeyForToken,
  cacheKeyForSentence,
  MemoryCacheStore,
  IndexedDBCacheStore,
  getDefaultStore,
  RemoteSharedCache,
  SHARED_CACHE_KEY_RE,
  CachedGlossStore,
  type CacheEntry,
  type GlossCacheStore,
  type SharedCacheApi,
} from "./cache.ts";

export {
  Mode,
  orchestrate,
  UserAbortedError,
  type Mode as ModeName,
  type GlossSource,
  type OrchestratedGloss,
  type OrchestrateStats,
  type DictAdapter,
  type LlmAdapter,
  type OrchestrateOptions,
  type OrchestrateResult,
} from "./modes.ts";

export {
  openRouterConfig,
  deepSeekConfig,
  customRelayConfig,
  MODEL_CONFIG_EXAMPLES,
  type ModelConfig,
  type ModelProvider,
} from "./models.ts";

export {
  containsKeyMaterial,
  redactApiKeyText,
  sanitizeForLog,
  SENSITIVE_FIELD,
} from "./redact.ts";

export { buildAutoSegmentMessages, parseAutoSegmentContent, cacheKeyForAutoToken, AUTO_LANG, AUTO_GLOSS_JSON_SHAPE } from "./auto.ts";
export type { AutoSentenceInput, AutoToken, AutoSegmentOutput } from "./auto.ts";

export { sha1Hex } from "./sha1.ts";
export { RESPONSE_API_RESERVED, type LlmTransport } from "./transport.ts";

// 模型质量金标（私有测试集 + 本地判分；UI 禁止渲染原文/参考）。
export {
  GOLDEN_SENTENCES,
  GOLDEN_TARGET,
  GOLDEN_VERSION,
  type GoldenItem,
  type GoldenRef,
  type GoldenToken,
} from "../golden/golden.ts";
export {
  QUALITY_THRESHOLDS,
  JUDGE_DEFAULT_OFF,
  scoreQuality,
  scoreSentence,
  suggestModel,
  applyJudge,
  type QualityActual,
  type QualitySummary,
  type SentenceScore,
  type JudgeSetting,
  type JudgedQuality,
} from "../golden/score.ts";
