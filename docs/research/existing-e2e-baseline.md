# Existing Playwright baseline

## Result

**PASS: 2 passed, 0 failed, 0 skipped, 0 flaky, no retries.** This is an existing-suite code gate, not user acceptance or a format-coverage claim.

Run started at `2026-09-17T06:59:33.535Z`. Playwright reported 3.5 seconds total.

| Existing test | Result | Duration |
| --- | --- | --- |
| `tests/e2e/quality.spec.mjs:6` — settings quality verdict | Pass | 520 ms |
| `tests/e2e/reader.spec.mjs:38` — seven-language upload, dictionaries, modes, mock LLM, and key hygiene | Pass | 2,603 ms |

There are no failure excerpts. The exact log is:

```text
Owned deterministic stub listening on http://127.0.0.1:5191

Running 2 tests using 1 worker

  ✓  1 tests/e2e/quality.spec.mjs:6:1 › settings: quality-test runs golden 7-lang and reports verdict (520ms)
  ✓  2 tests/e2e/reader.spec.mjs:38:1 › real app: 7-lang upload, dict, modes, mock-LLM, hygiene (2.6s)

  2 passed (3.5s)
Owned stub on port 5191 stopped.
```

The quality test expects the deterministic mock's low-quality output to produce an application verdict of `fail`. That expected verdict passed the test.

## Runtime and exact invocation

- Platform: macOS, `darwin arm64`.
- Node: `v26.5.0`, executable `/opt/homebrew/Cellar/node/26.5.0_1/bin/node`.
- Installed Playwright: `1.63.0`.
- Chromium version reported by a fresh default headless launch: `153.0.8010.12`.
- Base URL: `http://127.0.0.1:5191`.
- Workers: 1, to avoid concurrent mutation of the stub's shared request log.
- Existing configuration: 120-second test timeout, zero retries, no configured web server.

The working directory was:

```text
/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-existing-e2e-guz_viz9
```

The exact outer command was:

```sh
node run-baseline.mjs > artifacts/runner.log 2>&1
```

The private runner imported the unchanged `scripts/stub-server.mjs`, called `createStubServer(5191)`, and spawned the following command in that directory:

```sh
ILR_BASE=http://127.0.0.1:5191 \
PLAYWRIGHT_JSON_OUTPUT_FILE=/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-existing-e2e-guz_viz9/artifacts/playwright.json \
/opt/homebrew/Cellar/node/26.5.0_1/bin/node \
node_modules/@playwright/test/cli.js test \
tests/e2e/reader.spec.mjs tests/e2e/quality.spec.mjs \
--config=playwright.config.mjs --workers=1 --reporter=list,json \
--output=/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-existing-e2e-guz_viz9/test-results
```

The test subprocess inherited only existing `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, and `TZ` values, plus the two variables above. It did not inherit provider keys. The runner has a five-minute subprocess watchdog and closes its server in `finally`.

## Tested files and build provenance

Repository HEAD was `00c0f74bb8f3f14a69020893daa9946bd8f79cb8` (`perf(reader): progressive LLM fill + whole-chapter context`). Initial status was:

```text
## main...origin/main
?? docs/
?? tests/format-verification-20260917/
```

At `2026-09-17T14:59:06.533957+08:00`, a private snapshot copied only:

- `playwright.config.mjs`, `package.json`, and `package-lock.json`.
- `scripts/stub-server.mjs`.
- The two existing E2E specs and `tests/fixtures`.
- Existing `packages/web/dist` and `public/dict`.

The snapshot contains 79 copied files totaling 140,701,963 bytes. Its `node_modules` is a symlink to the existing repository dependencies; no install or dependency mutation ran. No `.git`, `.env`, private books, other verifier fixtures, or unrelated source files were copied. The temporary runner is outside the repository. The specs, stub, and Playwright configuration are unchanged and match HEAD.

**The application tested was the existing build, not a fresh build of HEAD.** Its `index.html` and asset directory had local modification times around `2026-09-17 14:34 +08:00`. No build record proves that these bytes correspond exactly to HEAD, so freshness remains unverified. This run did not build or modify shared `dist`.

`artifacts/provenance.json` records the SHA-256, size, and original modification time of every copied file. It also records hashes of the relevant tracked application source at snapshot time. Copy-time hashes matched, and the post-run comparison found no changes to the original copied files or recorded source files. This identifies the tested bytes without claiming a source-to-build relationship.

## Isolation and safety

The private copy isolates the specs' hard-coded `artifacts/shot-reader.png` and `artifacts/shot-settings.png` paths. JSON reports and Playwright output also stayed in the private directory. No product source, shared test harness, configuration, fixture, build, or dependency files changed.

Both specs used fresh Playwright contexts, repository test fixtures, explicit same-origin `/mock-llm` endpoints, and fixed fake keys (`sk-test-e2e-key` and `sk-test-quality`). No paid LLM invocation or real user key was used. No private or whole user book was uploaded. This was not an outbound-network audit; the existing app retains its configured external defaults and fallbacks, and the unchanged tests do not collect a complete network trace.

The reader test checks that non-mock same-origin requests carry no authorization header or test-key material. It also checks zero mock completion requests in mode B and authenticated mock completion requests in mode C. The final saved mock log contains six requests after the suite's resets; it is not a complete log of the earlier quality test.

The runner stopped its own server. A post-run socket connection to port 5191 returned macOS error 61 (connection refused). No other server or Tabbit task was touched. No commit was created.

## Artifacts

All paths below are relative to the private working directory given above:

- `run-baseline.mjs`: exact temporary orchestration code.
- `artifacts/command.json`: executable, arguments, working directory, and environment variable names.
- `artifacts/runtime.json`: runtime and browser version probe.
- `artifacts/provenance.json`: source identity and copied-file hash manifest.
- `artifacts/postrun.json`: unchanged-file checks, post-run status, and port closure check.
- `artifacts/runner.log`: complete orchestration log.
- `artifacts/e2e.log`: Playwright stdout and stderr.
- `artifacts/playwright.json`: structured results, resolved configuration, timings, and empty error arrays.
- `artifacts/exit.json`: exit code 0 and finish timestamp.
- `artifacts/mock-requests.json`: final stub request log after suite resets.
- `artifacts/shot-reader.png` and `artifacts/shot-settings.png`: screenshots produced by the existing reader spec.
- `test-results/`: private Playwright output directory.
