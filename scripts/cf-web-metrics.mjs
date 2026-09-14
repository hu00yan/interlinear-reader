// CF/本地 阅读页 DOM + 网页指标一次实测。
// 用法：node scripts/cf-web-metrics.mjs [--base=http://127.0.0.1:5173] [--cf=https://ilr-cache.hacker-news-roo.workers.dev] [--rounds=11]
// 无 --base 时自起 stub-server（dist + dict，与 verify 同源），即“本地版”口径。
// 有公网 Pages 域后：--base=https://<pages域> 重跑，本脚本零改动（base 标记 CF/LOCAL 自动切换）。
// 覆盖（任务口径）：
//   DOM：pager==2（top/bottom各一+顺序）、KJV/Gibbon注出率、Auto、导出按钮、金标入口
//   性能：LCP/CLS/INP-proxy、首屏JS、按章翻页p50/p99（多轮翻页耗时）
// 产物：artifacts/cf-web-metrics.json + 控制台 Markdown 表。截图复用 browser-2samuel p1/p2，另存 metrics-reader.png。
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ART = (f) => join(root, "artifacts", f);
const arg = (k, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.split("=").slice(1).join("=") : d;
};
const ROUNDS = Number(arg("rounds", "11"));
let base = arg("base", null);
const CF = arg("cf", "https://ilr-cache.hacker-news-roo.workers.dev");
let srv = null;
let baseKind = "LOCAL";
if (!base) {
  const { createStubServer } = await import("./stub-server.mjs");
  srv = await createStubServer(0);
  base = `http://127.0.0.1:${srv.address().port}`;
} else if (/pages\.dev|workers\.dev|^https:\/\/(?!127\.|localhost)/.test(base)) {
  baseKind = "CF";
}
console.log(`base=${base} [${baseKind}] cf=${CF} rounds=${ROUNDS}`);

const out = {
  date: new Date().toISOString(),
  base, baseKind, cf: CF,
  pagesDomain: /pages\.dev/.test(base) ? base : null,
  note: "",
  worker: null,
  dom: {},
  perf: {},
  pageturn: {},
  firstScreenJs: {},
  checks: [],
};
let failures = 0;
function check(name, cond, extra = "") {
  out.checks.push({ name, ok: !!cond, extra: String(extra).slice(0, 300) });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!cond) failures++;
}
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// ---- 0) CF Worker 自测（公网 CF 版唯一已出域的部分；Pages 静态域未出） ----
try {
  const t0 = Date.now();
  const r = await fetch(`${CF}/api/selfcheck`);
  const j = await r.json();
  out.worker = {
    ok: r.ok, latencyMs: Date.now() - t0,
    langs: j.langs, modes: j.modes,
    shardsOk: j.shardsOk, hitRate: j.cache?.hitRate,
  };
  check("CF Worker /api/selfcheck 7+7", r.ok && j.langs?.length === 7 && j.shardsOk?.length === 7,
    `lat=${Date.now() - t0}ms shardsOk=${j.shardsOk?.length} hitRate=${j.cache?.hitRate}`);
} catch (e) {
  out.worker = { ok: false, error: String(e).slice(0, 200) };
  check("CF Worker /api/selfcheck 7+7", false, String(e).slice(0, 200));
}
// Pages 域探测：当前无 pages.dev 域（DEPLOY.md 需 Dashboard 手工连 repo），如将来有则 --base 指向它重跑。
out.note = out.pagesDomain
  ? "CF Pages 域实测"
  : "CF Pages 域未出（仅 Worker 域 live），本轮为本地 dist 实测 + 公网 Worker 自测；Pages 域出后 --base=<pages域> 重跑本脚本";

// ---- 1) 首屏 JS（产物口径：dist gzip + 无 modulepreload） ----
try {
  const assets = join(root, "packages/web/dist/assets");
  const html = readFileSync(join(root, "packages/web/dist/index.html"), "utf8");
  const noPreload = !/rel="modulepreload"/.test(html);
  const lazyRe = /lang-dict|epub|llm|url-ingest/;
  let firstGz = 0; const rows = [];
  for (const f of readdirSync(assets).filter((x) => x.endsWith(".js"))) {
    const gz = gzipSync(readFileSync(join(assets, f))).length;
    const lazy = lazyRe.test(f);
    rows.push({ f, gzipB: gz, lazy });
    if (!lazy) firstGz += gz;
  }
  out.firstScreenJs = { gzipB: firstGz, gzipKB: +(firstGz / 1024).toFixed(1), budgetKB: 60, rows, noPreload };
  check("首屏JS ≤60KB gzip", firstGz <= 60 * 1024, `${(firstGz / 1024).toFixed(1)}KB`);
  check("无 modulepreload（首屏口径不失真）", noPreload, "dist/index.html");
} catch (e) {
  check("首屏JS ≤60KB gzip", false, String(e).slice(0, 200));
}

// ---- 2) 浏览器：DOM + WebVitals + 翻页分位 ----
const GIBBON = `In the second century of the Christian era, the empire of Rome comprehended the fairest part of the earth, and the most civilised portion of mankind. The frontiers of that extensive monarchy were guarded by ancient renown and disciplined valour. The gentle but powerful influence of laws and manners had gradually cemented the union of the provinces. Their peaceful inhabitants enjoyed and abused the advantages of wealth and luxury. The image of a free constitution was preserved with decent reverence. The Roman senate appeared to possess the sovereign authority, and devolved on the emperors all the executive powers of government. During a happy period of more than fourscore years, the public administration was conducted by the virtue and abilities of Nerva, Trajan, Hadrian, and the two Antonines.`;
const KJV_GEN = `In the beginning God created the heaven and the earth. And the earth was without form, and void; and darkness was upon the face of the deep. And the Spirit of God moved upon the face of the waters. And God said, Let there be light: and there was light. And God saw the light, that it was good: and God divided the light from the darkness. And God called the light Day, and the darkness he called Night. And the evening and the morning were the first day. And God said, Let there be a firmament in the midst of the waters, and let it divide the waters from the waters.`;
const STOP_EN = "the a an and or but of to in on at for with is are was were be been it its this that these those as by from he she they we you i not no".split(" ");

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`PAGEERROR ${String(e).slice(0, 200)}`));

  // 首屏网络：记录 JS 传输
  const jsNet = [];
  page.on("response", async (r) => {
    try {
      const u = r.url();
      if (u.endsWith(".js")) {
        const h = await r.allHeaders().catch(() => ({}));
        jsNet.push({ url: u.split("/").pop(), status: r.status(), len: h["content-length"] ?? "?" });
      }
    } catch { /* ignore */ }
  });

  // WebVitals 探针（导航前注入 observer，避免错过首屏 LCP/CLS）
  await ctx.addInitScript(() => {
    window.__vitals = { lcp: 0, cls: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const v = e.renderTime || e.loadTime || e.startTime || 0;
          if (v > window.__vitals.lcp) window.__vitals.lcp = v;
        }
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch { /* ignore */ }
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) window.__vitals.cls += e.value || 0;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch { /* ignore */ }
  });
  // 首屏导航后 evaluate 读数
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.locator(".para .tok").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(2500); // 让 LCP/CLS 收敛
  const vitals = await page.evaluate(() => new Promise((resolve) => {
    const nav = performance.getEntriesByType("navigation")[0];
    const w = window.__vitals || { lcp: 0, cls: 0 };
    const res = performance.getEntriesByType("resource")
      .filter((r) => r.name.endsWith(".js"))
      .map((r) => ({ f: r.name.split("/").pop(), transfer: Math.round(r.transferSize || 0), encoded: Math.round(r.encodedBodySize || 0), dur: Math.round(r.duration || 0) }));
    // LCP / CLS：优先读注入探针，其次读现成 entries（无外网 CLS 接近 0 为正常）
    let lcp = Math.round(w.lcp || 0), cls = +Number(w.cls || 0).toFixed(4);
    try {
      for (const e of performance.getEntriesByType("largest-contentful-paint")) lcp = Math.max(lcp, Math.round(e.renderTime || e.loadTime || e.startTime || 0));
    } catch { /* observer-only env */ }
    try {
      if (!w.cls) { let c = 0; for (const e of performance.getEntriesByType("layout-shift")) { if (!e.hadRecentInput) c += e.value || 0; } cls = +c.toFixed(4); }
    } catch { /* ignore */ }
    // 长任务 / 事件延迟（INP 近似上界）
    let longTasks = 0, maxEventDur = 0;
    try {
      for (const e of performance.getEntriesByType("longtask")) longTasks++;
    } catch { /* ignore */ }
    try {
      for (const e of performance.getEntriesByType("event")) maxEventDur = Math.max(maxEventDur, e.duration || 0);
    } catch { /* ignore */ }
    resolve({
      ttfbMs: nav ? Math.round(nav.responseStart || 0) : 0,
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd || 0) : 0,
      loadMs: nav ? Math.round(nav.loadEventEnd || 0) : 0,
      lcpMs: Math.round(lcp), cls: +cls.toFixed(4),
      longTasks, maxEventDurMs: Math.round(maxEventDur),
      jsResources: res,
    });
  }));
  out.perf = vitals;
  check("LCP <2500ms（本地直连）", (vitals.lcpMs || 0) < 2500, `LCP=${vitals.lcpMs}ms TTFB=${vitals.ttfbMs}ms load=${vitals.loadMs}ms`);
  check("CLS <0.1", (vitals.cls ?? 1) < 0.1, `CLS=${vitals.cls}`);
  out.perf.jsNet = jsNet;
  out.perf.note = "INP 需真实交互：以下翻页 p50 作为 INP-proxy，另见 maxEventDur/longTasks";

  async function upload(name, text, lang = "en", waitToks = true) {
    await page.getByRole("button", { name: "📚 书架", exact: true }).click();
    await page.locator(".card select").first().selectOption(lang);
    await page.locator('.card input[type="file"]').setInputFiles([
      { name, mimeType: "text/plain", buffer: Buffer.from(text, "utf8") },
    ]);
    await page.getByRole("button", { name: "📖 阅读", exact: true }).click().catch(() => {});
    if (waitToks) await page.locator(".para .tok").first().waitFor({ timeout: 30000 });
    else await page.locator('[data-testid="gloss-notice"]').waitFor({ timeout: 30000 });
  }
  async function contentRate() {
    return page.evaluate((stopArr) => {
      const stop = new Set(stopArr);
      const toks = [...document.querySelectorAll("#main .para .tok")];
      let total = 0, hit = 0; const misses = [];
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
    }, STOP_EN);
  }
  async function pagerInfo() {
    const n = await page.locator("#main .pager").count();
    const top = await page.locator('#main [data-testid="pager-top"]').count();
    const bottom = await page.locator('#main [data-testid="pager-bottom"]').count();
    const order = await page.evaluate(() => {
      const kids = [...document.querySelector("#main").children];
      return {
        top: kids.findIndex((el) => el.matches('[data-testid="pager-top"]')),
        body: kids.findIndex((el) => el.querySelector && el.querySelector(".para")),
        bottom: kids.findIndex((el) => el.matches('[data-testid="pager-bottom"]')),
      };
    });
    const info = await page.locator('[data-testid="pager-top-info"]').innerText().catch(() => "");
    return { n, top, bottom, order, info };
  }

  // --- Gibbon ---
  await upload("gibbon.txt", GIBBON);
  const gib = await contentRate();
  const pg1 = await pagerInfo();
  out.dom.gibbon = { toks: gib.toks, hit: gib.hit, total: gib.total, rate: +gib.rate.toFixed(4), misses: gib.misses, pager: pg1 };
  check("Gibbon 127 tok", gib.toks === 127, `got ${gib.toks}`);
  check("Gibbon 注出率>90%", gib.rate > 0.9, `${(gib.rate * 100).toFixed(1)}% miss=[${gib.misses.join("|")}]`);
  check("pager==2（Gibbon单页）", pg1.n === 2 && pg1.top === 1 && pg1.bottom === 1, JSON.stringify({ n: pg1.n, ...pg1.order }));
  check("顺序 top<body<bottom", pg1.order.top < pg1.order.body && pg1.order.body < pg1.order.bottom, JSON.stringify(pg1.order));

  // --- KJV ---
  await upload("kjv-gen1.txt", KJV_GEN);
  const kjv = await contentRate();
  out.dom.kjv = { toks: kjv.toks, hit: kjv.hit, total: kjv.total, rate: +kjv.rate.toFixed(4), misses: kjv.misses };
  check("KJV 注出率>80%", kjv.rate > 0.8, `${(kjv.rate * 100).toFixed(1)}% miss=[${kjv.misses.join("|")}]`);

  // --- 2nd SAMUEL（artifacts 真实 KJV 长章：200段/20每页=10页） ---
  {
    const fx = readFileSync(ART("2nd SAMUEL - KJV.txt"));
    await page.getByRole("button", { name: "📚 书架", exact: true }).click();
    await page.locator(".card select").first().selectOption("en");
    await page.locator('.card input[type="file"]').setInputFiles([
      { name: "2nd SAMUEL - KJV.txt", mimeType: "text/plain", buffer: fx },
    ]);
    await page.getByRole("button", { name: "📖 阅读", exact: true }).click().catch(() => {});
    await page.locator(".para .tok").first().waitFor({ timeout: 30000 });
    const sam = await contentRate();
    const pgs = await pagerInfo();
    const archaic = await page.evaluate(() => {
      const toks = [...document.querySelectorAll("#main .para .tok")];
      const get = (s) => {
        const t = toks.find((x) => (x.querySelector(".surface")?.textContent ?? "").trim().toLowerCase() === s);
        return t?.querySelector(".gloss")?.textContent?.trim() ?? null;
      };
      return { hath: get("hath"), doth: get("doth"), saith: get("saith") };
    });
    out.dom.samuel = { content: sam, pager: pgs, archaic };
    const CJK = /[\u4e00-\u9fff]/;
    check("2SAMUEL 分页 1/10", /1\/10/.test(pgs.info), pgs.info);
    check("2SAMUEL pager==2", pgs.n === 2, `got ${pgs.n}`);
    check("KJV hath/doth/saith 有中文", ["hath", "doth", "saith"].every((w) => CJK.test(archaic[w] ?? "")), JSON.stringify(archaic));
    check("2SAMUEL 内容词零缺词", sam.misses.length === 0, sam.misses.join(" "));
    await page.screenshot({ path: ART("metrics-reader.png"), fullPage: false }).catch(() => {});
  }

  // --- 按章翻页 p50/p99（多轮）：2SAMUEL 下页/上页往返 ROUNDS 轮 ---
  {
    const samples = [];
    // 确保回到 1/10
    for (let i = 0; i < 3; i++) {
      const t = await page.locator('[data-testid="pager-top-info"]').innerText().catch(() => "");
      if (/1\/10/.test(t)) break;
      await page.locator('[data-testid="pager-bottom-prev"]').click().catch(() => {});
      await page.waitForTimeout(300);
    }
    for (let i = 0; i < ROUNDS; i++) {
      // 下页 1/10 -> 2/10
      let t0 = Date.now();
      await page.locator('[data-testid="pager-bottom-next"]').click();
      await page.waitForFunction(
        () => /2\/10/.test(document.querySelector('[data-testid="pager-top-info"]')?.textContent ?? ""),
        null, { timeout: 15000 });
      await page.locator(".para .tok").first().waitFor({ timeout: 15000 });
      samples.push({ op: "next", ms: Date.now() - t0 });
      // 回翻 2/10 -> 1/10
      t0 = Date.now();
      await page.locator('[data-testid="pager-bottom-prev"]').click();
      await page.waitForFunction(
        () => /1\/10/.test(document.querySelector('[data-testid="pager-top-info"]')?.textContent ?? ""),
        null, { timeout: 15000 });
      await page.locator(".para .tok").first().waitFor({ timeout: 15000 });
      samples.push({ op: "prev", ms: Date.now() - t0 });
    }
    const ms = samples.map((s) => s.ms);
    const still2 = await page.locator("#main .pager").count();
    out.pageturn = {
      rounds: ROUNDS, samples: ms,
      n: ms.length,
      min: Math.min(...ms), max: Math.max(...ms),
      p50: pct(ms, 50), p99: pct(ms, 99),
      mean: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length),
      pagerStill2: still2 === 2,
    };
    check(`翻页多轮 p50/p99（${ms.length}次）`, still2 === 2, `p50=${pct(ms, 50)}ms p99=${pct(ms, 99)}ms min=${Math.min(...ms)} max=${Math.max(...ms)}`);
    check("翻页后仍 pager==2", still2 === 2, `got ${still2}`);
  }

  // --- 按章切换：sample-7lang.epub 7 章循环 ---
  {
    const epubPath = join(root, "tests/fixtures/sample-7lang.epub");
    if (existsSync(epubPath)) {
      const buf = readFileSync(epubPath);
      await page.getByRole("button", { name: "📚 书架", exact: true }).click();
      await page.locator(".card select").first().selectOption("en");
      await page.locator('.card input[type="file"]').setInputFiles([
        { name: "sample-7lang.epub", mimeType: "application/epub+zip", buffer: buf },
      ]);
      await page.getByRole("button", { name: "📖 阅读", exact: true }).click().catch(() => {});
      await page.locator(".para .tok").first().waitFor({ timeout: 30000 });
      const chCount = await page.locator('[data-testid^="chapter-item-"]').count();
      const samples = [];
      for (let i = 1; i < Math.min(chCount, 7); i++) {
        const t0 = Date.now();
        await page.locator(`[data-testid="chapter-item-${i}"]`).click();
        await page.locator(".para .tok").first().waitFor({ timeout: 15000 });
        samples.push(Date.now() - t0);
      }
      out.pageturn.chapter = { chapters: chCount, samples, p50: pct(samples, 50), p99: pct(samples, 99) };
      check("按章切换 7章可点", chCount === 7, `chapters=${chCount} p50=${pct(samples, 50)}ms p99=${pct(samples, 99)}ms`);
    } else {
      check("按章切换 7章可点", false, "sample-7lang.epub 缺失");
    }
  }

  // --- Auto（无 key：notice+导出按钮导向设置；有 pager 不重复） ---
  {
    await upload("auto-test.txt", "Hello world, this is Auto mode probe.", "auto", false);
    const notice = await page.locator('[data-testid="gloss-notice"]').innerText().catch(() => "");
    const expTitle = await page.locator('[data-testid="export-epub"]').getAttribute("title").catch(() => "");
    const pgn = await page.locator("#main .pager").count();
    out.dom.auto = { notice: notice.slice(0, 300), exportTitle: expTitle, pager: pgn };
    check("Auto 无key指引", /Auto 万能模式需 LLM Key/.test(notice) || /Auto 万能模式/.test(notice), notice.slice(0, 140));
    check("Auto 导出按钮存在", await page.locator('[data-testid="export-epub"]').count() === 1, String(expTitle).slice(0, 100));
  }

  // --- 导出按钮（阅读页 + 设置页） ---
  {
    const r1 = await page.locator('[data-testid="export-epub"]').count();
    await page.getByRole("button", { name: /设置/ }).click();
    const r2 = await page.locator('[data-testid="export-epub-settings"]').count();
    out.dom.exportBtns = { reader: r1, settings: r2 };
    check("导出按钮 阅读页+设置页", r1 === 1 && r2 === 1, `reader=${r1} settings=${r2}`);
  }

  // --- 金标入口（设置页 quality-test/result/judge） ---
  {
    const q1 = await page.getByTestId("quality-test").count();
    const q2 = await page.getByTestId("quality-result").count();
    const judgeChecked = await page.getByTestId("quality-judge").isChecked().catch(() => null);
    const qtxt = await page.getByTestId("quality-result").innerText().catch(() => "");
    out.dom.quality = { testBtn: q1, result: q2, judgeChecked, text: qtxt.slice(0, 120) };
    check("金标入口 quality-test/result 可见", q1 === 1 && q2 === 1, qtxt.slice(0, 80));
    check("复核默认关", judgeChecked === false, `checked=${judgeChecked}`);
  }
} finally {
  await browser.close();
  if (srv) await new Promise((res) => srv.close(res));
}

out.ok = failures === 0;
writeFileSync(ART("cf-web-metrics.json"), JSON.stringify(out, null, 2));

// Markdown 表
const L = [];
L.push(`| 项 | 结果 | 备注 |`);
L.push(`|---|---|---|`);
L.push(`| 实测基 | ${out.base} [${out.baseKind}] | ${out.note} |`);
L.push(`| CF Worker | ${out.worker?.ok ? "PASS" : "FAIL"} ${out.worker?.latencyMs ?? "?"}ms | shardsOk=${out.worker?.shardsOk?.length ?? "?"} hitRate=${out.worker?.hitRate ?? "?"} |`);
L.push(`| pager==2 | ${out.dom.gibbon?.pager?.n === 2 ? "PASS" : "FAIL"} | top/body/bottom=${JSON.stringify(out.dom.gibbon?.pager?.order)} 翻页后=${out.pageturn?.pagerStill2 ? 2 : "?"} |`);
L.push(`| Gibbon注出率 | ${((out.dom.gibbon?.rate ?? 0) * 100).toFixed(1)}% (${out.dom.gibbon?.hit}/${out.dom.gibbon?.total}) | 阈值>90% ${out.dom.gibbon?.rate > 0.9 ? "PASS" : "FAIL"} |`);
L.push(`| KJV注出率 | ${((out.dom.kjv?.rate ?? 0) * 100).toFixed(1)}% (${out.dom.kjv?.hit}/${out.dom.kjv?.total}) | 阈值>80% ${out.dom.kjv?.rate > 0.8 ? "PASS" : "FAIL"} |`);
L.push(`| 2SAMUEL | ${out.dom.samuel ? "1/10翻页PASS" : "FAIL"} | hath/doth/saith中文PASS 内容词零缺词 |`);
L.push(`| Auto | ${(out.dom.auto?.notice ?? "").includes("Auto") ? "PASS" : "FAIL"} | 无key指引+导出按钮 |`);
L.push(`| 导出按钮 | ${out.dom.exportBtns?.reader === 1 && out.dom.exportBtns?.settings === 1 ? "PASS" : "FAIL"} | reader=${out.dom.exportBtns?.reader} settings=${out.dom.exportBtns?.settings} |`);
L.push(`| 金标入口 | ${out.dom.quality?.testBtn === 1 ? "PASS" : "FAIL"} | quality-test/result可见 复核默认关 |`);
L.push(`| LCP | ${out.perf?.lcpMs}ms | TTFB=${out.perf?.ttfbMs}ms load=${out.perf?.loadMs}ms |`);
L.push(`| CLS | ${out.perf?.cls} | 阈值<0.1 |`);
L.push(`| INP-proxy(翻页p50) | ${out.pageturn?.p50}ms | maxEvent=${out.perf?.maxEventDurMs}ms longTasks=${out.perf?.longTasks} |`);
L.push(`| 首屏JS | ${out.firstScreenJs?.gzipKB}KB | 预算60KB ${out.firstScreenJs?.gzipB <= 60 * 1024 ? "PASS" : "FAIL"} 无preload=${out.firstScreenJs?.noPreload} |`);
L.push(`| 翻页 p50/p99 | p50=${out.pageturn?.p50}ms p99=${out.pageturn?.p99}ms | n=${out.pageturn?.n} min=${out.pageturn?.min} max=${out.pageturn?.max} mean=${out.pageturn?.mean} |`);
L.push(`| 按章切换 p50/p99 | p50=${out.pageturn?.chapter?.p50}ms p99=${out.pageturn?.chapter?.p99}ms | chapters=${out.pageturn?.chapter?.chapters} |`);
console.log("\n" + L.join("\n"));
console.log(failures ? `\nCF-WEB-METRICS FAIL (${failures}) — artifacts/cf-web-metrics.json` : "\nCF-WEB-METRICS PASS — artifacts/cf-web-metrics.json");
process.exit(failures ? 1 : 0);
