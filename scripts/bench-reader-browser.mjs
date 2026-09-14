// 阅读性能基准（真实 Chromium，纯 DOM/计时断言，不进 mock-LLM）。
// 用法：
//   node scripts/bench-reader-browser.mjs                  # 自起 stub-server（dist + dict）
//   node scripts/bench-reader-browser.mjs --base http://127.0.0.1:5173   # 打 dev server
//   node scripts/bench-reader-browser.mjs --text=path.txt  # 用真实文本（默认内置长文）
//
// 为什么存在：用户口径的“慢”是「打开一页/翻下一页要等十秒」。那个症状不在词典匹配
// （实测整章 <10ms），而在 ① 缺词 LLM 回填挡在首绘前 ② localStorage 缓存写盘。
// 本脚本把「首绘耗时」与「稳定态翻页耗时」固化成可回归的预算，防止再次退化。
//
// 预算（本机阈值，CI 可放宽）：
//   - 冷开（上传→正文可见）  ≤ 2000ms
//   - 稳定态翻页（连续 5 次） 中位数 ≤ 400ms、最差 ≤ 800ms
//   - 缺词回填不得阻塞首绘：首绘时该页词典命中数已 > 0，且首绘 < 预算
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

const argBase = process.argv.find((a) => a.startsWith("--base"))?.split("=")[1];
const argText = process.argv.find((a) => a.startsWith("--text="))?.slice("--text=".length);

// 内置语料：~300 词/段 × 30 段，接近“一页几百词”的重页场景
const SENT =
  "The council examined the ancient manuscript while the elders debated its meaning in the hall. " +
  "A merchant from the northern province arrived with news of the harbour and the coming harvest. " +
  "They spoke at length of justice and patience and the quiet virtue of ordinary labour. " +
  "The scribe recorded every judgement in the great ledger of the city that same evening. ";
function builtin(n = 30) {
  let out = "";
  for (let i = 0; i < n; i++) out += `Passage ${i + 1}. ${SENT}${SENT}\n\n`;
  return out;
}
const TEXT = argText ? readFileSync(argText, "utf8") : builtin();

let srv = null;
let base = argBase;
if (!base) {
  const { createStubServer } = await import("./stub-server.mjs");
  srv = await createStubServer(0);
  base = `http://127.0.0.1:${srv.address().port}`;
}
console.log(`base=${base}  corpus=${TEXT.length} chars`);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`PAGEERROR ${String(e).slice(0, 200)}`));
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.locator(".para .tok").first().waitFor({ timeout: 30000 });

  // 纯词典（无 key）：隔离 LLM 网络变量，只测词典+渲染+分页
  await page.evaluate(() => {
    const s = {
      baseUrl: "https://openrouter.ai/api/v1", apiKey: "", model: "bench", target: "zh", mode: "A",
      costCapUSD: 5, costUsedUSD: 0, showGloss: true, hideStopwords: false, hideKnown: false,
      freqHideTopN: 0, pageSize: 20,
    };
    localStorage.setItem("ilr.settings.v1", JSON.stringify(s));
    localStorage.setItem("ilr:key", "");
    localStorage.setItem("ilr:mode", "a");
    localStorage.removeItem("ilr.gloss-cache.v1");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".para .tok").first().waitFor({ timeout: 30000 });

  // 冷开：上传→正文可见
  await page.getByRole("button", { name: "📚 书架", exact: true }).click();
  await page.locator('.card input[type="file"]').setInputFiles([
    { name: "bench.txt", mimeType: "text/plain", buffer: Buffer.from(TEXT, "utf8") },
  ]);
  const t0 = Date.now();
  await page.locator('#main [data-testid="pager-bottom-next"]').waitFor({ timeout: 60000 });
  const coldMs = Date.now() - t0;
  const wordsOnPage = await page.locator("#main .para .tok").count();
  const hitsOnPaint = await page.locator("#main .para .tok .gloss:not(.missing)").count();

  // 稳定态翻页：点下页→页码信息变化
  const infoSel = '#main [data-testid="pager-bottom-info"]';
  const turns = [];
  for (let k = 0; k < 5; k++) {
    const before = await page.locator(infoSel).innerText();
    const tt = Date.now();
    await page.locator('#main [data-testid="pager-bottom-next"]').click();
    await page.waitForFunction(
      (prev) => {
        const el = document.querySelector('#main [data-testid="pager-bottom-info"]');
        return el && el.textContent !== prev;
      },
      before,
      { timeout: 60000 },
    );
    turns.push(Date.now() - tt);
    await page.waitForTimeout(200);
  }
  const sorted = [...turns].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];
  const pageInfo = await page.locator(infoSel).innerText();

  console.log(
    `cold-open=${coldMs}ms  words-on-paint=${wordsOnPage}  dict-hits-on-paint=${hitsOnPaint}\n` +
      `page-turns=${JSON.stringify(turns)}  median=${median}ms  worst=${worst}ms\n` +
      `page-info=${pageInfo.replace(/\n/g, " ")}`,
  );

  check("冷开 ≤ 2000ms", coldMs <= 2000, `${coldMs}ms`);
  check("首绘即含词典释义（回填不挡首绘）", hitsOnPaint > 0, `hits=${hitsOnPaint}/${wordsOnPage}`);
  check("翻页中位数 ≤ 400ms", median <= 400, `${median}ms`);
  check("翻页最差 ≤ 800ms", worst <= 800, `${worst}ms`);
} finally {
  await browser.close();
  if (srv) srv.close();
}

console.log(failures === 0 ? "\n基准通过" : `\n基准失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
