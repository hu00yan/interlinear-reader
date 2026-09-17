# Key security hardening — threat model, changes, evidence

Date: 2026-09-17 (revised same day: default flipped to remembered-key with explicit opt-out, provider-limit links added, dist rebuilt). Scope: userscript key handling (`packages/userscript`), web settings warning (`packages/web/src/ui/app.ts` settings section only), privacy docs. Threat model per user instruction: local malware or a malicious browser extension can read `localStorage`, IndexedDB, and script-manager storage and steal the user's LLM API key to drain its balance. Technical prevention is impossible; the goal is a prominent warning plus blast-radius reduction.

## Approved model

Default **remembers** the key in script-manager (GM) storage. A menu toggle **仅本次会话（不保存）** switches to memory-only, erasing persisted state; switching back persists the current key after a native confirmation. Rationale approved by the user: memory-only forces re-entry on every reload and does not stop local malware anyway; the real mitigation is blast-radius reduction through provider-side limits, low balance, rotation, and fast revocation.

## Changes

### Userscript (`packages/userscript/src/`)

- `security.mjs`: `KeySettings` owns key persistence. `SESSION_ONLY` (GM key `ilr-session-only-v1`) records the opt-out; legacy persisted keys are retained with an unknown timestamp and explicit opt-out wins over a saved key. `keySummary()` produces the display line — masked key (`sk-…last4`), storage mode, last-updated time, rotation hint — and `providerConsole()` maps exact recognized provider hosts to fixed HTTPS console URLs. `CONFIRMED_ENDPOINT` (`ilr-confirmed-endpoint-v1`) is compared before every LLM call so an endpoint change (including returning to a previously allowed endpoint) re-confirms.
- `main.mjs`: key entry only through the native GM menu prompt; the page panel has no key input. Panel shows the bold Chinese warning (`KEY_WARNING`), storage advice (`KEY_ADVICE`, naming OpenAI Usage limits, Anthropic Spend limits, DeepSeek/Moonshot consoles and warning that some budgets alert rather than enforce), masked key + storage mode + last-updated + rotation hint, and a provider-console button for recognized hosts that calls `GM_openInTab` with a fixed HTTPS URL (never page DOM, never `unsafeWindow`; unrecognized hosts show no button). Menu toggle 切换仅本次会话（不保存） erases the persisted key after native confirmation and survives a new page session; switching back persists after its own confirmation. Disable erases everything and resets the mode to remembered. The first-use confirmation states that the API key itself is transmitted and describes the text scope (article/main containers or body, offscreen nonhidden text included).
- Existing first-call confirmation kept; text-scope description made accurate.

### Web settings (`packages/web/src/ui/app.ts`)

- The settings section adds a compact bold-header Chinese warning beside the API key field (`api-key-security-warning`, `aria-describedby` linked), recommending a low-limit dedicated key, provider Usage/Billing/Limits configuration, rotation, and revocation. The file-handler area (mobi lane's ownership) was not touched by this task.

### Docs

- `packages/userscript/README.md` and `docs/research/userscript-implementation.md`: threat-model table (local malware / malicious extension / host page / other userscripts), what each storage option does and does not protect, the honest statement that no technical defense exists against local malware, and the new default documented as disk storage by default with limits + rotation as the real mitigation and memory-only as opt-out.

## Threat model summary

| Threat | Persisted key (GM storage / localStorage) | Session-only key (memory) | Practical defense |
| --- | --- | --- | --- |
| Local malware | Readable — GM storage is a file in the browser profile | Readable while the browser runs | Low-limit dedicated key, rotation, immediate revocation; no technical defense |
| Malicious browser extension | Usually readable (profile access or broad APIs) | Usually not from the page context; readable with profile access | Same as above; avoid sensitive extensions |
| Host page | Not readable — `@sandbox DOM` isolates GM storage from the page world | Not readable | Menu-prompt entry, masked display, origin+endpoint-scoped consent |
| Other userscripts | Not via this script's storage (per-script manager isolation); a hostile manager breaks this assumption | Not readable | No `unsafeWindow`, no page-world bridge |

Neither storage option is encrypted, and neither resists local malware. Memory-only loses the key on reload and forces re-entry; GM storage keeps it as plaintext in the profile. The real mitigation is a spend-capped, low-balance, dedicated key, rotated and revoked fast.

## Tests and evidence

Userscript unit tests (12 passing) cover: masked display with timestamp and rotation hint that never contains the full secret; default persistence across reload with timestamp; opt-out erases the disk key, retains the page key, survives reload, and reverses; legacy keys retained with unknown timestamp and explicit opt-out winning; endpoint re-confirmation across reloads and returns; provider-console allowlist (exact recognized hosts only, attacker-shaped hosts rejected).

The GM-stub browser harness (own server on port 5205, loopback-only, local dictionary/LLM stubs, synthetic test key) ran against the **rebuilt dist bundle at its default path** — no bundle override — proving the shipped bundle contains the hardening. Checks: default persists key + timestamp in GM with masked display/timestamp/rotation hint and the bold warning plus provider guidance present in the built bundle; persisted key alone cannot send (denial sends nothing, endpoint consent permits stub backfill, no key in DOM/shadow DOM/localStorage); menu opt-out erases persistence and survives a new session; switching back persists across sessions; the recognized-provider button invokes only `GM_openInTab` with the fixed console URL (stubbed, no external navigation); disable clears everything; endpoint change re-confirms before sending.

Verification commands: `npm run build --workspace packages/userscript`, `npm run test --workspace packages/userscript` (12/12), `ILR_TEST_PORT=5205 npm run test:browser --workspace packages/userscript` (11 behavior groups, zero page errors). No installs, no commits, no paid LLM, no shared dist writes beyond the approved rebuild.

- Bundle SHA-256: `838793025b4eb79327eee2c3c1320d2aa0bbf835520cd3db066857d80cff4028` (39,101 bytes)
- Evidence: `artifacts/userscript-1IxXi8/` (recovery run on the final tree: results.json with all 11 checks, `errors: []`, screenshots, loopback-only request log) and the earlier same-model runs at `artifacts/userscript-pkbA05/`, `artifacts/userscript-RP7d3i/`, `artifacts/userscript-9ELMhL/`, `artifacts/userscript-wUvBsz/`, `artifacts/userscript-ygP4Fl/`. The pre-hardening lane evidence remains at `artifacts/userscript-BXw6Kf/` and `artifacts/userscript-z9eXZO/`.
