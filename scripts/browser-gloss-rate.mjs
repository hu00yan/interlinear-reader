// 回归：真实文本注出率 + 阅读页 DOM 口径（无截图，纯 DOM 断言）。
// 用法：node scripts/browser-gloss-rate.mjs [--base http://127.0.0.1:5173]
// 无 --base 时自起 stub-server（dist + dict，与 verify.mjs 同源）。
// 断言（全部读 DOM，不看截图）：
//   1. Gibbon 开篇（127 tok 单段）：内容词命中率>90%，打印 miss 词
//   2. KJV Gen 1:1-6：内容词命中率>80%，打印 miss 词
//   3. cat 中英双命中：zh target 下 gloss=猫；切 EN 后含 cat
//   4. 古英语抽查：hath/doth/saith/thou 有中文
//   5. 单页 pager==2 且 top<body<bottom；多页 1/3->2/3 翻页后仍==2
//   6. notice 口径：[data-testid="gloss-notice"] 含"命中/缺词"；无 key ModeA 含"退化"+"设置"
//   7. ja 核验：ja->zh 常用词命中（家/町），魑魅/未知/行動 missing；notice 含"日→中"+"LLM"+"设置"；
//      切 EN 后家含 house、町含 town、行動含 action；zh 下行動 missing（不编造、不回退 en）；AI 入口 .ai-btn>=1
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 与 packages/web/src/dict/stopwords.ts en 表同口径（内容词 = 非停用词）
const STOP_EN = new Set(
  "the a an and or but of to in on at for with is are was were be been it its this that these those as by from he she they we you i not no".split(" "),
);

const GIBBON = `In the second century of the Christian era, the empire of Rome comprehended the fairest part of the earth, and the most civilised portion of mankind. The frontiers of that extensive monarchy were guarded by ancient renown and disciplined valour. The gentle but powerful influence of laws and manners had gradually cemented the union of the provinces. Their peaceful inhabitants enjoyed and abused the advantages of wealth and luxury. The image of a free constitution was preserved with decent reverence. The Roman senate appeared to possess the sovereign authority, and devolved on the emperors all the executive powers of government. During a happy period of more than fourscore years, the public administration was conducted by the virtue and abilities of Nerva, Trajan, Hadrian, and the two Antonines.`;

const KJV_GEN = `In the beginning God created the heaven and the earth. And the earth was without form, and void; and darkness was upon the face of the deep. And the Spirit of God moved upon the face of the waters. And God said, Let there be light: and there was light. And God saw the light, that it was good: and God divided the light from the darkness. And God called the light Day, and the darkness he called Night. And the evening and the morning were the first day. And God said, Let there be a firmament in the midst of the waters, and let it divide the waters from the waters.`;

const CAT = `The cat sat on the mat.`;

const ARCHAIC = `He hath made the house. Thou seest the light.`;

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
  await page.locator(".para .tok").first().waitFor({ timeout: 30000 });

  async function upload(name, text, lang = "en") {
    await page.getByRole("button", { name: "📚 书架", exact: true }).click();
    await page.locator(".card select").first().selectOption(lang);
    await page.locator('.card input[type="file"]').setInputFiles([
      { name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") },
    ]);
    await page.getByRole("button", { name: "📖 阅读", exact: true }).click().catch(() => {});
    await page.locator(".para .tok").first().waitFor({ timeout: 30000 });
  }

  // {toks, hitContent, totalContent, rate, misses[]} — 内容词=非停用词(data-term)，命中=.gloss 非 missing 且有文本
  async function contentRate() {
    return page.evaluate((stopArr) => {
      const stop = new Set(stopArr);
      const toks = [...document.querySelectorAll("#main .para .tok")];
      let total = 0, hit = 0;
      const misses = [];
      for (const t of toks) {
        const term = (t.getAttribute("data-term") ?? "").toLowerCase();
        if (stop.has(term)) continue;
        total++;
        const g = t.querySelector(".gloss");
        const txt = (g?.textContent ?? "").trim();
        if (g && !g.classList.contains("missing") && txt !== "" && txt !== "—" && txt !== "···") hit++;
        else misses.push(`${t.querySelector(".surface")?.textContent}/${term}`);
      }
      return { toks: toks.length, hit, total, rate: total ? hit / total : 1, misses: misses.slice(0, 12) };
    }, [...STOP_EN]);
  }

  async function glossOf(surface) {
    return page.evaluate((s) => {
      const toks = [...document.querySelectorAll("#main .para .tok")];
      const t = toks.find((x) => (x.querySelector(".surface")?.textContent ?? "").trim() === s);
      return t?.querySelector(".gloss")?.textContent?.trim() ?? null;
    }, surface);
  }

  // 1) Gibbon
  await upload("gibbon.txt", GIBBON);
  const gib = await contentRate();
  console.log(`Gibbon toks=${gib.toks} content=${gib.hit}/${gib.total}=${(gib.rate * 100).toFixed(1)}% miss=[${gib.misses.join(" | ")}]`);
  check("Gibbon 127 tok", gib.toks === 127, `got ${gib.toks}`);
  check("Gibbon 内容词命中>90%", gib.rate > 0.9, `${(gib.rate * 100).toFixed(1)}%`);

  // 5a) 单页 pager==2 + 顺序（Gibbon 单段单页）
  {
    const n = await page.locator("#main .pager").count();
    check("单页 .pager==2", n === 2, `got ${n} scripts/browser-gloss-rate.mjs`);
    const top = await page.locator('#main [data-testid="pager-top"]').count();
    const bottom = await page.locator('#main [data-testid="pager-bottom"]').count();
    check("top/bottom 各一套", top === 1 && bottom === 1, `top=${top} bottom=${bottom}`);
    const order = await page.evaluate(() => {
      const kids = [...document.querySelector("#main").children];
      return {
        top: kids.findIndex((el) => el.matches('[data-testid="pager-top"]')),
        body: kids.findIndex((el) => el.querySelector && el.querySelector(".para")),
        bottom: kids.findIndex((el) => el.matches('[data-testid="pager-bottom"]')),
      };
    });
    check("顺序 top<body<bottom", order.top !== -1 && order.top < order.body && order.body < order.bottom, JSON.stringify(order));
  }

  // 6) notice：命中/缺词 + 无 key ModeA 退化导向设置
  {
    const txt = (await page.locator('[data-testid="gloss-notice"]').innerText()).trim();
    check("notice 含命中/缺词", /命中/.test(txt) && /缺词/.test(txt), txt.slice(0, 120));
    check("无 key ModeA 退化提示", /退化/.test(txt) && /设置/.test(txt), txt.slice(0, 160));
  }

  // 2) KJV Gen 1:1-6
  await upload("kjv-gen1.txt", KJV_GEN);
  const kjv = await contentRate();
  console.log(`KJV toks=${kjv.toks} content=${kjv.hit}/${kjv.total}=${(kjv.rate * 100).toFixed(1)}% miss=[${kjv.misses.join(" | ")}]`);
  check("KJV 内容词命中>80%", kjv.rate > 0.8, `${(kjv.rate * 100).toFixed(1)}%`);

  // 3) cat 中英双命中
  await upload("cat.txt", CAT);
  const catZh = await glossOf("cat");
  check("cat zh=猫", catZh === "猫", JSON.stringify(catZh));
  await page.getByRole("button", { name: /目标：中文/ }).click();
  const catEn = await glossOf("cat");
  check("cat en 含 cat", !!catEn && /cat/i.test(catEn), JSON.stringify(catEn));
  await page.getByRole("button", { name: /目标：EN/ }).click(); // 切回中文，免影响后继

  // 4) 古英语抽查
  await upload("archaic.txt", ARCHAIC);
  const CJK = /[\u4e00-\u9fff]/;
  for (const w of ["hath", "Thou"]) {
    const g = await glossOf(w);
    check(`古英语 ${w} 有中文`, !!g && CJK.test(g), `${w} -> ${JSON.stringify(g)}`);
  }

  // 7) ja->en 常用词命中 + ja->zh 缺词进 LLM 队列（不编造，直调入口）
  // 现状：ja breadth en 100% / zh ~2%（JMdict_e 仅英文），缺词 .missing + AI 入口 + notice 导向设置。
  {
    const JA_MIXED = `家と人は町を見る。魑魅は未知だ。`;
    const JA_EN_ONLY = `行動と投票を想像する。`;
    async function glossMissing(surface) {
      return page.evaluate((s) => {
        const toks = [...document.querySelectorAll("#main .para .tok")];
        const t = toks.find((x) => (x.querySelector(".surface")?.textContent ?? "").trim() === s);
        const g = t?.querySelector(".gloss");
        return g ? g.classList.contains("missing") : null;
      }, surface);
    }
    // 7a) zh 目标（默认）：常用词命中，缺词 missing
    await upload("ja-mixed.txt", JA_MIXED, "ja");
    const jaHomeZh = await glossOf("家");
    check("ja->zh 家=家", jaHomeZh === "家", JSON.stringify(jaHomeZh));
    const jaTownZh = await glossOf("町");
    check("ja->zh 町含城镇", !!jaTownZh && /城镇/.test(jaTownZh), JSON.stringify(jaTownZh));
    const jaChimeiMiss = await glossMissing("魑魅");
    check("ja->zh 魑魅缺词missing", jaChimeiMiss === true, `missing=${jaChimeiMiss} scripts/browser-gloss-rate.mjs`);
    const jaMichiMiss = await glossMissing("未知");
    check("ja->zh 未知缺词missing", jaMichiMiss === true, `missing=${jaMichiMiss}`);
    // LLM 队列入口：A 模式每段“释义本句”按钮 + 缺词点词 AI（DOM 可断言），notice 导向设置。
    const aiBtns = await page.locator("#main .ai-btn").count();
    check("ja->zh 缺词LLM入口(ai-btn)", aiBtns >= 1, `got ${aiBtns}`);
    const noticeJa = (await page.locator('[data-testid="gloss-notice"]').innerText()).trim();
    check("ja notice含命中/缺词", /命中/.test(noticeJa) && /缺词/.test(noticeJa), noticeJa.slice(0, 120));
    check("ja notice日→中LLM为主", /日→中/.test(noticeJa) && /LLM/.test(noticeJa), noticeJa.slice(0, 160));
    check("ja notice无key导向设置", /设置/.test(noticeJa), noticeJa.slice(0, 160));
    // 7b) 切 EN：常用词命中（en 全量）
    await page.getByRole("button", { name: /目标：中文/ }).click();
    const jaHomeEn = await glossOf("家");
    check("ja->en 家含house", !!jaHomeEn && /house/i.test(jaHomeEn), JSON.stringify(jaHomeEn));
    const jaTownEn = await glossOf("町");
    check("ja->en 町含town", !!jaTownEn && /town/i.test(jaTownEn), JSON.stringify(jaTownEn));
    await page.getByRole("button", { name: /目标：EN/ }).click(); // 切回中文
    // 7c) en-only 词：en 命中、zh 明确 miss（不编造、不回退 en）
    await upload("ja-enonly.txt", JA_EN_ONLY, "ja");
    await page.getByRole("button", { name: /目标：中文/ }).click();
    const kodouEn = await glossOf("行動");
    check("ja->en 行動含action", !!kodouEn && /action/i.test(kodouEn), JSON.stringify(kodouEn));
    await page.getByRole("button", { name: /目标：EN/ }).click();
    const kodouMiss = await glossMissing("行動");
    const kodouZh = await glossOf("行動");
    check("ja->zh 行動缺词missing(不编造)", kodouMiss === true && (kodouZh === "—" || kodouZh === "···"), JSON.stringify(kodouZh));
  }

  // 5b) 多页翻页（45 段/页 20 → 3 页）
  {
    const paras = Array.from({ length: 45 }, (_, i) => `The cat sat in the house number ${i + 1}.`);
    await upload("multipage.txt", paras.join("\n\n"));
    const info1 = await page.locator('[data-testid="pager-top-info"]').innerText();
    check("分页 1/3", /1\/3/.test(info1), info1);
    await page.locator('[data-testid="pager-bottom-next"]').click();
    await page.waitForFunction(
      () => /2\/3/.test(document.querySelector('[data-testid="pager-top-info"]')?.textContent ?? ""),
      null, { timeout: 15000 },
    );
    const info2 = await page.locator('[data-testid="pager-top-info"]').innerText();
    check("翻页 2/3", /2\/3/.test(info2), info2);
    const n = await page.locator("#main .pager").count();
    check("翻页后仍 .pager==2", n === 2, `got ${n}`);
  }
} finally {
  await browser.close();
  if (srv) await new Promise((res) => srv.close(res));
}

console.log(failures ? `\nGLOSS-RATE FAIL (${failures})` : "\nGLOSS-RATE PASS");
process.exit(failures ? 1 : 0);
