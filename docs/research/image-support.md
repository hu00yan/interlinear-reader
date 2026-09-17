# Image support (按序保图) — implementation record

Date: 2026-09-17. Baseline: `main` @ `76fafbf` + uncommitted reviewed changes (MOBI ingest, D1 fix, userscript lane). This document records the image-preservation feature implementation and its verification.

## Goal (user-approved)

Mixed text+image EPUB books keep images **in reading order** between text paragraphs; image-only chapters no longer disappear from the book; an image-only whole book shows images instead of failing with 「EPUB 未提取到正文段落」. No OCR — images render as-is. Annotations (dictionary/LLM) apply to text only. MOBI images: best-effort; left text-only (below).

## Design chosen and why

Additive optional model, zero churn to the existing text pipeline:

- `BookChapter.blocks?: Array<{kind:'p', text} | {kind:'img', src, alt?}>` — reading order. `paragraphs: string[]` stays and still mirrors the p-blocks, so every existing consumer (tokenize, annotate, LLM backfill, TXT/MD/URL ingest, export fallback, all unit tests) is untouched.
- `Book.assets?: Record<path, Blob>` — raw image bytes keyed by archive path. No base64 in the Book; object URLs are created lazily at render time and revoked on book replace/unload.
- A flow entry is `{text:'', tokens:[], image:{src,alt,height}}` — one **geometry anchor, zero language tokens**. Images are never tokenized, never sent to dictionary or LLM, and export excludes them from annotation by construction.

Chosen over a parallel `imagesInOrder` map because the pagination pipeline is a flat token-index flow; a block must occupy a position in that same flat array to be paginated and rendered in order. `blocks` is the only structure that preserves interleaving without touching `FlowGeom` arithmetic.

## Files changed

| File | Change |
|---|---|
| `packages/web/src/types.ts` | `BookBlock` union, `BookChapter.blocks?`, `Book.assets?` |
| `packages/web/src/ingest/epub.ts` | `resolveEpubPath` (OPF-base relative resolution; rejects `http(s)`/`data`/`//`/archive-escape); `extractXhtml` emits ordered blocks, captures `img`/`svg image` `src`+`alt`; `parseEpub` keeps only `image/*` manifest-typed zip entries as `assets` blobs, resolves each img src against its spine doc, drops unresolvable refs, keeps image-only chapters (title fallback `插图 N`, reader TOC falls back too) |
| `packages/web/src/reader/blocks.ts` (new) | `chapterFlow` merge (p-blocks ↔ annotated paragraphs by index, images interleaved, `-1` orig for images), `flowLength` (image = 1 anchor), `BookImageUrls` lazy blob-URL pool with revoke |
| `packages/web/src/reader/render.ts` | `AnnotatedParagraph.image?`; `renderOnePara` renders a fixed-height `figure.reader-image` (`object-fit: contain`) — identical in probe and page, so pagination geometry never shifts on image load |
| `packages/web/src/ui/app.ts` | `replaceBook` (blob-URL lifecycle on import/reimport + pagehide/pageshow); flow built via `chapterFlow` in both词典 and auto branches; probe completeness counts `.reader-image` boxes; image anchor = 1 token in `flowIndexOf`; geometry cache key includes image cap; chapter TOC counts `N图`; LLM job collector skips image entries |
| `packages/web/src/export/epub.ts` | images packaged under `OEBPS/images/`, OPF manifest entries, chapter XHTML `<img>` with OEBPS-relative src (fixed `OEBPS/OEBPS/...` double-prefix), blocks-order merge, `buildEpubFiles` now async (asset bytes) |
| `packages/web/src/ingest/mobi.ts` | code comment: images intentionally not wired (see MOBI decision) |
| `packages/web/scripts/verify-track-a.ts` | `buildEpubFiles` is async now — await + String() coercions |

## Consumer migration list (audited, all 25 `.paragraphs` consumers)

Render/paginate (`app.ts` reader flow) — migrated to `chapterFlow`. Export (`export/epub.ts`) — blocks-order merge. LLM glossary/backfill — image entries skipped (`p.image` guard). TOC labels — `N图`. TXT/MD/URL ingest, verify-track-a, unit tests — untouched (additive field absent → behavior identical).

## Image geometry and pagination

An image block reserves `height = page capacity (cap)` px, one full-column slot, measured by the same hidden probe as text lines. Because the slot is fixed before pagination (not the natural bitmap height), loading an image can never reflow the page; tall images are letterboxed via `object-fit: contain` (never cropped), and the column-overflow self-check reports 0px overflow at 1280 and 390 on real fixtures.

## Export

Exported EPUB includes images in reading order, referenced as `images/imgN.<ext>` relative to `OEBPS/`, with OPF manifest `media-type` from the stored Blob and escaped alt text. Round-trip re-import restores identical block order and byte-identical assets (`tests/unit/image-roundtrip.test.mjs`, which failed before the `OEBPS/`-prefix fix and passes after).

## MOBI/AZW3 decision: text-only (honest limitation)

The vendored foliate API exposes `loadRecindex`/`loadResource` and KF8 documents carry `img[recindex]`, so wiring is *possible*, but the current MOBI pipeline flattens documents through `extractXhtml` before chapter assembly; threading image blocks through would require a second resource pipeline (recindex→Blob→`Book.assets`) plus per-book KF8 flow-order verification. Per the agreed "do NOT fake support", MOBI remains text-only with an explicit comment in `mobi.ts`; image-only MOBI still reports its text-only limitation. No OCR anywhere.

## Memory policy for big books

Asset blobs live in `Book.assets` for the session only; object URLs are pooled per book, created on first render, and revoked on book replacement, re-import, and `pagehide`. No base64 in the model; export re-reads blobs on demand. Fixed-layout EPUB (absolute-positioned spreads) remains out of scope — extraction is block-order based, not layout-preserving.

## Test results

- `tests/unit/image-blocks.test.mjs` (4): inline image position between text runs (dedup still applies per side), path resolution incl. percent-encoding and hostile-scheme rejection, image-only spine chapter survival + external/non-image exclusion, flow mapping (`-1` orig for images, URL revoke on book swap).
- `tests/unit/image-roundtrip.test.mjs` (2): export emits image-only chapter XHTML + zip entry `OEBPS/images/img1.png` + OPF item; full export→import round trip preserves order (`p,img,p`) and asset bytes.
- Full suite `node --test tests/unit/*.mjs`: **54/54** (all pre-existing tests, including the images-dropped baseline assertions in `epub-extraction-regression.test.mjs`, still green — `extractXhtml` keeps returning `paragraphs` for image-only input).
- `tsc --noEmit`: clean. `npm run build`: PASS, first-paint gzip 27.0KB ≤ 60KB.
- Existing e2e via stub on port 5212: reader + quality 2/2.

## Real-sample observations (処刑少女の生きる道, GA文庫, read-only from ~/Downloads)

- Import → **45 chapters** in TOC (baseline dropped 19 of them); 19 image-only chapters listed, e.g. `1. Cover (1图)`.
- Image-only chapter renders the illustration (natural size verified), pager `第1/45章 · Cover · 1/1 页（1段）`; at 390×800 reflow: column overflow 0px, no layout break.
- Mixed chapter (ch8: 1img/3p): reading order text→text→text→`[IMG]` matches spine order; image box 523×557 rendered from a 200px natural-width source (contained, not cropped).
- Cross-chapter prev from ch3 (image-only) lands exactly on ch2 (image-only) `第2/45章 · 1/1 页（1段）` with 1 visible image — D1 chapter-end semantics hold on image pages; forward return exact. (Baseline doc's earlier `backExact:false` was a multi-chapter walk artifact, not a defect.)
- All-image whole book: opens showing the illustration (chapter `章1 (0段)`, 1 spread image) instead of the old 「EPUB 未提取到正文段落」 error.

## Baseline doc updates (justified)

`tests/format-verification-20260917/` was extended (not deleted): `ready()` now also waits for `.reader-image` (image-only chapters have no `.para`), the `all-image` case now asserts the new image-not-error behavior, and the `horizontal` case records `imgChaptersTotal`. The old baseline evidence files remain untouched; the re-run shows `horizontal/ruby/images/all-image/continuity` = pass (baseline `images: fail` → `pass`).

## Evidence paths

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/img-e2e-0917/`
- `assets/browser-observations.json` — 6-case journey (5 pass; `boundaries` intentionally records the known unsupported-extension fall-through, unchanged scope)
- `turn-probe.json` + `real-mixed-ch8-1280.png`, `real-imgonly-ch1-1280.png`, `real-imgonly-ch1-390.png` — real-book mixed order, image box, 40-page walk, image-only chapter at both widths
- `cross-chapter-image-probe.json` + `cross-chapter-prev-ch2.png` — image-page D1 semantics
- `probe-real.mjs`, `turn-probe.mjs`, `cross-probe.mjs` — replay scripts (probe-real: exact ingest path, 45ch/21assets/19 img-only)
- Screenshots: `real-1280.png`, `real-390.png`, `synthetic-mixed.png`, `synthetic-image-only-chapter.png`, `all-image-book.png`

Replay (from repo root): `ILR_BASE=http://127.0.0.1:<port> ILR_EVIDENCE=<dir> node tests/format-verification-20260917/actual-browser.mjs`; unit suite and typecheck commands as in the repo docs.
