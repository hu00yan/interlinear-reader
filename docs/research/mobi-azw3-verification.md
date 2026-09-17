# Independent MOBI and AZW3 verification

Date: 2026-09-17. Baseline: `00c0f74`, plus the concurrent uncommitted lanes.
Reviewer: independent verifier, not the implementation worker.

## Verdict: CHANGES-NEEDED

The requested functional checks pass. Two delivery issues remain:

1. **Distribution attribution missing (required fix).** `packages/web/src/ingest/foliate-mobi.js:1–25` includes the correct MIT notice, but its ordinary block comment disappears during the production build. Neither `packages/web/dist/assets/mobi-CxNt6Fok.js` nor another distributed notice file contains John Factotum's copyright and permission notice. The upstream license requires the notice in copies or substantial portions. Preserve a legal comment in the bundle, or ship the complete notice with the deployed assets. Rebuild and verify the distributed copy, not just the source header.
2. **Real-sample format claim incorrect (documentation fix).** `docs/research/mobi-azw3-implementation.md:84` labels 牧歌 as MOBI7. Its record 0 is version 7, but EXTH 121 selects record **50**, whose version is **8**. The adapter therefore imports its **KF8 half**. This sample verifies combo selection, not the standalone MOBI7 path. Correct the report and qualify real-world MOBI7 coverage. Synthetic MOBI7 coverage passes; no additional real book was accessed for this review.

No product files were edited by this verifier. Builds refreshed tracked `packages/web/dist` as authorized. The settings-warning region and userscript lane were left untouched.

## Evidence and environment

All evidence below is local to this unique directory, referred to as `$E`:

```text
/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-mobi-verifier-HHrMwc/
```

- Node `v26.5.0`, TypeScript `5.9.3`, Vite `5.4.21`, Playwright `1.63.0`, Chromium `153.0.8010.12`, JSDOM `30.0.1`, esbuild `0.21.5`.
- Browser: own headless Chromium, fresh context per sample, 1280 × 900 viewport, service workers blocked.
- Server: independent copied build and stub on `http://127.0.0.1:5204`. No shared server was stopped.
- Real-book guard: only this origin's GET and HEAD requests allowed. **27 allowed requests, 0 blocked attempts, 0 page errors**. No key, external LLM request, install, Tabbit access, or paid call.
- Existing e2e guard: only the same loopback origin allowed, including its deterministic mock-LLM POST routes. This suite does not use a live provider.
- `snapshot/` and `snapshot-manifest.json` preserve the reviewed source. All eight compared files remained unchanged at the final check. `reviewed.diff` captures the relevant tracked diff.
- Acceptance publication was unavailable: `command -v lh` returned exit 1. Nothing was installed or uploaded. Evidence remains local for the coordinator.

## Executed checks

| Check | Result | Evidence |
| --- | --- | --- |
| Dedicated MOBI unit suite | PASS: 8 tests | `mobi-unit.log` |
| Full `tests/unit/*.mjs` suite | PASS: 37 tests, 6 suites | `unit.log` |
| TypeScript | PASS, exit 0 | `tsc.log` |
| Root `npm run build` | PASS, exit 0 | `build.log` |
| First-screen size gate | PASS: 25.7 KiB gzip against 60 KiB; MOBI lazy chunk 10.0 KiB | `build.log` |
| Existing reader and quality e2e | PASS: 2 tests, 3.8 seconds | `e2e.log`, `artifacts/playwright.json`, `artifacts/test-results/` |
| Tarball provenance and source license | PASS | `foliate-js-1.0.1.tgz`, `package/`, `upstream.diff`, `provenance.txt` |
| License in deployed build | FAIL: notice absent | `environment.json`, copied `packages/web/dist/` |
| Both requested real imports | PASS | `browser/results.json`, screenshots |
| Horizontal rendering and chapter navigation | PASS for both | `browser/results.json`, screenshots |
| Bounded bidirectional continuity | PASS for both | `browser/results.json` |
| Synthetic encryption rejection | PASS: clear DRM error and loading state cleared | `browser/encrypted.png`, `browser/results.json` |
| Plain text renamed `.mobi` | PASS: rejected, not text fallback | `browser/renamed-text.png`, `browser/results.json` |

Commands ran from the repository root unless a working directory is stated:

```sh
node --test tests/unit/mobi-ingest.test.mjs
node --test tests/unit/*.mjs
# Working directory: packages/web
../../node_modules/.bin/tsc --noEmit
# Working directory: repository root
npm run build
# Working directory: $E
node setup.mjs
node start.mjs
./node_modules/.bin/playwright test
node browser-verify.mjs
node headers.mjs
curl --fail --silent --show-error --location https://registry.npmjs.org/foliate-js/-/foliate-js-1.0.1.tgz --output foliate-js-1.0.1.tgz
tar -xzf foliate-js-1.0.1.tgz package/mobi.js package/LICENSE package/package.json
diff -u package/mobi.js snapshot/foliate-mobi.js
```

The initial root-level TypeScript invocation printed help because the root has no tsconfig; it was not counted as a pass. The corrected invocation above and the build's own type check both succeeded. The initial browser comparison harness lacked `CSS.escape` in JSDOM, before browser import; the final harness supplies a selector-escape helper for the unused selector cache. The product browser uses native `CSS.escape`. The final browser run passed. The worker's 37-test count refers to the full unit suite, not the eight-test MOBI file.

## Source review

These findings are source-read unless explicitly marked as executed.

### File handler and integration

- `packages/web/src/ui/app.ts:378–439`: extension routing covers `.mobi`, `.azw3`, and `.azw`, case-insensitively. Other names are sniffed for `BOOKMOBI` at bytes 60–67. The dynamic parser import occurs only for that route. Existing EPUB, Markdown, and plain-text paths remain.
- A `.mobi` extension short-circuits the UI's sniff. `validateMobi` then checks the actual header. **Observed:** renamed plain text receives `无效 MOBI/AZW3：文件头或记录表损坏（仅支持 BOOKMOBI，不支持 KFX）`; there is no TXT fallback.
- Fix B remains intact at lines 434–438: the catch sets the error and clears `state.status`. Assignment to `state.book` happens only after successful parsing. The browser rejection screenshot still displays the old `Hello Reader` book.
- The app diff is **not globally file-handler-only**: it also contains the expected separate settings-key-warning hunk at lines 2634–2640. That hunk was reviewed only to establish ownership and was not edited.
- `types.ts` adds `source: 'mobi'` without changing the Book shape. `vite.config.ts` groups the adapter and vendor module into a lazy chunk. `check-size.mjs` excludes that chunk while the existing module-preload ban remains. The adapter also imports EPUB extraction, so first MOBI use loads the EPUB dependency graph; it is not part of the first screen.
- `extractXhtml` is the shared extraction path, including the concurrently reviewed CDATA, ruby, and nested-block fixes. Div-only text remains unsupported, consistent with the existing extraction contract.

### Header bounds and encryption order

`packages/web/src/ingest/mobi.ts:9–59` checks the 78-byte PDB header, exact magic, nonzero 16-bit record count, complete table, and strictly increasing record offsets. Appending `file.size` to the table also rejects an out-of-file final offset. Offsets cannot overlap the table. Arithmetic uses JavaScript numbers, not signed 32-bit coercion: 16-bit counts and 32-bit field sums here do not overflow or truncate. Blob clamping does not bypass the monotonic bounds check.

The selected record checks its minimum size, MOBI magic, declared header length, supported compression, and available text-record count. EXTH traversal checks its declared extent, each record header, each size, and the exact four-byte boundary payload. A huge EXTH count cannot walk beyond the declared end without rejection.

Encryption is read after a 16-byte minimum check and **before** compression setup. `parseMobi` awaits all pre-validation before importing or opening Foliate. Both legacy and selected combo headers are checked. Unit tests exercise encryption values 1 and 2; the browser test observes the same clear rejection on a minimal encrypted synthetic file. No decryption is attempted.

Combo selection follows EXTH 121, rejects zero/out-of-range boundaries, and requires a version-8-or-newer target. Unit coverage confirms modern metadata and text selection. Real 牧歌 confirms record-50 selection. The vendor retains a broad fallback catch while reading combo headers. Adapter validation covers the common structural failures, but this is not exhaustive validation of every vendor metadata field. There is no claim that every corrupt combo must reject rather than fall back.

This wrapper is a header validator, not a complete untrusted-binary validator. It does not validate every HUFF, INDX, TAGX, FDST, fragment, or title offset. Title slicing can truncate silently; malformed downstream records can expose generic parser errors. No adversarial payloads or resource-exhaustion experiments were constructed for this review.

### Memory and large records

No large-book memory guarantee is established. `checkRecord` reads the entire record even when it needs only header data, without a file or record cap. The parser runs on the main thread without a cancellation budget.

- MOBI7 accumulates all decompressed text through repeated typed-array concatenation (`foliate-mobi.js:698–724`), then creates a byte-character array, joined string, and section buffers. Repeated cumulative copying can be quadratic in total text size for fixed-size records.
- KF8 retains expanding head/tail buffers (`1121–1144`) and repeatedly reconstructs skeletons (`1150–1169`). Sequential extraction still accumulates raw text and all output paragraphs.
- HUFF/CDIC uses recursive dictionary expansion and repeated concatenation (`326–348`). Output size and recursion are not explicitly bounded by this adapter. The implementation report's broad O(text) performance description is not a safe complexity guarantee.
- `finally` calls `destroy()` after successful open, including extraction failures. Resource rewrite/load methods are not used for the text-only import, so normal extraction avoids image/font blob URLs. Buffer caches rely on garbage collection after the parser becomes unreachable.

These are documented hardening and performance follow-ups, not evidence of a failure on the two bounded samples. This verification does not certify resilience to hostile files or very large books.

### Tolerant HTML fallback

The sole executable local vendor change is `KF8.createDocument` at lines 1171–1175. It parses XHTML first and retries HTML only when the result contains `parsererror` or lacks a root namespace. It does **not** catch exceptions from decompression or section assembly. Unlike `loadSection`, it does not mutate the parser's MIME mode for later sections.

This intentionally masks XML well-formedness failures, including benign named HTML entities, missing XHTML namespaces, and malformed markup. It can also recover partial prose from genuinely damaged markup without a corruption warning. That trade-off matches the existing EPUB tolerant extraction and upstream `loadSection` behavior. The unit case verifies `&nbsp;` recovery without displaying parser-error text. Binary correctness is not proved by successful tolerant parsing. No broader local catch or unexpected vendor change was found.

### Vendor provenance

The independently fetched npm tarball's SHA-512 integrity exactly matches the implementation report:

```text
sha512-Cj4h2ub5aVA+yUgbhvVhCyxwi0GPF4pyNBa6Lw9+6WKY1ReBxipItn2kEBO6u7Vu/xYXjK711R74+t+yW/0u5w==
```

The complete diff has exactly two hunks: the provenance/full MIT header addition and the three-line tolerant fallback replacing one return statement. The source notice matches `package/LICENSE`. **Source provenance verdict: PASS. Distribution notice verdict: FAIL**, as described above. The gitHead is recorded in the source/report; tarball-byte equivalence and integrity, rather than an independent git checkout, establish this review's provenance proof.

## Real-browser observations

Files were read directly from `~/Downloads`, never copied into the repository or served directories. Their exact basenames and header records are in `sample-headers.json`; SHA-256 values are in `browser/results.json`.

| Sample | Observed format and import | Bounded continuity |
| --- | --- | --- |
| 牧歌, 474,091 bytes | Combo: version 7 record 0, EXTH boundary 50, selected version 8, uncompressed. Five imported chapters. Chapter 3 is the main bilingual text, 1,778 paragraphs. | Chapter 3, first three spreads: 1,419 non-whitespace characters, 245 word tokens. |
| 水手比利·巴德, 887,832 bytes | Standalone version 8, PalmDOC compression. Two imported sections: `封面` (1,732 paragraphs) and `Table of Contents` (48 paragraphs). | Chapter 1, first three spreads: 1,693 non-whitespace characters, 151 word tokens. |

For both, the selected source language is Auto, with no key. The mode control is switched to B and its badge asserted. The existing Auto-without-key warning remains visible even in B; this is not an import error. Visible content is readable, horizontal, and free of parser-error text in the inspected screenshots. No LLM output was used.

Chapter navigation visits the last chapter and returns to the sampled chapter. Continuity concatenates the exact normalized source text from three consecutive rendered spreads and compares it with the chapter prefix extracted by the same adapter in JSDOM. It then verifies exact text and `(paragraph index, token index, surface)` equality on reverse and forward replay. This checks reader continuity against imported text, not independent full-book decoding accuracy. Punctuation is included in the text comparison; whitespace is normalized away. Nothing is claimed beyond those bounded prefixes.

The two-section AZW3 result is consistent with Foliate's skeleton/fragment section mapping. The importer does not split chapters by NCX labels. This review observes two sections, not a claim that the book has only two literary chapters.

Screenshots captured in `browser/`:

- `muge-ch1.png`, `muge-last.png`, `muge-continuity-page3.png`
- `billybudd-ch1.png`, `billybudd-last.png`, `billybudd-continuity-page3.png`
- `encrypted.png`, `renamed-text.png`

The two continuity-page screenshots and the encryption-error screenshot were opened and visually inspected by this verifier. JSON and DOM assertions support the other captures. `browser/network-audit.json` records the final real-book run; e2e network attachments are separate.

## Handoff

All execution checks requested for these two samples are complete. Before approval, preserve the MIT notice in deployed output and correct the real-MOBI7 evidence claim. The report also records source-read memory and malformed-input limitations without claiming they were stress-tested. No commits or product edits were made.

## Round-3 fix note — repair worker, 2026-09-17

This is a subsequent repair observation, not a rewrite of the independent verdict above.

- **Attribution repaired:** `mobi.ts` exports and logs the full `FOLIATE_MOBI_LICENSE`.
  A verbatim full-string check against rebuilt `mobi-CxqTDb25.js` passed, and a
  real import emitted exactly that notice in the browser console. The source-side
  `packages/web/src/ingest/FOLIATE-MOBI-LICENSE.md` covers compiled distribution.
  设置 now contains an About card for Foliate.js (MIT, vendored 1.0.1), JSZip,
  marked, and JSZip helpers, with license labels and upstream links. It does not
  preload the MOBI chunk; the settings key warning was not changed.
- **Claim corrected:** implementation report now identifies 牧歌 as COMBO
  (v7 record 0 → EXTH 121 boundary 50 → v8), proving KF8 combo selection only.
  Bounded top-level Downloads listing found six `.mobi` files: that combo plus
  five non-combo version-6 headers. Only PDB metadata and one/two header records
  were inspected per file. No non-combo v7 candidate exists in that bounded set:
  **no standalone-MOBI7 real sample locally; MOBI7 covered by synthetic tests only**
  (the requested v7 check; v6 candidates were not substituted or browser-imported).
- **Re-run gates:** dedicated MOBI 8/8; full unit 37/37 (6 suites); TypeScript
  exit 0; root build exit 0; size gate 26.4 KiB first-screen gzip / 60 KiB,
  MOBI lazy chunk 10.9 KiB. No size-gate changes in this repair.
- **Quick production smoke:** own verified PID 32007, `127.0.0.1:5206`, fresh
  Chromium, no key, GET/HEAD-only origin guard, blocked service workers/WebSockets.
  About card and upstream links visible/asserted; 牧歌 imports five chapters;
  horizontal chapter-3 text, exact next/previous replay, last-chapter navigation,
  and full runtime notice pass. Audit: 9 allowed, 0 blocked, 0 page errors.
  This is bounded smoke, not a new complete E2E or full-book decoding claim.

Evidence root:
`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-mobi-repair-A6rPON/`.
Logs: `mobi-unit.log`, `unit.log`, `tsc.log`, `build.log`, `browser.log`.
Checks: `license-check.json`, `sample-headers.json`, `browser/results.json`,
`browser/network-audit.json`. Screenshots: `browser/about-settings.png`,
`browser/about-block.png`, `browser/muge-combo-{import,body,last}.png`.
The About block and chapter-3 screenshots were opened for visual inspection.
No installs, commits, uploads, Tabbit use, paid calls, userscript edits, or
unowned-process shutdowns. `lh` unavailable; local evidence handed to coordinator
for final end-to-end verification.
