# Contract mirror (Track D). Owners: tracks A–C. Do NOT edit values here —
# change the owner file, this mirror fails loudly in `npm run verify`.

## 7×2 languages (owner: `packages/web/src/types.ts`, `SOURCE_LANGS`, `TARGET_LANGS`)
Source (7): `en de fr it es ru ja`. Targets (2): `zh en`.
R2 layout: `dict/{lang}/{target}.dict.br` — one immutable object per source→target pair (14 objects for 7×2).

Pair payload format: UTF-8 lines of `lemma<TAB>glosses`; multiple glosses are separated by U+001F. JSON is build-time input only, never a published dictionary asset. The client downloads and caches one complete pair file per language/target.

## Pair assets (owner: `packages/dict-loader/src/shard.mjs`)
`normalizeLemma` (lower/NFKC, de ß→ss, ru ё→е, latin accent strip; ja as-is) is used for lookup keys. There is no runtime sharding.
Static hosts serve prebuilt `.br` transparently; always request the `.dict` URL
(owner: `packages/dict-loader/src/index.mjs`, `fetchPair`).

## Dict lookup (web: `packages/web/src/dict/dict-loader.ts`)
`getGloss(lang, target, lemma) -> string | null`.
Miss → null → caller (Track C) sends to LLM. No en-pivot: zh miss NEVER falls
back to en (owner: `packages/dict-loader/src/index.mjs` header).
R2-backed loader returns `{status:"hit"|"miss", gloss:[], shard}`.

## A/B/C modes (owner: `packages/web/src/types.ts`, `Mode`)
- `A` = 词典全注 + 点词/点句 LLM (default)
- `B` = 纯词典，零 LLM 调用；缺词 gloss 为空 + `.missing`
- `C` = 整章 LLM (`glossSentence` per paragraph, cost-cap guarded)
- Rendered DOM (owner: `packages/web/src/reader/render.ts`):
  `.para > .tok(.surface + .gloss[.missing][.hidden-gloss])`,
  LLM-filled tokens carry `.from-llm`; A-mode paragraphs show `.ai-btn`.
- Persisted in `localStorage["ilr.settings.v1"]` (`apiKey, mode, target, ...`;
  owner: `packages/web/src/store/settings.ts`).

## Cache keys (owner: `packages/web/src/lib/hash.ts` — locked)
`wordCacheKey = sha1hex("lang|target|lemma|")` (40 hex),
`sentenceCacheKey = sha1hex("lang|target||sentence")`.
`workers/cache.ts` `KEY_RE` accepts 40-hex (+64-hex reserved) and NOTHING else.

## Key hygiene (owners: `packages/web/src/llm/provider.ts`, `packages/provider/*`)
BYOK lives in `ilr.settings.v1` and travels ONLY as
`Authorization: Bearer` to the configured provider `baseUrl` (browser-direct,
no proxy, no server). Same-origin `/api/*` requests MUST NOT contain key
material — refused 400 by the Worker, sniffed by e2e, covered by
`packages/provider/test/security.test.ts`.
