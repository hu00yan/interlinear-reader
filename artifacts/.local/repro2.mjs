import { chromium } from '@playwright/test';
const base = process.argv[2] || 'http://localhost:5175';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForSelector('#main .para .tok, #main .card', { timeout: 20000 });
await page.waitForTimeout(2000);

async function dump(label) {
  const info = await page.evaluate(() => {
    const spread = document.querySelector('[data-testid="book-spread"]');
    const left = document.querySelector('[data-testid="book-page-left"]');
    const right = document.querySelector('[data-testid="book-page-right"]');
    const toks = [...document.querySelectorAll('#main .para .tok')];
    let miss = 0; const samples = {};
    for (const t of toks) {
      const g = t.querySelector('.gloss');
      const txt = (g?.textContent ?? '').trim();
      if (!g || g.classList.contains('missing') || txt === '' || txt === '—' || txt === '···') miss++;
      const s = (t.querySelector('.surface')?.textContent ?? '').trim();
      if (['hath','doth','saith','He','house','book','word','good','the'].includes(s) && Object.keys(samples).length < 10 && !(s in samples))
        samples[s] = txt + '|term=' + t.getAttribute('data-term');
    }
    return {
      toks: toks.length, miss,
      hitRate: toks.length ? ((toks.length - miss) / toks.length).toFixed(3) : null,
      samples,
      items: document.querySelectorAll('[data-testid^="chapter-item-"]').length,
      foldTag: document.querySelector('[data-testid="chapter"]')?.tagName ?? null,
      foldOpen: document.querySelector('details[data-testid="chapter"]')?.open ?? 'N/A(not details)',
      spreadH: spread?.getBoundingClientRect().height ?? null,
      vh: window.innerHeight,
      leftH: left?.getBoundingClientRect().height ?? null,
      rightH: right?.getBoundingClientRect().height ?? null,
      notice: document.querySelector('[data-testid="gloss-notice"]')?.textContent?.slice(0, 200) ?? null,
    };
  });
  console.log('--- ' + label + ' ---');
  console.log(JSON.stringify(info, null, 2));
}
async function upload(name, text) {
  await page.getByRole('button', { name: '📚 书架' }).click();
  await page.locator('.card select').first().selectOption('en');
  await page.locator('.card input[type="file"]').setInputFiles([{ name, mimeType: 'text/plain', buffer: Buffer.from(text, 'utf8') }]);
  await page.getByRole('button', { name: '📖 阅读' }).click().catch(() => {});
  await page.locator('#main .para .tok').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
}
await dump('BOOT fixture (old dist)');
const KJV = 'He hath made the house.\n\nHe doth read the book.\n\nHe saith the word is good.';
await upload('kjv-2samuel.txt', KJV);
await dump('KJV upload en, no key (old dist)');
const LONG = Array.from({ length: 45 }, (_, i) => `The cat sat in the house number ${i + 1} and the dog likes fish in the garden.`).join('\n\n');
await upload('long.txt', LONG);
await dump('LONG 45para spread (old dist)');
await browser.close();
