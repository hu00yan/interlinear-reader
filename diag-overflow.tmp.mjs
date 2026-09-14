import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const warns = [];
page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') warns.push(`[${m.type()}] ${m.text().slice(0,200)}`); });
page.on('pageerror', e => warns.push(`[pageerror] ${String(e).slice(0,200)}`));
await page.goto('http://127.0.0.1:5176/', { waitUntil: 'networkidle' });
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);

const EN_SENT = 'Time and people find a way through the garden where the small cat drinks milk and the big dog likes fish while birds sing songs in the morning sun ';
const paras = [];
for (let i = 0; i < 60; i++) paras.push(`Paragraph ${i + 1}. ` + EN_SENT.repeat(3));
await page.getByRole('button', { name: '📚 书架', exact: true }).click();
await page.locator('.card select').first().selectOption('en');
await page.locator('[data-testid="paste-input"]').fill(paras.join('\n\n'));
await page.locator('[data-testid="paste-import"]').click();
await page.getByRole('button', { name: '📖 阅读', exact: true }).click();
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);

const diag = await page.evaluate(() => {
  const spread = document.querySelector('[data-testid="book-spread"]');
  const left = document.querySelector('[data-testid="book-page-left"]');
  const lcs = getComputedStyle(left);
  const spreadRect = spread.getBoundingClientRect();
  const leftRect = left.getBoundingClientRect();
  // 左列内容：各 .para 的 rect（相对列内容顶）
  const origin = leftRect.top + left.clientTop + parseFloat(lcs.paddingTop);
  const paraBoxes = [...left.querySelectorAll(':scope > div > .para')].map(p => {
    const r = p.getBoundingClientRect();
    return { top: Math.round(r.top - origin), bottom: Math.round(r.bottom - origin), cls: p.className, nTok: p.querySelectorAll('.tok').length };
  });
  // token 行：前 12 个 .tok 的 top/bottom
  const toks = [...left.querySelectorAll('.tok')].slice(0, 14).map(t => {
    const r = t.getBoundingClientRect();
    return { top: Math.round((r.top - origin) * 10) / 10, bottom: Math.round((r.bottom - origin) * 10) / 10, s: t.querySelector('.surface').textContent };
  });
  return {
    spreadClientW: spread.clientWidth, spreadClientH: spread.clientHeight,
    leftClientW: left.clientWidth, leftClientH: left.clientHeight,
    leftScrollH: left.scrollHeight,
    padTop: parseFloat(lcs.paddingTop), padBottom: parseFloat(lcs.paddingBottom),
    padL: parseFloat(lcs.paddingLeft), padR: parseFloat(lcs.paddingRight),
    colContentH: left.clientHeight - parseFloat(lcs.paddingTop) - parseFloat(lcs.paddingBottom),
    paraBoxes, toks,
    nPara: paraBoxes.length,
    info: document.querySelector('[data-testid="pager-bottom-info"]')?.textContent,
  };
});
console.log(JSON.stringify(diag, null, 1));
console.log('WARNS:', JSON.stringify(warns, null, 1));
await browser.close();
