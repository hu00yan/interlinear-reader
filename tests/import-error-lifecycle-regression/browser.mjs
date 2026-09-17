// Real-app regression; independent Chromium, not the blocked Tabbit backend.
// ILR_BASE=http://127.0.0.1:5194 ILR_EVIDENCE=/absolute/unique/output node tests/import-error-lifecycle-regression/browser.mjs
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const origin = process.env.ILR_BASE ?? "http://127.0.0.1:5194";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const out =
  process.env.ILR_EVIDENCE ??
  (await mkdtemp(
    "/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-import-error-"
  ));
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  serviceWorkers: "block",
});
const audit = {
  backend: "independent Playwright Chromium (not Tabbit)",
  browser: browser.version(),
  origin,
  requests: [],
  blocked: [],
  pageErrors: [],
  cases: [],
};
await context.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const allowed = url.origin === origin && ["GET", "HEAD"].includes(request.method());
  (allowed ? audit.requests : audit.blocked).push({
    url: url.origin + url.pathname,
    method: request.method(),
  });
  await (allowed ? route.continue() : route.abort("blockedbyclient"));
});
await context.addInitScript(() => localStorage.setItem("ilr:mode", "b"));
const page = await context.newPage();
page.on("pageerror", (error) => audit.pageErrors.push(error.message));
async function ready() {
  await expect(page.locator(".book-spread .para").first()).toBeVisible();
  await expect(page.getByTestId("pager-bottom-info")).toBeVisible();
  await expect(page.getByTestId("mode-switch")).toHaveValue("b");
}
async function upload(file) {
  await page.getByRole("button", { name: "📚 书架", exact: true }).click();
  await page.getByTestId("lang-select").selectOption("en");
  await page.locator("input[type=file]").setInputFiles(file);
}
async function source() {
  return page.locator(".book-spread .para").evaluateAll((nodes) =>
    nodes.map((node) => {
      const clone = node.cloneNode(true);
      clone.querySelectorAll(".gloss,.ai-btn").forEach((el) => el.remove());
      return clone.textContent;
    })
  );
}
const synthetic = (name, text) => ({ name, mimeType: "text/plain", buffer: Buffer.from(text) });
try {
  await page.goto(origin);
  await ready(); // Let the automatic fixture finish before replacing it.
  assert.equal(await page.evaluate(() => localStorage.getItem("ilr:key") || ""), "");
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("ilr.settings.v1") || "{}").apiKey || ""
    ),
    ""
  );
  await upload(
    synthetic("lifecycle-control.txt", "Time and people find a way.\n\nThe man reads a book.")
  );
  await ready();
  await expect(page.locator(".book-title")).toHaveText("lifecycle-control");
  const previous = {
    source: await source(),
    chapter: await page.getByTestId("chapter-select").inputValue(),
    page: await page.getByTestId("pager-bottom-info").innerText(),
  };
  await page.screenshot({ path: join(out, "01-supported-control.png") });
  audit.cases.push({ id: "supported-control", status: "pass", previous });

  const failures = [
    {
      id: "all-image-epub",
      file: fileURLToPath(
        new URL("../format-verification-20260917/fixtures/all-image-original.epub", import.meta.url)
      ),
      error: "EPUB 未提取到正文段落",
    },
    { id: "empty-txt", file: synthetic("empty.txt", " \n\n "), error: "TXT 为空" },
    {
      id: "invalid-epub",
      file: synthetic("invalid.epub", "This is not a ZIP archive."),
      error: /zip file/i,
    },
  ];
  for (const failure of failures) {
    await upload(failure.file);
    await expect(page.locator(".err")).toHaveText(failure.error);
    // Guards the documented baseline defect: the status remained “解析中…”.
    await expect(page.locator(".status-line")).toHaveCount(0);
    await expect(page.locator(".book-title")).toHaveText("lifecycle-control");
    await expect(page.locator(".book-card-title")).toHaveText("《lifecycle-control》");
    const error = await page.locator(".err").innerText();
    await page.screenshot({ path: join(out, `02-${failure.id}-failure.png`) });
    await page.getByRole("button", { name: "开始阅读", exact: true }).click();
    await ready();
    assert.deepEqual(
      await source(),
      previous.source,
      "Failed import must not mutate the prior book source"
    );
    assert.equal(await page.getByTestId("chapter-select").inputValue(), previous.chapter);
    assert.equal(await page.getByTestId("pager-bottom-info").innerText(), previous.page);
    audit.cases.push({
      id: failure.id,
      status: "pass",
      error,
      loadingCleared: true,
      priorBookRetained: true,
    });
    // Immediate successful retry after the image-only error, then restore the control for sibling failures.
    if (failure.id === "all-image-epub") {
      await upload(synthetic("lifecycle-recovered.md", "# Recovery\n\nThe people read again."));
      await ready();
      await expect(page.locator(".book-title")).toHaveText("lifecycle-recovered");
      assert((await source()).join("").includes("The people read again."));
      await expect(page.locator(".err")).toHaveText("");
      await page.screenshot({ path: join(out, "03-supported-recovery.png") });
      await page.getByRole("button", { name: "📚 书架", exact: true }).click();
      await expect(page.locator(".status-line")).toContainText("已载入《lifecycle-recovered》");
      await expect(page.locator(".err")).toHaveCount(0);
      audit.cases.push({
        id: "supported-recovery",
        status: "pass",
        title: "lifecycle-recovered",
        errorCleared: true,
      });
      await upload(
        synthetic("lifecycle-control.txt", "Time and people find a way.\n\nThe man reads a book.")
      );
      await ready();
    }
  }
  assert.deepEqual(audit.pageErrors, []);
  assert.deepEqual(audit.blocked, [], "No external or non-GET requests should even be attempted");
  audit.status = "pass";
} catch (error) {
  audit.status = "fail";
  audit.error = error.stack;
  await page.screenshot({ path: join(out, "regression-failure.png") });
  throw error;
} finally {
  await writeFile(join(out, "browser-observations.json"), JSON.stringify(audit, null, 2));
  console.log(
    JSON.stringify(
      {
        status: audit.status,
        cases: audit.cases,
        requests: audit.requests.length,
        blocked: audit.blocked.length,
        pageErrors: audit.pageErrors,
        out,
      },
      null,
      2
    )
  );
  await browser.close();
}
