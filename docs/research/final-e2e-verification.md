# Final E2E Verification — Interlinear Reader (2026-09-17)

**Verdict: NOT-READY** — 1 new defect: cross-chapter backward page turn does not land on the previous chapter's last page.

Independent fresh-eyes re-verification in a real headless Chromium against a fresh `npm run build` (dist git-tracked, refreshed this run). No product edits, no installs, no paid LLM, no Tabbit. All areas used fresh browser contexts; loopback-only network guard (0 blocked attempts); books read from ~/Downloads, never copied into the repo.

## Environment (observed)
| Item | Value |
|---|---|
| Commit + changes | `main` @ `00c0f74` + all session uncommitted changes (git status checked) |
| node | v26.5.0 |
| Chromium (Playwright bundled) | 153.0.8010.12 |
| Playwright | 1.63.0 |
| TypeScript | 5.9.2 (via `tsc --noEmit`, workspace dep) |
| vite | 5.4.21 |
| App build | `npm run build` (fresh) → tsc clean, size gate PASS (first-paint gzip 26.4KB / 60KB cap) |
| Serve | `scripts/stub-server.mjs` on 127.0.0.1:5208/5209/5211 (started by me, all stopped) |
| Evidence dir | `/private/var/folders/.../opencode/final-e2e-gF4N9U/` (temp, unique) |

## Pass/fail table (all observed in real browser unless noted)

| # | Scenario | Result | Key evidence (observed) |
|---|---|---|---|
| 1 | EPUB 処刑少女 import → 26 chapters, opening `たまに、夢を見る。`→`日本の、行ってもいない学校の教室の夢だ。` in ch5 (index 4), all pages `writing-mode: horizontal-tb` | **PASS** | pager `第5/26章 · 1/36 页（7段）`; fwd/back page-turn hash equality; chapter nav select; 390×800 reflow → `1/123 页（3段）`, horizontal-tb kept, turns verified |
| 1b | Synthetic 60-para EPUB: full forward traversal + exact page-content equality backward at 1280 and 390 | FAIL at **first cross-chapter backward step** | see defect below; within-chapter prev steps exact |
| 2 | Ruby/nested/CDATA fixture: `にほん` readings absent from source tokens (ruby rendered, no stray rt text); `外側。内側。終端。` nested blocks once, in DOM order; CDATA `Visible prose & punctuation.` preserved | **PASS** | combined fixture text: `...外側。内側。終端。Visible prose & punctuation.Before inside after.` |
| 3 | All-image EPUB → `.err` shows `EPUB 未提取到正文段落`, **no** stale `解析中...`, previous book retained, valid TXT re-import succeeds | **PASS** | error observed; reader still showed previous TXT after failed import; recovered TXT rendered |
| 4 | MOBI 牧歌.mobi (COMBO v7→v8): horizontal render, chapter nav, bidirectional turns | **PASS** | ch1 1/2→2/2 pages, back-exact; FOLIATE license in console |
| 4 | AZW3 水手比利·巴德.azw3 (KF8): imports, renders, paginates (463 pages ch1) | **PASS** | turns verified at 1/463→2/463, back exact |
| 4 | Synthetic encrypted MOBI (DRM encryption=2): clear rejection `此 MOBI/AZW3 文件已加密或受 DRM 保护...` | **PASS** | error observed + screenshot `drm-error.png` |
| 4 | Renamed .txt→.mobi (plain text, non-BOOKMOBI): rejected via header sniff, message `无效 MOBI/AZW3：文件头或记录表损坏（仅支持 BOOKMOBI，不支持 KFX）` | **PASS** | recorded actual behavior: reject (no silent text routing) |
| 4 | Settings → About: Foliate.js/JSZip/marked (+pako) with license links | **PASS** | `a` elements with hrefs to foliate-js / Stuk/jszip / markedjs/marked |
| 4 | MOBI import → console shows Foliate MIT notice (`Vendored mobi.js from foliate-js 1.0.1`, full MIT text) | **PASS** | console log captured in `logs` audit; license text incl. MIT grant present in lazy `mobi-CxqTDb25.js` chunk |
| 5 | File input accept = `.epub,.txt,.md,.mobi,.azw3,.azw` | **PASS** | attribute read from live DOM |
| 5 | Forced `.djvu` / `.pdf`-named text file | **KNOWN-FAIL (unchanged)** | both fall through to text: `Synthetic plain text under an unsupported extension...` rendered; recorded as known-unfixed defect |
| 6 | Settings: LLM key warning block `⚠️ 密钥安全：本程序无法从技术上防御本机恶意软件` visible; `测试连接` button present; no key set; test button makes no request without key | **PASS** | 0 blocked external requests in settings area; password input empty |
| 7 | Userscript: rebuilt `dist/interlinear-reader.user.js` sha256 `838793025b4e...` | **PASS** | matches expected exactly |
| 7 | Userscript GM-stub harness (separate server :5210): 12/12 checks incl. button in shadow DOM, ja/en glosses, skip editables, restore identity, masked key + timestamp, provider button hidden on unknown host, endpoint re-confirm | **PASS** | network audit 8 allowed / 0 blocked, 0 page errors |
| 8 | `tests/unit/*.mjs` — 37/37 | **PASS** | `npm run test:track-d` equivalent: `node --test tests/unit/*.mjs` |
| 8 | Userscript unit 12/12 | **PASS** | `npm run test --workspace packages/userscript` |
| 8 | `tsc --noEmit` — clean | **PASS** | packages/web tsconfig |
| 8 | Existing e2e reader + quality via stub server | **PASS** | 2 passed via `@playwright/test cli.js` against stub :5209, loopback guard 15/34 allowed, 0 blocked |
| 8 | Size gate | **PASS** | `npm run check:size` → 首屏 26.4KB ≤ 60KB |
| 9 | Export EPUB round-trip (Mode B, dictionary-only): export `Roundtrip-en-zh.epub` → re-import → paragraphs + glosses present | **PASS** | glosses observed: 时间/是/好/一/书/和/房子/这/猫/读/一/书; source text retained; validates plumbing, not translation quality |

## New defect (this run)
**D1 — Cross-chapter backward page turn lands mid-chapter instead of the previous chapter's last page.**
- Reproduced 3× (initial run, full rerun, isolated probe) on synthetic 2-chapter EPUB (`tests/format-verification-20260917/fixtures/continuity-original.epub`), viewports 1280 and 390.
- Isolated probe trail (1280×800, Mode B): forward walk reaches `第2/2章 · 章2 · 1/1 页（1段）` from `第1/2章 · 章1 · 10/10 页`, next disabled at book end. First **prev** from ch2 p1 → shows `第1/2章 · 章1 · 5/10 页` (段落025) instead of ch1 p10 (段落055). Subsequent prev steps decrement normally: 5→4→3→2→1, then prev disabled.
- Impact: reader loses reading position crossing a chapter boundary backward; content temporarily inaccessible by paging (accessible via chapter select).
- Isolation: within-chapter backward turns are exact; forward cross-chapter is exact; real 処刑少女 forward turns exact. The jump occurs specifically when stepping back from ch2 page 1 into ch1.
- Repro: upload continuity-original.epub (ja) → next to book end → prev once → observe pager `第1/2章 · 章1 · 5/10 页` ≠ `10/10`.
- Fix direction (source-read only): cross-chapter prev probably restores a stale `page-1`-style index of the previous chapter rather than its last page; see `packages/web/src/reader/paginate.ts` / `app.ts` cross-chapter turn logic around the `上一页` handler (app.ts ~L1251, ~L1974).

## Known-unfixed defects (confirmed unchanged, observed)
- **Unsupported extension fall-through**: forced `.pdf`/`.djvu` (text content) still import as text. File-input `accept` is correct, but drag/forced-import bypasses it. Unchanged from session baseline.
- (from D1's sibling) Forward cross-chapter turns are exact; only backward is affected.

## Screenshots (excerpts, unique temp dir)
epub-opening.png, epub-mobile.png, ruby-nested.png, cdata.png, all-image-error.png, drm-error.png, mobi-excerpt.png, azw3-excerpt.png, settings-warning.png, roundtrip.png — all in `/private/var/folders/.../opencode/final-e2e-gF4N9U/`. Backward-mismatch screenshots (backward-mismatch-1280.png, backward-mismatch-390.png) document D1.

## Network audit totals (all areas, all contexts)
- 90 requests, all `GET/HEAD` to origin 127.0.0.1:5208; **0 blocked**, 0 external, 0 page errors across 10 areas.
- Userscript harness: 8 allowed / 0 blocked (own server :5210, GM_xmlhttpRequest stubbed).
- e2e loopback guard: reader 34 allowed / quality 15 allowed / 0 blocked.
- No book content left the machine; books read-only from ~/Downloads (never uploaded/copied).

## Commands (verbatim)
```
npm run build
node --test tests/unit/*.mjs                                # 37 pass
npm run test --workspace packages/userscript                # 12 pass
./node_modules/.bin/tsc --noEmit -p packages/web/tsconfig.json
npm run check:size --workspace packages/web                 # PASS
npm run build --workspace packages/userscript && shasum -a 256 packages/userscript/dist/interlinear-reader.user.js
node <tmp>/verify.mjs                                       # 10-area browser journey (port 5208)
node <tmp>/run-gates.mjs                                    # reader+quality e2e (port 5209)
node <tmp>/run-userscript.mjs                               # GM-stub harness (port 5210)
node <tmp>/probe-backward.mjs                               # D1 isolation probe (port 5211)
```

## Observed vs source-read
- **Observed (browser)**: all table rows above, including D1 trail, DRM/renamed rejections, all-image error lifecycle, export round-trip, userscript 12 checks, settings/About/license console.
- **Source-read only**: root-cause hypothesis for D1 (app.ts cross-chapter turn logic ~L1251/L1974, paginate.ts); export format details (renderTokenEpub gloss `<small>` structure, buildChapterXhtml); FOLIATE_MOBI_LICENSE constant in mobi.ts (console output observed; full text matched in dist chunk by grep).

## Gate summary
- tests/unit 37/37 · userscript unit 12/12 · userscript browser harness 12/12 · e2e 2/2 · tsc clean · size PASS · build clean
- **Not fixed this session (by design)**: D1 (new, cross-chapter backward), unsupported-extension fall-through (known-unfixed, unchanged).

**Overall verdict: NOT-READY** until D1 is fixed and re-verified.

## D1 fix and builder re-verification (2026-09-17)

**D1: fixed; builder checks PASS.** The original report above is preserved. Independent verifier sign-off is still pending; unsupported-extension fall-through remains unchanged.

### Cause and change

- Reproduced the original failure before editing: ch2 p1 → prev → ch1 `5/10`, 段落025. The same probe after the fix reaches `10/10`, 段落055, and then walks backward through every page to the disabled book-start button.
- `goPrevPage` used `totalPagesFor`, a text-height estimate, to choose the previous chapter's final page. A measured plan can have more pages: clamping an underestimated index leaves the reader mid-chapter. An overestimate alone can already clamp correctly; the regression covers both directions.
- Cross-chapter prev now sets `pendingFlowAnchor = Number.POSITIVE_INFINITY`. Existing `findFlowPage` bounds handling resolves this chapter-end token anchor to the measured last page, including when the last paragraph spans pages.
- A render-local `landAtChapterEnd` preserves this intent through Auto token-boundary remeasurement and the final chrome stabilization pass. Ordinary resize anchors, within-chapter turns, and forward chapter crossing keep their existing behavior. `paginate.ts` and pager-end logic are unchanged.
- Changed source: `packages/web/src/ui/app.ts` pagination region only. Added `tests/unit/cross-chapter-prev.test.mjs`. Existing ingest, settings, and userscript work was not edited. The requested build refreshed web dist assets.

### Observed checks

| Check | Result |
|---|---|
| Regression before fix | Original 9-case run: 8 failures, including actual page index 4 versus expected 9; ordinary turns passed |
| Final regression | 11/11; estimated/measured counts 5/10, 10/5, 2/20, 10/1; both measured-plan branches; split final paragraph; stabilization; Auto remeasurement; normal resize and turns |
| Full unit suite | `node --test tests/unit/*.mjs`: 48/48 |
| TypeScript | `./node_modules/.bin/tsc --noEmit -p packages/web/tsconfig.json`: PASS |
| Build and size | `npm run build`: PASS; first-paint gzip 26.4KB ≤ 60KB |
| Existing reader and quality E2E | 2/2 via own stub on 127.0.0.1:5209; 49 allowed requests, 0 blocked |
| Real 処刑少女 EPUB, fresh Mode B contexts at 1280×800 and 390×800 | ch2 p1 → prev → ch1 `1/1`, all 3 source paragraphs, final paragraph index 2 (`佐藤真登`); next → exact ch2 p1 content; book-start/end button states correct |
| Real prose, chapter 5, both widths | Next then prev restores exact source-content hash |
| Synthetic 60-paragraph EPUB, both widths | Direct ch2 p1 → prev reaches measured last page (`8/8` desktop, `27/27` mobile), ending at source paragraph index 59, 段落060; next returns exact ch2 p1 |
| Synthetic full forward/backward traversal | Exact source-content hash and pager equality on every return page: 9 desktop pages and 28 mobile pages including ch2 p1; within-chapter prev/next exact |
| Browser isolation | Own headless Chromium 153.0.8010.12; four fresh contexts; GET/HEAD restricted to own loopback origin; 40 allowed requests, 0 blocked, 0 page errors |

The real book's first chapter is one-page front matter, so it does not itself expose estimate divergence. The synthetic chapter supplies that check. Its measured page counts differ between the original forward-walk probe and the fresh direct-chapter-select journey; each journey compares against its own measured plan and exact backward content, not a hardcoded page count.

### Evidence and replay

All evidence is local in:

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/d1-fix-rnYZEA/`

- `browser-before.log`, `browser-after.log`: original isolated D1 probe, before and after.
- `unit-before.log`, `unit-after.log`, `unit-full.log`, `tsc.log`, `build.log`, `e2e.log`, `e2e.json`: gate output.
- `observations.json`, `browser.log`: four browser journeys, pager state, source paragraph indices, hashes, and network totals.
- `real-1280-prev-last.png`, `real-390-prev-last.png`, `synthetic-1280-prev-last.png`, `synthetic-390-prev-last.png`: chapter-end landing screenshots. Corresponding `*-next-ch2.png` files show the return to ch2 p1.
- Replay: `node <evidence-dir>/verify-d1.mjs`, then `node <evidence-dir>/run-gates.mjs`. Both acquire port 5209 and close only their own server and Chromium processes.

No commits, installs, paid LLM calls, Tabbit access, or other-lane process termination. The real EPUB was read from Downloads without modification or copying into the repo. `lh` is unavailable in this environment, so no remote acceptance was published; the coordinator's verifier can use the local evidence above.
