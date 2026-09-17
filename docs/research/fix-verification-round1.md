# Fix verification, round 1

Date: 2026-09-17. Independent verifier, not either fix author. Reviewed `main` at `00c0f74` plus the two uncommitted product changes.

## Verdict

- **Fix A: CHANGES-NEEDED.** Ruby stripping and normal XHTML nested-block ordering work, but the new traversal silently drops CDATA source text. This is a newly introduced content-loss regression, reproduced against the baseline extractor and through the current built app.
- **Fix B: APPROVED.** Import failures show the actual error without stale `解析中…`. The prior book remains readable, and a subsequent valid TXT import succeeds.
- **Combined delivery: hold for A.** All requested automated gates pass, but they do not cover the CDATA regression.

## Evidence location

All new runtime evidence and verifier-only scripts are under:

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-fix-round1-verifier-8wInaz/`

Paths below are relative to that directory unless identified as repository paths. Nothing in the workers' evidence directories or baseline fixtures was edited.

## Blocking finding: CDATA source text disappears

**Observed, new regression.** `packages/web/src/ingest/epub.ts:85–90` consumes only node type 3, then returns for every non-element node. XML CDATA has node type 4. The old `textContent` extraction included it.

Valid XHTML reproduction inside an EPUB chapter:

```xml
<html xmlns="http://www.w3.org/1999/xhtml">
	<head><title>CDATA control</title></head>
	<body>
		<p><![CDATA[Visible prose & punctuation.]]></p>
		<p>Before <![CDATA[inside]]> after.</p>
	</body>
</html>
```

| Extractor | Paragraphs |
| --- | --- |
| Baseline `00c0f74`, executed in JSDOM | `Visible prose & punctuation.`, `Before inside after.` |
| Current working tree, executed in JSDOM | `Before after.` |
| Current build, actual Chromium file import | `Before after.` |

The first paragraph disappears completely; the second loses its middle word. This is source loss, not a gloss or layout issue. `source-edges.jsonl` records both executed extractors. `browser/cdata-observations.json` records the browser result. `browser/06-cdata-regression.png` shows the one remaining paragraph and was visually inspected. The fixture is `cdata-original.epub`; `cdata-browser.mjs` creates and imports it. Its exit 0 confirms reproduction of the defect, **not** acceptance success.

Requested author action: preserve CDATA text in the traversal and add a regression covering both CDATA-only paragraphs and mixed ordinary text/CDATA. No patch was made by this verifier.

## Requested behavior checks

These observations use the current combined build in a fresh, independent headless Chromium context, not Tabbit. Source assertions remove `.gloss` and `.ai-btn` nodes before comparison.

| Check | Result | Evidence and bounds |
| --- | --- | --- |
| Baseline synthetic ruby readings removed | **PASS** | `browser/observations.json`, `baseline-ruby-nested`. Exact first paragraph is `始まり。「日本へ行く。」`, without `にほん` or fallback parentheses. `browser/01-ruby-nested.png`, visually inspected. |
| Nested blockquote text once in DOM order | **PASS** | Same case: `絵の前。`, `絵の後。`, `外側。`, `内側。`, `終端。` each once, in that order. |
| Multiple `rt`, retained `rb`, `rtc` annotations, `rt` inside `rp` with order variants | **PASS** | Independent `edge-original.epub`; `ruby-variants-nested-headings-spine` case. Bases render as `東京。`, `山。`, `海。`; all annotation markers disappear. |
| Nested `li > blockquote > p`, text before/after descendants | **PASS** | Exact sequence `外。`, `中。`, `芯。`, `中終。`, `外終。`. `browser/02-edge-ruby-list-headings.png`. |
| Headings and furniture | **PASS** | Ruby-bearing wrapped `h1` supplies clean chapter title `日本`, not body text. Repeated initial `h2`/paragraph title disappears. `h3`/`h4` remain in order. Nav/header/footer content absent. Standard headings also compared against baseline in `source-edges.jsonl`. |
| Spine order, `linear=no`, nav skip | **PASS** | Independent EPUB places non-linear, manifest `properties=nav`, and `toc.xhtml` entries before the two body chapters. UI exposes only `日本 (11段)` then `終章 (1段)`; second chapter renders `最後。`. |
| Real Japanese book opening | **PASS, bounded sample** | 26 chapters; index 4 starts `たまに、夢を見る。` then `日本の、行ってもいない学校の教室の夢だ。`. Computed writing mode `horizontal-tb`. `real-opening` case. No real-book screenshot or full-book dump. |
| All-image EPUB failure clears loading | **PASS** | Error `EPUB 未提取到正文段落`; zero `.status-line` elements; prior control book still present and readable. `image-error` case and `browser/03-image-error-no-loading.png`, visually inspected. |
| Valid TXT immediately after failure | **PASS** | `verifier-recovery.txt` renders `The people read again.`; error cleared. `txt-recovery` case and `browser/04-txt-recovery.png`. |
| Forced `.mobi` text rejection | **FAIL, known unchanged defect** | `verifier-forced.mobi` still renders its original plain text. `mobi-fallthrough` case and `browser/05-mobi-known-defect.png`. This is not MOBI binary support. No fix attempted. |
| Empty TXT and malformed EPUB lifecycle | **PASS** | Re-ran worker B's actual script against this verifier's combined build. `lifecycle/browser-observations.json`: errors shown, loading cleared, prior source/chapter/page unchanged, successful Markdown retry. |
| CDATA source continuity | **FAIL, new in A** | Blocking finding above. |

`browser.mjs` reuses the baseline ruby and all-image fixtures read-only, and generates its own extended ruby/spine fixture. The real book was discovered narrowly by normalized filename prefix `処刑少女の生きる道` in `~/Downloads` and imported directly with the file input. Only its two short opening paragraphs are retained locally.

## Diff and test assessment

### Product scope

Reviewed the actual diffs, not only worker summaries. `git diff --stat` before and after execution remained:

```text
packages/web/src/ingest/epub.ts | 37 ++++++++++++++++++++++++++++++-------
packages/web/src/ui/app.ts      |  2 ++
2 files changed, 32 insertions(+), 7 deletions(-)
```

`product.diff` retains the reviewed patch. No other tracked product file changed. `git diff --check` passed. Existing untracked work at entry was `docs/`, `tests/format-verification-20260917/`, `tests/import-error-lifecycle-regression/`, and `tests/unit/epub-extraction-regression.test.mjs`. This verifier adds only this report within the repository. Test runners, new synthetic fixtures, built assets, and screenshots are in the unique temporary directory.

### Fix A

**Source-read:** stripping `rt`, `rp`, and `rtc` before title/body extraction correctly avoids readings in both places. Traversing one body tree avoids ancestor `textContent` duplication and flushes outer text around nested supported blocks. `parseEpub` spine filtering is untouched. Div-only prose and images remain unsupported; this patch does not pretend to add them.

**Observed limitation, pre-existing:** the no-body fallback at line 104 still visits every `p`, including nested descendants. For `<section><p>Outer<p>Inner</p>Tail</p></section>`, current output is `Outer`, `Inner`, `Tail`, `Inner`; baseline was `OuterInnerTail`, `Inner`. Evidence: `source-edges.jsonl`. Nested paragraphs are not conforming XHTML structure, so this is a non-blocking fallback limitation, not the reason to reject A. The ordinary valid `li > blockquote > p` case passes.

The six new unit cases cover normal ruby containers, nested blocks/lists, headings, furniture, image-only emptiness, a simple fragment, and tolerant HTML parsing. They are focused and use real DOM parsing. They miss CDATA and the fallback nesting limitation. The description above `extractXhtml` remains older than this patch and does not exactly describe its heading candidates; this is not a newly introduced blocker.

### Fix B

**Source-read:** the catch adds only `state.status = ''` beside the existing error assignment. Book/chapter/page assignments occur after parsing resolves, so parser failures do not mutate the prior book. No routing, extension validation, encoding, or URL-import change is bundled into B.

The new browser regression exercises the real file input with three failure types, checks loading removal and previous-book retention, and checks recovery. Its fresh context, Mode B, GET/HEAD-only loopback guard, and service-worker block are appropriate. The test depends on `tests/format-verification-20260917/fixtures/all-image-original.epub`, which is currently untracked along with the test; include that fixture or an equivalent generator when packaging the change. The independent verifier additionally tested the specifically requested TXT recovery, rather than relying only on the worker's Markdown retry.

## Automated gates and execution details

**Gates:** full `tests/unit/*.mjs` suite passed (28 tests, 5 suites); web TypeScript check passed; isolated current-source Vite build passed; existing reader and quality E2E assertions passed (2 tests). Logs: `unit.log`, `tsc.log` (empty output, exit 0), `build.log`, and `e2e.log`.

Versions observed locally: Node `v26.5.0`, npm `11.17.0`, TypeScript `5.9.3`, Vite `5.4.21`, Playwright `1.63.0`, Chromium `153.0.8010.12`, JSDOM `30.0.1`, JSZip `3.10.2`.

Repository working directory: `/Users/huyan00/mycode/interlinear-reader`. Exact commands and script entry points:

```sh
# E is shorthand for the actual absolute output path used by the commands.
E=/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-fix-round1-verifier-8wInaz

git status --short
git diff --stat
git diff packages/web/src/ingest/epub.ts packages/web/src/ui/app.ts > "$E/product.diff"
git diff --check
node --test tests/unit/*.mjs > "$E/unit.log" 2>&1
# Executed with packages/web as working directory:
../../node_modules/.bin/tsc --noEmit > "$E/tsc.log" 2>&1

# Current-source build and isolated harness setup. No dependency installation.
node "$E/prepare.mjs" > "$E/build.log" 2>&1
node "$E/start.mjs" > "$E/server.log" 2>&1
# start.mjs ran as an owned background process, PID 22015, port 5196.

# Executed with E as working directory:
./node_modules/.bin/playwright test > e2e.log 2>&1
node browser.mjs > browser.log 2>&1
node source-edges.mjs > source-edges.jsonl
node cdata-browser.mjs > cdata-browser.log 2>&1

# Executed from repository root:
ILR_BASE=http://127.0.0.1:5196 ILR_EVIDENCE="$E/lifecycle" node tests/import-error-lifecycle-regression/browser.mjs > "$E/lifecycle.log" 2>&1

lsof -nP -iTCP:5196 -sTCP:LISTEN
ps -p 22015 -o pid=,command=
kill -TERM 22015
```

The isolated harness copies the existing `scripts/stub-server.mjs` unchanged and builds current source into `E/packages/web/dist`. Existing E2E specs are copied with only their Playwright import changed to `./guard.mjs`; their assertions are unchanged. Their relative screenshot paths consequently target `E/artifacts/`, not shared repository artifacts. The temporary config uses one worker, no retries, its own reports, and blocked service workers. The guard permits only the exact loopback origin, with POSTs limited to `/mock-llm/`, and closes WebSockets. Existing specs use synthetic fake keys against this local deterministic stub, not paid services. These E2E results establish plumbing, not translation quality.

### Verifier harness corrections, retained honestly

1. The first isolated E2E run passed quality but failed the reader's `/dict/en/en.dict.00` length assertion: 573 characters instead of more than 1,000,000. The isolated Vite build intentionally omitted public-directory copying, but the verifier had not yet linked the existing split dictionary directory. The stub returned the SPA fallback. Added only a read-only link with `ln -s /Users/huyan00/mycode/interlinear-reader/packages/web/public/dict packages/web/dist/dict` in E. The rerun passed both unchanged specs. Initial log and artifacts remain in `e2e-initial-missing-shard.log` and `initial-e2e-artifacts/`.
2. The first independent browser script reached and passed all format/recovery cases, then used an overly strict array assertion for forced `.mobi` text. The reader had split one paragraph into two displayed fragments (`Synthetic forced extension remains ` and `plain text.`). Changed only the verifier assertion to compare joined source text. Final run passed the unchanged-defect check. Initial log and JSON remain in `browser-initial-fragment-assertion.log` and `browser/initial-fragment-observations.json`.

Neither correction changed product source or existing test assertions.

## Comparison with baseline and worker evidence

Baseline reference: repository `docs/research/format-browser-verification.md` and `/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-format-verification-20260917/`.

- Baseline ruby source `日本（にほん）` now becomes `日本` in the same original fixture.
- Baseline nested output concatenated ancestor text and then repeated the child. Current output emits each source segment once in order for normal body XHTML.
- Baseline all-image error retained `解析中…`; current failure removes that status and preserves the error and previous book.
- Real-book chapter count, opening order, and horizontal layout match the bounded baseline observation.
- Forced unsupported-extension fallthrough remains. Illustration support and div-only extraction were not expanded; the original synthetic fixture still has two imported text chapters rather than its image-only middle chapter.
- Worker A's `result.json` and unit before/after logs support its intended ruby/nesting repair. Worker B's `browser-observations.json` supports lifecycle repair. This verifier reran combined checks rather than treating those worker artifacts as independent proof.
- The CDATA comparison is stronger than source inspection: the baseline function was loaded from `git show 00c0f74:packages/web/src/ingest/epub.ts` into a temporary file, and both versions ran against the same input. Only the current version was additionally tested in Chromium.

## Safety, cleanup, and limits

Port 5196 had no listener at recovery. This verifier started and recorded PID 22015, verified its command and listening address before stopping it, and received clean background completion. No worker server was stopped. All own browser contexts closed in `finally`.

Independent format run: 10 allowed same-origin GET/HEAD requests, zero blocked attempts, zero WebSocket attempts, zero page errors. CDATA and lifecycle runs likewise recorded zero blocked attempts or page errors. All real-book interaction occurred in a no-key Mode B context allowing only GET/HEAD to the exact loopback origin, with service workers blocked. No book bytes were uploaded to any HTTP endpoint. No real-book screenshot, book copy, external evidence upload, paid LLM call, install, commit, or Tabbit interaction occurred.

`lh acceptance run list --json` returned `command not found: lh`. Evidence remains local; no published acceptance URL or uploaded coverage is claimed. All requested browser behaviors were observed locally, including the known failure. The additional CDATA check fails and blocks approval of A.

Full-book continuity, visual illustration support, binary MOBI/PDF conversion, native file-picker filtering, concurrent import races, full `npm run verify`, and production deployment were not tested in this round. No conclusion about paid translation quality follows from stub E2E.

## Round 2: independent re-review after CDATA repair

Date: 2026-09-17. Fresh verifier session, `main` at `00c0f74` plus the uncommitted fixes. The round-1 findings above remain a historical record; these verdicts supersede them for the repaired working tree.

### Final verdicts

- **Fix A: APPROVED.** The one-line repair preserves both CDATA-only paragraphs and mixed text/CDATA runs. Actual Chromium file imports preserve the ampersand and middle word. Ruby removal and nested-block ordering still pass.
- **Fix B: still APPROVED.** The all-image EPUB shows the actual error without stale loading, retains the prior readable book, and permits valid TXT recovery.
- **Combined delivery: approved for the scope of A and B.** The previously reported unsupported-extension fallthrough remains unchanged and is not covered by this approval.

### Evidence location and independence

All final round-2 scripts, generated fixtures, builds, logs, and screenshots are under this unique directory:

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-fix-round2-verifier-IdCbLz/`

Paths below are relative to that directory. The verifier read the repair evidence at `ilr-cdata-repair-dNbOjH` but did not treat its passing runs as proof. The current product source was rebuilt and exercised on an independently owned server at `http://127.0.0.1:5198`.

`setup.mjs` copies the inspected round-1 verifier harness into the new directory, changes the port, includes the dictionary link required by the existing E2E test, and replaces the former CDATA defect-reproduction assertion with the exact positive assertion. Existing reader and quality E2E assertions remain unchanged; only their Playwright import points to the local network guard. Their outputs and reports are isolated under `artifacts/`.

### Diff review: minimal repair, no scope creep

**Source-read and diff comparison:** `vs-round1.diff` compares the entire tracked product patch against round 1. Apart from the Git blob hash, the only difference is `packages/web/src/ingest/epub.ts:86`:

```diff
-    if (node.nodeType === 3) {
+    if (node.nodeType === 3 || node.nodeType === 4) { // Text or CDATA.
```

Node type 4 now follows the existing text path, including the `inBlock` restriction. Ruby removal, flushing, heading handling, spine filtering, and Fix B are unchanged. No debug logging or `debugger` statement was found in the EPUB file or product patch.

The requested `git diff packages/web/src/ingest/epub.ts tests/unit/epub-extraction-regression.test.mjs` is saved as `requested.diff`. The test file is **untracked**, so Git does not include it in that output. Direct inspection confirms seven focused cases, including the new exact-array assertion for the two CDATA paragraphs. `cmp` confirms that the file matches the repair worker's saved copy. The worker's `repair-only.diff` records the five-line test addition; an independent pre-repair test-file snapshot was not available in the prior verifier directory.

Whole-repository tracked diff statistics before and after execution were identical to round 1:

```text
packages/web/src/ingest/epub.ts | 37 ++++++++++++++++++++++++++++++-------
packages/web/src/ui/app.ts      |  2 ++
2 files changed, 32 insertions(+), 7 deletions(-)
```

Evidence: `product.diff`, `vs-round1.diff`, `diff-stat-before.txt`, `diff-stat-after.txt`, and `status-after.txt`. `git diff --check` passed. The same untracked path groups remain; the only repository edit by this verifier is this report section. No product or test file was edited by the verifier.

### Observed browser outcomes

These are executed UI observations, not conclusions drawn only from source. Both browser scripts launch real headless Chromium `153.0.8010.12` with a fresh context, Mode B, empty API-key storage, blocked service workers, and a guard allowing only GET/HEAD requests to the exact loopback origin. Source comparisons clone the rendered paragraph nodes and remove `.gloss` and `.ai-btn` before reading text.

| Check | Result | Observed evidence |
| --- | --- | --- |
| CDATA-only paragraph, including ampersand | **PASS** | Exact source `Visible prose & punctuation.` in `browser/cdata-observations.json`. |
| Mixed ordinary text and CDATA | **PASS** | Exact source `Before inside after.` in the same JSON. Both paragraphs appear in `browser/06-cdata-preserved.png`, visually inspected. |
| Ruby readings absent from source | **PASS** | `browser/observations.json`, `baseline-ruby-nested`: `始まり。「日本へ行く。」`, with no `にほん` or ruby fallback parentheses. Multiple `rt`, `rb`, `rtc`, and nested `rp` variants also pass. `browser/01-ruby-nested.png` visually inspected. |
| Nested blockquote order and uniqueness | **PASS** | Exact baseline sequence `絵の前。`, `絵の後。`, `外側。`, `内側。`, `終端。`, once each. Extended nested list/blockquote case yields `外。`, `中。`, `芯。`, `中終。`, `外終。`, once each in order. |
| Real Japanese EPUB opening | **PASS, bounded sample** | Read-only file-input import of the single matching `~/Downloads/処刑少女の生きる道…epub`. 26 chapters; index 4 begins `たまに、夢を見る。` then `日本の、行ってもいない学校の教室の夢だ。`. Writing mode remains `horizontal-tb`. Only those two short paragraphs are retained in the JSON. |
| All-image EPUB error without stale loading | **PASS** | Error `EPUB 未提取到正文段落`, zero `.status-line` nodes, prior `verifier-control` book retained and its source unchanged after reopening. `browser/03-image-error-no-loading.png` visually inspected. |
| Valid TXT recovery | **PASS** | Subsequent import displays `The people read again.`, correct book title, and empty error. `browser/04-txt-recovery.png` and `txt-recovery` observation. |
| Headings and spine filters | **PASS** | Extended fixture still exposes two chapters, clean title `日本`, ordered headings, and final chapter `最後。`; non-linear and navigation entries do not appear. |
| Forced plain-text `.mobi` fallthrough | **Known unchanged failure** | Additional control still imports the plain text. Recorded separately in `mobi-fallthrough`; not a new failure of A or B. |

The format run records 10 allowed requests; the CDATA run records 8. Both record zero blocked attempts, WebSocket attempts, and page errors. The real book was replaced with synthetic text before any screenshot. No real-book copy or screenshot was created.

### Automated gates and commands

All requested automated gates passed: **29 unit tests, 5 suites; web TypeScript check; isolated current-source build; 2 existing reader/quality E2E tests**. Evidence is in `unit.log`, `tsc.log` (empty, exit 0), `build.log`, `e2e.log`, and `artifacts/playwright.json`. The E2E tests use fake keys only against the local deterministic stub, with guarded requests; they do not establish paid translation quality.

Commands and entry points executed from the repository root unless otherwise noted:

```sh
E=/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-fix-round2-verifier-IdCbLz

git status --short
git diff packages/web/src/ingest/epub.ts tests/unit/epub-extraction-regression.test.mjs > "$E/requested.diff"
git diff > "$E/product.diff"
git diff --stat > "$E/diff-stat-before.txt"
git diff --check
node --test tests/unit/*.mjs > "$E/unit.log" 2>&1
# Working directory: packages/web
../../node_modules/.bin/tsc --noEmit > "$E/tsc.log" 2>&1

# Working directory: E
node setup.mjs
node prepare.mjs > build.log 2>&1
lsof -nP -iTCP:5198 -sTCP:LISTEN
node start.mjs > server.log 2>&1
# start.mjs runs in the background; owned PID 23412.
./node_modules/.bin/playwright test > e2e.log 2>&1
node browser.mjs > browser.log 2>&1
node cdata-browser.mjs > cdata-browser.log 2>&1

lsof -nP -iTCP:5198 -sTCP:LISTEN
ps -p 23412 -o pid=,command=
kill -TERM 23412
```

`prepare.mjs` copies the unchanged repository stub server, builds current source into `E/packages/web/dist`, and links existing dictionaries and fixtures read-only. No dependencies were installed.

### Harness caveat, cleanup, and limits

An optional early baseline comparison tried to strip TypeScript with regular expressions and failed with verifier-script syntax errors. It was abandoned, not counted as product evidence. Those files were initially created under a new `r2` subdirectory of the prior verifier output and then moved into this round's `abandoned-source-probe/`, together with two scratch files initially placed in `/tmp`. Existing round-1 artifacts were not overwritten. The successful gates and Chromium results above do not use that probe.

Port 5198 had no listener before startup. The verifier confirmed that PID 23412 was `node start.mjs` and listened only on `127.0.0.1:5198`, then stopped that PID. The owned background process exited 0. No other server was stopped; both browser scripts close their browsers in `finally`.

No product edits, test edits, commits, installs, Tabbit use, paid LLM calls, or external evidence uploads occurred. `lh acceptance run list --json` returned `command not found: lh`; evidence is local, and no published acceptance or uploaded coverage is claimed. The round-1 limitations remain: this is not a full-book continuity audit, an illustration-support test, a binary MOBI/PDF test, a concurrency test, or a deployment check. Empty-TXT and malformed-EPUB lifecycle cases were not rerun in round 2; Fix B's all-image failure and TXT recovery were observed again directly.
