# Install the Interlinear Reader userscript

This is a userscript, not a Chrome extension. It adds **文 / Annotate** to a page and displays Chinese glosses beneath Japanese and English words. Missing glosses stay blank unless you configure an LLM and approve text sharing.

## Build and install from a file

1. From the repository root, run `npm run build --workspace packages/userscript`.
2. Install Tampermonkey from its official browser-store listing.
3. Open the Tampermonkey dashboard and create a new script.
4. Replace the editor contents with `packages/userscript/dist/interlinear-reader.user.js` and save. Alternatively, use the dashboard's file-import facility if your version provides it. Opening a local `.user.js` file directly is manager/browser dependent.
5. **Before enabling the script, restrict its included sites in Tampermonkey settings.** The distributed header has `@match *://*/*`; it does not implement a separate per-site enable list. Avoid mail, account, payment, medical, and other sensitive sites.
6. Reload an allowed article page and click **文 / Annotate**.
7. Click **↩ Restore** to remove annotations and stop outstanding work.

The build uses the repository's existing esbuild dependency. No dependency was installed for this package. The output is gitignored and contains all executable code; it does not load JavaScript or WASM from a CDN.

## Configure optional LLM backfill

1. Open Tampermonkey's menu for this script.
2. Select **Interlinear: configure LLM (key remembered by default)**.
3. Enter your OpenAI-compatible base URL, including its API prefix, such as `https://provider.example/v1`. The script appends `/chat/completions`. Redirecting URLs are rejected.
4. Read the bold Chinese security warning in the panel and the repeated warning in the native key dialog. Enter the provider's model ID and API key in the native browser dialogs opened from the manager menu. The key is never prefilled. Blank disables backfill. **By default the key is remembered**: it is written to Tampermonkey's local GM storage and survives reloads. To keep a key for this page session only, use the menu toggle **切换仅本次会话（不保存）** before or after configuring; a native confirmation precedes the change. The panel displays a masked key (`sk-…last4`), the storage mode, the last-updated time, and a rotation hint — never a key input.
5. Activate annotation again.
6. Read the first-use confirmation. It identifies the endpoint and explains the text sent. Cancel keeps dictionary-only mode for this activation.

When the endpoint host is a recognized provider, the panel shows a button that opens that provider's usage-limit console page through `GM_openInTab` with a fixed HTTPS URL (OpenAI → Usage limits / 项目限额; Anthropic → Spend limits; DeepSeek, Moonshot and similar consoles). It never navigates via the page DOM or `unsafeWindow`, and unrecognized hosts show no button.

**Storage reality and real mitigation.** By default the API key is stored on disk in script-manager storage. No userscript technique defends that key against malware or a hostile browser extension with access to the same machine or profile; treat the key as readable by anything that can read your browser profile. The practical mitigations are blast-radius reduction: use a dedicated key with a low balance and hard usage/spend limits configured in the provider console (verify the limit is enforced, not merely an alert), rotate it periodically, and revoke it immediately if anything looks wrong. Use 仅本次会话（不保存） only to avoid persistence, not as protection against local malware.

Consent is remembered in GM storage for the current site origin and exact endpoint. The last confirmed endpoint is also stored and compared before sending; changing endpoints requires confirmation again, including a return to a previously used endpoint. Consent covers later article mutations while annotation remains active. Use **revoke text-sharing consent** to stop work and require a new confirmation. Use **disable LLM / erase key and consent** to remove the key from this page and script storage. The menu toggle back to remembered mode persists the current session key to disk only after its native confirmation.

## Install from a published listing

No listing has been published. After a maintainer manually publishes a release:

1. Open `<GREASYFORK_LISTING_URL>`.
2. Inspect the source, version, permissions, and privacy description.
3. Select **Install this script** and review Tampermonkey's installation prompt.
4. Restrict included sites before enabling.

Maintainers: use [the listing stub](GREASYFORK.md) and [publication checklist](../../docs/research/userscript-implementation.md#manual-publication). Do not publish placeholder URLs.

## Permission and privacy reference

### Key storage threat model

No technical defense exists against local malware or a malicious extension with enough privilege: both read the browser profile on disk, where script-manager storage lives. The hardening below warns and shrinks blast radius; it does not stop a compromised machine.

| Threat                      | Can it read a remembered key (default)?                                             | Can it read a session-only key?                           | Mitigations in this script                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Local malware               | Yes — GM storage is a file in the browser profile                                   | Yes, while the browser runs                               | Low-limit dedicated key, named provider-console limit pages, rotation hint, revocation guidance |
| Malicious browser extension | Often yes — profile access or broad extension APIs                                  | Usually no from the page context; yes with profile access | Same; avoid sensitive extensions                                                                |
| Host page                   | No — `@sandbox DOM` keeps GM storage out of the page world                          | No                                                        | Menu-prompt entry only, masked display, consent scoped to origin + endpoint                     |
| Other userscripts           | Not via this script's storage (per-script isolation); a hostile manager breaks this | No                                                        | No `unsafeWindow`, no page-world bridge                                                         |

Storage default (user-approved revision, 2026-09-17): **the key is remembered — GM storage on disk as soon as it is configured.** The opt-out is the menu toggle '仅本次会话（不保存）'. Session-only memory keeps the key out of every on-disk store but loses it on reload and remains readable by an attacker while the page is open; it reduces persistence, not exposure. Neither storage is encrypted; neither resists local malware. A low-balance, spend-capped, dedicated key — with hard limits verified in the provider console, rotated periodically and revoked on suspicion — is the practical defense.

- `GM_getValue` and `GM_setValue`: save consent, last confirmed endpoint, the bounded dictionary cache, and — **by default** — the configuration including the API key and its last-updated time. The menu toggle **切换仅本次会话（不保存）** erases the stored configuration and keeps keys memory-only until reversed. No page `localStorage`, DOM input, log, or `unsafeWindow` contains the full userscript key. GM storage is plain script-manager storage: anything that can read the browser profile can read the stored key, and no userscript can change that.
- `GM_registerMenuCommand`: provides configuration, consent revocation, key deletion, and dictionary-cache deletion.
- `GM_xmlhttpRequest`: downloads dictionary data and calls only the configured LLM endpoint. Requests omit cookies and reject redirects. Current Tampermonkey support for these options is required.
- `GM_openInTab`: used only to open a fixed provider-console URL after you click the panel button for a recognized provider host. No page-supplied URL is ever opened.
- `@connect pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev`: the same public R2 dictionary bucket used by the web app. Dictionary requests contain language-pair paths, not article words or the API key.
- `@connect *`: permits custom provider hosts. Narrow this line to your provider's hostname if possible. The code is not a general cross-origin proxy; the wildcard is a manager permission, not a list of hosts the script contacts automatically.
- `@sandbox DOM`: requests DOM access without page-world JavaScript access. Explicit GM grants remain enabled. Never change this to `@grant none` for key-bearing use.
- `@noframes`: no iframe coverage by default.

No LLM request occurs without a nonempty key, model, and explicit consent. The LLM receives only eligible text blocks containing missing words, requested words, and a dictionary instruction. It does not receive the page URL, HTML, form values, or dictionary authorization. A batch is approximately 6,000 JSON characters, with at most 20 text blocks. Each activation is limited to 10 requests and 40,000 transmitted source characters. Responses remain in page-session memory, not persistent excerpt storage. The provider may retain text or charge you; stop cannot recall a request already received by the provider.

## Limitations and data attribution

- Initial scope is Japanese and English to simplified Chinese. `Intl.Segmenter` supplies word boundaries, with a basic regex fallback. Japanese deinflection is bundled from `packages/lang-packs/src/ja.mjs`. There is no remote tokenizer, English stemming, or English-pivot dictionary lookup. Gloss quality is not guaranteed.
- The checked-in `public/dict/sizes.json` records **101 Japanese→Chinese entries** and **107,715 English→Chinese entries**. Japanese dictionary-only coverage is sparse. The production bucket may differ; this run tested local stubs, not current R2 availability.
- Dictionary records are UTF-8 `lemma<TAB>glosses`, with U+001F between senses. Only the first short sense is displayed. `.dict.br` relies on HTTP `Content-Encoding: br`; raw compressed data is rejected and `.dict` is tried. No remote code executes.
- GM dictionary cache has a conservative 2 MiB serialized UTF-16 budget and seven-day freshness. Oversized pairs work in memory but are downloaded again in a new page session. At most the two supported language maps remain in memory. Cache deletion is available in the menu.
- Up to 400 text nodes and 40,000 source characters are annotated. Individual nodes over 1,500 characters are skipped. Article/main containers are preferred; pages without them use body text. “Visible” means rendered, not necessarily within the viewport. Offscreen, nonhidden article text can be included. Occlusion and site-specific sensitive content are not detected.
- Forms, controls, editable areas, code, scripts, styles, hidden ancestors, existing ruby, SVG, MathML, and iframes are skipped. Closed Shadow DOM, canvas, PDFs, browser-internal pages, and store-restricted pages are unsupported.
- Each original text node is retained under an owned host; rendered source and glosses live inside Shadow DOM. Restore unwraps current children instead of restoring a stale HTML snapshot. Site edits and element identities are preserved in the tested cases. Frameworks, accessibility tools, selection/copy, vertical writing, and complex layouts may still behave differently.
- Shadow DOM isolates styles, not a hostile page. A page can modify shared DOM. CSP, sandbox choice, native prompt behavior, and GM permissions vary with browser and manager version. **Tampermonkey installation, isolation, redirect enforcement, and strict-CSP sites were not tested in headless Chromium.** Do not treat the harness as security certification. No mobile manager compatibility guarantee is made.
- A host can opt out with `<meta name="interlinear-reader-ignore">`.

Dictionary attribution is separate from the MIT userscript license. See the bucket's `dict/ja/manifest.json` and `dict/en/manifest.json`, the repository's `public/dict/*/manifest.json`, and [DICT_SOURCES.md](../../DICT_SOURCES.md). Sources include EDRDG/JMdict, Wiktionary, ECDICT, and curated entries. Some manifest license notes remain marked **VERIFY**; resolve those notes before public distribution. No dictionary files are bundled here.

## Verification commands

Run from the repository root:

```sh
npm run build --workspace packages/userscript
npm run test --workspace packages/userscript
npm run test:browser --workspace packages/userscript
```

The browser command starts its own loopback server on port 5200 and a separate headless Chromium context. It blocks external traffic, maps R2 requests to self-authored local dictionary fixtures, and serves a free LLM stub. The server and browser close in `finally`. Screenshots and request summaries go into a unique `artifacts/userscript-*` directory. Port conflicts fail rather than killing another server.

**This is injected-bundle logic verification with GM stubs, not a Tampermonkey-runtime test.** Review [implementation and evidence](../../docs/research/userscript-implementation.md) before making compatibility claims.
