import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = '/private/var/folders/pw/zr39lg6537l37bwc6gtzs0780000gn/T/opencode/pagination-before';
mkdirSync(OUT, { recursive: true });

// 生成长章节：60 段，每段约 45 词（中英混排一小部分），确保远超一页
const EN_SENT = 'Time and people find a way through the garden where the small cat drinks milk and the big dog likes fish while birds sing songs in the morning sun ';
const paras = [];
for (let i = 0; i < 60; i++) {
  paras.push(`Paragraph ${i + 1}. ` + EN_SENT.repeat(3));
}
// 加一个超长单段（单段超高场景）
paras.push('LONGPARA. ' + EN_SENT.repeat(30));
// 加中英混排段
paras.push('混排段落 Mixed content 时间 time 房子 house 测试 test '.repeat(20));
const longText = paras.join('\n\n');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const log = [];
page.on('console', m => log.push(`[console:${m.type()}] ${m.text().slice(0,300)}`));
page.on('pageerror', e => log.push(`[pageerror] ${String(e).slice(0,300)}`));

await page.goto('http://127.0.0.1:5176/', { waitUntil: 'networkidle' });
// 等 fixture 自动加载
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1500);

// 切到书架，用粘贴导入长章节
await page.getByRole('button', { name: '📚 书架', exact: true }).click();
await page.locator('.card select').first().selectOption('en');
await page.locator('[data-testid="paste-input"]').fill(longText);
await page.locator('[data-testid="paste-import"]').click();
// 回到阅读
await page.getByRole('button', { name: '📖 阅读', exact: true }).click();
await page.locator('.para .tok').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);

const measure = () => page.evaluate(() => {
  const vp = { w: window.innerWidth, h: window.innerHeight };
  const spread = document.querySelector('[data-testid="book-spread"]');
  const left = document.querySelector('[data-testid="book-page-left"]');
  const right = document.querySelector('[data-testid="book-page-right"]');
  const info = document.querySelector('[data-testid="pager-bottom-info"]');
  const cs = spread ? getComputedStyle(spread) : null;
  const rect = (el) => el ? { clientH: el.clientHeight, scrollH: el.scrollHeight, clientW: el.clientWidth, scrollW: el.scrollWidth, overflow: getComputedStyle(el).overflow, overflowY: getComputedStyle(el).overflowY } : null;
  // 全章段数：从 chapter-select option 文本取
  const chSel = document.querySelector('[data-testid="chapter-select"]');
  // 当前页 DOM 段数与 token 数
  const parasInPage = document.querySelectorAll('[data-testid="book-spread"] .para').length;
  const toksInPage = document.querySelectorAll('[data-testid="book-spread"] .tok').length;
  // 每列 .para 高度累加 vs 列高（判断截断：内容总高 > 列 clientHeight 但 overflow hidden）
  const colMeasure = (pageEl) => {
    if (!pageEl) return null;
    const reader = pageEl.firstElementChild;
    const kids = reader ? [...reader.children] : [...pageEl.children];
    let sum = 0;
    const hs = [];
    for (const k of kids) {
      const h = k.getBoundingClientRect().height;
      hs.push(Math.round(h));
      sum += h;
    }
    return { n: kids.length, sum: Math.round(sum), colClientH: pageEl.clientHeight, overflowPx: Math.round(sum - pageEl.clientHeight) };
  };
  return {
    vp, info: info?.textContent ?? null,
    spread: rect(spread), left: rect(left), right: rect(right),
    parasInPage, toksInPage,
    leftCols: colMeasure(left), rightCols: colMeasure(right),
    leftOverflowAttr: left?.getAttribute('data-overflow'),
    rightOverflowAttr: right?.getAttribute('data-overflow'),
    bodyScrollH: document.body.scrollHeight, docEl: document.documentElement.clientHeight,
    appOverflow: (() => { const a = document.getElementById('app'); return a ? getComputedStyle(a).overflow : null; })(),
  };
});

const m1 = await measure();
writeFileSync(join(OUT, 'measure-desktop-1280x800.json'), JSON.stringify(m1, null, 2));
await page.screenshot({ path: join(OUT, 'page1-1280x800.png') });

// 翻到下一页，看页数与内容
const nextBtn = page.locator('[data-testid="pager-bottom-next"]');
const infoText = async () => (await page.locator('[data-testid="pager-bottom-info"]').textContent());
console.log('PAGE1 INFO:', await infoText());
console.log(JSON.stringify(m1, null, 2));

// 遍历所有页，收集每页 info + 每页是否有内部溢出（scrollHeight>clientHeight+1）
const pages = [];
const seen = new Set();
for (let i = 0; i < 40; i++) {
  const info = await infoText();
  if (seen.has(info)) break;
  seen.add(info);
  const m = await measure();
  const overflowL = m.left ? (m.left.scrollH - m.left.clientH) : 0;
  const overflowR = m.right ? (m.right.scrollH - m.right.clientH) : 0;
  pages.push({ info, parasInPage: m.parasInPage, toksInPage: m.toksInPage, overflowL, overflowR, leftCols: m.leftCols, rightCols: m.rightCols });
  await page.screenshot({ path: join(OUT, `walk-${String(i).padStart(2,'0')}-1280x800.png`) });
  const dis = await nextBtn.isDisabled();
  if (dis) break;
  await nextBtn.click();
  await page.waitForTimeout(1200);
}
writeFileSync(join(OUT, 'walk-pages.json'), JSON.stringify(pages, null, 2));
console.log('WALK:', JSON.stringify(pages.map(p => ({ info: p.info, paras: p.parasInPage, oL: p.overflowL, oR: p.overflowR })), null, 2));

// 手机窄屏
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(2500);
const mMobile = await measure();
writeFileSync(join(OUT, 'measure-mobile-390x844.json'), JSON.stringify(mMobile, null, 2));
await page.screenshot({ path: join(OUT, 'page-390x844.png') });
console.log('MOBILE INFO:', await infoText());
console.log(JSON.stringify(mMobile, null, 2));

writeFileSync(join(OUT, 'console-log.txt'), log.join('\n'));
await browser.close();
console.log('DONE ->', OUT);
