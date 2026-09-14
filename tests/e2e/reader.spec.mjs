// Track-D unattended e2e against the REAL web build (packages/web/dist).
// All LLM traffic goes to the harness /mock-llm endpoint: $0, deterministic.
// Covers: boot render -> 7-lang TXT upload -> dict hit -> EPUB chapters ->
// A/B/C switch -> B zero-LLM -> C mock-LLM backfill (.from-llm) -> persistence
// -> key hygiene (key only to provider domain, never same-origin) ->
// selfcheck poll -> screenshots.
import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FX = (f) => join(root, "tests/fixtures", f);
const LANGS = ["en", "de", "fr", "it", "es", "ru", "ja"];
// surface word -> expected zh gloss (web mock-dict, lang-agnostic lookup)
const HIT = {
  en: ["Time", "时间"], de: ["Haus", "房子"], fr: ["maison", "房子"],
  it: ["casa", "房子"], es: ["casa", "房子"], ru: ["Дом", "房子"], ja: ["家", "家"],
};
const leakRe = /(sk-test-e2e|apikey\s*[:=]|x-api-key)/i;

const modeSelect = (page) => page.locator('.reader-meta select[data-testid="mode-switch"]');
const tok = (page, surface) =>
  page.locator(".para .tok").filter({ has: page.locator(".surface", { hasText: new RegExp(`^${surface}$`) }) });

const readerNav = (page) => page.getByRole("button", { name: "📖 阅读", exact: true });

async function uploadLang(page, lang, file) {
  await page.getByRole("button", { name: /书架/ }).click();
  const sels = page.locator(".card select");
  await sels.first().selectOption(lang);
  await page.locator('.card input[type="file"]').setInputFiles(file);
  // upload handler switches straight to the reader tab; assert rendered output
  await readerNav(page).click();
  await expect(page.locator(".para .tok").first()).toBeVisible({ timeout: 20000 });
}

test("real app: 7-lang upload, dict, modes, mock-LLM, hygiene", async ({ page, request }) => {
  const sameOriginReqs = [];
  page.on("request", (r) => {
    if (r.url().startsWith("http://127.0.0.1") && !r.url().includes("/mock-llm/"))
      sameOriginReqs.push({ url: r.url(), headers: r.headers(), body: r.postData() ?? "" });
  });
  await page.goto("/");
  // 1) boot: bundled fixture renders without any upload
  await expect(page.locator(".para .tok").first()).toBeVisible({ timeout: 20000 });

  // 2) 7 langs: upload txt -> dict hit gloss visible
  for (const lang of LANGS) {
    await uploadLang(page, lang, FX(`${lang}.txt`));
    const [surface, gloss] = HIT[lang];
    const t = tok(page, surface);
    await expect(t.first()).toBeVisible();
    await expect(t.first().locator(".gloss")).toHaveText(gloss, { timeout: 10000 });
  }

  // 3) EPUB path: 7 chapters preserved
  await page.getByRole("button", { name: /书架/ }).click();
  await page.locator(".card select").first().selectOption("en");
  await page.locator('.card input[type="file"]').setInputFiles(FX("sample-7lang.epub"));
  // EPUB parsing is asynchronous and upload switches to reader automatically.
  await expect(page.locator(".reader-meta > select").first().locator("option")).toHaveCount(7, { timeout: 30000 });

  // 4) A/B/C switch flips badge
  await modeSelect(page).selectOption("b");
  await expect(page.locator(".badge", { hasText: "模式 B" })).toBeVisible();
  // B: pure dict — unknown word shows empty .missing gloss, never LLM
  await page.request.post("/mock-llm/__reset");
  await uploadLang(page, "en", FX("en.txt"));
  await modeSelect(page).selectOption("b");
  const unk = tok(page, "Xyzenigma");
  await expect(unk.first().locator(".gloss.missing")).toHaveCount(1, { timeout: 10000 });
  let recs = await page.request.get("/mock-llm/__requests").then((r) => r.json());
  expect(recs.filter((q) => q.path.includes("chat/completions"))).toHaveLength(0);

  // 5) point app at harness mock-LLM + device key, then C-mode backfill
  await page.getByRole("button", { name: /设置/ }).click();
  const origin = new URL(page.url()).origin;
  const baseUrl = page.locator(".card input[type='url']");
  await baseUrl.fill(`${origin}/mock-llm`);
  await baseUrl.dispatchEvent("change");
  const keyInput = page.locator(".card input[type='password']");
  await keyInput.fill("sk-test-e2e-key");
  await keyInput.dispatchEvent("change");
  await readerNav(page).click();
  await page.request.post("/mock-llm/__reset");
  await modeSelect(page).selectOption("c");
  await expect(page.locator(".badge", { hasText: "模式 C" })).toBeVisible();
  // mock echoes the lowercased lemma ("xyzenigma"), not the surface ("Xyzenigma")
  const filled = tok(page, "Xyzenigma").first().locator(".gloss");
  await expect(filled).toHaveText("MOCK:xyzenigma", { timeout: 30000 });
  await expect(tok(page, "Xyzenigma").first()).toHaveClass(/from-llm/);
  recs = await page.request.get("/mock-llm/__requests").then((r) => r.json());
  const chats = recs.filter((q) => q.path.includes("chat/completions"));
  expect(chats.length).toBeGreaterThan(0);
  expect(chats.every((q) => q.hasAuth)).toBe(true); // key goes to provider domain

  // 6) key hygiene: NOTHING same-origin may carry key material
  expect(sameOriginReqs.length).toBeGreaterThan(0);
  for (const q of sameOriginReqs) {
    expect(q.headers["authorization"] ?? "", `auth leak: ${q.url}`).toBe("");
    expect(`${q.url}\n${q.body}`, `key leak: ${q.url}`).not.toMatch(leakRe);
  }

  // 7) refresh persistence: mode/target/key survive reload (ilr.settings.v1)
  await page.reload();
  await expect(page.locator(".badge", { hasText: "模式 C" })).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: /设置/ }).click();
  await expect(page.locator(".card input[type='password']")).toHaveValue("sk-test-e2e-key");

  // 8) selfcheck pollable (CI gate)
  const sc = await request.get("/api/selfcheck");
  expect(sc.ok()).toBeTruthy();
  const body = await sc.json();
  expect(body.langs).toEqual(LANGS);
  expect(body.modes).toEqual(["A", "B", "C"]);
  expect(body.shardsOk.length).toBe(7);

  // 9) screenshots
  await readerNav(page).click();
  await page.screenshot({ path: join(root, "artifacts/shot-reader.png"), fullPage: true });
  await page.getByRole("button", { name: /设置/ }).click();
  await page.screenshot({ path: join(root, "artifacts/shot-settings.png"), fullPage: true });
});
