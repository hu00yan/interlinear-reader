# Userscript implementation and verification

Date: 2026-09-17. Scope: standalone Tampermonkey userscript only. No Chrome extension, paid LLM request, dependency installation, commit, upload, or publication was performed. Existing web application files were not edited by this task.

## Metadata repair (2026-09-17)

The earlier artifact did not inject in real Tampermonkey because `@match <all_urls>` is unsupported by that manager. [Tampermonkey's @match documentation](https://www.tampermonkey.net/documentation.php?q=match), checked through Context7, explicitly states that limitation and documents `*://*/*`. `packages/userscript/header.txt` now uses `@match *://*/*`, covering ordinary HTTP and HTTPS pages, including localhost. It does not promise file-URL or browser-internal-page coverage.

`@sandbox DOM`, all GM grants, `@connect`, `@noframes`, and `document-idle` are unchanged. DOM requests a DOM-capable sandbox without requiring `unsafeWindow`; removing it or choosing `raw`/`JavaScript` would change the execution-context request without addressing the matching error. The rebuilt executable body is byte-identical to the prior artifact.

Current bundle: SHA-256 `3d2bfa380bd0291dd97965f5a9fac5116b2aefc97bed527a45667fdaeb56a0c4`, **39,263 bytes**. `test/metadata.test.mjs` failed on the old pattern and now checks source and distribution metadata against the supported HTTP/HTTPS pattern form and required coverage. Userscript tests pass 13/13; the GM-stub browser harness passes 11/11 with zero page errors on loopback port 5221.

A separate headed Chromium 140.0.7339.16 profile with real Tampermonkey 5.5.0 reproduced zero controls for the original bundle, then one Shadow DOM control for this exact rebuilt bundle, including after reload. This closes the startup blocker, not the remaining manager menu, key, annotation, or transport checks. No daily-profile changes or downloads were needed. The temporary browser, server, profile, and extension copy were cleaned up.

Evidence: `/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/tm-match-fix-rl95gq72/` (`real-manager-results.json`, `fixed.png`, `unit.log`, `userscript-s6YPfi/results.json`). See [the real-manager report](tampermonkey-real-browser.md) for the old/new comparison, cleanup, and verification limits. Earlier results below describe their recorded artifact hashes, not this repair run.

## Design

`packages/userscript` fits the root `packages/*` npm workspace convention. Its build script uses the already-installed esbuild to bundle `src/main.mjs`, `src/core.mjs`, `src/network.mjs`, and the shared Japanese deinflection function into `dist/interlinear-reader.user.js`. The output is gitignored. Neither root package metadata nor the lockfile was changed.

The script starts only in the top frame, with a body present, and without `meta[name="interlinear-reader-ignore"]`. A floating button and each annotation have their own Shadow DOM. Source words retain their original order and punctuation. Original text nodes remain in the owned hosts' unprojected light DOM. Restore unwraps current children rather than replacing page HTML or writing an old text snapshot, so site edits are not overwritten.

Selection prefers outermost article/main containers and falls back to body text. It excludes controls, forms, editable ancestors, code, scripts, styles, hidden content, existing ruby, SVG, MathML, iframe content, and owned nodes. Rendered offscreen article text is eligible; viewport-only selection is not implemented. Bounds are 400 text nodes and 40,000 characters, with text nodes over 1,500 characters skipped.

The tokenizer uses `Intl.Segmenter('ja', {granularity: 'word'})`, with a basic regex fallback. Script detection distinguishes Japanese from English. One-character kana fragments are not glossed. The shared `deinflectJa` function supplies dictionary-form candidates; only that code is bundled from the Japanese pack, not remote tokenizer loaders. Initial target language is simplified Chinese. English stemming and English-pivot lookup are not included.

A debounced MutationObserver invalidates the run immediately and rescans after 300 ms. Self-writes are made while the observer is disconnected; Shadow DOM updates do not reach its light-DOM observer. Generation checks, connection/content checks, and abort signals prevent late responses from changing restored or replaced text. A restore or configuration change aborts outstanding requests. SPA additions and site edits to the retained source nodes are covered by the harness.

## GM APIs and privacy

- `GM_getValue` / `GM_setValue` hold consent, the last confirmed endpoint, the bounded dictionary cache, and the configuration with the API key — **remembered on disk by default** with a `keyUpdatedAt` timestamp. The menu toggle **切换仅本次会话（不保存）** is the explicit opt-out: it erases the stored configuration immediately, keeps the current page's key in memory, and its effect survives reinjection. The key is entered through a native prompt from the manager menu, never prefilled, and never written to page DOM, localStorage, logs, or unsafeWindow. Panel and prompt show a masked key (`sk-…last4`), the storage mode, the last-updated time, and a rotation hint.
- `GM_registerMenuCommand` exposes configuration, the storage-mode toggle, key deletion, consent revocation, and cache deletion.
- `GM_openInTab` opens only fixed, hard-coded provider-console URLs (from an exact-host allowlist in `security.mjs`) when the user clicks the panel's provider button. No page-supplied URL is ever opened.
- `GM_xmlhttpRequest` performs fixed-path dictionary GETs and configured-endpoint POSTs. Requests use `anonymous: true`, `redirect: 'error'`, a timeout, abort handling, and response-size checks. A final-URL check is additional defense, not a substitute for manager-enforced redirect rejection.
- `@sandbox DOM` requests DOM-only access with explicit GM grants. `@connect` includes the exact R2 host and a wildcard for custom provider hosts. `@match *://*/*` covers HTTP and HTTPS pages; Tampermonkey rejects the Chrome-extension form `<all_urls>`. Users must restrict included sites and should narrow the wildcard to their provider host. No page-supplied URL becomes a cross-origin proxy target.

LLM backfill is off without a key and model. Configuration does not send a request. Before the first call, the native confirmation identifies the exact destination and the source-text scope. Consent is recorded per site origin and endpoint; declining preserves dictionary-only mode for that activation. The last confirmed endpoint is stored separately and compared before every send, so an endpoint change requires a new confirmation even when returning to a previously allowed endpoint. Configuration changes erase consent. Text sharing can be revoked through the menu.

### Key storage threat model

**Storage default (user-approved revision, 2026-09-17): the key is remembered — written to GM storage on disk as soon as it is configured.** The opt-out is the menu toggle '仅本次会话（不保存）'. No technical defense exists against local malware or a malicious extension with sufficient privileges: such software reads the browser profile, and both `localStorage` and script-manager storage are files there. A session-only key is equally readable while the browser runs, so memory-only storage reduces persistence, not exposure. The measures below warn the user and shrink the blast radius; they do not stop a compromised machine. The real mitigation is a dedicated low-balance key with hard usage/spend limits (verify the limit is enforced, not merely an alert), rotated periodically and revoked on suspicion.

| Threat | Can read a remembered key (default)? | Can read a session-only key? | Mitigations in this script |
| --- | --- | --- | --- |
| Local malware | Yes — GM storage is a file in the browser profile | Yes, while the browser runs | Low-limit dedicated key advice with named provider-console limit pages, rotation hint with last-updated timestamp, revocation guidance; no technical defense |
| Malicious browser extension | Often yes — profile access or extension APIs with broad permissions | Usually no from the page context, yes with profile access | Same as above; avoid sensitive extensions |
| Host page | No — `@sandbox DOM` keeps GM storage out of the page world; no DOM or localStorage path carries the key | No, same | Key entry only via native menu prompt; masked display; consent scoped to origin + endpoint |
| Other userscripts | Not through this script's GM storage (manager isolates per-script storage); a hostile manager breaks this assumption | No | No `unsafeWindow`, no page-world bridge, no shared-world storage |

The backfill follows `packages/web/src/llm/provider.ts`'s `glossBatchPage` pattern: batches of source blocks and exact requested word strings; JSON response keyed by block id and word. The userscript does not import that provider's localStorage-facing application configuration. The endpoint receives only blocks with missing words, not the page URL, HTML, forms, or a chapter-wide duplicate context. Each activation permits at most 10 calls and 40,000 transmitted source characters. A batch targets 6,000 serialized characters and at most 20 blocks. Responses are parsed as data and rendered with textContent. Unknown keys, nonstring glosses, and reflected API-key strings are ignored. Raw errors and responses are not displayed.

No eval, remote JavaScript execution, remote WASM, external page bridge, or persistent LLM excerpt cache is present. GM storage and Shadow DOM do not establish protection against a compromised manager, hostile page/runtime, or local machine compromise.

## Exact dictionary reuse

Canonical host from `packages/web/src/dict/dict-loader.ts`:

`https://pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev`

Requested data paths are:

- `/dict/ja/zh.dict.br`, then `/dict/ja/zh.dict` on failure or invalid text.
- `/dict/en/zh.dict.br`, then `/dict/en/zh.dict` on failure or invalid text.

The web loader tries same-origin `.dict`, same-origin numbered parts, then R2 `.dict.br`. A userscript has no trusted same-origin dictionary deployment, so it reads R2 directly through GM. R2's compressed object requires `Content-Encoding: br` for browser/GM decompression. Raw compressed bytes and HTML are rejected. Dictionary data uses UTF-8 `lemma<TAB>glosses`, with U+001F between senses, as stated in `public/dict/{lang}/manifest.json`. Only the first short sense is used.

The GM cache is LRU-ordered with a conservative 2 MiB serialized UTF-16 budget and seven-day freshness. Whole objects exceeding the budget remain memory-only. In-flight pair loads are deduplicated within a run; at most the two supported pair maps remain in memory. Dictionary URLs contain no article words. Dictionary requests never carry Authorization.

`public/dict/sizes.json` records 101 Japanese→Chinese entries (1,271 uncompressed bytes) and 107,715 English→Chinese entries (5,831,237 bytes). Thus Japanese dictionary-only coverage is sparse, while the English whole object exceeds persistent-cache capacity. Production bucket availability and current contents were not contacted or verified in this run.

Dictionary attribution is separate from the MIT script license. Consult `DICT_SOURCES.md` and the language manifests. The manifests contain unresolved `VERIFY` licensing notes; those are publication-review blockers, not claims of cleared redistribution rights. Dictionary files are not included in the userscript bundle.

## Verification results

Commands, run from the repository root:

```sh
npm run build --workspace packages/userscript
npm run test --workspace packages/userscript
npm run test:browser --workspace packages/userscript
npm test
```

Build succeeded. Twelve userscript unit tests pass (key-security coverage updated for the remembered-by-default revision). The existing root suite passed 75 tests at the earlier verification; the web app was not modified by this revision. Eleven browser behavior groups pass (revised harness). No page errors were recorded.

Recovery-run evidence (final sources, rebuilt distribution bundle at its default path, harness port 5205): `artifacts/userscript-1IxXi8/` — bundle sha256 `838793025b4eb79327eee2c3c1320d2aa0bbf835520cd3db066857d80cff4028`, 39,101 bytes, all eleven checks passing, zero page errors, loopback-only requests. Earlier same-model runs: `artifacts/userscript-pkbA05/`, `artifacts/userscript-RP7d3i/`, `artifacts/userscript-9ELMhL/`, `artifacts/userscript-wUvBsz/`, `artifacts/userscript-ygP4Fl/` (bundle sha256 `3b26a83c8dba9d81758bed68383cbe76a6076a39dd726867d530cdbe00d5e947`, superseded by the recovery rebuild, which fixed a stale storage-mode write in the disable handler and a `[hidden]`-vs-CSS display conflict on the provider button). See `docs/research/key-security-hardening.md` for the full check list. The pre-revision evidence remains below.

Original evidence directory: `artifacts/userscript-BXw6Kf/`.

- `annotated.png`: floating restore button and dictionary-derived Chinese glosses beneath source words, including 本→书 and Hello→你好. Code, textarea, and editable text remain untouched.
- `backfilled.png`: accepted stub LLM backfill is visible beneath missing words.
- `restored.png`: annotations are gone after restoring during an outstanding delayed request.
- `results.json`: seven passing behavior groups and request summaries without keys or article payloads.

The first run's equivalent evidence remains at `artifacts/userscript-z9eXZO/`; its dictionary screenshot was also visually inspected. These are local builder artifacts, not uploaded acceptance evidence. The user required loopback-only tests, so no external acceptance upload was attempted.

Behavior checks cover:

1. Button appears in Shadow DOM.
2. Japanese `.dict.br` data is HTTP-decompressed, English falls back to `.dict`, dictionary glosses appear, skipped areas remain unchanged, and no LLM request occurs by default.
3. Restore retains exact original text-node, link, and site-element identities.
4. Configuring stores key + `keyUpdatedAt` in GM storage by default; masked key, storage mode, timestamp and rotation hint display; bold warning and provider-limit guidance are present in the built bundle; the panel has no key input.
5. A configured key does not bypass confirmation; denying sends nothing; accepting permits stub backfill; the key is absent from page and shadow DOM and localStorage.
6. Debounced SPA additions receive annotations and site-modified source text survives restore.
7. Restore during a delayed backfill prevents stale annotation writes.
8. The session-only menu toggle erases the stored key, survives reinjection without retaining it, and can be reversed.
9. A recognized provider button opens only a fixed console URL through `GM_openInTab` (stubbed, no external navigation); the remembered key persists across a new session with the same timestamp.
10. Disable-LLM clears both stored and in-memory keys.
11. A host opt-out meta tag prevents initialization.

Unit coverage includes lossless tokenization with and without Intl.Segmenter, skip behavior, node identity and site-edit preservation, dictionary parsing, cache bounds/LRU ordering, endpoint validation, batching, and the key-security suite described in `docs/research/key-security-hardening.md`.

## Harness boundary and remaining manual checks

`packages/userscript/test/browser.mjs` starts a self-owned loopback server (default port 5200; the recovery run used `ILR_TEST_PORT=5205` and injected the dist bundle by default path), opens a separate headless Chromium context, injects the built `.user.js`, and supplies closure-based GM stubs. The R2 host is mapped to the loopback dictionary fixture. All browser traffic outside loopback is blocked. The LLM is a free local stub; its bearer value is a synthetic test-only key. The script closes the browser and server in `finally`, and a port conflict fails instead of killing another process.

This proves implemented page/DOM and request-gating logic, **not Tampermonkey installation or runtime isolation**. The harness is deliberately page-world code and must not be represented as a secure sandbox. Untested in an actual manager: native settings prompts, grant availability, wildcard permission prompts, sandbox selection, redirect enforcement, timeout details, strict CSP, extension reload/update behavior, and production R2 response headers. No iframe, mobile manager, screen-reader, hostile-page, or arbitrary-framework compatibility claim is made. Key storage hardening evidence: `docs/research/key-security-hardening.md`.

The implementation follows the userscript and MV3 constraints researched in `docs/research/format-extension-feasibility.md`, especially GM-only key storage, no remote executable data, and shared-DOM/CSP caveats. Current Tampermonkey API documentation for GM requests, redirects, anonymous requests, sandbox, and connect permissions was additionally queried through Context7. The codebase graph did not contain this repository; discovery therefore used the supplied source paths and local files.

An independent verifier should review the source and rerun the local harness. A subsequent authorized manual Tampermonkey session should verify manager-specific behavior before public release.

## Manual publication

1. Review the MIT code license and dictionary-source notices, including unresolved manifest licensing notes.
2. Complete actual Tampermonkey runtime checks on supported browsers, ordinary article pages, and a strict-CSP fixture.
3. Replace owner/repository feedback and homepage placeholders in `packages/userscript/GREASYFORK.md`. Add a real `@supportURL` to the header if appropriate.
4. Review the broad match and connect permissions, privacy wording, and version number.
5. Rebuild and rerun the userscript checks.
6. Sign in to GreasyFork manually and create the script listing using the bilingual stub.
7. Upload or paste only the built `.user.js` as script code. Do not upload keys, local test artifacts, or dictionary data.
8. Inspect the rendered listing and install prompt before publishing.
9. After manual publication, replace `<GREASYFORK_LISTING_URL>` in installation instructions with the real URL.

No GreasyFork API, automatic upload, or publication operation is included or was executed.
