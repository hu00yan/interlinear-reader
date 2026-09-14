# @interlinear/provider — Track C

LLM Provider 层 + 三模式编排 + 缓存。零依赖，`.ts` 纯可擦除语法，Node ≥22.6 / 现代浏览器直接跑，`node:test` 单测。

锁死约束：只做 OpenAI 兼容协议（Chat Completions + JSON，Response API 预留 `transport.ts`）；key 只存浏览器 localStorage（本包永不读写任何 storage）、浏览器直调 LLM、绝不经过自家 Workers/服务器、不记日志原文；缺词直走 LLM；缓存键 `sha1(lang|target|lemma|归一化句)`；模式 A 默认 / B 纯词典 / C 整章 LLM。

## 文件清单

| 文件 | 职责 |
|---|---|
| `src/types.ts` | 公共类型（Token/Sentence/Gloss/ClientOptions/Usage） |
| `src/client.ts` | `createClient({baseUrl,apiKey,model,…})`、`glossBatch` 批量、JSON 优先 + 纯文本回退、重试/退避/超时/节流、费用计数与熔断（postChat 成功先 `record(usage??estimate)` 再 `parse`；envelope 不可解析按 estimate 补记） |
| `src/prompt.ts` | prompt 构建：候选词典释义做选择式消歧，无候选=缺词直编 |
| `src/parse.ts` | JSON 解析（多形状归一）+ 弱模型纯文本行回退，`GlossParseError` |
| `src/retry.ts` | `TimeoutError`/`HttpError`、重试判定（429/5xx/超时/网络）、指数退避+抖动 |
| `src/budget.ts` | `BudgetTracker`（token/费用计数，上限熔断，`reset()` 解锁） |
| `src/modes.ts` | `orchestrate({mode:'A'/'B'/'C',…})`：A 点触发、B 永不调 LLM、C 整章（封顶+确认门+进度；B 缺词回 lemma+`dictMiss`，见下） |
| `src/cache.ts` | 归一化+`cacheKeyForToken`/`cacheKeyForSentence`、内存/IndexedDB 本地、`RemoteSharedCache`（`apiVersion:"v1"\|"workers"`，只读穿+幂等写穿，永不带 key；key 正则 `SHARED_CACHE_KEY_RE`） |
| `src/mock-server.ts` | 本地 mock OpenAI 兼容 endpoint（Node，供 Track D e2e；固定 `MOCK:<lemma>` 可断言，支持故障注入；同时 mock `/v1/gloss-cache` 与 `/api/cache` 两种 wire） |
| `src/models.ts` | OpenRouter / DeepSeek / 自定义中转配置 helper + 可粘贴示例 |
| `src/redact.ts` | `SENSITIVE_FIELD`、`containsKeyMaterial`、`redactApiKeyText`、`sanitizeForLog`（日志脱敏；`extraHeaders` 复用同一 `SENSITIVE_FIELD` 拦截） |
| `src/sha1.ts` | 无依赖 SHA-1（与 `node:crypto` 对拍通过） |
| `src/transport.ts` | 传输层接缝（v1=Chat Completions；Response API 预留未实现） |
| `src/index.ts` | 公共出口（不导出 apiKey 相关任何东西） |

## 接口文档

### `createClient(options)` → `glossBatch`

```ts
import { createClient } from "@interlinear/provider";

const llm = createClient({
  baseUrl: "https://openrouter.ai/api/v1", // 任意 OpenAI 兼容 base
  apiKey: localStorage.getItem("llm-key") ?? "", // 调用方负责存取，本包只放内存
  model: "deepseek/deepseek-chat",
  timeoutMs: 30000, maxRetries: 3, baseDelayMs: 400,
  maxSentencesPerRequest: 8, maxConcurrency: 3,
  jsonMode: "auto", // "on" | "off"；auto 遇 400 自动降级纯文本
  prices: { input: 0.14, output: 0.28 }, // 可选：用于费用熔断
  maxCostUsd: 1.0, maxTokens: 200_000,   // 可选：任一超限即熔断
  onEvent: (e) => console.debug(e.type), // 已脱敏事件，无 key
});

const out: Record<string, Array<{ i, lemma, gloss, source: "llm" }>> =
  await llm.glossBatch({
    lang: "en", target: "zh",
    sentences: [{
      id: "s1", text: "The cat sits.",
      tokens: [
        { i: 0, surface: "cat", lemma: "cat",
          candidates: [{ gloss: "猫", pos: "n." }] }, // Track B 注入
        { i: 1, surface: "sits", lemma: "sit" },      // 无候选=缺词，直编
      ],
    }],
  });

llm.getUsage();   // { requests, inputTokens, outputTokens, costUsd, tripped }
llm.resetBudget();// 熔断后解锁
```

错误：`GlossParseError`（耗尽重试仍不可解析）、`TimeoutError`、`HttpError`（401 等不重试）、`BudgetExceededError`（`.usage` 快照）。

计费顺序（锁死，防绕过熔断）：`postChat` 成功后先 `budget.record(usage ?? estimate)` 再 `parseGlossContent`；
`postChat` 抛 `GlossParseError`（非 JSON 信封 / 无 content 字符串）时按 `(estIn, estOut)` 补记一次。
`parseGlossContent` 失败不再补记（已记过）。`extraHeaders` 拦截复用 `redact.ts` 的 `SENSITIVE_FIELD`
（`authorization|api[_-]?key|x-api-key|proxy-authorization`，大小写不敏感）+ `containsKeyMaterial(value)`。

### 三模式 `orchestrate`

```ts
import { orchestrate } from "@interlinear/provider";

await orchestrate({
  mode: "A", // "B" 纯词典（llm 传抛错桩亦可，绝不调用）/ "C" 整章
  lang: "en", target: "zh", sentences,
  dict: { lookup: ({ lemma }) => dictHits }, // Track B：[] = 缺词
  cache,                                     // CachedGlossStore（可选）
  llm,                                       // A/C 必需
  confirmChapter: ({ sentenceCount, tokenCount }) => userConfirmed, // C
  maxSentencesPerChapter: 200, batchSize: 10, // C 封顶+分批
  onProgress: (done, total) => bar(done / total),
});
// → { glosses: { s1: [{ i, lemma, gloss, source: "dict"|"cache"|"llm", dictMiss? }] }, stats }
```

B 模式无词典命中时 gloss **锁死回退为 lemma** 并标记 `dictMiss: true`（纯离线可显示，单测 `modes.test.ts` 已 pin）。
Web 渲染层的 `"···"`（`packages/web/src/reader/render.ts:94` 无 gloss 占位 + `ui/app.ts:325` B 提示文案）是
`gloss == null` 时的显示占位，不是 provider 契约：一旦接线 `orchestrate`，B 缺词显示 lemma，不再出现空串占位。

### 接线状态（现状锁死，web 未接 `orchestrate`）

| 项 | provider（本包） | web 现状（只读，不改） | 结论 |
|---|---|---|---|
| `orchestrate` | `src/modes.ts` 已实现 A/B/C | `packages/web/src/ui/app.ts` 仅 import `glossSentence/testConnection`，经 `annotateParagraphs` + `dict-loader` 直注；无任何 `orchestrate` 引用 | **未接线**：web 的 A/B/C 是渲染模式（`render.ts:modeToContract`），不是本包编排；接线由 Track D 排期 |
| B 缺词显示 | `lemma` + `dictMiss:true`（永不空串） | 缺词 `gloss=null` → 渲染 `"···"` | winner = **lemma**（本包契约）；`···` 仅保留为未接线前的空占位 |
| C 确认门 | `confirmChapter({mode:"C",sentenceCount,tokenCount})`，截断**后**计数，falsy → `UserAbortedError` 且零 LLM 花费；`maxSentencesPerChapter` 默认 200，`batchSize` 默认 10，`onProgress(done,total)` | `ui/app.ts:380-410` 无确认框：逐段 `glossSentence` + `costCapUSD` 门限，超限即停并回退词典 | Track D 接线时必须补确认框（文案需含句数/token 数/费用预估/上限，见 `confirmChapter` 说明），确认后才调 `orchestrate` |

`confirmChapter` 说明（C 模式）：调用时机 = 截断后、任何 LLM 花费前；参数 `sentenceCount`/`tokenCount` 均为截断后实际将处理量；
返回 falsy（或 resolve falsy）即抛 `UserAbortedError`，此时 `mock.chatRequests` 零增长（单测 `modes.test.ts` 已 pin）；
确认通过后按 `batchSize` 分批走“缓存 sweep → 单次 LLM → 写穿”循环，`onProgress` 按句递增。

### 缓存

```ts
import { CachedGlossStore, MemoryCacheStore, RemoteSharedCache, cacheKeyForToken } from "@interlinear/provider";

const key = cacheKeyForToken({ lang: "en", target: "zh", lemma: "cat", sentenceText: "The cat sits." });
// = sha1("en|zh|cat|The cat sits.")，key 含 key 材料直接抛错
const store = new CachedGlossStore({
  local: new MemoryCacheStore(),                       // 浏览器用 getDefaultStore() → IndexedDB
  remote: new RemoteSharedCache({ baseUrl: "https://<自家workers域名>", apiVersion: "workers" }), // 新代码用 workers；缺省 v1 仅兼容旧 mock
});
await store.set(key, { gloss: "猫", lemma: "cat", cachedAt: Date.now() });
```

#### 三方缓存键矩阵（锁死 winner）

| 方 | 公式 | 归一化 | 大小写 | 上下文 | 输出 |
|---|---|---|---|---|---|
| provider 本包（`src/cache.ts`，winner） | token：`sha1(lang\|target\|lemma\|norm(句))`；句：`sha1(lang\|target\|__sent__\|norm(句))` | NFKC + 空白折叠 + trim | **保留**（el/de 大小写有义，单测 pin `Λόγος` 不变） | **token-in-context**：同 lemma 异句 ⇒ 异键 | 40 小写 hex |
| web（`packages/web/src/lib/hash.ts`，仅静态词典用） | 词：`sha1(lang\|target\|norm(lemma)\|)`；句：`sha1(lang\|target\|\|norm(句))`；`glossSentence` 用 `sentenceCacheKey(lang,target,句+"‖"+lemmas)` | NFKC + 空白折叠 + trim + **小写（ja 外）** | 小写 | **无上下文**（空槽位分体） | 40 小写 hex |
| workers（`workers/cache.ts` + `CONTRACT.md`） | 注释称 `sha1(lang\|target\|lemma\|)` / `sha1(lang\|target\|\|句)`；`CONTRACT.md:20-22` 仍写 `sha256(lang\|term\|context)`（ stale ） | 以调用方为准 | 以调用方为准 | 以调用方为准 | `KEY_RE=/^([0-9a-f]{40}\|[0-9a-f]{64})$/`（40 sha1 现行 + 64 sha256 预留，单测 pin） |

winner（锁死）：LLM 释义缓存一律用 **provider 的 token-in-context + 保留大小写**。
理由：同形异义需句上下文区分；de 句首大写 / el 大小写有义，web 的小写折叠会撞键。
web 的小写+空槽位键只保留给静态词典词缓存（`dict-loader`），**不得用于 LLM gloss 缓存**；
workers 的 `KEY_RE` 已兼容 winner（40 hex 直通），无需改 workers。
`cacheKeyForSentence` 用 `__sent__` 隔离命名空间（vs web 的空 lemma `||`），避免词/句键串槽。

#### 共享缓存 wire（锁死 workers，新代码用 `apiVersion:"workers"`）

| 项 | `v1`（legacy，缺省，仅兼容旧 mock） | `workers`（locked contract） |
|---|---|---|
| GET | `GET /v1/gloss-cache?key=` → `{entry}\|404` | `GET /api/cache?key=` → `{hit:true,value}\|{hit:false}`（`workers/cache.ts:73-100`，stub 同规则） |
| PUT | `PUT /v1/gloss-cache` body `{key,entry}` → `{ok:true}` | `PUT /api/cache?key=` body `{value}` → `{ok:true,hitRate}`（key 在 query，body 只带 value，>8KB 413） |
| key 正则 | 不校验（历史测试用 `k1`/`missing` 等非 hex） | `SHARED_CACHE_KEY_RE`（= workers `KEY_RE`：40hex sha1 / 64hex sha256），非法直接抛，防 key 材料混入 |
| 读兼容 | `{entry}\|{value}\|裸 entry` 均接受 | 同左，另接受 `{hit:false}` → null |

`RemoteSharedCache({apiVersion})` 缺省 `"v1"` 保证现有 e2e 不破；新接线一律传 `"workers"`。
mock-server 同时实现两条路由（`src/mock-server.ts`），`cachePuts` 两种 PUT 均记录。
`CONTRACT.md:20-22` 的 `sha256(lang|term|context)` 描述已 stale，以本节 + `workers/cache.ts:KEY_RE` 为准；
`README` 旧文中的 `src/lib/provider-mock.mjs` 路径已不存在，指向改为 `workers/cache.ts` / `CONTRACT.md` / `packages/web/src/lib/hash.ts`。

### Mock（Track D e2e）

```ts
import { startMockServer } from "@interlinear/provider/mock-server";
const mock = await startMockServer(); // mock.url → LLM baseUrl；mock.origin → 自家域假装
// 返回 MOCK:<lemma>；mock.setDefaultBehavior("slow"|"error500"|"invalid-json"|"plain-text"|"reject-json"|"flaky-once"|"unauthorized")
// 或按请求头 x-mock-behavior 覆盖；mock.requests 审计；mock.cachePuts 断言幂等
await mock.close();
```

## 支持的 model 配置示例

```jsonc
// OpenRouter（任意模型 id）
{ "baseUrl": "https://openrouter.ai/api/v1", "model": "deepseek/deepseek-chat" }
// + 可选头：{ "HTTP-Referer": "https://example.com", "X-Title": "Interlinear Reader" }

// DeepSeek 原生（OpenAI 兼容）
{ "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" }

// 自定义中转（任意 OpenAI 兼容 relay；缺 /chat/completions 自动补）
{ "baseUrl": "https://relay.example.com/v1", "model": "gpt-4o-mini" }
```

对应 helper：`openRouterConfig({model, siteUrl?, appName?})`、`deepSeekConfig({model?})`、`customRelayConfig({baseUrl, model})`（见 `src/models.ts`，`MODEL_CONFIG_EXAMPLES` 可直接粘贴）。

## 安全（单测覆盖）

- 发往自家域名（`RemoteSharedCache`）的请求永不带 `Authorization`、URL/body 永不含 key（`security.test.ts` 逐请求审计）。
- 本包源码无 `localStorage`/`sessionStorage` 引用（静态断言），运行时 spy  storage 零写入；缓存 at-rest 扫描无 key 材料。
- `onEvent`/日志经 `sanitizeForLog` 脱敏；`client` 对象序列化不含 key。

## 未决依赖（需跨 track 对齐）

1. **Track B 候选形状**：`Candidate {gloss,pos?,source?}` 为本包定义，待 Track B `lookup` 对齐注入（含词性/来源可显著提升消歧）。
2. **Workers 共享缓存契约**：已对齐 workers 方（`GET/PUT /api/cache?key=` + `{value}` + `KEY_RE 40/64hex`），本包 `RemoteSharedCache({apiVersion:"workers"})` 即该契约；`v1` 仅 legacy 缺省保留。`CONTRACT.md:20-22` 的 sha256 描述 stale，待其跟进改 sha1/winner 口径（只读穿假设服务端不鉴权不变）。
3. **缓存键算法分歧**：已锁死 winner = 本包 `sha1(lang|target|lemma|归一化句，保留大小写，token-in-context)`（见上矩阵）；web 小写+分体键只留静态词典用；workers `KEY_RE` 已兼容。旧文 `src/lib/provider-mock.mjs` 路径已不存在，代之以 `workers/cache.ts` / `CONTRACT.md` / `packages/web/src/lib/hash.ts` 三方对照。
4. **Track D 接线**：`orchestrate` 尚未被 web 接线（web 现用 `glossSentence` 直调，见上表）；接线时需补 C 确认框（句数/token 数/费用预估/上限文案）并传 `confirmChapter`，B 缺词按 lemma 显示；`IndexedDBCacheStore` 库名 `interlinear-gloss` 需与 web 侧共识；mock server（双 wire）已就绪供其 e2e 使用。
5. **Response API**：v1 不做，接缝见 `src/transport.ts`（`RESPONSE_API_RESERVED`）。
