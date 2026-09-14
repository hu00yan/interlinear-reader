# interlinear-reader · Track D (deploy + unattended harness)

Cloudflare Pages (`packages/web/dist`) + R2 public origin
(`dict/{lang}/{target}.dict.br`, r2.dev direct, no Worker). Free tier only, no DB.
BYOK keys never leave the browser (browser-direct to provider).

- Contract mirror: `CONTRACT.md` (7×2 langs, one asset per source/target pair, A/B/C, sha1 keys, hygiene)
- Deploy/runbook: `DEPLOY.md`
- One-key self-check: `npm run verify` → `artifacts/verify-report.json + .html`
- Dict ship: `npm run deploy:dict` (dry-run) / `npm run deploy:dict:live`
- R2-layout proof: `npm run dict:proof` (needs stub or prod base via `ILR_BASE`)
- Local harness server: `npm run dev:stub` (real dist + dict + `/mock-llm` + `/api/*`)
- Prod poll: `npm run selfcheck [baseUrl]`
- CI: `.github/workflows/verify.yml` (verify on push + nightly prod selfcheck)

Out of scope: web UI features (A), dict content/lemmatizers (B), provider prompts (C).
