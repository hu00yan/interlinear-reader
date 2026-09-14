// 浏览器自测循环：2nd SAMUEL + KJV 章节（真实 Chromium）。
// 用法：node scripts/browser-2samuel.mjs [--base http://127.0.0.1:5173]
// 无 --base 时自起 stub-server（dist + dict + fixtures，与 verify.mjs 同源）。
// 断言：
//   1. 单页 .pager==2 且 top/body/bottom 顺序对
//   2. KJV 每词有 .gloss 元素；抽查 hath/doth/saith 有中文；非停用词零缺词
//   3. 翻页 1/10 -> 2/10 正常，翻页后仍 .pager==2
// 截图：artifacts/browser-2samuel-p1.png / p2.png
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ART = (f) => join(root, "artifacts", f);
const FX = join(root, "artifacts", "2nd SAMUEL - KJV.txt");

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}

const argBase = process.argv.find((a) => a.startsWith("--base"))?.split("=")[1];
let srv = null;
let base = argBase;
if (!base) {
  const { createStubServer } = await import("./stub-server.mjs");
  srv = await createStubServer(0);
  base = `http://127.0.0.1:${srv.address().port}`;
}
console.log(`base=${base}`);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`PAGEERROR ${String(e).slice(0, 200)}`));

  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  // 书架 -> en -> 上传 2nd SAMUEL KJV
  await page.getByRole("button", { name: "📚 书架", exact: true }).click();
  await page.locator(".card select").first().selectOption("en");
  await page.locator('.card input[type="file"]').setInputFiles(FX);
  // 上传后自动切阅读页；等 token 渲染
  await page.getByRole("button", { name: "📖 阅读", exact: true }).click().catch(() => {});
  await page.locator(".para .tok").first().waitFor({ timeout: 30000 });

  // 书名/章节：badge 或 pager 信息带 2nd SAMUEL（parseTxt 以文件名去扩展名作标题）
  const mainText = await page.locator("#main").innerText();
  check("载入 2nd SAMUEL", /2nd SAMUEL/i.test(mainText), mainText.slice(0, 120));

  // 1) 单页 .pager==2
  const pagerCount = await page.locator("#main .pager").count();
  check("单页 .pager==2", pagerCount === 2, `got ${pagerCount} scripts/browser-2samuel.mjs:58`);
  const topCount = await page.locator('#main [data-testid="pager-top"]').count();
  const bottomCount = await page.locator('#main [data-testid="pager-bottom"]').count();
  check("top/bottom 各一套", topCount === 1 && bottomCount === 1, `top=${topCount} bottom=${bottomCount}`);

  // 顺序 top < body(.para) < bottom（比较 DOM 先后）
  const order = await page.evaluate(() => {
    const main = document.querySelector("#main");
    const kids = [...main.children];
    const idxTop = kids.findIndex((el) => el.matches('[data-testid="pager-top"]'));
    const idxBody = kids.findIndex((el) => el.querySelector && el.querySelector(".para"));
    const idxBottom = kids.findIndex((el) => el.matches('[data-testid="pager-bottom"]'));
    return { idxTop, idxBody, idxBottom };
  });
  check(
    "顺序 top<body<bottom",
    order.idxTop !== -1 && order.idxBody !== -1 && order.idxBottom !== -1 &&
      order.idxTop < order.idxBody && order.idxBody < order.idxBottom,
    JSON.stringify(order),
  );

  // 2) KJV 释义：每词有 .gloss 元素
  const glossStats = await page.evaluate(() => {
    const toks = [...document.querySelectorAll("#main .para .tok")];
    let withoutGloss = 0;
    let missing = 0;
    const sample = {};
    for (const t of toks) {
      const g = t.querySelector(".gloss");
      if (!g) { withoutGloss++; continue; }
      if (g.classList.contains("missing") || g.textContent.trim() === "" || g.textContent.trim() === "—") missing++;
      const surf = (t.querySelector(".surface")?.textContent ?? "").trim().toLowerCase();
      if (["hath", "doth", "saith"].includes(surf) && !(surf in sample)) {
        sample[surf] = g.textContent.trim();
      }
    }
    return { toks: toks.length, withoutGloss, missing, sample };
  });
  check("KJV 每词有 .gloss 元素", glossStats.toks > 0 && glossStats.withoutGloss === 0,
    `toks=${glossStats.toks} withoutGloss=${glossStats.withoutGloss}`);
  const CJK = /[\u4e00-\u9fff]/;
  for (const w of ["hath", "doth", "saith"]) {
    const g = glossStats.sample[w] ?? "";
    check(`KJV 抽查 ${w} 有中文`, CJK.test(g), `${w} -> ${JSON.stringify(g)}`);
  }
  // 非停用词零缺词（data-term 已是现代形 lemma；停用词 he/the/is 允许缺）
  const STOP = new Set("the a an and or but of to in on at for with is are was were be been it its this that these those as by from he she they we you i not no".split(" "));
  const contentMissing = await page.evaluate((stopArr) => {
    const stop = new Set(stopArr);
    const bad = [];
    for (const t of document.querySelectorAll("#main .para .tok")) {
      const term = (t.getAttribute("data-term") ?? "").toLowerCase();
      if (stop.has(term)) continue;
      const g = t.querySelector(".gloss");
      if (!g || g.classList.contains("missing") || g.textContent.trim() === "" || g.textContent.trim() === "—") {
        bad.push(`${t.querySelector(".surface")?.textContent}/${term}`);
      }
    }
    return bad.slice(0, 10);
  }, [...STOP]);
  check("KJV 非停用词零缺词", contentMissing.length === 0, contentMissing.join(" "));

  // 3) 翻页 1/10 -> 2/10
  const info1 = await page.locator('[data-testid="pager-top-info"]').innerText();
  check("分页 1/10", /1\/10/.test(info1), info1);
  await page.screenshot({ path: ART("browser-2samuel-p1.png"), fullPage: true });
  await page.locator('[data-testid="pager-bottom-next"]').click();
  await page.waitForFunction(() => /2\/10/.test(document.querySelector('[data-testid="pager-top-info"]')?.textContent ?? ""), null, { timeout: 15000 });
  const info2 = await page.locator('[data-testid="pager-top-info"]').innerText();
  check("翻页 2/10", /2\/10/.test(info2), info2);
  await page.locator(".para .tok").first().waitFor({ timeout: 30000 });
  const pagerCount2 = await page.locator("#main .pager").count();
  check("翻页后仍 .pager==2", pagerCount2 === 2, `got ${pagerCount2}`);
  await page.screenshot({ path: ART("browser-2samuel-p2.png"), fullPage: true });

  // 回翻 2/10 -> 1/10（往返正常）
  await page.locator('[data-testid="pager-bottom-prev"]').click();
  await page.waitForFunction(() => /1\/10/.test(document.querySelector('[data-testid="pager-top-info"]')?.textContent ?? ""), null, { timeout: 15000 });
  const info3 = await page.locator('[data-testid="pager-top-info"]').innerText();
  check("回翻 1/10", /1\/10/.test(info3), info3);
} finally {
  await browser.close();
  if (srv) await new Promise((res) => srv.close(res));
}

console.log(failures ? `\nBROWSER-2SAMUEL FAIL (${failures})` : "\nBROWSER-2SAMUEL PASS");
process.exit(failures ? 1 : 0);
