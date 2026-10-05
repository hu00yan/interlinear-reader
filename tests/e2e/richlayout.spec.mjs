// Rich-layout (保真版式) e2e: 滚动/单页/双页三种翻页方式 + 双页不再"右页空白、左页硬掰两页"
// + 图片经 assets blob 正常渲染 + 纯文本模式退化。全部打真 dist（跑在 verify.mjs 起的 stub-server 上）。
import { test, expect } from "@playwright/test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FX = (f) => join(root, "tests/fixtures", f);

const readerNav = (page) => page.getByRole("button", { name: "📖 阅读", exact: true });
const settingsNav = (page) => page.getByRole("button", { name: /设置/ });
const richNavSel = (page) => page.locator('[data-testid="richnav-switch"]');
const richReader = (page) => page.locator('[data-testid="rich-reader"]');
const richDoc = (page) => page.locator(".rich-doc");

async function uploadFile(page, file) {
  await page.getByRole("button", { name: "📚 书架", exact: true }).click();
  const sels = page.locator(".card select");
  await sels.first().selectOption("en");
  await page.locator('.card input[type="file"]').setInputFiles(file);
  await readerNav(page).click();
  await expect(page.locator(".rich-doc .tok").first()).toBeVisible({ timeout: 20000 });
}

async function setRichNav(page, v) {
  await settingsNav(page).click();
  await richNavSel(page).selectOption(v);
  await readerNav(page).click();
  await expect(page.locator(".rich-doc")).toBeVisible({ timeout: 20000 });
}

test("rich layout three nav modes + double-page sanity + image + plain-text fallback", async ({
  page,
}) => {
  await page.goto("/");
  await uploadFile(page, FX("en-long.txt"));

  // 1) 滚动：整章可滚、单栏、自然排版
  await setRichNav(page, "scroll");
  await expect(richReader(page)).toHaveCSS("overflow-y", "auto");
  const mw = await richDoc(page).evaluate((el) => el.style.maxWidth);
  expect(mw).toBe("46rem");
  const scrollToks = await page.locator(".rich-doc .tok").count();
  expect(scrollToks).toBeGreaterThan(50); // 整章全注出，无分页切片

  // 2) 单页翻页：隐藏溢出、translateX 驱动、单栏
  await setRichNav(page, "single");
  await expect(richReader(page)).toHaveCSS("overflow-y", "hidden");
  const doc = richDoc(page);
  await expect(doc).toHaveCSS("column-gap", "0px");
  const t0 = await doc.evaluate((el) => el.style.transform);
  expect(t0).toMatch(/translateX\(-?\d+px\)/);
  const info1 = await page.locator('[data-testid="pager-bottom-info"]').textContent();
  const m1 = info1.match(/(\d+)\/(\d+)\s*页/);
  expect(m1, `pager info: ${info1}`).toBeTruthy();
  expect(Number(m1[1])).toBeGreaterThanOrEqual(1);

  // 3) 双页翻页（宽屏）：两列、左页跨满两格、右页隐藏、页数>1
  await setRichNav(page, "double");
  await expect(doc).toHaveCSS("column-gap", "48px");
  const geom = await doc.evaluate((el) => ({
    scrollW: el.scrollWidth,
    clientW: el.clientWidth,
    transform: el.style.transform,
  }));
  expect(geom.scrollW, "double 应双栏溢出成多页").toBeGreaterThan(geom.clientW);
  const rightDisplay = await page
    .locator('[data-testid="book-page-right"]')
    .evaluate((el) => getComputedStyle(el).display);
  expect(rightDisplay).toBe("none");
  // 同一视口内应能看到两列 .tok（左列右列并排，而不是一页硬掰两半）
  const xs = await page.locator(".rich-doc .tok").evaluateAll((els) => {
    const set = new Set();
    for (const el of els.slice(0, 400)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.top >= 0 && r.top < window.innerHeight) set.add(Math.round(r.left / 80));
    }
    return [...set].length;
  });
  expect(xs, "双页应并排可见两列").toBeGreaterThanOrEqual(2);
  const info2 = await page.locator('[data-testid="pager-bottom-info"]').textContent();
  const m2 = info2.match(/(\d+)\/(\d+)\s*页/);
  expect(m2, `pager info: ${info2}`).toBeTruthy();
  expect(Number(m2[2]), `双页总页数应>1: ${info2}`).toBeGreaterThan(1);

  // 4) 双页 + 窄屏：退化单栏（<=899px）
  await page.setViewportSize({ width: 480, height: 800 });
  await settingsNav(page).click();
  await richNavSel(page).selectOption("scroll");
  await richNavSel(page).selectOption("double");
  await readerNav(page).click();
  await expect(page.locator(".rich-doc")).toBeVisible({ timeout: 20000 });
  await expect(page.locator(".rich-doc")).toHaveCSS("column-gap", "0px");
  await page.setViewportSize({ width: 1280, height: 720 });

  // 5) 图片：EPUB 内嵌图经 assets blob 渲染
  await uploadFile(page, FX("sample-image.epub"));
  const img = page.locator(".rich-doc img");
  await expect(img).toHaveCount(1, { timeout: 20000 });
  await expect(img).toHaveAttribute("src", /^blob:/);
  const ok = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
  expect(ok, "图片应解码成功（naturalWidth>0）").toBe(true);

  // 6b) 书内链接：拦截，不允许冒顶导航（否则整页白屏/^404）
  const urlBefore = page.url();
  await page.locator(".rich-doc a").first().click();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(urlBefore);
  await expect(page.locator(".rich-doc")).toBeVisible();

  // 7) 纯文本模式：干掉原书格式与图片，走纯文本链路
  await settingsNav(page).click();
  await page.locator("label.set", { hasText: "纯文本模式" }).locator("input").check();
  await readerNav(page).click();
  await expect(page.locator(".rich-doc")).toHaveCount(0, { timeout: 20000 });
  await expect(page.locator(".rich-doc img")).toHaveCount(0);
  await expect(page.locator("[data-testid^='book-page'] .para .tok").first()).toBeVisible({
    timeout: 20000,
  });
});
