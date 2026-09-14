# DEPLOY.md — Pages + R2 public origin (no Worker) + rollback

Scope: deploy ONLY. Web UI (A), dict content (B), provider prompts (C) are other tracks.

## 0. Architecture (locked)

- **Pages (static)**: `packages/web/dist` (vite build) — reader + `dict/`.
  No secrets in output (`scripts/build-check.mjs` scans).
  Git integration auto-deploys on push to main. Build command:
  `npm --prefix packages/web install && npm --prefix packages/web run build`
  (copy-dict → split-dict → tsc → vite), output dir `packages/web/dist`.
- **Dict reads (no server)**: web loader fetches same-origin in order —
  1. `/dict/{lang}/{target}.dict` (whole pair),
  2. `/dict/{lang}/{target}.dict.00`, `.01`… (chunks; `split-dict.mjs` cuts
     any pair >20MB because Pages refuses files >25MB — e.g. `en/en.dict`),
  3. R2 public origin `https://pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev/dict/{lang}/{target}.dict.br`
     (override via `VITE_R2_PUBLIC`; browser-transparent brotli).
  No Worker, no KV, no DO, no secrets. BYOK keys NEVER leave the browser
  (browser-direct to provider `baseUrl`; e2e-sniffed + provider security tests).
- **R2**: bucket `ilr-dict-v2` = canonical store of whole-pair `.br`
  (`dict/{lang}/{target}.dict.br`, 14 objects) + rollback source.
  Public r2.dev enabled (reads need no Worker); CORS for pages origin
  still pending (API rejects shapes — reads currently served by Pages;
  R2 fallback activates once CORS lands).

Contract mirror: `CONTRACT.md` (owners cited per section).

## 1. One-time setup (all done via CLI, no dashboard clicks needed)

```bash
npm install                          # root (playwright + harness)
npm --prefix packages/web install    # web build deps (once per machine/CI)
npx playwright install chromium      # e2e browser (once per machine/CI)
wrangler login
wrangler r2 bucket create ilr-dict-v2
wrangler r2 bucket create ilr-dict-preview
# public reads without a Worker:
# (managed r2.dev domain; done 2026-09-14 via API)
```

## 2. Deploy dictionary pairs (R2 canonical)

```bash
npm run deploy:dict        # DRY-RUN: object table + totals, no network (CI-safe)
npm run deploy:dict:live   # LIVE: `wrangler r2 object put` each .br object
```

Verify: `wrangler r2 bucket info ilr-dict-v2`
Spot-check: `curl https://pub-<id>.r2.dev/dict/ja/zh.dict.br | brotli -d | head -c 200`.
See `DICT_SOURCES.md` for content pipeline (Track B owns content).

## 3. Deploy Pages (static, auto)

Cloudflare Dashboard → Pages → Connect repo once; every push to main
rebuilds and redeploys automatically. No Action, no token, no Worker.

Health (CI + nightly): `node scripts/selfcheck-local.mjs <base>`
probes `/dict/ja/zh.dict` (whole pair) + `/dict/en/en.dict.00`
(first chunk of the split pair). `.github/workflows/verify.yml` runs
`npm run verify` on push/PR and polls prod nightly.

What `npm run verify` runs (in order): fixtures → track-D unit →
web build (tsc+vite+60KB) → web headless verify (A) → provider tests (C) →
dict-loader tests (B) → build-check → budget → deploy:dict dry-run →
dict-proof (real R2-layout loader over HTTP, 7×2 zh/en + miss) →
Playwright e2e (real app: 7-lang upload, dict hit, EPUB chapters, A/B/C,
B zero-LLM, C mock-LLM backfill, persistence, key hygiene, screenshots) →
static-dict selfcheck.

## 4. Free-tier accounting

| Resource | Free quota | Our ceiling | Enforced by |
|---|---|---|---|
| R2 storage | 10 GB | 17.3 MB dict (50 MB budget gate) | `scripts/budget.mjs` |
| R2 ops | generous free | dict immutable-ish; reads cached per pair in memory | `loadPair` mem |
| Pages | unlimited req, 25 MB/file | static only; pairs >20 MB split to chunks | `split-dict.mjs` |
| Workers | — | NOT USED (removed 2026-09-14; was shared cache + selfcheck) | — |

LLM spend in harness/CI: **$0** — e2e + all tests use the harness `/mock-llm`
endpoint and Track C's mock server only. Real provider calls are browser-direct
with the user's own key (other tracks).

## 5. Rollback

- **R2 dict**: objects are stable by key; re-run `npm run deploy:dict:live`
  from the last good commit.
- **Pages**: Dashboard → Pages → Deployments → Rollback to prior hash
  (or `git revert` + push — Git integration redeploys).
- **Kill-switch**: dict misses fall through to bundled mock → pivot(en) →
  provider/mock LLM (degraded, not down).
  B mode never needs the network at all (pure dict path).

## 6. Non-goals (other tracks)

Real EPUB UX, dict content/lemmatizers, provider prompts/models.
