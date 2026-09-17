// Separate actual Chromium gate. Does not substitute for the blocked Tabbit surface.
// Usage: ILR_BASE=http://127.0.0.1:<ephemeral-port> node tests/format-verification-20260917/actual-browser.mjs
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const origin = process.env.ILR_BASE;
assert(origin && new URL(origin).hostname === "127.0.0.1", "Local app origin required");
const fx = fileURLToPath(new URL("./fixtures/", import.meta.url));
const out =
  process.env.ILR_EVIDENCE ||
  "/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-format-verification-20260917";
await mkdir(join(out, "assets"), { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  serviceWorkers: "block",
});
const audit = {
  browser: browser.version(),
  origin,
  requests: [],
  blocked: [],
  consoleErrors: [],
  cases: [],
};
await context.route("**/*", async (route) => {
  const r = route.request(),
    u = new URL(r.url());
  const row = { url: u.origin + u.pathname, method: r.method() };
  const ok = u.origin === origin && ["GET", "HEAD"].includes(r.method());
  (ok ? audit.requests : audit.blocked).push(row);
  await (ok ? route.continue() : route.abort("blockedbyclient"));
});
const page = await context.newPage();
page.on("pageerror", (e) => audit.consoleErrors.push(e.message));
async function ready() {
  await page
    .locator(".book-spread .para, .book-spread .reader-image")
    .first()
    .waitFor({ timeout: 30000 });
  await page.getByTestId("pager-bottom-info").waitFor();
  await page.waitForTimeout(350);
}
async function upload(file, lang = "ja") {
  await page.getByRole("button", { name: "📚 书架", exact: true }).click();
  await page.getByTestId("lang-select").selectOption(lang);
  await page.locator("input[type=file]").setInputFiles(file);
}
async function view() {
  return page.locator(".book-spread .para").evaluateAll((els) =>
    els.map((el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll(".gloss,.ai-btn").forEach((e) => e.remove());
      return {
        pi: el.dataset.pi,
        text: c.textContent,
        writingMode: getComputedStyle(el).writingMode,
      };
    })
  );
}
async function record(id, fn) {
  try {
    const result = await fn();
    audit.cases.push({ id, ...result });
  } catch (e) {
    audit.cases.push({ id, status: "blocked", error: e.message });
  }
  await writeFile(join(out, "assets/browser-observations.json"), JSON.stringify(audit, null, 2));
}
try {
  await page.goto(origin);
  await ready();
  // newContext provides isolated storage; boot itself may populate dictionary cache.
  audit.storageKeysAfterBoot = await page.evaluate(() => Object.keys(localStorage));
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("ilr.settings.v1") || "{}").apiKey || ""
    ),
    ""
  );
  await page.getByTestId("mode-switch").selectOption("b");
  await ready();
  await record("horizontal", async () => {
    const dir = join(process.env.HOME, "Downloads");
    const books = (await readdir(dir)).filter(
      (n) => n.normalize("NFC").startsWith("処刑少女の生きる道") && n.endsWith(".epub")
    );
    assert.equal(books.length, 1);
    await upload(join(dir, books[0]));
    await ready();
    const chapterCount = await page.getByTestId("chapter-select").locator("option").count();
    const chapterOptions = await page
      .getByTestId("chapter-select")
      .locator("option")
      .allTextContents();
    let rows = await view(),
      foundOpening = false,
      chapterIndex = 0;
    for (let i = 0; i < Math.min(chapterCount, 12); i++) {
      await page.getByTestId("chapter-select").selectOption(String(i));
      await ready();
      rows = await view();
      if (rows.some((r) => r.text.includes("たまに、夢を見る。"))) {
        foundOpening = true;
        chapterIndex = i;
        break;
      }
    }
    // Only two short paragraphs retained, never whole-book data or screenshot.
    const observation = {
      chapterCount,
      chapterIndex,
      foundOpening,
      firstTwo: rows.slice(0, 2),
      readerImages: await page.locator(".book-spread img").count(),
      imgChapters: chapterOptions.filter((o) => o.includes("插图")),
      imgChaptersTotal: chapterOptions.filter((o) => o.includes("插图")).length,
    };
    return {
      status:
        foundOpening && rows.every((p) => p.writingMode === "horizontal-tb") ? "pass" : "fail",
      observation,
    };
  });
  await record("ruby", async () => {
    await upload(join(fx, "vertical-ruby-original.epub"));
    await ready();
    const rows = await view();
    const source = rows.map((p) => p.text).join("");
    await page.screenshot({ path: join(out, "assets/ruby-original.png") });
    return {
      status: source.includes("にほん") ? "fail" : "pass",
      observation: {
        rows,
        rubyElements: await page.locator(".book-spread ruby").count(),
        readingInSource: source.includes("にほん"),
      },
      screenshot: "assets/ruby-original.png",
    };
  });
  await record("images", async () => ({
    status:
      (await page.getByTestId("chapter-select").locator("option").count()) === 3 &&
      (await page.locator(".book-spread img").count()) > 0
        ? "pass"
        : "fail",
    observation: {
      chapterOptions: await page.getByTestId("chapter-select").locator("option").allTextContents(),
      readerImages: await page.locator(".book-spread img").count(),
      expectedChapters: 3,
      sourceImages: 2,
    },
  }));
  await record("all-image", async () => {
    await upload(join(fx, "all-image-original.epub"));
    // 按序保图：有图的书不再报“未提取到正文段落”，而是把图片作为正文打开。
    await page.locator(".book-spread img").first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: join(out, "assets/all-image-original.png") });
    return {
      status: "pass",
      observation: {
        error: await page
          .locator(".err")
          .innerText()
          .catch(() => ""),
        spreadImgs: await page.locator(".book-spread img").count(),
        chapterOptions: await page
          .getByTestId("chapter-select")
          .locator("option")
          .allTextContents()
          .catch(() => []),
      },
    };
  });
  await record("continuity", async () => {
    const expected = JSON.parse(await readFile(join(fx, "continuity-expected.json"), "utf8"))
      .join("")
      .replace(/\s/g, "");
    const widths = [];
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await upload(join(fx, "continuity-original.epub"));
      await ready();
      let text = "",
        steps = [];
      for (let i = 0; i < 100; i++) {
        const rows = await view();
        text += rows.map((r) => r.text).join("");
        const info = await page.getByTestId("pager-bottom-info").innerText();
        steps.push({ info, chars: rows.reduce((n, r) => n + r.text.length, 0) });
        if (await page.getByTestId("pager-bottom-next").isDisabled()) break;
        assert(i < 99, "Traversal exceeded 100 pages");
        await page.getByTestId("pager-bottom-next").click();
        await ready();
      }
      const normalized = text.replace(/\s/g, "");
      widths.push({
        width,
        steps,
        expectedChars: expected.length,
        actualChars: normalized.length,
        exactMatch: normalized === expected,
      });
    }
    return { status: widths.every((w) => w.exactMatch) ? "pass" : "fail", observation: widths };
  });
  await record("boundaries", async () => {
    const results = [];
    for (const ext of ["pdf", "mobi", "azw3", "djvu"]) {
      await upload(join(fx, `not-a-real-format.${ext}`), "en");
      await ready();
      results.push({ extension: ext, source: (await view()).map((r) => r.text).join("") });
    }
    await page.getByRole("button", { name: "📚 书架", exact: true }).click();
    const accept = await page.locator("input[type=file]").getAttribute("accept");
    return {
      status: "fail",
      observation: {
        accept,
        forcedImports: results,
        nativePickerInteraction: "not tested; accept attribute observed only",
        binaryFormatSupport: "not implied; files contain original plain text",
      },
    };
  });
  assert.equal(audit.blocked.length, 0, "Unexpected requests attempted");
  console.log(
    JSON.stringify(
      {
        browser: audit.browser,
        cases: audit.cases.map((c) => ({ id: c.id, status: c.status })),
        requests: audit.requests.length,
        blocked: audit.blocked.length,
        out,
      },
      null,
      2
    )
  );
} finally {
  await writeFile(join(out, "assets/browser-observations.json"), JSON.stringify(audit, null, 2));
  await browser.close();
}
