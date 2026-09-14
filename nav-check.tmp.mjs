import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://127.0.0.1:5176/', { waitUntil: 'networkidle' });
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1000);

// 导入长章节（与复现脚本同构：60 段 x ~90 词，确保多页）
const EN_SENT = 'Time and people find a way through the garden where the small cat drinks milk and the big dog likes fish while birds sing songs in the morning sun ';
const paras = [];
for (let i = 0; i < 60; i++) paras.push(`Paragraph ${i + 1}. ` + EN_SENT.repeat(3));
await page.getByRole('button', { name: '📚 书架', exact: true }).click();
await page.locator('.card select').first().selectOption('en');
await page.locator('[data-testid="paste-input"]').fill(paras.join('\n\n'));
await page.locator('[data-testid="paste-import"]').click();
await page.getByRole('button', { name: '📖 阅读', exact: true }).click();
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2000);

const infoText = async () => {
  const el = page.locator('[data-testid="pager-bottom-info"]');
  await el.waitFor({ timeout: 15000 });
  return (await el.textContent())?.trim();
};
const firstSurface = async () => {
  const els = page.locator('[data-testid="book-spread"] .para .surface');
  const n = await els.count();
  const out = [];
  for (let i = 0; i < Math.min(n, 3); i++) out.push(await els.nth(i).textContent());
  return { n, first3: out };
};

console.log('START:', await infoText(), JSON.stringify(await firstSurface()));
for (let k = 0; k < 4; k++) {
  const dis = await page.locator('[data-testid="pager-bottom-next"]').isDisabled();
  console.log(`click#${k} nextDisabled=${dis}`);
  if (dis) break;
  await page.locator('[data-testid="pager-bottom-next"]').click();
  await page.waitForTimeout(2500);
  console.log(`AFTER click#${k}:`, await infoText(), JSON.stringify(await firstSurface()));
  // 内容溢出量
  const ov = await page.evaluate(() => {
    const l = document.querySelector('[data-testid="book-page-left"]');
    const r = document.querySelector('[data-testid="book-page-right"]');
    return {
      l: l ? l.scrollHeight - l.clientHeight : null,
      r: r ? r.scrollHeight - r.clientHeight : null,
      lAttr: l?.getAttribute('data-overflow'),
    };
  });
  console.log('  overflow L/R:', JSON.stringify(ov));
}
// 键盘翻页
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(2500);
console.log('AFTER ArrowRight:', await infoText(), JSON.stringify(await firstSurface()));
await browser.close();
console.log('DONE');
