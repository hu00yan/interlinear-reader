// `npm run verify` — one-key unattended self-check. Zero humans, zero LLM spend.
// Orchestrates every track's own checks plus Track-D deploy gates:
//   0. fixtures -> 1. track-d unit -> 2. web build -> 3. web headless verify ->
//   4. provider tests -> 5. dict-loader tests -> 6. build-check -> 7. budget ->
//   8. deploy:dict dry-run -> 9. dict-proof (real loader over HTTP) ->
//   10. Playwright e2e (real app + harness mock-LLM) -> 11. selfcheck poll
// Writes artifacts/verify-report.json + .html. Non-zero exit + file:line on failure.
import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "artifacts"), { recursive: true });
const started = Date.now();
const steps = [];
let failed = false;

function step(name, ok, detail = "", at = "") {
  steps.push({ name, ok, detail, at });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}${at ? ` (${at})` : ""}`);
  if (!ok) failed = true;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, encoding: "utf8", timeout: opts.timeout ?? 300000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const m = out.match(/([a-zA-Z0-9_./-]+\.(?:mjs|mts|ts|js|html|json)):(\d+)/);
  return { code: r.status ?? 1, out, loc: m ? `${m[1]}:${m[2]}` : (opts.at ?? "") };
}

function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? root,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), opts.timeout ?? 300000);
    child.on("close", (status) => {
      clearTimeout(timeout);
      const out = `${stdout}\n${stderr}`;
      const m = out.match(/([a-zA-Z0-9_./-]+\.(?:mjs|mts|ts|js|html|json)):(\d+)/);
      resolve({ code: status ?? 1, out, loc: m ? `${m[1]}:${m[2]}` : (opts.at ?? "") });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ code: 1, out: String(error), loc: opts.at ?? "" });
    });
  });
}

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";

// 0) fixtures (idempotent)
{
  const r = run("node", ["scripts/make-fixture.mjs"], { at: "scripts/make-fixture.mjs:1" });
  step("fixtures (7 txt + 7-chapter epub)", r.code === 0, r.out.trim().slice(-120), r.loc);
}
// 1) track-d unit
{
  const r = run("node", ["--test", "tests/unit/worker-rules.test.mjs", "tests/unit/key-compat.test.mjs"], { at: "tests/unit/worker-rules.test.mjs:1" });
  const m = r.out.match(/# (pass|fail) \d+/g) ?? [];
  step("unit track-d (worker rules + key compat)", r.code === 0, m.join(" ") || r.out.slice(-200), r.loc);
  if (r.code !== 0) writeFileSync(join(root, "artifacts/unit.log"), r.out);
}
// 2) web build (owner: packages/web; includes tsc + vite + 300KB check-size)
{
  const r = run(npmBin, ["--prefix", "packages/web", "run", "build"], { at: "packages/web/src/main.ts:1", timeout: 600000 });
  const tail = r.out.split("\n").filter((l) => /首屏|PASS|FAIL|error TS/i.test(l)).join(" | ").slice(-300);
  step("web build (tsc+vite+300KB)", r.code === 0, tail || r.out.slice(-200), r.loc);
}
// 3) web headless verify (owner: Track A jsdom suite)
{
  const r = run(npmBin, ["--prefix", "packages/web", "run", "verify"], { at: "packages/web/scripts/verify-track-a.ts:1", timeout: 300000 });
  const tail = r.out.split("\n").filter((l) => /PASS|FAIL|通过|失败/i.test(l)).slice(-4).join(" | ").slice(-300);
  step("web headless verify (track A)", r.code === 0, tail || r.out.slice(-200), r.loc);
}
// 4) provider tests (owner: Track C; mock-server, security, budget...)
{
  const r = run("node", ["--test", "packages/provider/test/*.test.ts"], { at: "packages/provider/test/security.test.ts:1", timeout: 300000 });
  const m = r.out.match(/# (pass|fail) \d+/g) ?? [];
  step("provider tests (track C)", r.code === 0, m.join(" ") || r.out.slice(-200), r.loc);
}
// 4b) quality golden (owner: packages/provider/golden; local rules, mock integration)
{
  const r = run("node", ["--test", "packages/provider/test/quality.test.ts"], { at: "packages/provider/golden/score.ts:1", timeout: 300000 });
  const m = r.out.match(/# (pass|fail) \d+/g) ?? [];
  step("quality golden (7-lang local score + mock)", r.code === 0, m.join(" ") || r.out.slice(-200), r.loc);
}
// 5) dict-loader tests (owner: Track B)
{
  const r = run("node", ["--test", "packages/dict-loader/test/*.test.mjs"], { at: "packages/dict-loader/test/loader.test.mjs:1", timeout: 300000 });
  const m = r.out.match(/# (pass|fail) \d+/g) ?? [];
  const noTests = /no tests found/i.test(r.out);
  step("dict-loader tests (track B)", r.code === 0 && !noTests, m.join(" ") || r.out.slice(-200), r.loc);
}
// 6) build-check (Pages shippability)
{
  const r = run("node", ["scripts/build-check.mjs"], { at: "scripts/build-check.mjs:1" });
  step("build-check (dist + shards + no secrets)", r.code === 0, r.out.trim().slice(-160), r.loc);
}
// 7) budget gates
{
  const r = run("node", ["scripts/budget.mjs"], { at: "scripts/budget.mjs:1" });
  const tail = r.out.split("\n").filter((l) => /^(PASS|FAIL)/.test(l)).map((l) => l.split(":")[0]).join(" ");
  step("budget (first-screen/lang-pack/R2)", r.code === 0, `${tail}`.slice(-300) || r.out.slice(-200), r.loc);
}
// 8) deploy:dict dry-run
{
  const r = run("node", ["scripts/deploy-dict.mjs", "--dry-run"], { at: "scripts/deploy-dict.mjs:1" });
  step("deploy:dict dry-run (R2 table)", r.code === 0, r.out.trim().split("\n")[0]?.slice(-160) ?? "", r.loc);
}
// 9-11) stub server: dict-proof -> e2e -> selfcheck
{
  const { createStubServer } = await import("./stub-server.mjs");
  const srv = await createStubServer(0);
  const port = srv.address().port;
  process.env.ILR_BASE = `http://127.0.0.1:${port}`;
  try {
    const r1 = await runAsync("node", ["scripts/dict-proof.mjs"], { at: "scripts/dict-proof.mjs:1", timeout: 300000 });
    step("dict-proof (real loader 7x2 zh/en + miss)", r1.code === 0, r1.out.trim().slice(-1000) || "(no output)", r1.loc);
    const r2 = await runAsync("npx", ["playwright", "test"], { at: "tests/e2e/reader.spec.mjs:1", timeout: 600000 });
    writeFileSync(join(root, "artifacts/e2e.log"), r2.out);
    const tail = r2.out.split("\n").filter((l) => /passed|failed|flaky/i.test(l)).join(" | ").slice(-200);
    step("e2e (7-lang/dict/modes/mock-LLM/hygiene/shots)", r2.code === 0, tail || r2.out.slice(-300), r2.loc);
    try {
      // 无 Worker：健康 = 同源静态词典可取（小包整包 + 超限分片首片）。
      const [zh, chunk] = await Promise.all([
        fetch(`${process.env.ILR_BASE}/dict/ja/zh.dict`).then((x) => x.text()),
        fetch(`${process.env.ILR_BASE}/dict/en/en.dict.00`).then((x) => x.text()),
      ]);
      const ok = zh.includes('家') && chunk.length > 1_000_000;
      step("selfcheck (static dict)", ok, `ja/zh=${zh.split('\n').filter(Boolean).length}entries en-chunk=${(chunk.length / 1048576).toFixed(1)}MB`, "scripts/selfcheck-local.mjs:1");
      writeFileSync(join(root, "artifacts/selfcheck.json"), JSON.stringify({ ok, jaZhEntries: zh.split('\n').filter(Boolean).length }, null, 2));
    } catch (e) { step("selfcheck (static dict)", false, String(e), "scripts/selfcheck-local.mjs:1"); }
  } finally {
    await new Promise((res) => srv.close(res));
  }
}

const report = {
  version: "0.1.0",
  date: new Date().toISOString(),
  ok: !failed,
  durationMs: Date.now() - started,
  contract: {
    langs: ["en", "de", "fr", "it", "es", "ru", "ja"], targets: ["zh", "en"],
    modes: ["A", "B", "C"], r2Layout: "dict/{lang}/{target}.dict.br",
    owners: "types/shard/hash/settings locked by tracks A-C; mirrored in CONTRACT.md",
  },
  steps,
  artifacts: ["artifacts/verify-report.json", "artifacts/verify-report.html", "artifacts/shot-reader.png", "artifacts/shot-settings.png", "artifacts/e2e.log", "artifacts/selfcheck.json"].filter((f) => existsSync(join(root, f))),
};
writeFileSync(join(root, "artifacts/verify-report.json"), JSON.stringify(report, null, 2));
const rows = steps.map((s) => `<tr><td>${s.ok ? "PASS" : "FAIL"}</td><td>${s.name}</td><td>${s.detail}</td><td>${s.at}</td></tr>`).join("");
writeFileSync(join(root, "artifacts/verify-report.html"),
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>verify ${report.ok ? "PASS" : "FAIL"}</title></head>` +
  `<body><h1>verify ${report.ok ? "PASS" : "FAIL"} (${report.date})</h1>` +
  `<table border="1"><tr><th>ok</th><th>step</th><th>detail</th><th>at</th></tr>${rows}</table></body></html>`);
console.log(failed ? "VERIFY FAIL — see artifacts/verify-report.html" : "VERIFY PASS");
process.exit(failed ? 1 : 0);
