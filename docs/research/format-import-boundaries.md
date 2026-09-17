# Unsupported-format import boundaries

Date: 2026-09-17. Independent verifier retry: PDF, MOBI, AZW3, and DjVu extension boundaries.

## Verdict

**Actual Chromium checks completed. Forced unsupported extensions are not explicitly rejected.** All four self-authored plain-text files named `.pdf`, `.mobi`, `.azw3`, and `.djvu` rendered as one-chapter books. Valid TXT imports and recovery passed.

These files contain UTF-8 text, not binary book formats. The observations prove extension fall-through, **not PDF, MOBI, AZW3, or DjVu format support**. Native file chooser filtering was not exercised.

Tabbit remains blocked on its own surface. Its corrected single-navigation retry failed before import. The successful observations below come from a separate Playwright-driven headless Chromium context against the actual source-backed Vite app, not Tabbit, a mock DOM, or a parser-only test.

## Observed checks

“Fail” for a forced import means that the UI did not explicitly reject the unsupported extension. It does not mean the browser observation failed.

| Check | Result | Actual observation |
| --- | --- | --- |
| Live input metadata | Pass | `accept=".epub,.txt,.md"`; accessible label `选择 EPUB / TXT 文件` |
| Self-authored Japanese/English TXT | Pass | `control-ja-en` opens in Mode B, one chapter and three paragraphs. Japanese and English source content is preserved. First match at 701 ms. |
| Forced `.pdf` | Fail: explicit rejection absent | `fake-book.pdf` opens as one chapter, one paragraph. Text first observed at 210 ms and still rendered after 10,007 ms. No nonempty error. |
| Forced `.mobi` | Fail: explicit rejection absent | `fake-book.mobi` opens as one chapter, one paragraph. Text first observed at 211 ms and still rendered after 10,004 ms. No nonempty error. |
| Forced `.azw3` | Fail: explicit rejection absent | `fake-book.azw3` opens as one chapter, one paragraph. Text first observed at 211 ms and still rendered after 10,006 ms. No nonempty error. |
| Forced `.djvu` | Fail: explicit rejection absent | `fake-book.djvu` opens as one chapter, one paragraph. Text first observed at 210 ms and still rendered after 10,005 ms. No nonempty error. |
| Return to library after each forced import | Pass, 4/4 | `📚 书架` opens the library and exposes the file input. |
| Import a valid TXT after each forced import | Pass, 4/4 | Each distinct `recovery-after-<extension>.txt` opens in Mode B with its complete original source and no nonempty error, as recorded at the end of each 10-second window. |
| Tabbit app navigation | Blocked | Corrected retry fails after 275 ms with `page.goto: Target page, context or browser has been closed`. No Tabbit import or screenshot. |

Live import guidance reads:

> EPUB（保留章节段落）/ TXT / URL 正文提取。语言：7 源语言 + Auto 万能（LLM 自动识别，无包语言用 Auto），导入时选择。

The unsupported fixtures each contain this sentence, with the corresponding extension substituted:

> Self-authored verifier plain text renamed with extension .pdf. No binary format content here. Paragraph two for the reader.

The complete source survives in the rendered spread for every fixture. No persistent processing state or gibberish appeared in the final observations. Each unsupported-file window lasted approximately 10 seconds; the few extra milliseconds are DOM sampling overhead, not an additional wait.

### Recovery assertion correction

The initial runner incorrectly classified the four recovery checks as `no-terminal-result-within-10s`. It joined `.para` fragments with a newline, but the reader splits one paragraph across its two columns. This inserted a newline into the expected sentence and caused a false negative.

The unchanged raw DOM arrays and screenshots show the recovery text. A separate `adjudicate.mjs` joins column fragments without adding a character, checks the expected sentence, and compares the entire source to the original file after whitespace normalization. All nine imports preserve their complete source. The separate `assets/assessed-results.json` records the corrected verdicts; the raw JSON and runner output remain unchanged. No product fix or second browser run was used to obtain those verdicts. The first render time for recovery is unknown; final rendering within the recorded observation window is established. A second exact character comparison, without whitespace normalization, confirms all four recovery sources equal their fixture text after removing the fixture's trailing newline: 82 characters for PDF recovery and 83 for each other recovery. The erroneous newline join added exactly one character at offset 68 or 69. See `assets/recovery-exact-comparison.json`.

## Source context and rolling-change provenance

The observed `accept` list excludes all four extensions. `accept` is a picker hint, not application validation. `setInputFiles` bypasses normal picker filtering.

At observation time, [`packages/web/src/ui/app.ts`](../../packages/web/src/ui/app.ts) dispatches EPUB to `parseEpub`, Markdown to `parseMarkdown`, and every other extension to `parseTxt(await decodeTextFile(f), ...)`. [`packages/web/src/ingest/txt.ts`](../../packages/web/src/ingest/txt.ts) builds text paragraphs, not binary-format structure.

- Repository: `/Users/huyan00/mycode/interlinear-reader`.
- HEAD: `00c0f74bb8f3f14a69020893daa9946bd8f79cb8`.
- Browser run: `2026-09-17T07:09:50.633Z` through `2026-09-17T07:11:12.809Z`.
- Chromium: `153.0.8010.12`; Vite: `5.4.21`.
- Origin: `http://127.0.0.1:5195`.
- This is the working-tree source, **not pristine HEAD**. Other workers changed `app.ts` before browser startup; the Vite log records reloads at 15:07:39 and 15:08:01 local time. `ingest/epub.ts` was already modified at lane entry. This verifier did not edit either file.
- SHA-256 checks before and after the browser run match for all three source files below. The browser run therefore observed a stable interval despite parallel work.

| Source file | SHA-256 during browser run |
| --- | --- |
| `packages/web/src/ui/app.ts` | `131fec61e11cc0c87854a21c6ea7a89d2a3276708700a41c6e6ec77c54c19520` |
| `packages/web/src/ingest/epub.ts` | `9365387296ce897be917cd61341d90a0b74ac68d2a8fedcc361831a160f8b4bc` |
| `packages/web/src/ingest/txt.ts` | `abc6c64c8fcb30c39dbebf44f892f455756f7ee8ceecaf72f56373e1e5380f76` |

## Browser isolation and network audit

The fallback launches a separate headless Chromium with a fresh context, `serviceWorkers: 'block'`, a 1280×900 viewport, and no API key. The UI selects Mode B before import. Each final reader snapshot reports mode `b`.

An HTTP route guard allows only GET and HEAD to the exact origin `http://127.0.0.1:5195`; all other requests are aborted. All WebSockets are blocked separately, including Vite HMR.

Observed audit: **38 allowed loopback requests, zero blocked HTTP attempts, one blocked loopback HMR WebSocket, and zero page errors**. No external request or LLM POST occurred. No real Downloads books, binary fixtures, API keys, paid LLM, installs, build, E2E rerun, commit, or external publication were used in this retry. Existing E2E artifacts and the other verifier's files were untouched.

## Tabbit retry provenance

The first submitted program mistakenly exported a function instead of executing top-level statements. Request `minimal-goto-5195` returned `value: null` in 52 ms with the page still at `about:blank`. **It did not navigate and is not evidence of success or the target-closed failure.** Task `ilr-boundaries-retry` was finished once, with zero screenshots.

A corrected top-level single-goto program used fresh task `ilr-boundaries-retry-goto`, ID `task-dc940452-f8e4-4835-81eb-743354c4e788`. It installed an exact-origin GET/HEAD guard and called `page.goto` once with a 12-second timeout. It failed after 275 ms: `NAVIGATION_FAILED`, `networkError: UNKNOWN`, `pageStillResponsive: false`, and task page `p1` closed. The task was finished once, with zero screenshots; group `2D3BE20BB132349359D7D87BEFDC8B17` was retained. No Tabbit runtime repair or further navigation was attempted.

The earlier blocked lane remains documented in `/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-boundaries-diagnostics.md`. Its two prior navigation failures are historical evidence, not results of this retry. The separate-surface precedent is [Format browser verification baseline](format-browser-verification.md), whose files were only read.

## Commands and artifacts

Unique evidence root:

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-boundaries-retry-20260917/`

Executed browser and assessment commands, with `ART` denoting that exact root:

```sh
ART=/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-boundaries-retry-20260917
# Server launched from packages/web:
npx vite --port 5195 --strictPort --host 127.0.0.1
# Browser commands executed from the repository root:
"$HOME/.local/bin/tabbit-cli" nodejs --task ilr-boundaries-retry --request-id minimal-goto-5195 --timeout-ms 60000 < "$ART/tabbit-minimal-goto.js"
"$HOME/.local/bin/tabbit-cli" finish --task ilr-boundaries-retry
"$HOME/.local/bin/tabbit-cli" nodejs --task ilr-boundaries-retry-goto --request-id single-goto-5195 --timeout-ms 60000 < "$ART/tabbit-single-goto.js" > "$ART/assets/tabbit-single-goto.out" 2>&1
node "$ART/verify-boundaries.mjs" > "$ART/assets/chromium-run.out" 2>&1
"$HOME/.local/bin/tabbit-cli" finish --task ilr-boundaries-retry-goto > "$ART/assets/tabbit-finish.out" 2>&1
node "$ART/adjudicate.mjs" > "$ART/assets/adjudication.out"
ps -p 20170 -o pid=,command=
kill -TERM 20170
```

Artifacts under the root:

- `assets/browser-observations.json`: raw DOM snapshots, exact UI text, timing, network audit, and source hashes. Recovery classifications have the documented verifier false negative.
- `assets/assessed-results.json`: corrected per-check verdicts and full-source comparisons against the original files.
- `assets/chromium-run.out` and `assets/adjudication.out`: raw runner summary and separate assessment output.
- `assets/picker.png`, `assets/txt-control.png`, `assets/forced-pdf.png`, `assets/forced-mobi.png`, `assets/forced-azw3.png`, and `assets/forced-djvu.png`.
- `assets/recovery-after-pdf.png`, `assets/recovery-after-mobi.png`, `assets/recovery-after-azw3.png`, and `assets/recovery-after-djvu.png`.
- `assets/tabbit-retry-minimal-goto.out`: invalid no-navigation submission response.
- `assets/tabbit-single-goto.out` and `assets/tabbit-finish.out`: actual retry failure and cleanup response.
- `verify-boundaries.mjs`, `adjudicate.mjs`, `tabbit-minimal-goto.js`, and `tabbit-single-goto.js`: exact programs, including the preserved verifier mistakes.
- `control-ja-en.txt` (213 bytes), `fake-book.pdf` (124 bytes), and `fake-book.mobi`, `fake-book.azw3`, `fake-book.djvu` (125 bytes each): self-authored fixtures. Four distinct `recovery-after-*.txt` files contain original recovery sentences.

The TXT control, forced PDF, and final DjVu recovery screenshots were visually inspected in addition to the DOM assessment. Other screenshots are captured evidence; their corresponding DOM snapshots were assessed.

Server output is retained at `/Users/huyan00/.local/share/opencode/shell/25421a522e123308c5d500280a1313cb9cb2b742/sh_0ae303417001avrUXPCXyTuI3V.out`. Vite was ready in 110 ms and the readiness request returned HTTP 200. PID 20170 was checked for this exact port and command before SIGTERM; its background shell reported completion. Chromium was closed in `finally`. Other servers and ports were not stopped.

Local evidence covers every requested boundary check, including four recoveries. Tabbit coverage remains zero. No acceptance URL or uploaded-evidence claim is made: this lane retained local artifacts only.
