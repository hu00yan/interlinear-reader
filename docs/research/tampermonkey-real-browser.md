# Real Tampermonkey verification — matching metadata blocker

Date: 2026-09-17.

## Repair verification (2026-09-17)

**Matching blocker fixed and self-confirmed in real Tampermonkey.** The original findings below remain historical evidence for bundle `83879302…`.

Tampermonkey's [official @match documentation](https://www.tampermonkey.net/documentation.php?q=match), queried through Context7, explicitly says `<all_urls>` is not supported. It documents `*://*/*` for HTTP and HTTPS pages. This is a manager metadata limitation, not a sandbox/grant incompatibility. `header.txt` now uses that documented pattern, with a comment explaining why. It does not promise file-URL or browser-internal-page coverage.

`@sandbox DOM` is unchanged. The [sandbox documentation](https://www.tampermonkey.net/documentation.php?q=sandbox) describes DOM access in `ISOLATED_WORLD` or another enabled DOM-capable context. This script does not require `unsafeWindow`; switching to `raw`, `JavaScript`, or the default would unnecessarily change the execution-context request. All GM grants, connect declarations, `@noframes`, and `document-idle` remain unchanged. The rebuilt executable body is byte-identical to the original; only the header and explanatory comments differ.

New delivered artifact: SHA-256 `3d2bfa380bd0291dd97965f5a9fac5116b2aefc97bed527a45667fdaeb56a0c4`, **39,263 bytes**.

### Repair evidence

Directory: `/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/tm-match-fix-rl95gq72/`.

- `real-manager.mjs`, `real-manager.log`, `real-manager-results.json`: fresh headed Chromium 140.0.7339.16, real unpacked Tampermonkey 5.5.0, Allow User Scripts enabled through UI, local file import through the real manager. Original bundle yields zero controls; exact rebuilt bundle yields one control with a Shadow DOM; reload retains one control. `window.GM_getValue` is undefined in page world, an observed boundary rather than a comprehensive isolation proof.
- `original.png`, `fixed.png`, `installed-fixed.png`: original absence, fixed visible panel, and installed fixed script. `fixed.png` visually reviewed.
- `fixed.user.js`, `artifact.json`: exact rebuilt copy, hash, byte count, identical executable-body comparison, and cleanup confirmation.
- `unit.log`: 13/13 userscript tests passed. The new `test/metadata.test.mjs` failed before the fix with `header: <all_urls> must use protocol://domain/path, not <all_urls>`, then passed after rebuild. It guards source and delivered metadata plus the intended HTTP/HTTPS coverage; it is not a userscript-manager emulator.
- `browser.log`, `userscript-s6YPfi/results.json`: 11/11 GM-stub behavior groups passed on own port 5221, with zero page errors and loopback-only dictionary/LLM stubs. This remains separate from real-manager proof.

The real-manager repair run used a loopback fixture on port 5222, with external DNS disabled. No annotation activation, dictionary request, or provider call was made there. It proves actual install, startup, and reload for the exact rebuilt bundle, **not the downstream real-manager menu, key, annotation, or transport checks**. Those remain for independent verification on the new hash. The earlier “Remaining unproven” section still applies to those behaviors.

The browser and server closed in `finally`; temporary profile and copied extension package were removed. No Tabbit extension-page navigation, daily-profile edits, downloads, dependency installs, web-package edits, or commits occurred during repair. Changes are limited to the userscript header, rebuilt output, metadata test, and the two requested reports. No acceptance upload was performed (`lh` was previously confirmed absent).

## Original verdict (before repair)

**CHANGES NEEDED. The exact delivered bundle installs and is enabled in real Tampermonkey 5.5.0, but does not execute on the localhost fixture.** An A/B/A comparison isolates the shipped `@match <all_urls>` metadata as the cause in this runtime: changing only that line in a temporary copy to `@match http://localhost:5217/*` makes the Shadow DOM control appear; reinstalling the original makes it disappear again. No product source or bundle was changed.

This is an observed matching incompatibility, not a validated general replacement pattern. The owner should fix the header using supported userscript match patterns, rebuild, and repeat real-manager verification on the new hash.

## Route and environment

1. Verified the requested artifact before testing and again after cleanup: SHA-256 `838793025b4eb79327eee2c3c1320d2aa0bbf835520cd3db066857d80cff4028`, 39,101 bytes.
2. Tabbit diagnose succeeded; one minimal `about:blank` → data-page probe succeeded. Earlier target-closed failures did not recur.
3. Tabbit automation rejected both `chrome://extensions/` and Tampermonkey's `chrome-extension://.../options.html` with `Protocol error (Page.navigate): Navigation URL is not allowed`. Read-only filesystem inspection found Tampermonkey 5.5.0 installed in Tabbit. No daily-profile settings or scripts were changed.
4. Used the separate-profile fallback: existing headed Playwright Chromium 140.0.7339.16 with real Tampermonkey 5.5.0 MV3. Copied only the installed extension package, not user storage, into unique temporary storage and loaded it unpacked. No downloads or package installs.
5. Enabled Chromium's **Allow User Scripts** permission through its extension-details UI, only in the temporary profile. Imported the exact bundle through Tampermonkey **Utilities → Import from file → Install**. The real Installed Userscripts dashboard showed it enabled.

This was genuine Tampermonkey, not a GM shim. It was headed Chromium in an isolated profile, **not the user's daily Tabbit/Chrome profile** and not branded Google Chrome.

## Observed A/B/A results

Fixture: `http://localhost:5217/fixture`, Japanese and English article text, contenteditable, textarea, input, preformatted code, and a site-owned marker.

A separate tiny control userscript used an explicit localhost match, `@sandbox DOM`, and `@grant GM_getValue`. It wrote only `typeof GM_getValue` to a body attribute. That attribute was `function`, establishing that real-manager execution and the GM grant worked in the same fixture while the delivered product did not run.

| Installed product | Control userscript | Product controls `[data-ilr-owned="controls"]` | Result |
| --- | --- | --- | --- |
| Exact delivered bundle, `@match <all_urls>` | `function` | 0 | FAIL: no product button |
| Temporary copy, only match changed to `http://localhost:5217/*` | `function` | 1 | Diagnostic PASS: real-manager product startup and visible Shadow DOM panel |
| Exact delivered bundle reinstalled; fixture reloaded | `function` | 0 | FAIL reproduced |

The temporary variant's visible panel included the annotation button, Chinese key-security warning, provider-limit advice, no-key state, and remembered-key default. That screenshot is **not evidence that the exact delivered bundle works**.

## Remaining unproven

Testing stopped at the delivered artifact's activation failure. None of the following are newly proven in real Tampermonkey: dictionary annotation, editable exclusions during annotation, restore ownership, native GM menu configuration, masked synthetic key, key absence from page DOM/localStorage while configured, unknown-host provider-button behavior, endpoint re-confirmation, manager persistence, or GM cross-origin/redirect enforcement. Prior GM-stub harness evidence remains separate; it cannot establish these real-manager claims.

No annotation click, synthetic key entry, or provider call was made in this run. The local server included dictionary fixture responses, but they were not exercised. No paid LLM or R2 request was made by the product. External DNS was disabled for the spawned browser; Tampermonkey attempted its own first-run/help navigation, which failed with `ERR_NAME_NOT_RESOLVED`. Local fixture requests used loopback. There is no complete browser-wide network capture, so this report does not claim a packet-level audit of all browser background traffic.

## Evidence

Unique evidence directory:

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/tampermonkey-real-n3e3keq9/`

- `interlinear-reader.user.js`: exact artifact copy.
- `control.user.js`: independent real-GM execution control.
- `explicit-match.user.js`: diagnostic temporary copy; only one metadata line differs.
- `launch.mjs`: headed browser and loopback fixture server setup.
- `requests.jsonl`: loopback fixture request paths and Authorization-presence boolean.
- `exact-result.json`: original bundle absent while control executes.
- `explicit-match-result.json`: temporary variant produces one control host.
- `original-reinstall-result.json`: original failure reproduced.
- `exact-bundle-installed.png`: actual Tampermonkey dashboard, original product and control enabled.
- `exact-bundle-missing-button.png`: original fixture with no product button.
- `explicit-match-button.png`: temporary variant with visible product panel.
- `original-reinstalled-missing-button.png`: reproduced original absence.

The dashboard and temporary-variant screenshots were visually reviewed. Browser interaction commands and their outputs are also in the session transcript. The launcher output is retained at `/Users/huyan00/.local/share/opencode/shell/25421a522e123308c5d500280a1313cb9cb2b742/sh_0aefefa29001fTYnzqHuCtN02c.out`.

## Cleanup and publication

- Tabbit task `usrev` finished once with `--discard`; only its two scratch tabs were closed.
- Spawned browser and loopback server shut down through the launcher's SIGTERM handler; launcher exited zero.
- Temporary Chromium profile and copied Tampermonkey package removed. Evidence files retained.
- No daily-profile modification, no commits, no dependency downloads/installations, no product edits.
- `lh` is unavailable (`command -v lh` exit 1). No acceptance was uploaded and no acceptance URL exists. Coverage: real-manager installation and matching diagnosis evidenced; downstream behavior checks blocked, not passed.

## Round 2 — independent downstream verification (2026-09-17)

**Verdict: PASS for the observed product flows, with one explicit test-plan deviation.** The dictionary endpoint cannot be configured through a native menu: the delivered script hardcodes its R2 dictionary URL and offers only cache clearing. Dictionary requests were therefore intercepted at the browser network boundary and fulfilled using bytes fetched from a loopback dictionary stub. No userscript code or GM API was replaced. This proves real-manager dictionary rendering with local response data, **not a nonexistent dictionary-endpoint configuration feature**, nor production R2/Brotli delivery. If native dictionary-endpoint configurability is a delivery requirement, that requirement is CHANGES-NEEDED.

Exact bundle checked before and after testing: SHA-256 `3d2bfa380bd0291dd97965f5a9fac5116b2aefc97bed527a45667fdaeb56a0c4`, 39,263 bytes. Header retains `@match *://*/*`, `@sandbox DOM`, and the five GM grants. Independent headed Chromium 140.0.7339.16, genuine Tampermonkey 5.5.0 copied from the installed extension package into temporary profiles, Allow User Scripts enabled through Chromium UI, exact file imported through Utilities → Import from file → Install. No GM shim, daily-profile edits, dependency installs, or product fixes.

### Results by flow

| Flow | Verdict | Observed evidence |
| --- | --- | --- |
| JA/EN annotate | PASS with dictionary routing deviation above | Real click on 文 / Annotate produces 本→书, 猫→猫咪, Hello→你好, world→世界 beneath source words. Local dictionary GETs carry no Authorization. |
| Editable exclusions | PASS | Contenteditable, textarea, input, and pre remain unchanged and unannotated. |
| SPA additions | PASS | Adding a paragraph containing Hello 猫 while active results in 你好 / 猫咪 glosses after the debounce; observed after one second, without another activation click. Exact debounce duration was not measured. |
| Restore ownership | PASS | Restore removes all annotation hosts, preserves original JA/EN text and dynamic paragraph, preserves editable contents, and preserves identity of the site-owned marker node. |
| Native key configuration | PASS | Real Tampermonkey menu opens three native prompts; synthetic key is never prefilled. Panel shows sk-…1234, remembered storage, and an ISO last-updated timestamp. |
| Remember/session lifecycle | PASS | Default remembered key and timestamp survive reload. Session-only confirmation retains the current-page key but erases persistence; reload shows 密钥：未设置. Toggle back, reconfigure, reload restores remembered key. This is observed persistence behavior, not forensic disk erasure. |
| Endpoint re-confirmation | PASS | Initial /v1 confirmation held open with zero POSTs; accept yields exactly one local POST. Changing to /v2 displays the new recipient and holds total POST count at one; cancel sends nothing. Subsequent activation and accept yield exactly one /v2 POST. Local LLM gloss 本地 appears. |
| Provider console buttons | PASS | All five known API hosts show a button and create a real manager-opened tab with the exact fixed console URL below. |
| Unknown/misleading hosts | PASS for tested cases | Loopback, api.openai.com.attacker.invalid, attacker.invalid/api.openai.com, and api-openai.com show no provider button and create no new tab. No paid request was attempted for these configurations. |
| Page-world isolation spot-check | PASS | Full synthetic key absent from page DOM serialization including recursively inspected open Shadow DOM, localStorage, and sessionStorage. GM, GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_registerMenuCommand, and GM_openInTab are undefined in page world. This is a spot-check, not a comprehensive hostile-page security proof. |

Actual new-tab URLs read through the real extension's `chrome.tabs.query` (not a GM_openInTab stub):

- `api.openai.com` → `https://platform.openai.com/settings/organization/limits`
- `api.anthropic.com` → `https://console.anthropic.com/settings/limits`
- `api.deepseek.com` → `https://platform.deepseek.com/usage`
- `api.moonshot.cn` → `https://platform.moonshot.cn/console`
- `api.moonshot.ai` → `https://platform.moonshot.ai/console`

### Evidence and harness limitations

Evidence directory: `/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/tm-round2-verify-40112/`.

- `observations.json`: consolidated artifact, per-flow observations, local request counts, provider tab URLs, limitations, cleanup, and final hash.
- `observations-first.json`: initial real-manager annotation, exclusions, dynamic additions, restore, key masking/reload, isolation, and initial session lifecycle observations.
- `observations-key-consent.json`: complete repeated key lifecycle and local LLM consent observations, including before/after POST counts and native dialog messages.
- `observations-providers.json`: all five known hosts and four unknown/misleading endpoint cases, real tab inventory deltas, console log, cleanup.
- `annotated.png`, `dynamic.png`, `restored.png`, `remembered-reload.png`, `session-erased-reload.png`, `remember-restored-reload.png`, `isolation.png`, `first-consent-accepted.png`, `changed-endpoint-declined.png`, `changed-endpoint-accepted.png`, and `provider-*.png`: actual browser screenshots. Annotation, session-erased, and OpenAI-button screenshots visually reviewed.
- `*-dialog.txt`: exact privacy-confirmation messages. Native dialog messages were captured through Playwright's real dialog event; screenshots show post-dialog page state, not the native modal itself.
- `exact.user.js`, `verify.mjs`, `flows.mjs`, `providers.mjs`: exact artifact and runnable harness components. `verify.mjs` currently selects the focused provider sequence; `flows.mjs` retains the key/consent sequence. Initial interactive observations are retained as JSON rather than misrepresented as a single uninterrupted run.

Earlier harness failures are retained, not product failures: Tampermonkey closes its action page after a menu choice, causing a reused popup handle to fail; a retained dialog listener handled a dialog twice; holding a native consent dialog while awaiting its click caused a verifier wait cycle. Fresh action pages and a single queued dialog handler resolved those harness problems. `observations-harness-dialog.json` retains the wait failure. The later `failure.png` / assertion in `observations-key-consent.json` records a provider capture gap: no Playwright-intercepted navigation appeared within 700 ms. The focused provider run instead inspected real browser tabs after 2.5 seconds and observed every correct URL. It did not change the product. The key/consent run logged errors in Tampermonkey's action page (`reading 'replace'`); no corresponding fixture-page error was recorded, and the clean focused provider run had no console errors.

Network controls: fixture and LLM server bound to `127.0.0.1:5233`; the temporary local harness control endpoint used `127.0.0.1:5234`. Browser DNS rules map external hosts to NOTFOUND, excluding localhost. Browser routing aborts external requests it observes; dictionary URLs are fulfilled from the loopback stub, and the real GM transport delivered two synthetic-key POSTs only to loopback. Tampermonkey telemetry/first-run requests observed by routing were aborted. Initial provider-tab navigations were **not captured by Playwright routing**, so provider URL verification relies on tab inventory plus the external-DNS block; no provider content was loaded. This is not a packet-level audit of browser background traffic or proof of manager redirect enforcement.

Final cleanup confirmed: spawned browser closed, both loopback servers closed, temporary profile and extension copy removed, evidence retained. The first harness crash also left no running profile process; its temporary profile was removed before the fresh run. Product source/bundle unchanged. `lh` remains unavailable (exit 1), so no acceptance was uploaded and no acceptance URL exists. The older Remaining unproven section is historical; this round supersedes it only for the flows explicitly covered above.
