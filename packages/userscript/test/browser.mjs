import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { brotliCompressSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.ILR_TEST_PORT ?? 5200);
const origin = `http://127.0.0.1:${port}`;
const evidenceRoot =
  process.env.ILR_EVIDENCE_ROOT ?? fileURLToPath(new URL("../../../artifacts/", import.meta.url));
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(`${evidenceRoot}/userscript-`);
const fixture = await readFile(`${root}/test/fixture.html`, "utf8");
const script = await readFile(
  process.env.ILR_TEST_BUNDLE ?? `${root}/dist/interlinear-reader.user.js`,
  "utf8"
);
const requests = [],
  checks = [];
let delay = 0;
const secret = "test-only-key-never-persist-to-page";
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/dict/")) {
    requests.push({
      type: "dict",
      path: req.url,
      authorizationPresent: !!req.headers.authorization,
    });
    const text = req.url.includes("/ja/")
      ? "猫\t猫\n本\t书\n朝\t早晨\n"
      : "hello\t你好\nbook\t书\n";
    // ja proves .br HTTP decompression; en forces the .dict fallback.
    if (req.url.includes("/en/") && req.url.endsWith(".br")) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.url.endsWith(".br")) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Encoding": "br" });
      res.end(brotliCompressSync(text));
    } else {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
    }
    return;
  }
  if (req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.ok(!body.includes("secret"));
    const input = JSON.parse(JSON.parse(body).messages[1].content);
    requests.push({ type: "llm", path: req.url, sentences: input.sentences.length });
    const result = Object.fromEntries(
      input.sentences.map((s) => [s.id, Object.fromEntries(s.lemmas.map((l) => [l, "补全"]))])
    );
    setTimeout(() => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
    }, delay);
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    req.url === "/ignored"
      ? fixture.replace("<title>", '<meta name="interlinear-reader-ignore"><title>')
      : fixture
  );
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // GM_getValue is synchronous; harness storage lives in closure in the page,
  // like a manager stub, NOT evidence of actual sandbox isolation.
  await page.goto(origin);
  await page.evaluate((origin) => {
    const values = new Map();
    const menus = new Map();
    window.GM_getValue = (key, fallback) =>
      values.has(key) ? structuredClone(values.get(key)) : fallback;
    window.GM_setValue = (key, value) => values.set(key, structuredClone(value));
    window.__savedConfig = () => values.get("ilr-config-v1") ?? null;
    window.__openedTabs = [];
    window.GM_openInTab = (url, options) => window.__openedTabs.push({ url, options });
    window.GM_registerMenuCommand = (name, fn) => menus.set(name, fn);
    window.__menu = (prefix) => [...menus].find(([name]) => name.includes(prefix))[1]();
    window.GM_xmlhttpRequest = (details) => {
      const abort = new AbortController();
      const url = new URL(details.url);
      if (url.hostname === "pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev") {
        url.protocol = "http:";
        url.host = new URL(origin).host;
      } else if (url.origin !== origin) throw Error("Non-loopback request blocked");
      fetch(url, {
        method: details.method,
        headers: details.headers,
        body: details.data,
        signal: abort.signal,
        redirect: "error",
        credentials: "omit",
      })
        .then(async (response) =>
          details.onload({
            status: response.status,
            responseText: await response.text(),
            finalUrl: details.url,
          })
        )
        .catch((error) => (error.name === "AbortError" ? details.onabort() : details.onerror()));
      return { abort: () => abort.abort() };
    };
  }, origin);
  await page.addScriptTag({ content: script });
  const button = page.getByRole("button", { name: "文 / Annotate" });
  await button.waitFor();
  checks.push("floating button appears in Shadow DOM");
  await page.evaluate(() => {
    window.__original = document.querySelector("#japanese").firstChild;
    window.__link = document.querySelector("#original-link");
    window.__site = document.querySelector("#site-owned");
  });
  await button.click();
  await page.getByText("Dictionary ready · missing glosses left blank", { exact: true }).waitFor();
  assert.ok(await page.locator("#japanese .ilr-gloss").filter({ hasText: "书" }).count());
  assert.equal(requests.filter((r) => r.type === "llm").length, 0);
  for (const id of ["code", "input", "editable", "hidden"])
    assert.equal(await page.locator(`#${id} [data-ilr-owned]`).count(), 0);
  assert.ok(requests.some((r) => r.path === "/dict/en/zh.dict"));
  checks.push("dictionary-only default, JA .br glosses, EN .dict fallback, skipped content");
  await page.screenshot({ path: `${evidence}/annotated.png`, fullPage: true });
  await page.getByRole("button", { name: "↩ Restore" }).click();
  assert.equal(await page.locator('[data-ilr-owned="annotation"]').count(), 0);
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector("#japanese").firstChild === window.__original &&
        document.querySelector("#original-link") === window.__link &&
        document.querySelector("#site-owned") === window.__site
    )
  );
  checks.push("restore retains original text, link and site-node identities");

  assert.ok(script.includes("默认记住密钥"));
  assert.ok(script.includes("本程序无法从技术上防御本机恶意软件"));
  assert.ok(script.includes("OpenAI Dashboard → Usage limits / 项目限额"));
  assert.ok(script.includes("Anthropic Console → Spend limits"));
  assert.ok(script.includes("DeepSeek/月之暗面"));
  assert.equal(await page.locator('[data-ilr-owned="controls"] input').count(), 0);
  assert.ok(await page.locator("strong").filter({ hasText: "密钥安全" }).count());
  const answers = [`${origin}/v1`, "stub-model", secret];
  const configureDialog = (dialog) => dialog.accept(answers.shift());
  page.on("dialog", configureDialog);
  await page.evaluate(() => window.__menu("configure LLM"));
  page.off("dialog", configureDialog);
  const saved = await page.evaluate(() => window.__savedConfig());
  assert.equal(saved.key, secret);
  assert.equal(saved.rememberKey, true);
  assert.ok(Number.isFinite(Date.parse(saved.keyUpdatedAt)));
  assert.ok(
    await page
      .getByText(
        `密钥：sk-…${secret.slice(-4)} · 已记住（本地磁盘） · 更新：${saved.keyUpdatedAt} · 建议定期轮换`,
        { exact: true }
      )
      .count()
  );
  checks.push(
    "default persists key + timestamp in GM; masked display + timestamp + rotation hint; bold warning and provider guidance present in built bundle"
  );
  let confirms = 0;
  const deny = async (dialog) => {
    confirms++;
    assert.ok(dialog.message().includes(`${origin}/v1/chat/completions`));
    await dialog.dismiss();
  };
  page.on("dialog", deny);
  await button.click();
  await page.getByText("Dictionary only · LLM consent declined", { exact: true }).waitFor();
  assert.equal(requests.filter((r) => r.type === "llm").length, 0);
  assert.equal(confirms, 1);
  page.off("dialog", deny);
  await page.getByRole("button", { name: "↩ Restore" }).click();
  const allow = async (dialog) => {
    confirms++;
    await dialog.accept();
  };
  page.on("dialog", allow);
  await button.click();
  await page.getByText("Done · dictionary + LLM", { exact: true }).waitFor();
  page.off("dialog", allow);
  assert.ok(requests.some((r) => r.type === "llm"));
  assert.equal(confirms, 2);
  const leaked = await page.evaluate((key) => {
    const visit = (root) =>
      [...root.querySelectorAll("*")].some(
        (el) =>
          [...el.attributes].some((a) => a.value.includes(key)) ||
          (el.textContent ?? "").includes(key) ||
          (el.shadowRoot && visit(el.shadowRoot))
      );
    return visit(document) || JSON.stringify(localStorage).includes(key);
  }, secret);
  assert.equal(leaked, false);
  checks.push(
    "configured key alone cannot send; denial sends nothing; explicit endpoint consent permits stub backfill; no key in DOM/shadow DOM/localStorage"
  );
  await page.screenshot({ path: `${evidence}/backfilled.png`, fullPage: true });

  // A SPA addition is annotated; changed original text is not overwritten.
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.id = "dynamic";
    p.textContent = "猫と本。";
    document.querySelector("article").append(p);
  });
  await page.locator("#dynamic .ilr-gloss").first().waitFor();
  await page.evaluate(() => {
    document.querySelector("#japanese [data-ilr-owned]").firstChild.data = "サイト更新";
  });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "↩ Restore" }).click();
  assert.ok((await page.locator("#japanese").textContent()).includes("サイト更新"));
  checks.push("debounced SPA addition and original-text mutation preserve site edits");

  // Cancel a delayed backfill and ensure it cannot resurrect annotations.
  delay = 600;
  const before = requests.filter((r) => r.type === "llm").length;
  await button.click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-ilr-owned="controls"]')
      .shadowRoot.textContent.includes("LLM backfill")
  );
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: "↩ Restore" }).click();
  await page.waitForTimeout(900);
  assert.equal(await page.locator('[data-ilr-owned="annotation"]').count(), 0);
  assert.ok(requests.filter((r) => r.type === "llm").length > before);
  checks.push("restore during delayed request prevents stale write");

  // Changing the destination cannot reuse an earlier endpoint's consent.
  const changedAnswers = [`${origin}/v2`, "stub-model", secret];
  const changeEndpoint = (dialog) => dialog.accept(changedAnswers.shift());
  page.on("dialog", changeEndpoint);
  await page.evaluate(() => window.__menu("configure LLM"));
  page.off("dialog", changeEndpoint);
  const beforeChangedEndpoint = requests.filter((r) => r.type === "llm").length;
  let changedConfirms = 0;
  const denyChanged = async (dialog) => {
    changedConfirms++;
    assert.ok(dialog.message().includes(`${origin}/v2/chat/completions`));
    assert.ok(dialog.message().includes("offscreen"));
    await dialog.dismiss();
  };
  page.on("dialog", denyChanged);
  await button.click();
  await page.getByText("Dictionary only · LLM consent declined", { exact: true }).waitFor();
  page.off("dialog", denyChanged);
  assert.equal(changedConfirms, 1);
  assert.equal(requests.filter((r) => r.type === "llm").length, beforeChangedEndpoint);
  await page.getByRole("button", { name: "↩ Restore" }).click();

  const acceptToggle = (dialog) => dialog.accept();
  page.on("dialog", acceptToggle);
  await page.evaluate(() => window.__menu("切换仅本次会话"));
  page.off("dialog", acceptToggle);
  assert.equal(await page.evaluate(() => window.__savedConfig()), null);
  assert.ok(await page.getByText(`密钥：sk-…${secret.slice(-4)} · 仅本次会话（不保存）`).count());
  const sessionAnswers = [`${origin}/v1`, "stub-model", secret];
  const sessionDialog = (dialog) => dialog.accept(sessionAnswers.shift());
  page.on("dialog", sessionDialog);
  await page.evaluate(() => window.__menu("configure LLM"));
  page.off("dialog", sessionDialog);
  assert.equal(await page.evaluate(() => window.__savedConfig()), null);
  // Simulate reinjection into a fresh page session, preserving the GM stub storage.
  await page.locator('[data-ilr-owned="controls"]').evaluate((el) => el.remove());
  await page.addScriptTag({ content: script });
  assert.ok(await page.getByText("密钥：未设置", { exact: true }).count());
  assert.ok(
    await page.getByText("存储：仅本次会话（不保存）；菜单可切换", { exact: true }).count()
  );
  checks.push(
    "endpoint change re-confirms before sending; menu opt-out erases persistence and survives a new session without retaining the key"
  );

  page.on("dialog", acceptToggle);
  await page.evaluate(() => window.__menu("切换仅本次会话"));
  page.off("dialog", acceptToggle);
  const providerAnswers = ["https://api.openai.com/v1", "stub-model", secret];
  const providerDialog = (dialog) => dialog.accept(providerAnswers.shift());
  page.on("dialog", providerDialog);
  await page.evaluate(() => window.__menu("configure LLM"));
  page.off("dialog", providerDialog);
  const beforeConsole = requests.length;
  await page
    .getByRole("button", { name: "打开 OpenAI Usage limits / 项目限额", exact: true })
    .click();
  assert.deepEqual(await page.evaluate(() => window.__openedTabs), [
    {
      url: "https://platform.openai.com/settings/organization/limits",
      options: { active: true, insert: true, setParent: false },
    },
  ]);
  assert.equal(requests.length, beforeConsole);
  assert.equal(await page.evaluate(() => window.__savedConfig()?.rememberKey), true);
  const savedTime = await page.evaluate(() => window.__savedConfig().keyUpdatedAt);
  await page.locator('[data-ilr-owned="controls"]').evaluate((el) => el.remove());
  await page.addScriptTag({ content: script });
  assert.ok(
    await page
      .getByText(
        `密钥：sk-…${secret.slice(-4)} · 已记住（本地磁盘） · 更新：${savedTime} · 建议定期轮换`,
        { exact: true }
      )
      .count()
  );
  checks.push(
    "restoring remembered mode persists across new session; recognized provider button invokes only GM_openInTab with fixed console URL (stubbed, no external navigation)"
  );
  await page.evaluate(() => window.__menu("disable LLM"));
  assert.equal(await page.evaluate(() => window.__savedConfig()), null);
  assert.ok(await page.getByText("密钥：未设置", { exact: true }).count());
  checks.push("disable menu clears persisted and current-session key");
  assert.ok(requests.filter((r) => r.type === "dict").every((r) => !r.authorizationPresent));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${evidence}/restored.png`, fullPage: true });
  const ignoredPage = await context.newPage();
  await ignoredPage.goto(`${origin}/ignored`);
  await ignoredPage.addScriptTag({ content: script });
  assert.equal(await ignoredPage.locator("[data-ilr-owned]").count(), 0);
  checks.push("host opt-out prevents initialization");
  await writeFile(
    `${evidence}/results.json`,
    JSON.stringify(
      {
        harness: "headless Chromium, injected bundle + GM stubs; NOT Tampermonkey runtime",
        checks,
        requests,
        errors,
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: checks.length, evidence }, null, 2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
