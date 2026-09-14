# DEPLOY.md — Track D: Pages + R2 + Workers (free tier) + rollback

Scope: deploy ONLY. Web UI (A), dict content (B), provider prompts (C) are other tracks.

## 0. Architecture (locked)

- **Pages (static)**: `packages/web/dist` (vite build, owned by web track) —
  reader + `fixtures/`. No secrets in output (`scripts/build-check.mjs` scans).
- **R2**: bucket `ilr-dict-v2`, layout `dict/{lang}/{target}.dict.br`
  (one object per source→target pair, 14 objects total, prebuilt `.br`) +
  `cache/{sha256}.json` (shared LLM-gloss spillover, written by the Worker).
- **Workers**: `workers/cache.ts` — ONLY `GET/PUT /api/cache?key` and
  `GET /api/selfcheck`. No DB, no KV, no DO, no secrets. BYOK keys NEVER pass
  through Workers (400-refused + e2e-sniffed + provider security tests).

Contract mirror: `CONTRACT.md` (owners cited per section).

## 1. One-time setup

```bash
npm install                          # root (playwright + harness)
npm --prefix packages/web install    # web build deps (once per machine/CI)
npx playwright install chromium      # e2e browser (once per machine/CI)
wrangler login
wrangler r2 bucket create ilr-dict-v2
wrangler r2 bucket create ilr-dict-preview
# optional durable hit-rate:
# wrangler analytics-engine create ilr_zen   # then uncomment ZEN in wrangler.toml
```

## 2. Deploy dictionary pairs (R2)

Track D ships Track B's prebuilt `.br` — it never rebuilds dict content:

```bash
npm run deploy:dict        # DRY-RUN: object table + totals, no network (CI-safe)
npm run deploy:dict:live   # LIVE: `wrangler r2 object put` each .br object
```

Verify: `wrangler r2 bucket info ilr-dict-v2`
Spot-check: `wrangler r2 object get ilr-dict-v2/dict/en/zh.dict.br --file - | brotli -d | head -c 200`.

## 3. Deploy Worker (cache)

```bash
npx wrangler deploy                 # -> https://ilr-cache.<account>.workers.dev
curl 'https://ilr-cache.<account>.workers.dev/api/selfcheck'
```

Expected: `{"langs":[…7…],"targets":["zh","en"],"modes":["A","B","C"],"shardsOk":[…7 prefixes…],"cache":{…}}`.

## 4. Deploy Pages (static)

Cloudflare Dashboard → Pages → Connect repo, settings:

- Build command: `npm --prefix packages/web install && npm --prefix packages/web run build`
- Output dir: `packages/web/dist`
- Env: none (no secrets — the app is keyless at rest; BYOK stays on user devices)

Same-origin `/api/*` → Worker route (`/api/*`), so the app's reads hit the
shared cache and `/api/selfcheck` is CI-pollable on the same host.

## 5. Post-deploy gates (CI)

```bash
npm run verify                                   # full harness, mock LLM, $0
node scripts/selfcheck-local.mjs https://ilr-cache.<account>.workers.dev
```

`.github/workflows/verify.yml` runs `npm run verify` on push/PR and polls
prod `/api/selfcheck` nightly. `npm run verify` writes
`artifacts/verify-report.json + .html` and exits non-zero with `file:line`.

What `npm run verify` runs (in order): fixtures → track-D unit →
web build (tsc+vite+300KB) → web headless verify (A) → provider tests (C) →
dict-loader tests (B) → build-check → budget → deploy:dict dry-run →
dict-proof (real R2-layout loader over HTTP, 7×2 zh/en + miss) →
Playwright e2e (real app: 7-lang upload, dict hit, EPUB chapters, A/B/C,
B zero-LLM, C mock-LLM backfill, persistence, key hygiene, screenshots) →
selfcheck poll.

## 6. Free-tier accounting

| Resource | Free quota | Our ceiling | Enforced by |
|---|---|---|---|
| Workers req | 100k/day | LRU 10k entries, 8KB body cap, 30d TTL | `workers/cache.ts` consts |
| R2 storage | 10 GB | < 1 MB dict (50 MB budget gate) | `scripts/budget.mjs` |
| R2 ops | generous free | dict immutable-ish; cache spills LRU-bounded | LRU cap |
| Pages | unlimited req | static only | — |
| Analytics Engine | generous free | optional, off by default | commented binding |

LLM spend in harness/CI: **$0** — e2e + all tests use the harness `/mock-llm`
endpoint and Track C's mock server only. Real provider calls are browser-direct
with the user's own key (other tracks).

## 7. Rollback

- **Worker**: `npx wrangler rollback` (or redeploy previous version;
  cache is best-effort — safe to lose, refills on demand).
- **R2 dict**: objects are stable by key; re-run `npm run deploy:dict:live`
  from the last good commit.
- **Pages**: Dashboard → Pages → Deployments → Rollback to prior hash.
- **Kill-switch**: if `/api/selfcheck` shows `shardsOk < 7`, the reader still
  works — dict misses fall through to cache → provider/mock (degraded, not down).
  B mode never needs the network at all (pure bundled-dict path).

## 8. Non-goals (other tracks)

Real EPUB UX, dict content/lemmatizers, provider prompts/models.
