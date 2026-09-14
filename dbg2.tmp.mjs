import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', m => { const t = m.text(); if (t.includes('[paginate]')) console.log(`[${m.type()}] ${t.slice(0,220)}`); });
await page.goto('http://127.0.0.1:5176/', { waitUntil: 'networkidle' });
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(600);
const EN_SENT = 'Time and people find a way through the garden where the small cat drinks milk and the big dog likes fish while birds sing songs in the morning sun ';
const paras = [];
for (let i = 0; i < 10; i++) paras.push(`Paragraph ${i + 1}. ` + EN_SENT.repeat(3));
await page.getByRole('button', { name: '📚 书架', exact: true }).click();
await page.locator('.card select').first().selectOption('en');
await page.locator('[data-testid="paste-input"]').fill(paras.join('\n\n'));
await page.locator('[data-testid="paste-import"]').click();
await page.getByRole('button', { name: '📖 阅读', exact: true }).click();
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(3000);
// 每列精确诊断
const d = await page.evaluate(() => {
  const out = [];
  for (const id of ['book-page-left', 'book-page-right']) {
    const col = document.querySelector(`[data-testid="${id}"]`);
    const cs = getComputedStyle(col);
    const origin = col.getBoundingClientRect().top + col.clientTop + parseFloat(cs.paddingTop);
    const kids = [...col.querySelectorAll(':scope > div > .para')].map(p => {
      const r = p.getBoundingClientRect();
      return { cls: p.className, top: Math.round(r.top - origin), bottom: Math.round(r.bottom - origin), nTok: p.querySelectorAll('.tok').length, pi: p.getAttribute('data-pi') };
    });
    out.push({ id, clientH: col.clientHeight, scrollH: col.scrollHeight, kids });
  }
  return { cols: out, info: document.querySelector('[data-testid="pager-bottom-info"]')?.textContent };
});
console.log(JSON.stringify(d, null, 1));
await browser.close();
