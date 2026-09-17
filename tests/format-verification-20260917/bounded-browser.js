// Feed to tabbit-cli nodejs. Override origin below for a new ephemeral stub server.
const origin = "http://127.0.0.1:59479";
const fs = await import("node:fs/promises");
const path = await import("node:path");
const root = "/Users/huyan00/mycode/interlinear-reader";
const fx = root + "/tests/format-verification-20260917/fixtures/";
globalThis.audit = { requests: [], blocked: [], started: new Date().toISOString() };
await page.route("**/*", async (route) => {
  const r = route.request(),
    u = new URL(r.url());
  const ok = u.origin === origin && ["GET", "HEAD"].includes(r.method());
  const row = { url: u.origin + u.pathname, method: r.method() };
  (ok ? audit.requests : audit.blocked).push(row);
  await (ok ? route.continue() : route.abort("blockedbyclient"));
});
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(origin);
const keys = await page.evaluate(() => Object.keys(localStorage));
assert.equal(keys.length, 0, "Ephemeral origin must start with empty localStorage");
await expect(page.locator(".para .tok").first()).toBeVisible();
await page.getByTestId("mode-switch").selectOption("b");
globalThis.importFile = async (file) => {
  await page.getByRole("button", { name: "📚 书架", exact: true }).click();
  await page.getByTestId("lang-select").selectOption("ja");
  await page.locator("input[type=file]").setInputFiles(file);
};
globalThis.sourceView = async () =>
  page.locator(".book-spread .para").evaluateAll((els) =>
    els.map((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll(".gloss,.ai-btn").forEach((e) => e.remove());
      return {
        pi: el.dataset.pi,
        text: clone.textContent,
        writingMode: getComputedStyle(el).writingMode,
      };
    })
  );
const downloads = path.join(process.env.HOME, "Downloads");
const names = (await fs.readdir(downloads)).filter(
  (n) => n.normalize("NFC").startsWith("処刑少女の生きる道") && n.endsWith(".epub")
);
assert.equal(names.length, 1);
await importFile(path.join(downloads, names[0]));
await expect(page.getByTestId("chapter-select")).toBeVisible({ timeout: 30000 });
await expect(page.locator(".book-spread .para").first()).toBeVisible({ timeout: 30000 });
// Real-book evidence deliberately bounded to two short opening paragraphs.
const actual = await sourceView();
audit.realBook = {
  chapterCount: await page.getByTestId("chapter-select").locator("option").count(),
  firstTwo: actual.slice(0, 2),
  readerImages: await page.locator(".book-spread img").count(),
  allShownHorizontal: actual.every((p) => p.writingMode === "horizontal-tb"),
};
assert(audit.realBook.allShownHorizontal);
await importFile(fx + "all-image-original.epub");
await expect(page.locator(".err")).toHaveText("EPUB 未提取到正文段落");
audit.allImage = { error: await page.locator(".err").innerText() };
// Remove the previous real book title from screenshot by fresh page navigation first.
await page.reload();
await expect(page.locator(".para .tok").first()).toBeVisible();
await importFile(fx + "all-image-original.epub");
await expect(page.locator(".err")).toHaveText("EPUB 未提取到正文段落");
const shot = await page.screenshot({
  path: artifactPath("all-image-original.png"),
  fullPage: false,
});
globalThis.evidenceDir =
  "/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/ilr-format-verification-20260917";
await fs.mkdir(evidenceDir, { recursive: true });
await fs.writeFile(evidenceDir + "/bounded.json", JSON.stringify(audit, null, 2));
return { audit, shot };
