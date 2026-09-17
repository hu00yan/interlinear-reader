# MOBI / AZW3 (KF8) ingest implementation

Coordinator note (2026-09-17, user decision): third-party license attribution must also be
visible in the web app itself — add an About block on the existing 设置 page listing Foliate.js
(MIT), JSZip, marked and other bundled third-party code with licenses and upstream URLs;
GitHub-side attribution via LICENSE/NOTICE. The runtime `FOLIATE_MOBI_LICENSE` constant remains
the fallback tied to the parser chunk. Include this About block in the fix scope.

Date: 2026-09-17. Author: implementation worker (subagent). Scope: real browser-side parsing of
unencrypted MOBI7 and KF8/AZW3, per approved plan. No OCR, no DRM bypass, no extension renaming.

## Design

- **New module `packages/web/src/ingest/mobi.ts`**: `parseMobi(file, lang): Promise<Book>`.
  - Pre-validation pass (`validateMobi`) before any decompression: PDB header magic `BOOKMOBI`,
    record-count sanity, monotonic record-offset table, record-0 MOBI header (magic, length,
    compression ∈ {1, 2, 17480}, text-record count), EXTH walk with strict bounds. Encryption
    (`encryption != 0`) is rejected with a clear user-facing DRM message — checked for the
    standalone header **and** the KF8 half of combo files before decompression ever runs.
    For combo files (EXTH record 121 `boundary`), the KF8 half's header is validated the same
    way; a damaged legacy header is rejected rather than silently falling back.
  - HTML extraction is delegated to vendored Foliate parser sections; each section document is
    serialized and fed through the existing `extractXhtml` pipeline (`ingest/epub.ts`), so the
    round-1 ruby/CDATA/nested-block fixes apply unchanged to MOBI content.
  - Chapter mapping: sections with paragraphs become `BookChapter`s (`chN`, title from
    h1/h2/title, else `Chapter N`); image-only/empty sections are skipped; a book with zero
    paragraphs throws `MOBI/AZW3 未提取到正文段落（不支持图片扫描/OCR）`.
  - `Book.source` is the new `'mobi'` variant in `types.ts`. Language: caller's selection wins,
    same as EPUB (metadata language is not used to override).
- **Dependency route: vendored single module.** `foliate-js@1.0.1` exists on npm but pulls an
  unrelated runtime dependency (`construct-style-sheets-polyfill`) that the text-only path never
  uses. The tarball (integrity
  `sha512-Cj4h2ub5aVA+yUgbhvVhCyxwi0GPF4pyNBa6Lw9+6WKY1ReBxipItn2kEBO6u7Vu/xYXjK711R74+t+yW/0u5w==`,
  gitHead `f52d42c6127d0ad981a2c67634113541b17ae01e`, MIT) was downloaded and its single
  `mobi.js` vendored verbatim as `packages/web/src/ingest/foliate-mobi.js` with the full MIT
  license header and provenance comment. One local change: `KF8.createDocument` now applies the
  same tolerant `text/html` fallback as `loadSection` (upstream parses strictly there too but
  `loadSection` re-parses on `parsererror`; without this, XHTML-invalid KF8 sections surfaced
  `parsererror` XML as source text). No other edits.
- **Wiring (`app.ts`, file-handler region only)**: input `accept` adds `.mobi,.azw3,.azw`;
  handler routes `.mobi/.azw3/.azw` **or** any file whose bytes 60–68 are `BOOKMOBI` (header
  sniff, so mislabeled files work) to the lazy `ingest/mobi.js` import. Unknown extensions keep
  the shipped text-fallback behavior; EPUB/TXT/MD paths unchanged.
- **Size budget**: `mobi.ts` + `foliate-mobi.js` form a lazy `mobi` chunk via `manualChunks`
  (`vite.config.ts`); `check-size.mjs` lazy pattern extended with `mobi`. Measured first-screen
  total 25.3KB gzip vs 60KB limit; the mobi chunk itself is 10.0KB gzip, loaded only on import.

## Commands

```sh
# from repo root
node --test tests/unit/*.mjs                       # full unit suite incl. new mobi-ingest
cd packages/web && ../../node_modules/.bin/tsc --noEmit
cd packages/web && node scripts/copy-dict.mjs && node scripts/split-dict.mjs && \
  ../../node_modules/.bin/vite build && node scripts/check-size.mjs

# isolated harness (own port 5199, evidence dir below)
E=/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-mobi-implementation-VuPRts
node "$E/setup.mjs"; node "$E/start.mjs"           # stub server, loopback-only, PID 25754
cd "$E" && ./node_modules/.bin/playwright test     # existing reader+quality specs via guard.mjs
cd "$E" && node browser-real.mjs                   # real-sample verification
```

## Unit coverage (`tests/unit/mobi-ingest.test.mjs`, 8 cases)

Fixtures are built byte-by-byte in the test (PDB header, MOBI/EXTH records, PalmDOC literal-run
compression, INDX/TAGX/IDXT skeleton+fragment indexes, minimal HUFF/CDIC stream); no copyrighted
books in the repo:

1. record-0 title + `<mbp:pagebreak>` chapters + selected lang + ruby/nested extraction
2. EXTH title precedence + PalmDOC UTF-8 literal runs
3. KF8 skeleton/fragment reassembly in order + CDATA preservation
4. combo files prefer the KF8 half, including its EXTH metadata
5. encryption rejection (values 1 and 2) on standalone and combo KF8 headers, before decompression
6. non-MOBI header, truncated record table, bad combo boundary, image-only emptiness → clear errors
7. malformed KF8 HTML tolerated (no `parsererror` leakage)
8. minimal HUFF/CDIC (compression 17480) dictionary-stream decompression

## Real-sample browser verification (read-only, bounded)

Harness: own stub on `http://127.0.0.1:5199`, fresh Chromium context per book, service workers
blocked, route guard allowing only loopback GET/HEAD (audit JSON below), no API key, Mode B
switched via the app's own mode-select control (badge asserted 模式 A→B). Books imported via
`setInputFiles` straight from `~/Downloads`; never copied into the repo or served dirs, never
uploaded (network audit: zero blocked attempts, zero page errors, only loopback asset/dict/fixture
GETs). Findings honestly recorded:

| Sample | Format | Result |
| --- | --- | --- |
| 牧歌….mobi (474,091 B) | COMBO: v7 record 0 → EXTH 121 boundary 50 → v8 KF8 | Imports as 5 chapters; title from metadata. First page is the CIP/publication block (front matter, expected). Text clean horizontal-tb Chinese; no mojibake. `牧歌` main body = chapter 3 (1778 段). Page turn + chapter nav verified (5/5 then back to 1/5). |
| 水手比利·巴德….azw3 (887,832 B) | KF8 | Imports as 2 "chapters" — the book's spine has only two large sections (`封面` 1732 段, `Table of Contents` 48 段); section granularity comes from the file, not the parser. 613-page first section paginates and turns correctly; text clean, correct metadata title. |

牧歌 proves **KF8 combo selection**, not standalone MOBI7 parsing. The historical evidence
filenames containing `muge-mobi7` below are mislabeled; they are retained as original artifacts,
not evidence of standalone MOBI7 coverage.

Both: `writingMode: horizontal-tb`, page-turn reproducibility true in both directions,
bounded sample only (no full-book continuity audit). Chapter counts this coarse are a property
of these files' internal sectioning, not a defect introduced here.

## Evidence paths (unique temp dir)

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-mobi-implementation-VuPRts/`

- `browser/muge-mobi7-observations.json`, `browser/billybudd-kf8-observations.json`
- `browser/muge-mobi7-0{1,2,3}-*.png`, `browser/billybudd-kf8-0{1,2,3}-*.png` (visually inspected)
- `browser/network-audit.json` (0 blocked, 0 page errors, GET/HEAD loopback only)
- `e2e.log` (2 passed), `artifacts/test-results/*/network.json` (0 blocked)
- harness: `setup.mjs`, `start.mjs` (PID 25754, port 5199), `tests/e2e/guard.mjs`,
  `playwright.config.mjs`, `browser-real.mjs`

## Round-3 repair and re-verification (2026-09-17)

The distribution notice is now executable data, not just a source comment:
`mobi.ts` exports the full `FOLIATE_MOBI_LICENSE` (version, gitHead, upstream,
local fallback change, copyright, permission and warranty) and calls `console.info`
after header validation. `packages/web/src/ingest/FOLIATE-MOBI-LICENSE.md` records
source and deployed-output obligations. The existing 设置 page now has a
**关于 · 第三方代码** card listing Foliate.js, JSZip (MIT option), marked,
and JSZip compression/runtime helpers with license labels and upstream URLs.
This repair edits only `renderSettings` in `app.ts`; the key warning is retained.
The About card does not import or preload the MOBI chunk.

Bounded local search: six top-level `~/Downloads/*.mobi` files were listed;
read-only PDB metadata and at most two header records per file were inspected
(no text decompression, uploads, or copying books). 牧歌 is the sole v7 record-0
candidate and selects v8 record 50. The other five have version-6 headers and
no EXTH 121 boundary; none is a non-combo version-7 sample. Therefore:
**no standalone-MOBI7 real sample locally; MOBI7 covered by synthetic tests only**.
Here this statement means the requested standalone version-7 real-book check;
version-6 legacy-family candidates were not substituted or browser-imported.

Final repair evidence directory (`$R`):

```text
/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-mobi-repair-A6rPON/
```

- `mobi-unit.log`: 8/8 passed; `unit.log`: 37/37 passed, 6 suites.
- `tsc.log`: `packages/web` TypeScript check exit 0.
- `build.log`: root `npm run build` exit 0, first-screen gzip **26.4 KiB / 60 KiB**;
  lazy MOBI **10.9 KiB**. The existing module-preload gate remains intact.
- `license-check.json`: the **entire** source notice is present verbatim in
  built `mobi-CxqTDb25.js`, with a retained `console.info` call.
- `sample-headers.json`, `headers.mjs`: bounded header observations and reproducible reader.
- `browser/results.json`: production-build browser smoke PASS. About text and
  Foliate/JSZip/marked upstream links asserted; no MOBI preload from Settings;
  console output exactly matches the full notice on 牧歌 import. Five chapters,
  chapter-3 horizontal rendering, next/previous exact spread replay (558 and
  233 non-whitespace characters), and last-chapter navigation passed.
- `browser/network-audit.json`: 9 allowed GET/HEAD requests to the own origin,
  0 blocked attempts, 0 page errors. Own stub at `127.0.0.1:5206`, PID 32007
  (command line verified), fresh Chromium context, service workers and WebSockets
  blocked, empty API key. No external requests or paid calls.
- Screenshots: `browser/about-settings.png`, `browser/about-block.png`,
  `browser/muge-combo-import.png`, `browser/muge-combo-body.png`,
  `browser/muge-combo-last.png`. About and chapter-3 captures opened and visually
  inspected: visible attribution and readable horizontal text. The pre-existing
  Auto-without-key warning remains visible in mode B; it is not an import error.
- Harness: `setup.mjs`, `start.mjs`, `browser-smoke.mjs`; `browser.log` is the
  successful final run. No standalone-v7 browser check is claimed.
- `lh` is unavailable (`command -v lh` exit 1); evidence stayed local, with no
  installs or uploads. Complete E2E remains the coordinator's next step.

## Limitations

- **KFX / DRM out of scope**: encrypted files are detected (encryption flag, standalone and
  combo) and rejected with a clear message before any decompression; no DRM circumvention.
- **Big-book memory unknown**: MOBI7 decompresses the whole text into memory and KF8 caches
  raw slices front/back; very large books were not memory-profiled.
- **HUFF/CDIC performance**: correctness is covered by a synthetic unit case; real-world
  HUFF/CDIC throughput on large books is untested. Dictionary decompression is recursive with
  caching; repeated buffer concatenation can make total work superlinear. No O(text) guarantee
  or hostile-input resource bound is established.
- Section/chapter granularity follows each file's internal structure (some KF8 books put the
  whole text in one or two sections); no synthetic chapter re-splitting is attempted.
- `packages/web/dist` is git-tracked in this repo, so the verification build refreshed its
  tracked+untracked asset hashes (including the new lazy `mobi` chunk). That is build output,
  not source; reviewers should regenerate via `vite build` rather than review hashes.
