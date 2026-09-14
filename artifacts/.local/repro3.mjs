import { chromium } from '@playwright/test';
const base = 'http://localhost:5175';
const browser = await chromium.launch();
// 移动单栏
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#main .para .tok', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const m = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="book-spread"]');
    const cs = getComputedStyle(s);
    return { display: cs.display, cols: cs.gridTemplateColumns ?? null, maxH: cs.maxHeight, spreadH: s.getBoundingClientRect().height, vh: window.innerHeight };
  });
  console.log('MOBILE 390px:', JSON.stringify(m));
  await page.close();
}
// 章节展开交互
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#main .para .tok', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const before = await page.evaluate(() => ({
    open: document.querySelector('details[data-testid="chapter"]').open,
    navVisible: document.querySelector('[data-testid="chapter-list"]').offsetParent !== null,
  }));
  await page.locator('details[data-testid="chapter"] > summary').click();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    open: document.querySelector('details[data-testid="chapter"]').open,
    navVisible: document.querySelector('[data-testid="chapter-list"]').offsetParent !== null,
    items: document.querySelectorAll('[data-testid^="chapter-item-"]').length,
  }));
  await page.locator('[data-testid="chapter-item-1"]').click();
  await page.waitForTimeout(1500);
  const switched = await page.evaluate(() => ({
    badge: document.querySelector('[data-testid="chapter"]')?.textContent?.slice(0, 40),
    info: document.querySelector('[data-testid="pager-top-info"]')?.textContent?.slice(0, 60),
  }));
  console.log('FOLD before:', JSON.stringify(before), 'after-expand:', JSON.stringify(after), 'after-click-item2:', JSON.stringify(switched));
  await page.close();
}
// 粘贴导入 KJV（新 dist 粘贴链）
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#main .para .tok', { timeout: 20000 });
  await page.getByRole('button', { name: '📚 书架' }).click();
  await page.locator('.card select').first().selectOption('en');
  await page.locator('[data-testid="paste-input"]').fill('He hath made the house.\n\nHe doth read the book.');
  await page.locator('[data-testid="paste-import"]').click();
  await page.locator('#main .para .tok').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const toks = [...document.querySelectorAll('#main .para .tok')];
    let miss = 0; const samp = {};
    for (const t of toks) {
      const g = t.querySelector('.gloss'); const txt = (g?.textContent ?? '').trim();
      if (!g || g.classList.contains('missing') || txt === '' || txt === '—' || txt === '···') miss++;
      const s = (t.querySelector('.surface')?.textContent ?? '').trim();
      if (['hath', 'doth'].includes(s)) samp[s] = txt;
    }
    return { toks: toks.length, miss, samp };
  });
  console.log('PASTE KJV:', JSON.stringify(r));
  await page.close();
}
await browser.close();
