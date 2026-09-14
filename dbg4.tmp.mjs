import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
await page.waitForTimeout(2500);
// 左列全部 .tok 行（top 去重），与探针行对比
const d = await page.evaluate(() => {
  const col = document.querySelector('[data-testid="book-page-left"]');
  const cs = getComputedStyle(col);
  const origin = col.getBoundingClientRect().top + col.clientTop + parseFloat(cs.paddingTop);
  const lines = new Map();
  col.querySelectorAll('.tok').forEach(t => {
    const r = t.getBoundingClientRect();
    const k = Math.round(r.top - origin);
    if (!lines.has(k)) lines.set(k, { top: k, bottom: Math.round(r.bottom - origin), n: 0, words: [] });
    const L = lines.get(k); L.n++; L.bottom = Math.max(L.bottom, Math.round(r.bottom - origin));
    if (L.words.length < 9) L.words.push(t.querySelector('.surface').textContent);
  });
  return [...lines.values()];
});
console.log('REAL LEFT LINES:');
d.forEach(l => console.log(`top=${l.top} bottom=${l.bottom} n=${l.n} ${l.words.join('/')}`));
await browser.close();
