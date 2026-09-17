# Format browser verification baseline

Date: 2026-09-17. Commit: `00c0f74` on `main`.

## Verdict

**Partial delivery: actual Chromium observations complete; required Tabbit surface blocked.** No product source, existing tests, or harness files changed. The existing build and both repository E2E tests passed. These gates do not establish translation quality.

The installed Tabbit CLI was used first, as requested. It failed during navigation before any file import. A separate Playwright-driven Chromium session then exercised the real built app and real file input, not a parser-only test or simulated DOM. Its findings below are browser-observed, but are not presented as a successful Tabbit run.

## Observed outcomes

| Check | Actual Chromium result | Evidence |
| --- | --- | --- |
| Local Japanese vertical EPUB reads horizontally | Pass, bounded sample. 26 imported chapters. Chapter index 4 shows `たまに、夢を見る。` followed by `日本の、行ってもいない学校の教室の夢だ。`. Computed writing-mode is `horizontal-tb`. | `assets/browser-observations.json`, case `horizontal` |
| Ruby readings remain separate from source words | Fail. Original synthetic `<ruby>日本<rp>（</rp><rt>にほん</rt><rp>）</rp></ruby>` becomes `日本（にほん）` in source text, excluding gloss nodes. No ruby element remains. | `assets/ruby-original.png`; case `ruby` |
| Illustrations and image-only chapters remain available | Fail. Synthetic EPUB contains three linear spine chapters and two images. UI exposes only `第一章 (5段)` and `第三章 (1段)`, with zero reader images. The image-only middle chapter disappears. | Cases `images` and `ruby`; both screenshots |
| All-image EPUB reports its limitation | Pass for visible error, not image support. UI displays `EPUB 未提取到正文段落`. Previous synthetic book remains. Screenshot also shows stale `解析中...`; no claim that error recovery UX is complete. | `assets/all-image-original.png`; case `all-image` |
| Source continuity through page turns | Pass for the original synthetic content. All 1,628 non-whitespace source characters preserved in order at 1280×800 and 390×800. First chapter takes 8 and 27 pages respectively, followed by the second chapter. | Case `continuity`, full pager sequence |
| Unsupported extensions rejected explicitly | Fail for forced import. File input advertises `.epub,.txt,.md`; original plain text named `.pdf`, `.mobi`, `.azw3`, and `.djvu` is nevertheless rendered when setInputFiles bypasses the picker filter. | Case `boundaries` |

Additional synthetic observation: nested blockquote text appears as `外側。内側。終端。` and then `内側。` again. `DIV専用本文。` is absent. The screenshot shows the duplicate inner text. This confirms loss/duplication at the extraction boundary, not a translation issue.

The real book was imported directly from its narrowly discovered Unicode filename in `~/Downloads`, never copied into the repository or served fixture directories. Only two short opening paragraphs are retained in local JSON. No real-book screenshot was taken. The real book's shown page has zero images; whole-book illustration enumeration was not performed. Ruby contamination is proven by the synthetic fixture, not asserted for every ruby in the real book.

## Evidence and safety

Evidence directory:

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-format-verification-20260917/`

- `assets/browser-observations.json`: browser version, request audit, source-only DOM observations, page traversal, and results.
- `assets/ruby-original.png`: synthetic reader screenshot, visually inspected with Read.
- `assets/all-image-original.png`: synthetic error screenshot, visually inspected with Read.
- `gate-summary.json`: compact actual-browser outcome summary.
- `result.json`: structured local acceptance round; not published.
- `assets/reasoning.md`: reviewer-facing explanation of observed outcomes.
- `assets/tabbit-blocker.txt`: recorded commands and returned attachment failures.
- Repository `artifacts/playwright.json`: existing E2E JSON report. Existing E2E also writes `artifacts/shot-reader.png` and `artifacts/shot-settings.png`; these are not cited as format proof.

The actual-format browser uses a new isolated BrowserContext, blocks service workers, and allows only GET/HEAD requests to its exact loopback origin. It has no real API key and selects Mode B. Audit: 10 allowed same-origin GETs, zero blocked attempts, zero page errors, zero LLM POSTs. Thus no book bytes went to a network endpoint during these checks. Dictionary lookups are local. Mock LLM results from existing E2E prove plumbing only, not semantic correctness.

## Executed commands and versions

Working directory for all repository commands: `/Users/huyan00/mycode/interlinear-reader`.

```sh
node --version                 # v26.5.0
npm --version                  # 11.17.0
npx playwright --version       # 1.63.0
npm run build                  # PASS; Vite 5.4.21, tsc, first-screen size gate
node tests/format-verification-20260917/make-fixtures.mjs
node --input-type=module -e 'import {createStubServer} from "./scripts/stub-server.mjs"; const s=await createStubServer(0); console.log(`FORMAT_ORIGIN=http://127.0.0.1:${s.address().port}`)'
# Returned http://127.0.0.1:59479; own server PID 17649 at recovery.
ILR_BASE=http://127.0.0.1:59479 npx playwright test tests/e2e/reader.spec.mjs
# 1 passed (3.5s)
ILR_BASE=http://127.0.0.1:59479 npm run e2e
# 2 passed (3.4s)
ILR_BASE=http://127.0.0.1:59479 node tests/format-verification-20260917/actual-browser.mjs
# Chromium 153.0.8010.12; 3 pass, 3 fail baseline outcomes; 0 blocked.
```

The format script exits normally after recording baseline failures; do not interpret exit 0 as all checks passing. Inspect its case statuses. The script initially stopped on a verifier-authored assumption that localStorage remained empty after boot. The app populated `ilr.gloss-cache.v1`. Only the new verifier script was corrected to check absence of a key within its fresh BrowserContext; no product or existing harness change was made. The final completed run is the evidence above.

Reproduction assets are under `tests/format-verification-20260917/`: original fixture generator, small generated fixtures, pre-authored human-outcome plan, actual browser script, and attempted Tabbit script. A new stub server selects a new ephemeral port; set `ILR_BASE` accordingly. The attempted `bounded-browser.js` records the old port and was not successful; it also retains the overly strict post-boot storage assertion as an attempted-run artifact, not a validated runner.

## Tabbit blocker and ownership

Installed runtime reported Playwright core/test expect 1.62.1, instance `74A44B26538ECF7F`.

- `nodejs --task ilr-format-verification --request-id bounded-01 --timeout-ms 180000 < tests/format-verification-20260917/bounded-browser.js`: failed on page.goto with `Target page, context or browser has been closed`.
- Read-only recovery request `inspect-after-closure`: got an implicit about:blank page and localStorage SecurityError. No import occurred.
- Attempt to resume own retained group: `SESSION_GROUP_CONFLICT`.
- Minimal second guarded navigation `minimal-import`: same target-closed error before file upload.
- Reclaim of task-created tab 1356119126: `PAGE_ATTACHMENT_TIMEOUT`.
- `finish --task ilr-format-verification`: completed exactly once, `finished: true`, `keep: true`, screenshotCount 0, retained group `B39CA15CCC969E1574A426E96D73B415`. Recovery diagnostic subsequently returned Unknown task, consistent with finished ownership.

No existing user tab was modified. The original task-created retained group was `FA4C5F4875249E9BFDE1C92DD366B48F`; failures left local app tabs without successful attachment. No further browser repair was attempted. Fixing the Tabbit runtime requires separate approval. The separate headless Chromium context was closed by its script. After verifying PID 17649 belonged to this run's ephemeral stub command, the verifier stopped it with `kill -TERM 17649`; its shell reported completion. No server was left running by this verifier.

## Unverified and not applicable

- Tabbit: all six format checks remain blocked on that surface.
- Native file chooser UI filtering was not exercised. Only its accept attribute and separately forced imports were observed.
- Real MOBI, AZW3, PDF, and DjVu binaries were not parsed or converted. A renamed text fixture is not evidence of binary format support.
- Reverse page turns, resize-anchor preservation, full-book continuity, export round-trip, OCR, and paid LLM quality were not tested.
- Loaded browser extension E2E: **not applicable**, no extension implemented. Not a pass.
- Full `npm run verify` was not run. Source `scripts/verify.mjs:65` references `tests/unit/worker-rules.test.mjs`, absent from the surveyed tests directory. This is a source-level harness concern, not an observed failure from running the whole command. No fix made.
- `lh acceptance run list --json` returned `command not found: lh`. No install, auth, or publishing attempted. Acceptance URL unavailable; uploaded evidence coverage 0/6. Local evidence covers 6/6 actual-Chromium outcomes (required screenshots for ruby/error present), while required Tabbit coverage remains 0/6. The local round is partial, not certified complete.

## Change boundary

Before: clean `main...origin/main` at `00c0f74`.

After recovery: `?? docs/` and `?? tests/format-verification-20260917/`, no tracked modifications. `docs/research/format-extension-feasibility.md` belongs to the research worker and was not edited. This verifier adds only `docs/research/format-browser-verification.md` and the uniquely named local test directory. Build output and existing E2E artifacts are ignored by repository rules. No installs, commits, deployment, or publishing occurred.
