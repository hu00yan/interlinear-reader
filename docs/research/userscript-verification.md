# Independent userscript verification

Date: 2026-09-17. Baseline: `main` at `00c0f74`, with concurrent uncommitted work. This verification did not use the previous verifier's artifacts as evidence.

## Verdict

- **Core: APPROVED** within the local GM-stub harness boundary. Static review and independent browser checks passed for the copied prebuilt bundle and the snapshot rebuilt from source.
- **Hardening source: APPROVED** within that boundary. Native menu-driven key entry, masking, session-only default, explicit persistence, warning text, and endpoint re-confirmation are implemented in the snapshot.
- **Hardening delivery artifact: CHANGES-NEEDED before distribution.** The prebuilt bundle copied from the repository predates the hardening source. Its core works, but it still persists keys by default and lacks the mask and warnings. This is a concurrent build-state finding, not a claim that the hardening worker has finished with broken code. The source rebuild in temporary storage passes. The owning worker must regenerate the final bundle after finishing, then verify that artifact.

No product source, shared build output, other lane's files, or commits were changed. No dependencies were installed. Browser requests used only a self-owned loopback server on port 5203, with local dictionary and LLM stubs. No R2 or paid LLM requests were made. Documentation queries used Context7, separately from the browser harness.

## Snapshot and evidence

All fresh test artifacts are under:

`/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/userscript-independent-rffd9kfl/`

The snapshot copied `packages/userscript` and its local Japanese deinflection dependency, `packages/lang-packs`, excluding `.git` and `node_modules`. A snapshot-level `node_modules` symlink uses existing installed dependencies. Product files remain copied and isolated.

| Artifact | Contents |
| --- | --- |
| `snapshot-sha256.json` | Hashes of copied source and original output |
| `original-bundle.user.js` | Unchanged prebuilt bundle copied before rebuilding the snapshot |
| `packages/userscript/dist/interlinear-reader.user.js` | Rebuilt snapshot bundle used for hardening browser checks |
| `verify-browser.mjs` | Independently authored Playwright harness |
| `browser-results.json`, `browser.log` | Five passing behavior groups, request summaries, no page errors or console output |
| `annotated.png` | Japanese and English glosses below words; excluded content untouched |
| `restored-masked.png` | Restored site edits, masked synthetic key, warning and advice |
| `verify-original-core.mjs`, `original-core-results.json`, `original-core.log`, `original-annotated.png` | Separate core verification of the copied original bundle |
| `unit.log` | Six existing userscript tests passed |
| `security-verifier.test.mjs`, `security-unit.log` | Four independent hardening state tests passed |
| `root-test.log` | Root suite: 75 passed, zero failed |
| `web-tsc.log` | Empty output, exit zero for web type-check |
| `static-scan.json` | Line-level scan of source and both bundles for executable code, storage, logging, and key sinks |
| `bundle-hardening.diff` | Original-to-rebuilt difference: hardening and build-relative source comments |

SHA-256:

- Original bundle: `c776daf7ca8d7c994edd758abea593aaf3d7bd62d253fee1671318208717f0fd`
- Snapshot rebuilt bundle: `422752a4e5a359f2cb8772bf51aaf544cedbdb8f8bab881b1c45d2dccbe46ac6`

A live-versus-snapshot hash comparison after the browser run found no changes to the copied userscript files. Later concurrent changes are outside this verdict.

## Check results

| Check | Result | Evidence and scope |
| --- | --- | --- |
| Button, Japanese and English annotation | PASS | Original and rebuilt bundles render a floating button and 本→书, Hello→你好. Browser geometry confirms glosses below source words. Screenshots visually reviewed. |
| Punctuation and text preservation | PASS | Tokenizer rejoins exactly with and without `Intl.Segmenter`. Original text node identity survives restore. |
| Skip behavior | PASS | Static selector review covers forms, editables, controls, code, hidden ancestors, ruby, SVG, MathML, iframe, and owned nodes. Browser checks cover input, textarea, editable descendants, pre, code, hidden, form, and ruby. |
| Restore only owned records | PASS | `restore()` unwraps recorded hosts, not arbitrary matching page elements. Site-owned marker, original link and text identities survive. Changed source text and a site-added child remain after restore. |
| Shadow DOM style separation | PASS | Open roots isolate controls and gloss markup. A hostile global `.ilr-gloss { display:none!important }` fixture does not hide glosses. Open Shadow DOM is not a confidentiality boundary. |
| MutationObserver own-node handling | PASS | Annotation construction and restoration disconnect the observer. Gloss/status changes occur in shadow roots outside its subtree. Stable wait produces no extra hosts or dictionary requests. SPA insertion is annotated; source edits are retained. |
| Cancellation and stale response handling | PASS, static | Generation, abort, active, connectivity, and original-content checks gate asynchronous writes. Restore invalidates and aborts before unwrapping. This independent harness did not exercise a delayed response. |
| Dictionary cache bounds | PASS | Serialized UTF-16 GM cache is capped at 2 MiB and LRU-ordered. Existing unit tests cover eviction and oversized entries. Two supported languages bound the number of in-memory maps; memory maps are not capped at 2 MiB. Network responses have a 32 MiB ceiling. |
| Dictionary transport | PASS, local only | Fixed pair URLs contain no page terms. Both browser dictionary requests lack Authorization. Parsing treats responses as text, not code. Production R2 availability, Brotli headers, and fallback transport were not exercised independently. |
| Header and API declarations | PASS, documentation review | Four GM APIs used by source have matching grants. Explicit dictionary host plus wildcard permits configured provider hosts. `@sandbox DOM`, `document-idle`, and `@noframes` agree with the implementation. Wildcard permission remains intentionally broad. |
| No eval or remote executable code | PASS | Both bundles and all four source modules reviewed. No eval, Function constructor, dynamic remote imports, remote script insertion, or `@require`. Japanese deinflection is bundled locally. Responses use JSON parsing and `textContent`. |
| Key entry | PASS, source/rebuilt | Native `prompt()` is called only from the GM configuration menu callback. There is no DOM key input and no prompt prefill. This is not a `GM_prompt` API. |
| Mask and no full key in page storage/DOM/logs | PASS, source/rebuilt | Display contains only masked suffix. Recursive DOM, shadow DOM, attributes, input values, localStorage, and sessionStorage inspection finds no full synthetic key. No console output was captured. Static source scan finds no runtime page-storage or logging sinks. |
| Default session-only and remember opt-in | PASS, source/rebuilt | Default configuration writes no key to GM storage. State tests cover new-instance loss, explicit persistence, forgetting, and migration of legacy saved keys without opt-in. The browser persistence checkbox/confirmation path is statically reviewed, not end-to-end exercised. |
| Endpoint re-confirmation | PASS, source/rebuilt | Snapshot `main.mjs` calls both `needsEndpointConfirmation()` and `confirmEndpoint()`. First denial sends nothing; acceptance sends one local stub request. Changing `/v1` to `/v2` prompts again, names the destination, and denial prevents another request. |
| Warning and advice | PASS, source/rebuilt | Panel and key prompt include local-malware/extension theft and balance-depletion warning. Advice covers low-balance/limited keys, Usage/Billing/Limits, alert-only budget caveat, rotation, and revocation. |
| Prebuilt hardening matches source | FAIL at snapshot time | Original bundle has the older GM-persistence path and lacks `security.mjs`, mask, warning, and dedicated endpoint-confirmation state. Snapshot rebuild resolves the difference. |

The source initially read before copying lacked the endpoint-confirmation calls. The subsequent snapshot already included them. This was observed concurrent progress, not an outstanding source defect.

## Static-review details and limitations

`core.mjs` retains exact original nodes as unprojected light-DOM children. Source words and glosses render in the shadow tree. Restore unwraps current children rather than replacing a saved HTML snapshot, preserving site edits.

Selection prefers outermost article/main containers, otherwise body. It includes offscreen rendered text, not only viewport text. The rebuilt consent explicitly says this. Limits are 400 recorded nodes, 40,000 source characters, and 1,500 characters per text node. A 300 ms debounce handles observed SPA mutations. The observer's attribute filter does not cover every possible page-driven visibility change, and stylesheet-only changes may not trigger a scan. Arbitrary-framework compatibility is not established.

Dictionary freshness is seven days in persistent cache. An already-loaded memory map is reused for the page session. The 2 MiB cache bound applies to writes, not a hostile or manually oversized preexisting GM value before parsing. `anonymous: true`, redirect rejection, final-URL checking, timeout, and response-size controls are present. Actual userscript-manager enforcement remains untested.

The full key is held in the userscript closure, optionally GM storage, and the configured endpoint's Authorization header. The masked last four characters are intentionally visible in shared DOM. Responses containing the full configured key are rejected before display. These observations do not prove protection against local malware, malicious extensions, a compromised manager, or all hostile-page behavior.

Tampermonkey documentation consulted through Context7:

- [Sandbox metadata](https://www.tampermonkey.net/documentation.php?q=sandbox): `DOM` requests `ISOLATED_WORLD` or another enabled DOM-capable context. It is not an unconditional isolation guarantee across runtimes.
- [Connect metadata](https://www.tampermonkey.net/documentation.php?q=connect): multiple hosts and `*` are supported; both initial and final destinations are checked.
- [Grant metadata](https://www.tampermonkey.net/documentation.php?q=grant): GM API access is explicitly granted.
- [GM_xmlhttpRequest](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest): documents `anonymous`, redirect policy, callbacks, `finalUrl`, and abort handles, with browser-specific limitations.

## Commands and versions

From the isolated snapshot directory:

```sh
node --test packages/userscript/test/*.test.mjs > unit.log 2>&1
node packages/userscript/build.mjs
node verify-browser.mjs > browser.log 2>&1
node --test security-verifier.test.mjs > security-unit.log 2>&1
node verify-original-core.mjs > original-core.log 2>&1
diff -u original-bundle.user.js packages/userscript/dist/interlinear-reader.user.js > bundle-hardening.diff
```

The original bundle was saved before the snapshot build. The diff exits 1 because differences exist, not because the build failed.

From the live repository root, with output redirected into the evidence directory:

```sh
npm test
./node_modules/.bin/tsc --noEmit -p packages/web/tsconfig.json
```

Automated gates: userscript tests 6/6; independent security tests 4/4; root tests 75/75; web type-check exit 0. The root suite emits one Node experimental localStorage warning. Root and web results describe the concurrent live state at execution time, not an isolated all-lane snapshot. `npm test` does not include `tests/unit` or the userscript suite.

Versions: Node `v26.5.0`, npm `11.17.0`, Playwright `1.63.0`, Chromium `153.0.8010.12`, TypeScript `5.9.3`, esbuild `0.21.5`, jsdom `30.0.1`.

## Verification boundary

The harness injects the bundle and page-world GM stubs into headless Chromium. It is **not a Tampermonkey runtime**, an installation test, or evidence of actual manager sandbox secrecy. Native browser dialogs were exercised through stub-registered menu callbacks, not a real extension menu. Strict CSP, grants, permissions, redirect enforcement, cross-origin GM semantics, manager persistence across reloads, mobile browsers, and real provider behavior remain manual checks before publication.

The harness routes R2-named dictionary requests to `127.0.0.1:5203` before network access. Its local endpoint uses a synthetic key. Browser routing rejects non-loopback origins. Request evidence records paths and Authorization presence, not secret values or source payloads. The server and browser close in `finally`; no other process was stopped.

Five browser behavior groups have local JSON and screenshot evidence. No acceptance upload was performed: `lh` is unavailable (`command -v lh` exited 1), and no installation was attempted. There is no published acceptance URL. The local evidence and this report are the verification deliverables.
