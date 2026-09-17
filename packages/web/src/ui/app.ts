import {
  Mode,
  SOURCE_LANGS,
  SOURCE_LANG_NAMES,
  TARGET_LANGS,
  type Book,
  type SourceLang,
  type TargetLang,
  type Token,
} from "../types.js";
import {
  loadSettings,
  saveSettings,
  modeToContractValue,
  modeFromContractValue,
  type Settings,
} from "../store/settings.js";

import { loadLanguagePack } from "../reader/langpack-loader.js";
import {
  annotateParagraphs,
  patchGlosses,
  renderParagraphs,
  renderSlices,
  type AnnotatedParagraph,
} from "../reader/render.js";
import { tokenizeParagraph } from "../reader/tokenize.js";
import { BookImageUrls, chapterFlow, flowLength } from "../reader/blocks.js";
import {
  estimateParaHeightPx,
  findFlowPage,
  getColumnContentHeight,
  getColumnWidthPx,
  getPageCapacityPx,
  getProbeColumnWidthPx,
  groupTokensToLines,
  isSingleColumnViewport,
  measurePaginate,
  paginateFlowLines,
  paginateTextHeights,
  slicesForTokenRange,
  type FlowGeom,
  type FlowLine,
  type FlowPage,
  type FlowSlice,
  type FlowTokenBox,
} from "../reader/paginate.js";
import { isProperNounSurface } from "../dict/dict-loader.js";
import { detectParaLang, normalizeLangTag } from "../reader/langdetect.js";
import { autoSegmentGloss, chunkByChars, glossBatchPage, testConnection } from "../llm/provider.js";
import { estimateCostUSD, estimateTokens, formatUSD } from "../lib/cost.js";
import {
  addVocab,
  isKnown,
  listVocab,
  removeVocab,
  setKnown,
  exportVocabJSON,
} from "../vocab/store.js";
import { parseTxt } from "../ingest/txt.js";

type Tab = "library" | "reader" | "vocab" | "settings";

const state = {
  settings: loadSettings(),
  book: null as Book | null,
  chapterIdx: 0,
  page: 0,
  tab: "reader" as Tab,
  pack: null as Awaited<ReturnType<typeof loadLanguagePack>> | null,
  annotated: [] as AnnotatedParagraph[],
  /** 当前章全章纯词典注出（翻页/缩放复用，不重复调词典；Mode C/A 的 LLM 只回填当前页 slice） */
  annotatedFull: [] as AnnotatedParagraph[],
  annotatedFullKey: "",
  loading: false,
  error: "",
  status: "",
};

// 阅读页渲染代际：renderReader 跨 await，快速翻页/切 Tab 时旧续体必须丢弃，
// 否则旧 bottom pager 会追加到新 main 造成底部两套重复（2nd SAMUEL 1/10 页必现）。
let readerSeq = 0;
const bookImageUrls = new BookImageUrls();
function replaceBook(book: Book): void {
  bookImageUrls.setBook(book);
  state.book = book;
  state.annotatedFull = [];
  state.annotatedFullKey = "";
  flowGeomCache.clear();
  pendingFlowAnchor = null;
}
window.addEventListener("pagehide", () => bookImageUrls.setBook(null));
window.addEventListener("pageshow", () => bookImageUrls.setBook(state.book));
// 缩放重排：debounced resize 只重算分页（复用 annotatedFull），按全局 token 锚点保持位置。
let resizeTimer: number | undefined;
let resizeWired = false;
let fontsReadyWired = false;
let fullscreenWired = false;
let lastReaderSync: (() => void) | null = null;
/**
 * 行级分页状态（本章）：翻页直接 state.page±1；只有 resize/字体等几何变化才经锚点重映射。
 * 根因（2026-09 实测）：旧逻辑每次 render 都按“上次页首段引用”无条件回映射，
 * 下页点击后 state.page+1 随即被复位到 0，长章永远卡在 1/N（59/60 内容不可达）。
 * 锚点仅由几何变化或跨章回退入口显式设置（pendingFlowAnchor）；章内翻页永不回映射。
 * 跨章回退用 +Infinity 表示章末 token，避免估算页号与实测分页不一致。
 */
let lastFlowPages: FlowPage[] = [];
let lastFlowKey = "";
let pendingFlowAnchor: number | null = null;
/** 行几何缓存（key=章节+列宽+AI按钮；showGloss/词释义不影响盒高，见 paginate.ts） */
const flowGeomCache = new Map<string, FlowGeom>();
/** 双语改判记录（key=`书::章::主语言::目标`，值为原文段下标->语言，随 full 缓存）。
 * 改判只对“被改判过的那个 full 数组”生效（arr 引用比对）：并发渲染时后来者
 * 拿的是新注出的 fresh 数组，不能沿用旧数组的改判记录跳过重注，否则新数组
 * 全是主包 miss 却挂着改判标记（整章德语全“—”却标 lang=de 的根因）。 */
const fallbackLangByKey = new Map<string, Map<number, SourceLang>>();
const fallbackArrByKey = new Map<string, AnnotatedParagraph[]>();
/** auto 逐段识别语言（key=书::章::目标::原文段下标，值为 bcp47 主标签；随 autoAnnCache 同修剪） */
const autoDetectedLang = new Map<string, string>();
/** auto 跨页注出缓存（key=书::章::目标::原文段下标；切章清旧，不重复计费） */
const autoAnnCache = new Map<string, AnnotatedParagraph>();
/** 全书术语表缓存（session 级；key=`书::源语言::目标`）与在途 Promise（整书只跑一次）。
 * 用户口径：一本书的上下文最充足；术语表保证同一专名/术语全书译法一致。 */
const bookGlossaryCache = new Map<string, Record<string, string>>();
const bookGlossaryInflight = new Map<string, Promise<Record<string, string>>>();
/**
 * 失败冷却：术语表提炼是整书级的后台工作，单块失败（429/网络抖动/超时）不应让
 * 每次翻页都从头重跑整本书的 LLM 往返（实测：一次失败 → 每页重启 40 次请求，
 * 页面缺词回填被永远饿死，这就是用户看到的“不止一轮通信”）。失败后本会话冷却
 * 2 分钟再试，期间安静降级为“无术语表继续”。
 */
const bookGlossaryRetryAt = new Map<string, number>();
const GLOSSARY_RETRY_COOLDOWN_MS = 120_000;
/** 起一次整书术语表提炼（后台，不挡阅读）；已缓存则直接返回，在途则复用同一 Promise。 */
function ensureBookGlossary(
  book: Book,
  s: Settings,
  save: () => void
): Promise<Record<string, string>> {
  const key = `${book.title}::${book.lang}::${s.target}`;
  const got = bookGlossaryCache.get(key);
  if (got) return Promise.resolve(got);
  const inflight = bookGlossaryInflight.get(key);
  if (inflight) return inflight;
  if (!s.bookGlossary || !s.apiKey) return Promise.resolve({});
  if (Date.now() < (bookGlossaryRetryAt.get(key) ?? 0)) return Promise.resolve({});
  const p = (async (): Promise<Record<string, string>> => {
    try {
      const { extractBookGlossary } = await import("../llm/provider.js");
      const r = await extractBookGlossary(
        { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model },
        book.lang,
        s.target,
        book.chapters.flatMap((c) => c.paragraphs)
      );
      if (Object.keys(r.glossary).length) {
        bookGlossaryCache.set(key, r.glossary);
        bookGlossaryRetryAt.delete(key);
      } else {
        bookGlossaryRetryAt.set(key, Date.now() + GLOSSARY_RETRY_COOLDOWN_MS);
      }
      if (r.costUSD > 0) {
        s.costUsedUSD = +(s.costUsedUSD + r.costUSD).toFixed(4);
        save();
      }
      return r.glossary;
    } catch {
      // 降级：无术语表继续（缺词回填本身仍可用）；冷却期内不再重启整书提炼。
      bookGlossaryRetryAt.set(key, Date.now() + GLOSSARY_RETRY_COOLDOWN_MS);
      return {};
    } finally {
      bookGlossaryInflight.delete(key);
    }
  })();
  bookGlossaryInflight.set(key, p);
  return p;
}
/**
 * 页脚预留（pager-bottom + cost 行高）：分页发生在它们挂载前，此时 spread 偏高；
 * 预算 = 预挂载列高 - 预留。首绘用默认 76（桌面实测 pager+cost），rAF 收敛环实测修正。
 */
let lastChromeReserved = 76;
function rememberFlowPages(key: string, pages: FlowPage[]): void {
  lastFlowKey = key;
  lastFlowPages = pages;
}
/** 几何变化入口：记住当前页首 token，全局下标，重排后恢复（不跳回第一页） */
function keepAnchorAndSync(): void {
  try {
    // 防跨章竞态：只有缓存页属于当前章才取锚点，否则按页号钳制（不跨章映射）
    const b = state.book;
    const base = b ? `${b.title}::${state.chapterIdx}::${b.lang}::${state.settings.target}` : "";
    const pg = lastFlowPages[state.page];
    if (pg && base && lastFlowKey.startsWith(base)) pendingFlowAnchor = pg.startTok;
  } catch {
    // ignore
  }
  lastReaderSync?.();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const raf = (window as unknown as { requestAnimationFrame?: (cb: () => void) => number })
        .requestAnimationFrame;
      if (typeof raf === "function") {
        raf.call(window, () => resolve());
        return;
      }
    } catch {
      // jsdom 无 rAF，走 setTimeout
    }
    setTimeout(() => resolve(), 0);
  });
}

/**
 * 阅读 chrome 高度归 CSS：#app 为 100dvh 栅格，#main 是 flex 列，.book-spread 取 flex:1。
 * 工具条 / 页脚 / 统计都是 #main 的兄弟节点，浏览器已把它们从 1fr 里扣掉了。
 *
 * 这里只做一件事：清掉历史遗留的 inline height。
 * 根因（本次设计通道实测）：旧实现按 `100dvh - (topbar+meta+fold+notice+pager+96)`
 * 写死 #main 高度，而 meta/fold/notice/pager 本身就在 #main 内部 —— 同一批 chrome
 * 被扣了两次，再叠一个 96px 魔数。flex-grow 兜住了大部分，但任何 grow 失效的场景
 * （全屏、窄屏、字体替换）都会在书页下方留出一条死白。CSS 已能精确布局，故不再写死。
 */
function fitReaderChrome(): void {
  try {
    const main = document.getElementById("main");
    if (main?.style.height) main.style.removeProperty("height");
  } catch {
    // 无布局环境忽略
  }
}

function wireReaderResize(): void {
  if (resizeWired) return;
  resizeWired = true;
  window.addEventListener("resize", () => {
    if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (!lastReaderSync) return;
      if (state.tab !== "reader" || !state.book) return;
      fitReaderChrome();
      keepAnchorAndSync();
    }, 200);
  });
  // 字体异步就绪（webfont/系统字体替换）导致行高变化时同样按锚点重排
  if (!fontsReadyWired) {
    fontsReadyWired = true;
    try {
      const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
      void fonts?.ready?.then(() => {
        if (state.tab !== "reader" || !state.book || !lastReaderSync) return;
        fitReaderChrome();
        keepAnchorAndSync();
      });
    } catch {
      // ignore
    }
  }
  // 浏览器 Esc 退出全屏时同步阅读全屏态（去类 + 重渲染按钮文案）
  if (!fullscreenWired) {
    fullscreenWired = true;
    try {
      document.addEventListener("fullscreenchange", () => {
        try {
          if (!document.fullscreenElement) document.body.classList.remove("reader-fullscreen");
        } catch {
          // ignore
        }
        lastReaderSync?.();
      });
    } catch {
      // ignore
    }
  }
}

function save(): void {
  saveSettings(state.settings);
}

export function mountApp(root: HTMLElement): void {
  root.innerHTML = "";
  // 应用骨架：header（品牌 + 当前书 + 状态）/ main / nav。
  // 语义元素而非 div：屏读可直接跳到正文区，CSS 栅格负责桌面/移动两种导航位置。
  const top = document.createElement("header");
  top.className = "topbar";
  const tabs = document.createElement("nav");
  tabs.className = "tabs";
  tabs.setAttribute("aria-label", "主导航");
  const main = document.createElement("main");
  main.id = "main";
  root.append(top, main, tabs);

  const tabDefs: Array<[Tab, string]> = [
    ["library", "📚 书架"],
    ["reader", "📖 阅读"],
    ["vocab", "📝 生词"],
    ["settings", "⚙️ 设置"],
  ];
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  for (const [id, label] of tabDefs) {
    const b = document.createElement("button");
    // 无障碍名即整串文本（验收脚本按 "📚 书架" 等名称精确匹配，不得拆成多个子节点）
    b.textContent = label;
    b.type = "button";
    b.addEventListener("click", () => {
      state.tab = id;
      sync();
    });
    tabs.appendChild(b);
    tabBtns.set(id, b);
  }

  function sync(): void {
    // 每次重渲染先递增代际，作废仍在 await 的旧 renderReader 续体（防底部 pager 重复挂载）。
    readerSeq++;
    lastReaderSync = sync;
    wireReaderResize();
    root.dataset.view = state.tab;
    tabBtns.forEach((b, id) => {
      const active = id === state.tab;
      b.classList.toggle("active", active);
      if (active) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    top.innerHTML = "";
    const brand = document.createElement("div");
    brand.className = "brand";
    // 绿标是真按钮：回书架（之前是 span 装饰，用户误以为坏掉的按键）。
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "brand-mark";
    mark.setAttribute("aria-label", "图书首页");
    mark.title = "回书架";
    mark.textContent = "≡";
    mark.addEventListener("click", () => {
      state.tab = "library";
      sync();
    });
    const h = document.createElement("h1");
    h.textContent = "Interlinear Reader";
    brand.append(mark, h);
    top.appendChild(brand);
    // 当前书是顶栏主角（书名 + 语言对），应用名降为标识
    if (state.book) {
      const id = document.createElement("div");
      id.className = "book-id";
      const t = document.createElement("span");
      t.className = "book-title";
      t.textContent = state.book.title;
      t.title = state.book.title;
      const langs = document.createElement("span");
      langs.className = "book-langs";
      langs.textContent = `${SOURCE_LANG_NAMES[state.book.lang]} → ${
        state.settings.target === "zh" ? "中文" : "EN"
      }`;
      id.append(t, langs);
      top.appendChild(id);
    }
    const badges = document.createElement("div");
    badges.className = "badges";
    const modeBadge = document.createElement("span");
    modeBadge.className = "badge";
    modeBadge.textContent = `模式 ${state.settings.mode}`;
    modeBadge.title = "A=词典+点查 B=纯词典 C=整章LLM";
    badges.appendChild(modeBadge);
    const tgt = document.createElement("span");
    tgt.className = "badge";
    tgt.textContent = state.settings.target === "zh" ? "目标 中文" : "目标 EN";
    badges.appendChild(tgt);
    top.appendChild(badges);
    main.innerHTML = "";
    if (state.tab === "library") renderLibrary(main, sync);
    else if (state.tab === "reader") void renderReader(main, sync);
    else if (state.tab === "vocab") renderVocab(main, sync);
    else renderSettings(main, sync);
  }
  sync();
  // 启动即尝试加载示例书（无书时阅读页不空白）
  void ensureFixture().then(() => {
    if (state.tab === "reader") sync();
  });
}

// ---------------- 书架 ----------------

/**
 * 用户真实导入解码：File -> string（与脚本 parseTxt 同一条链的前置）。
 * - f.text() 默认 UTF-8，GBK/Big5 会 mojibake 导致整章 miss（KJV 无注的编码分支）。
 * - 策略：arrayBuffer + TextDecoder 严格 UTF-8，失败回退 GBK，再回退 windows-1252；
 * - 去 BOM（parseTxt 亦去，但此处先去避免首词 lemma 带 \uFEFF）。
 */
async function decodeTextFile(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // 去 UTF-8 BOM
  const noBom =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.slice(3)
      : bytes;
  // TypeScript DOM lib 未必含 gbk/windows-1252 声明，走 (TextDecoder as never) 兼容。
  const tryDecode = (enc: string, fatal: boolean): string | null => {
    try {
      const Ctor = TextDecoder as unknown as new (
        label: string,
        opts?: { fatal?: boolean }
      ) => { decode(b: Uint8Array): string };
      return new Ctor(enc, { fatal }).decode(noBom);
    } catch {
      return null;
    }
  };
  return (
    tryDecode("utf-8", true) ??
    tryDecode("gbk", false) ??
    tryDecode("windows-1252", false) ??
    tryDecode("utf-8", false) ??
    ""
  );
}

function renderLibrary(main: HTMLElement, sync: () => void): void {
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2 class="card-title">导入内容</h2><div class="muted">EPUB / MOBI / AZW3（未加密，保留章节段落）/ TXT / URL 正文提取。语言：7 源语言 + Auto 万能（LLM 自动识别，无包语言用 Auto），导入时选择。</div>`;

  const row1 = document.createElement("div");
  row1.className = "row";
  const langSel = document.createElement("select");
  langSel.setAttribute("data-testid", "lang-select");
  langSel.id = "ilr-lang-select";
  langSel.setAttribute("aria-label", "源语言选择");
  // 语言选项末尾加 Auto/万能：SOURCE_LANGS 末位即 'auto'（types.ts），不经词典/分词包，整句送 LLM。
  for (const l of SOURCE_LANGS) {
    const o = document.createElement("option");
    o.value = l;
    o.textContent = `${l} · ${SOURCE_LANG_NAMES[l]}`;
    langSel.appendChild(o);
  }
  langSel.value = state.book?.lang ?? "en";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".epub,.mobi,.azw3,.azw,.txt,.md";
  fileInput.className = "file-input";
  fileInput.setAttribute("aria-label", "选择 EPUB / MOBI / AZW3 / TXT 文件");
  const langLabel = document.createElement("label");
  langLabel.className = "inline-label";
  langLabel.htmlFor = langSel.id;
  langLabel.textContent = "源语言";
  row1.append(langLabel, langSel, fileInput);
  card.appendChild(row1);

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const lang = langSel.value as SourceLang;
    state.error = "";
    state.status = "解析中…";
    sync();
    try {
      const extension = /\.([^.]+)$/.exec(f.name)?.[1].toLowerCase() || "";
      const mobi =
        ["mobi", "azw3", "azw"].includes(extension) ||
        new TextDecoder().decode(await f.slice(60, 68).arrayBuffer()) === "BOOKMOBI";
      if (!mobi && !["epub", "mobi", "azw3", "azw", "txt", "md"].includes(extension))
        throw new Error(
          `不支持的文件类型：${extension ? `.${extension}` : "无扩展名"}（支持 .epub/.mobi/.azw3/.azw/.txt/.md）`
        );
      const book = mobi
        ? await (await import("../ingest/mobi.js")).parseMobi(f, lang)
        : /\.epub$/i.test(f.name)
          ? await (await import("../ingest/epub.js")).parseEpub(f, lang)
          : // .md 走 marked 词法解析（懒加载分片）；.txt 同一条 parseTxt 链。
            // 编码先解码（UTF-8 严格→GBK→1252），再解析。
            /\.md$/i.test(f.name)
            ? await (
                await import("../ingest/markdown.js")
              ).parseMarkdown(await decodeTextFile(f), f.name, lang)
            : parseTxt(await decodeTextFile(f), f.name, lang);
      replaceBook(book);
      state.chapterIdx = 0;
      state.page = 0;
      state.pack = null;
      state.status = `已载入《${book.title}》${book.chapters.length} 章`;
      state.tab = "reader";
    } catch (e) {
      // 导入失败：清掉“解析中…”加载态（只留真实错误），旧书原样保留（state.book 未动）。
      state.error = (e as Error).message;
      state.status = "";
    }
    sync();
  });

  const row2 = document.createElement("div");
  row2.className = "row";
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "https://… 文章 URL";
  urlInput.className = "grow";
  urlInput.setAttribute("aria-label", "文章 URL");
  const urlBtn = document.createElement("button");
  urlBtn.textContent = "抓取正文";
  urlBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    state.status = "抓取中…";
    state.error = "";
    sync();
    try {
      const { fetchArticle } = await import("../ingest/url.js");
      const { book, via } = await fetchArticle(url, langSel.value as SourceLang);
      replaceBook(book);
      state.chapterIdx = 0;
      state.page = 0;
      state.pack = null;
      state.status = `已载入《${book.title}》${via === "proxy" ? "（经公开代理抓取）" : ""}`;
      state.tab = "reader";
    } catch (e) {
      state.error = (e as Error).message;
      state.tab = "library";
    }
    sync();
  });
  row2.append(urlInput, urlBtn);
  card.appendChild(row2);

  // 粘贴导入（与上传同一条 parseTxt→annotate 链；KJV 用户真实路径之一）。
  // - 同 langSel 语言判定：en 走词典链，auto 走纯 LLM（需 key，无 key 报错导设置，与阅读页一致）。
  // - 编码：粘贴已是 string，无需解码；空行分段由 parseTxt 统一处理。
  {
    const pasteRow = document.createElement("div");
    pasteRow.className = "row stretch";
    const pasteInput = document.createElement("textarea");
    pasteInput.setAttribute("data-testid", "paste-input");
    pasteInput.setAttribute("aria-label", "粘贴文本导入");
    pasteInput.placeholder = "粘贴英文文本（KJV 如 He hath…），空行分段，与上传同一解析链";
    pasteInput.rows = 3;
    pasteInput.className = "grow";
    const pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.setAttribute("data-testid", "paste-import");
    pasteBtn.textContent = "粘贴导入";
    pasteBtn.title = "与上传同一 parseTxt 链；auto 需 key（纯 LLM），en 无 key 可读";
    pasteBtn.addEventListener("click", () => {
      const text = pasteInput.value;
      if (!text.trim()) {
        state.error = "粘贴为空：先粘贴文本再导入。";
        sync();
        return;
      }
      const lang = langSel.value as SourceLang;
      // auto 无 key 先拦（与阅读页 auto 分支同语）：避免空注出让用户误以为 KJV 无注
      if (lang === "auto" && !state.settings.apiKey) {
        state.error =
          "Auto 万能模式需 LLM Key：去「设置」填写（仅存 localStorage，浏览器直调），或改选 en 走词典。";
        state.tab = "settings";
        sync();
        return;
      }
      try {
        const title = text.trim().split("\n")[0].slice(0, 24) || "粘贴文本";
        const book = parseTxt(text, `${title}.txt`, lang);
        replaceBook(book);
        state.chapterIdx = 0;
        state.page = 0;
        state.pack = null;
        state.error = "";
        // KJV 语言提示：含 hath/doth/saith/thou 却选 auto 且无 key 已上拦；选 auto 有 key 走 LLM，选 en 走词典
        state.status = `已载入《${book.title}》${book.chapters.length} 章（${lang}→${state.settings.target}，粘贴与上传同链）`;
        state.tab = "reader";
      } catch (e) {
        state.error = (e as Error).message;
      }
      sync();
    });
    pasteRow.append(pasteInput, pasteBtn);
    card.appendChild(pasteRow);
    const pasteHint = document.createElement("div");
    pasteHint.className = "muted";
    pasteHint.textContent =
      "粘贴与上传同链：en 无 key 可读（词典），auto 需 key（纯 LLM）；KJV 建议选 en。";
    card.appendChild(pasteHint);
  }

  const row3 = document.createElement("div");
  row3.className = "row";
  const fixBtn = document.createElement("button");
  fixBtn.type = "button";
  fixBtn.textContent = "载入示例（fixture）";
  fixBtn.addEventListener("click", () => {
    void ensureFixture(true).then(sync);
  });
  row3.appendChild(fixBtn);
  const hint = document.createElement("span");
  hint.className = "muted";
  hint.textContent = "无 key 也可读：示例 + mock 词典逐词注出";
  row3.appendChild(hint);
  card.appendChild(row3);

  if (state.status) {
    const p = document.createElement("div");
    p.className = "muted status-line";
    p.setAttribute("role", "status");
    p.textContent = state.status;
    card.appendChild(p);
  }
  if (state.error) {
    const p = document.createElement("div");
    p.className = "err";
    p.textContent = state.error;
    card.appendChild(p);
  }
  main.appendChild(card);

  if (state.book) {
    // 当前书：书名/来源/语言对为标题，章节表为列表，“开始阅读”为主动作
    const info = document.createElement("div");
    info.className = "card book-card";
    const chs = state.book.chapters
      .map(
        (c, i) =>
          `<li class="chapter-row"><span class="chapter-no">第${i + 1}章</span>` +
          `<span class="chapter-name">${escapeHtml(c.title)}</span>` +
          `<span class="muted">${c.paragraphs.length} 段</span></li>`
      )
      .join("");
    info.innerHTML =
      `<h2 class="card-title book-card-title">《${escapeHtml(state.book.title)}》</h2>` +
      `<div class="muted">${escapeHtml(state.book.source)} · ${state.book.lang}→${state.settings.target} · 共 ${state.book.chapters.length} 章</div>` +
      `<ul class="chapter-rows">${chs}</ul>`;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "primary";
    go.textContent = "开始阅读";
    go.addEventListener("click", () => {
      state.tab = "reader";
      sync();
    });
    info.appendChild(go);
    main.appendChild(info);
  }
}

async function ensureFixture(force = false): Promise<void> {
  if (state.book && !force) return;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}fixtures/hello-en.epub`);
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const { parseEpub } = await import("../ingest/epub.js");
    replaceBook(
      await parseEpub(new File([buf], "hello-en.epub", { type: "application/epub+zip" }), "en")
    );
    state.chapterIdx = 0;
    state.page = 0;
    state.pack = null;
  } catch {
    // fixture 缺失不阻塞（构建产物未带 public 时）
  }
}

// ---------------- 导出 EPUB（阅读页当前书） ----------------

/**
 * 导出当前书为标准 EPUB（JSZip 复用，章节保留，文件名含语言）。
 * - 无 key：纯词典导出（annotated 缺词留原文，不编造）。
 * - 有 key 且非 B 模式：缺词走 LLM 回填（与 A 共用 glossSentence + 费用上限；失败回退词典）。
 * - Auto 万能：不经词典/分词包，逐段 autoSegmentGloss（纯 LLM 费用，需 key；无 key 报错导设置）。
 * 本函数不碰分页布局（只读 state.book/pack/settings，写 status/error/cost）。
 */
async function exportCurrentBookAsEpub(): Promise<void> {
  const book = state.book;
  if (!book) {
    state.error = "没有可导出的书：先去「书架」载入。";
    return;
  }
  const s = state.settings;
  // Auto 万能导出：逐段 LLM 分词+注（纯 LLM 费用；B 模式同样强制走 LLM）。
  if (book.lang === "auto") {
    if (!s.apiKey) {
      state.error =
        "Auto 万能模式需 LLM Key：去「设置」填写（仅存 localStorage，浏览器直调），再导出。";
      state.tab = "settings";
      return;
    }
    const { autoSegmentGloss } = await import("../llm/provider.js");
    const knownFnAuto = (lemma: string) => isKnown(book.lang, lemma);
    const annotatedByChapterAuto: AnnotatedParagraph[][] = [];
    let spentAuto = 0;
    for (const ch of book.chapters) {
      const ann: AnnotatedParagraph[] = [];
      for (const para of ch.paragraphs) {
        if (s.costUsedUSD + spentAuto >= s.costCapUSD) {
          state.error = `已达费用上限，Auto 导出已停止（保留已注部分）。`;
          break;
        }
        try {
          const { tokens, costUSD } = await autoSegmentGloss(
            { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model },
            s.target,
            para
          );
          spentAuto += costUSD;
          ann.push({
            text: para,
            tokens: tokens.map((t) => ({
              surface: t.surface,
              lemma: t.lemma,
              isWord: true,
              gloss: t.gloss,
              glossSource: "llm" as const,
              known: knownFnAuto(t.lemma),
              stopword: false,
            })),
          });
        } catch {
          ann.push({ text: para, tokens: [] });
          break;
        }
      }
      annotatedByChapterAuto.push(ann);
    }
    if (spentAuto > 0) {
      s.costUsedUSD = +(s.costUsedUSD + spentAuto).toFixed(4);
      save();
    }
    const { buildEpubBlob } = await import("../export/epub.js");
    const { blob, filename } = await buildEpubBlob(book, annotatedByChapterAuto, s.target);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    state.status = `已导出 ${filename}（${book.chapters.length} 章，auto→${s.target}，纯 LLM 分词+注）`;
    return;
  }
  if (!state.pack || state.pack.code !== book.lang) {
    const { loadLanguagePack } = await import("../reader/langpack-loader.js");
    state.pack = await loadLanguagePack(book.lang);
  }
  const pack = state.pack;
  const knownFn = (lemma: string) => isKnown(book.lang, lemma);
  const { annotateParagraphs } = await import("../reader/render.js");
  const annotatedByChapter: AnnotatedParagraph[][] = [];
  for (const ch of book.chapters) {
    annotatedByChapter.push(
      await annotateParagraphs(pack, book.lang, s.target, ch.paragraphs, knownFn)
    );
  }
  // 有 key 回填（B 模式永不调 LLM；无 key 跳过，保持纯词典）。
  if (s.apiKey && s.mode !== Mode.B) {
    const { glossSentence } = await import("../llm/provider.js");
    let spent = 0;
    for (let ci = 0; ci < book.chapters.length; ci++) {
      const chParas = book.chapters[ci].paragraphs;
      let ann = annotatedByChapter[ci];
      const override = new Map<string, Record<string, string>>();
      for (const para of ann) {
        const missing = [
          ...new Set(para.tokens.filter((t) => t.isWord && !t.gloss).map((t) => t.lemma)),
        ].slice(0, 40);
        if (missing.length === 0 || s.costUsedUSD + spent >= s.costCapUSD) continue;
        try {
          const { glosses, costUSD } = await glossSentence(
            { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model },
            book.lang,
            s.target,
            para.text,
            missing
          );
          if (Object.keys(glosses).length) override.set(para.text, glosses);
          spent += costUSD;
        } catch {
          break;
        }
      }
      if (override.size) {
        ann = await annotateParagraphs(pack, book.lang, s.target, chParas, knownFn, override);
        annotatedByChapter[ci] = ann;
      }
    }
    if (spent > 0) {
      s.costUsedUSD = +(s.costUsedUSD + spent).toFixed(4);
      save();
    }
    if (s.costUsedUSD >= s.costCapUSD) {
      state.error = `已达费用上限，导出中 LLM 回填已停止（保留词典部分）。`;
    }
  }
  const { buildEpubBlob } = await import("../export/epub.js");
  const { blob, filename } = await buildEpubBlob(book, annotatedByChapter, s.target);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  state.status = `已导出 ${filename}（${book.chapters.length} 章，${book.lang}→${s.target}${s.apiKey ? "，含 LLM 回填" : "，纯词典"}）`;
}

// ---------------- 行级 flow 分页管线（自适应真翻页） ----------------
// 探针把整章以目标列宽渲染一次（BFC+同 padding，见 styles.css .measure-probe），
// 逐 token 测盒 → 按行分组 → 只在行首切分。行内贪心断行状态与真实列一致，
// 故列高算术精确：满页不溢出、无截断、无内滚；页页填满、无空白大洞。
// - 中英混排/行内注音高度不一：全部来自真实 DOM 测量，非字符数估算；
// - 几何缓存 key=章节+列宽+AI按钮（释义显隐/文本不影响盒高）；
// - 探针失败（无布局）时回退段级 measurePaginate（保留旧实测语义）。

interface FlowIndex {
  paraStart: number[];
  paraLens: number[];
  total: number;
}

function flowIndexOf(flow: AnnotatedParagraph[]): FlowIndex {
  const paraStart: number[] = [0];
  const paraLens: number[] = [];
  for (const p of flow) {
    paraLens.push(flowLength(p));
    paraStart.push(paraStart[paraStart.length - 1] + flowLength(p));
  }
  return { paraStart, paraLens, total: paraStart[paraStart.length - 1] };
}

/** 探针实测行表；返回 null 表示无可用布局（调用方回退估高） */
function measureFlowLines(
  flow: AnnotatedParagraph[],
  probeOpts: {
    mode: Settings["mode"];
    showGloss: boolean;
    filters: { hideStopwords: boolean; hideKnown: boolean; freqHideTopN: number };
    lang: SourceLang;
    showAIButton: boolean;
  },
  probeW: number
): FlowLine[] | null {
  try {
    if (typeof document === "undefined" || !flow.length) return null;
    const probe = document.createElement("div");
    probe.className = "book-page measure-probe";
    probe.style.width = `${Math.max(160, Math.floor(probeW))}px`;
    document.body.appendChild(probe);
    try {
      renderParagraphs(probe, flow, {
        ...probeOpts,
        measure: true,
        onTokenClick: (): void => undefined,
        onSentenceAI: (): void => undefined,
      });
      // AI 按钮同样测量（data-ai）：高度并入段尾行，否则按钮独占一行时真实列比探针高。
      const els = probe.querySelectorAll(".tok, .wsep, .ai-btn, .reader-image");
      const total = flow.reduce((a, p) => a + flowLength(p), 0);
      // Images have a geometry anchor, but no tokens or AI buttons.
      const expectBtns = probeOpts.showAIButton ? flow.filter((p) => !p.image).length : 0;
      if (!els.length || els.length !== total + expectBtns) return null;
      const cs = getComputedStyle(probe);
      const origin =
        probe.getBoundingClientRect().top + probe.clientTop + (parseFloat(cs.paddingTop) || 0);
      if (!Number.isFinite(origin)) return null;
      const boxes: FlowTokenBox[] = [];
      let g = 0;
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HTMLElement;
        const r = el.getBoundingClientRect();
        const pi = Number(el.dataset.pi ?? -1);
        const ti = Number(el.dataset.ti ?? -1);
        const ai = el.classList.contains("ai-btn");
        if (pi < 0 || ti < 0 || !(r.height > 0)) return null;
        if (ai) {
          boxes.push({
            top: r.top - origin,
            bottom: r.bottom - origin,
            para: pi,
            tok: ti,
            g,
            ai: true,
          });
        } else {
          boxes.push({ top: r.top - origin, bottom: r.bottom - origin, para: pi, tok: ti, g });
          g++;
        }
      }
      if (g !== total) return null;
      // 顺序校验：文档顺序须为 (para, tok) 升序（换行/混排不得乱序）
      for (let i = 1; i < boxes.length; i++) {
        const a = boxes[i - 1];
        const b = boxes[i];
        if (b.para < a.para || (b.para === a.para && b.tok <= a.tok)) return null;
      }
      const geom = groupTokensToLines(boxes, total);
      if (!geom.lines.length) return null;
      return geom.lines;
    } finally {
      probe.remove();
    }
  } catch {
    return null;
  }
}

/** 段级回退（探针无布局时）：measurePaginate 段页 → token 页，保持调用存在（旧实测语义） */
function fallbackFlowPages(
  flow: AnnotatedParagraph[],
  idx: FlowIndex,
  cap: number,
  twoCol: boolean,
  colW: number
): FlowPage[] {
  try {
    const seg = measurePaginate(flow, cap, twoCol, colW);
    const pages: FlowPage[] = [];
    // 段页展平为全局 token 区间：flow 下标→paraStart 映射
    const ranges: Array<{ a: number; b: number }> = [];
    const pushParas = (paras: AnnotatedParagraph[]): void => {
      for (const p of paras) {
        const fi = flow.indexOf(p);
        if (fi < 0) continue;
        ranges.push({ a: idx.paraStart[fi], b: idx.paraStart[fi] + idx.paraLens[fi] });
      }
    };
    if (!twoCol) {
      for (const pg of seg) {
        ranges.length = 0;
        pushParas(pg[0] ?? []);
        if (!ranges.length) continue;
        pages.push({
          startTok: ranges[0].a,
          endTok: ranges[ranges.length - 1].b,
          cutTok: ranges[ranges.length - 1].b,
        });
      }
    } else {
      for (const pg of seg) {
        ranges.length = 0;
        pushParas(pg[0] ?? []);
        pushParas(pg[1] ?? []);
        if (!ranges.length) continue;
        const a = ranges[0].a;
        const b = ranges[ranges.length - 1].b;
        pages.push({ startTok: a, endTok: b, cutTok: b });
      }
    }
    return pages;
  } catch {
    return [];
  }
}

interface ChapterFlow {
  pages: FlowPage[];
  geom: FlowGeom;
  idx: FlowIndex;
}

/** 章节 flow 分页：探针命中走行级精确分页，否则段级回退；空流保一空页 */
function paginateChapterFlow(
  flow: AnnotatedParagraph[],
  cacheKey: string,
  cap: number,
  columns: 1 | 2,
  colW: number,
  probeOpts: {
    mode: Settings["mode"];
    showGloss: boolean;
    filters: { hideStopwords: boolean; hideKnown: boolean; freqHideTopN: number };
    lang: SourceLang;
    showAIButton: boolean;
  }
): ChapterFlow {
  const idx = flowIndexOf(flow);
  const emptyGeom: FlowGeom = {
    lines: [],
    tokenLine: [],
    paraStart: idx.paraStart,
    total: idx.total,
    paraLens: idx.paraLens,
  };
  if (!flow.length || !idx.total) {
    return { pages: [{ startTok: 0, endTok: 0, cutTok: 0 }], geom: emptyGeom, idx };
  }
  // Reserve a full-column slot. object-fit preserves natural aspect on load,
  // without asynchronous reflow or decoded-size races in the geometry cache.
  for (const p of flow) if (p.image) p.image.height = cap;
  const probeW = getProbeColumnWidthPx(columns === 1) ?? colW;
  const geometryKey =
    cacheKey + "::" + probeW + (flow.some((p) => p.image) ? `::images::${cap}` : "");
  let lines: FlowLine[] | null = null;
  const hit = flowGeomCache.get(geometryKey);
  if (hit && hit.total === idx.total) {
    lines = hit.lines;
  } else {
    lines = measureFlowLines(flow, probeOpts, probeW);
    if (lines && lines.length) {
      const tokenLine = new Array(idx.total).fill(-1);
      lines.forEach((l, li) => {
        for (let t = l.firstTok; t <= l.lastTok; t++) tokenLine[t] = li;
      });
      flowGeomCache.set(geometryKey, {
        lines,
        tokenLine,
        paraStart: idx.paraStart,
        total: idx.total,
        paraLens: idx.paraLens,
      });
      if (flowGeomCache.size > 8) {
        const first = flowGeomCache.keys().next();
        if (!first.done) flowGeomCache.delete(first.value);
      }
    }
  }
  if (lines && lines.length) {
    const pages = paginateFlowLines(lines, idx.total, cap, columns);
    if (pages.length) {
      const tokenLine = new Array(idx.total).fill(-1);
      lines.forEach((l, li) => {
        for (let t = l.firstTok; t <= l.lastTok; t++) tokenLine[t] = li;
      });
      return {
        pages,
        geom: {
          lines,
          tokenLine,
          paraStart: idx.paraStart,
          total: idx.total,
          paraLens: idx.paraLens,
        },
        idx,
      };
    }
  }
  const fb = fallbackFlowPages(flow, idx, cap, columns === 2, colW);
  if (fb.length) return { pages: fb, geom: emptyGeom, idx };
  return { pages: [{ startTok: 0, endTok: idx.total, cutTok: idx.total }], geom: emptyGeom, idx };
}

/**
 * 一页缺词的 LLM 批量回填：按字符预算切块，**每块一次请求**（glossBatchPage），
 * 章节上下文随行选义。返回 override（段文本 -> lemma->gloss）与本次花费。
 * - 每块返回即回调 `onPartial(override, spent)`：调用方立刻把已到的释义填进页面
 *   （增量渲染），不必等整页/整批做完——大请求与小请求的网络延迟一样，能填就先填。
 * - 术语表由调用方决定：A 模式并行后台跑（不等），C 模式先等（整页 LLM 需一致性）。
 */
async function fetchGlossBatches(
  s: Settings,
  lang: SourceLang,
  target: TargetLang,
  jobs: { text: string; missing: string[] }[],
  context: string,
  glossary: Record<string, string>,
  onPartial?: (override: Map<string, Record<string, string>>, spent: number) => void
): Promise<{ override: Map<string, Record<string, string>>; spent: number; lastErr: string }> {
  const override = new Map<string, Record<string, string>>();
  let spent = 0;
  let lastErr = "";
  // 一页（约 1-2 千词）通常一次装下；预算取大一些，避免把一页拆成多轮往返。
  const batches = chunkByChars(jobs, (j) => j.text.length + j.missing.join(",").length, 12000);
  let base = 0;
  for (const ck of batches) {
    if (s.costUsedUSD + spent >= s.costCapUSD) break;
    const idBase = base;
    base += ck.length;
    try {
      const r = await glossBatchPage(
        { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model },
        lang,
        target,
        context,
        ck.map((j, i) => ({ id: `s${idBase + i}`, text: j.text, lemmas: j.missing })),
        fetch,
        { glossary }
      );
      ck.forEach((j, i) => {
        const g = r.glosses.get(`s${idBase + i}`);
        if (g && Object.keys(g).length) override.set(j.text, g);
      });
      spent += r.costUSD;
      onPartial?.(override, spent);
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return { override, spent, lastErr };
}

/**
 * 把 override 的 LLM 释义就地写进本页已注出的 token（token 边界不变，故无需重切）。
 * 只补 LLM 给到的词，词典已有释义保持不动——这正是不重建 DOM 就能增量重绘的前提。
 */
function applyOverrideToSlice(
  slice: AnnotatedParagraph[],
  override: Map<string, Record<string, string>>
): number {
  let filled = 0;
  for (const para of slice) {
    const m = override.get(para.text);
    if (!m) continue;
    for (const t of para.tokens) {
      if (!t.isWord) continue;
      const g =
        m[t.lemma] ?? m[t.lemma.toLowerCase()] ?? m[t.surface] ?? m[t.surface.toLowerCase()];
      if (g) {
        t.gloss = g;
        t.glossSource = "llm";
        t.glosses = null;
        filled += 1;
      }
    }
  }
  return filled;
}

// ---------------- 阅读 ----------------

async function renderReader(main: HTMLElement, sync: () => void): Promise<void> {
  if (!state.book) {
    const d = document.createElement("div");
    d.className = "empty";
    d.innerHTML =
      `<div class="empty-mark" aria-hidden="true">📖</div>` +
      `<strong>还没有在读的书</strong>` +
      `<div class="muted">去「书架」上传 EPUB / TXT，或一键载入示例；无 key 也能靠词典逐词对照。</div>`;
    const b = document.createElement("button");
    b.className = "primary";
    b.textContent = "去书架";
    b.addEventListener("click", () => {
      state.tab = "library";
      sync();
    });
    d.appendChild(b);
    main.appendChild(d);
    return;
  }
  const book = state.book;
  const s: Settings = state.settings;
  // 本次渲染代际快照（sync() 已递增 readerSeq；旧续体 await 后比对丢弃，防底部 pager 重复）。
  const seq = readerSeq;
  // 跨章回退的章末意图保留至本轮几何收敛；普通翻页/resize 仍保留页首锚点。
  const landAtChapterEnd = pendingFlowAnchor === Number.POSITIVE_INFINITY;
  // 错误语义（带来即消费）：上次 sync 带来的错在本轮显示、本轮清空；
  // 本轮章节处理中产生的新错在首绘前同步进 errBox；下轮无新错即干净。
  const carriedError = state.error;
  state.error = "";

  // 控制条（单一工具条）：章节 / 模式 / 目标 / 释义 为主，全屏与导出降为右侧次要组。
  // 注意：验收/e2e 以 `.reader-meta > select` 定位章节与模式下拉，两个 select 必须是 meta 的直接子节点，
  // 且章节下拉在前（first）。
  const meta = document.createElement("div");
  meta.className = "reader-meta";
  meta.setAttribute("role", "group");
  meta.setAttribute("aria-label", "阅读控制");
  const chSel = document.createElement("select");
  chSel.setAttribute("data-testid", "chapter-select");
  chSel.setAttribute("aria-label", "章节选择");
  book.chapters.forEach((c, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    // 图片章（0 文字段）也必须在 TOC 可选：块数计入括号，标题缺省已由 ingest 兜底“插图 N”。
    const imgCount = c.blocks?.filter((b) => b.kind === "img").length ?? 0;
    const label =
      c.title || (imgCount && !c.paragraphs.length ? `插图 ${i + 1}` : `Chapter ${i + 1}`);
    const blockCount = c.blocks?.length || c.paragraphs.length;
    o.textContent = `${i + 1}. ${label.slice(0, 24)} (${imgCount && !c.paragraphs.length ? `${imgCount}图` : `${c.paragraphs.length}段`})`;
    o.title = `${blockCount} blocks`;
    chSel.appendChild(o);
  });
  chSel.value = String(state.chapterIdx);
  chSel.addEventListener("change", () => {
    state.chapterIdx = Number(chSel.value);
    state.page = 0;
    sync();
  });
  meta.appendChild(chSel);
  // 章节折叠摘要行在下方 details[data-testid="chapter"] 内（默认收起，避免顶部摊开）；
  // 此处 meta 不再放 badge，避免双 chapter 口径（DOM 唯一 [data-testid="chapter"] 即折叠容器）。

  // 模式切换（验收：切换 A/B/C 生效；CONTRACT 口径：select[data-testid="mode-switch"]，值 a|b|c 小写）
  const modeSel = document.createElement("select");
  modeSel.setAttribute("data-testid", "mode-switch");
  for (const m of [Mode.A, Mode.B, Mode.C]) {
    const o = document.createElement("option");
    o.value = modeToContractValue(m);
    o.textContent = m === Mode.A ? "A·词典+点查" : m === Mode.B ? "B·纯词典" : "C·整章LLM";
    modeSel.appendChild(o);
  }
  modeSel.value = modeToContractValue(s.mode);
  modeSel.title = "A默认(词典全注+点词点句LLM)/B纯词典/C整章LLM";
  modeSel.addEventListener("change", () => {
    s.mode = modeFromContractValue(modeSel.value) ?? Mode.A;
    save();
    state.page = 0;
    sync();
  });
  meta.appendChild(modeSel);

  const tgtBtn = document.createElement("button");
  tgtBtn.type = "button";
  tgtBtn.textContent = s.target === "zh" ? "目标：中文 ⇄" : "目标：EN ⇄";
  tgtBtn.title = "目标语言 ZH+EN 切换";
  tgtBtn.addEventListener("click", () => {
    s.target = s.target === "zh" ? "en" : "zh";
    save();
    sync();
  });
  meta.appendChild(tgtBtn);

  // 释义显隐是开关，不是动作：用 aria-pressed 表达当前态（视觉上也回一个选中色）
  const glossBtn = document.createElement("button");
  glossBtn.type = "button";
  glossBtn.textContent = "释义";
  glossBtn.title = s.showGloss ? "当前：显示逐词释义（点击隐藏）" : "当前：已隐藏释义（点击显示）";
  glossBtn.setAttribute("aria-pressed", String(s.showGloss));
  glossBtn.setAttribute("aria-label", "逐词释义显隐");
  glossBtn.addEventListener("click", () => {
    s.showGloss = !s.showGloss;
    save();
    sync();
  });
  meta.appendChild(glossBtn);

  // 次要动作组（右对齐）：全屏 / 导出
  const toolGroup = document.createElement("div");
  toolGroup.className = "tool-group";

  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.type = "button";
  fullscreenBtn.setAttribute("data-testid", "fullscreen-reader");
  // 窄屏只留主语（全屏 / 导出），后半截由 CSS .lbl-ext 隐藏 —— 移动端工具条不再换行吃掉正文高度。
  // 阅读全屏 = 书页占满视口、应用 chrome 全藏（顶栏/导航/工具条），只留书 + 翻页脚。
  // 之前只调了浏览器 requestFullscreen，应用 chrome 原样留着，等于没全屏。
  const inReaderFs = (() => {
    try {
      return document.body.classList.contains("reader-fullscreen");
    } catch {
      return false;
    }
  })();
  fullscreenBtn.innerHTML = inReaderFs
    ? '退出<span class="lbl-ext">全屏</span>'
    : '全屏<span class="lbl-ext">阅读</span>';
  fullscreenBtn.title = inReaderFs
    ? "退出阅读全屏（Esc 也可退出）"
    : "书页占满屏幕，隐藏顶栏与工具条（← → 翻页）";
  fullscreenBtn.setAttribute("aria-pressed", String(inReaderFs));
  fullscreenBtn.addEventListener("click", async () => {
    try {
      if (document.body.classList.contains("reader-fullscreen")) {
        document.body.classList.remove("reader-fullscreen");
        if (document.fullscreenElement) await document.exitFullscreen();
      } else {
        document.body.classList.add("reader-fullscreen");
        try {
          await document.documentElement.requestFullscreen();
        } catch {
          // 浏览器拒绝（如 iframe 权限）：应用级全屏照样生效
        }
      }
    } catch {
      // 无布局环境忽略
    }
    sync();
  });
  toolGroup.appendChild(fullscreenBtn);

  // 导出 EPUB（阅读页当前书：原文+释义对照，gloss 落小字括号；章节保留；文件名含语言）。
  // 无 key 纯词典导出，有 key 可含 LLM 回填（与 A/C 共用 glossSentence + 费用上限）。
  // Auto 万能：纯 LLM 分词+注（需 key，无 key 导设置）。
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.setAttribute("data-testid", "export-epub");
  exportBtn.innerHTML = '导出<span class="lbl-ext"> EPUB</span>';
  exportBtn.title =
    book.lang === "auto"
      ? s.apiKey
        ? "Auto 纯 LLM 分词+注导出（费用上限内）"
        : "Auto 万能需 key：去设置填 key 后导出（纯 LLM 费用）"
      : s.apiKey
        ? "含词典注出 + 缺词 LLM 回填（费用上限内）"
        : "无 key：纯词典导出（缺词留原文，去设置填 key 可回填）";
  exportBtn.addEventListener("click", () => {
    exportBtn.disabled = true;
    const prev = exportBtn.textContent;
    exportBtn.textContent = "导出中…";
    void exportCurrentBookAsEpub()
      .catch((e) => {
        state.error = `导出失败：${(e as Error).message}`;
      })
      .finally(() => {
        exportBtn.disabled = false;
        exportBtn.textContent = prev;
        sync();
      });
  });
  toolGroup.appendChild(exportBtn);

  // 章节目录（默认收起）：details[data-testid="chapter"] 默认无 open，
  // 摘要行即当前章标记（DOM 口径 data-testid="chapter"，文本含 第X/Y章），展开后见 chapter-list。
  // 本次设计改动：从独占一条横幅改为工具条里的 chip + 浮层目录（CSS 绝对定位），
  // 既省一条 chrome，也让展开/收起不再改变书页高度（不再触发重排分页）。
  {
    const fold = document.createElement("details");
    fold.className = "chapter-fold";
    fold.setAttribute("data-testid", "chapter");
    fold.setAttribute("data-chapter", String(state.chapterIdx));
    // 默认收起：不设 open（DOM 可断言：fold.open === false）
    const sum = document.createElement("summary");
    sum.className = "chapter-summary";
    sum.setAttribute("data-chapter", String(state.chapterIdx));
    sum.innerHTML = `目录<span class="lbl-ext"> · 第${state.chapterIdx + 1}/${book.chapters.length}章</span>`;
    sum.title = `当前：${book.chapters[state.chapterIdx].title}（共${book.chapters.length}章）· 点击展开目录`;
    fold.appendChild(sum);
    const nav = document.createElement("nav");
    nav.className = "chapter-list";
    nav.setAttribute("data-testid", "chapter-list");
    nav.setAttribute("aria-label", "章节列表");
    book.chapters.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-testid", `chapter-item-${i}`);
      b.setAttribute("data-chapter", String(i));
      if (i === state.chapterIdx) b.setAttribute("aria-current", "true");
      b.textContent = `${i + 1}. ${c.title.slice(0, 12)}`;
      b.title = `${c.title}（${c.paragraphs.length}段）`;
      b.addEventListener("click", () => {
        state.chapterIdx = i;
        state.page = 0;
        sync();
      });
      nav.appendChild(b);
    });
    fold.appendChild(nav);
    meta.appendChild(fold);
  }
  meta.appendChild(toolGroup);
  main.appendChild(meta);

  // 本页统计（命中/缺词）—— 挂在页脚的状态行里（见下方 statusRow），不再在书页上方独占一条。
  const notice = document.createElement("div");
  notice.setAttribute("data-testid", "gloss-notice");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  const usingFallback = state.pack == null || state.pack.code !== book.lang;
  void usingFallback;
  const isAuto = book.lang === "auto";
  const modeText = isAuto
    ? "Auto 万能模式：无词典/分词包，整句送 LLM 自动识别源语言并分词+注（纯 LLM 费用，按段计费，注意上限；无 key 请去「设置」填写）。"
    : s.mode === Mode.B
      ? 'B 模式：纯词典，不调用 LLM。缺词显示"···"，可切 A 点查。'
      : s.mode === Mode.A
        ? "A 模式：词典全注；点击单词/“释义本句”走 LLM（缺词或想看语境义时）。"
        : "C 模式：当前页逐段调 LLM 整句注词（费用注意上限）。";
  /**
   * 状态行只占一行（页脚高度必须与文案长度无关，否则首绘分页预算 lastChromeReserved 失准），
   * 超出部分省略号收起，全文放 title 供悬停查看。
   */
  const setNotice = (text: string): void => {
    notice.textContent = text;
    notice.title = text;
  };
  setNotice(modeText);

  const errBox = document.createElement("div");
  errBox.className = "err";
  if (carriedError) errBox.textContent = carriedError;
  main.appendChild(errBox);

  // 分页（长章不能一次全渲染）+ 章间连续翻页：末页下页进下一章首夜，首夜上页回上一章末页
  // 响应式无内滚：按实际渲染高度分页（measurePaginate），不用固定词数；每页内容高度 <= 可用高度。
  const totalChapters = book.chapters.length;
  const ch = book.chapters[state.chapterIdx];
  const isSingleNow = (): boolean => isSingleColumnViewport();
  const capacityNow = (): number => getPageCapacityPx();
  const colWidthNow = (single: boolean): number => getColumnWidthPx(single);
  // 首绘占位页数：纯文本估高；不能用来定位跨章回退的末页。
  const totalPagesFor = (ci: number): number => {
    const paragraphs = book.chapters[ci].paragraphs;
    if (!paragraphs.length) return 1;
    const single = isSingleNow();
    const cap = capacityNow();
    const colW = colWidthNow(single);
    const hs = paragraphs.map((t) => estimateParaHeightPx(t, colW));
    return Math.max(1, paginateTextHeights(hs, cap, !single).length);
  };
  // 实测前暂用估算占位（注释中…期间不显示错误页码，底 pager 在实测后才挂载）。
  let totalPages = totalPagesFor(state.chapterIdx);
  /** 当前页去重保序段（notice/回填/页码“（N段）”用） */
  let slice: AnnotatedParagraph[] = [];
  /** 当前页渲染 flow（行级切片的归属数组；auto 注出后 token 就地就位） */
  let renderFlow: AnnotatedParagraph[] = [];
  /** renderFlow 同下标的原文段下标（双语改判/统计用；auto 分支赋 flowAutoOrig） */
  let flowOrig: number[] = [];
  /** 当前页左右列 token 切片（行首切分，无截断无内滚，见 paginate.ts） */
  let leftSlices: FlowSlice[] = [];
  let rightSlices: FlowSlice[] = [];
  /**
   * LLM 回填：首绘只收集（绝不等待网络），尾部挂载后**按页一次批量请求**跑。
   * - kind 'a'：只送词典缺词；kind 'c'：送整页词表。
   *   两者都沿用本包 token 边界，回填只换释义文本 → 就地 patch（增量重绘）。
   * - next：下一页的注出任务，首绘后预取入缓存（翻到下一页即命中，注出不再等网络）。
   */
  let llmBackfill: {
    kind: "a" | "c";
    jobs: { text: string; missing: string[] }[];
    context: string;
    glossaryKey: string;
    next: { jobs: { text: string; missing: string[] }[]; context: string } | null;
  } | null = null;
  /** 本次分页所用预算/列数/探针输入（rAF 收敛环复用，不重新注出） */
  let capUsedForPaging = 0;
  let columnsUsed: 1 | 2 = 1;
  let flowCacheKey = "";
  let flowColW = 360;
  let flowProbeOpts: {
    mode: Settings["mode"];
    showGloss: boolean;
    filters: { hideStopwords: boolean; hideKnown: boolean; freqHideTopN: number };
    lang: SourceLang;
    showAIButton: boolean;
  } | null = null;
  /** 列绘制/自检/notice/pager 刷新（try 内赋值，尾部 rAF 收敛环复用，故提函数级） */
  let paintedCols: { left: HTMLElement; right: HTMLElement } | null = null;
  let paintColumns: (() => { left: HTMLElement; right: HTMLElement }) | null = null;
  /** 增量回填：只改有变化的 .gloss（同 renderFlow 引用；不重建 DOM、不丢选中态） */
  let patchPaintedGlosses: (() => void) | null = null;
  let checkColumns: (() => number) | null = null;
  let paintNotice: (() => void) | null = null;
  let updatePagerChrome: (() => void) | null = null;
  // 章界无缝：全书首夜/末页才禁用，章内 1/N 语义保留（info 仍显示 章内 page+1/totalPages）
  let isFirstOfBook = state.chapterIdx === 0 && state.page <= 0;
  let isLastOfBook = state.chapterIdx === totalChapters - 1 && state.page >= totalPages - 1;
  const refreshBookEnds = (): void => {
    isFirstOfBook = state.chapterIdx === 0 && state.page <= 0;
    isLastOfBook = state.chapterIdx === totalChapters - 1 && state.page >= totalPages - 1;
  };
  const goPrevPage = (): void => {
    if (state.page > 0) state.page -= 1;
    else if (state.chapterIdx > 0) {
      state.chapterIdx -= 1;
      state.page = 0;
      // 估高页数不等于实测页数；越界 token 锚点由 findFlowPage 钳到章末，
      // 即使最后一段跨页，也定位最后一个 token 所在页而不是该段首页。
      pendingFlowAnchor = Number.POSITIVE_INFINITY;
    }
    sync();
  };
  const goNextPage = (): void => {
    if (state.page < totalPages - 1) state.page += 1;
    else if (state.chapterIdx < totalChapters - 1) {
      state.chapterIdx += 1;
      state.page = 0;
    }
    sync();
  };

  const pager = (pos: "top" | "bottom") => {
    const d = document.createElement("div");
    d.className = `pager pager-${pos}`;
    d.setAttribute("data-testid", `pager-${pos}`);
    const prev = document.createElement("button");
    prev.type = "button";
    prev.setAttribute("data-testid", `pager-${pos}-prev`);
    prev.setAttribute("aria-label", "上一页");
    prev.textContent = "‹ 上页";
    prev.disabled = isFirstOfBook;
    prev.addEventListener("click", () => {
      goPrevPage();
    });
    const info = document.createElement("span");
    info.className = "pager-info";
    info.setAttribute("data-testid", `pager-${pos}-info`);
    info.setAttribute("data-chapter", String(state.chapterIdx));
    info.setAttribute("data-page", String(state.page));
    info.textContent = `第${state.chapterIdx + 1}/${totalChapters}章 · ${ch.title} · ${state.page + 1}/${totalPages} 页（${slice.length}段）`;
    const next = document.createElement("button");
    next.type = "button";
    next.setAttribute("data-testid", `pager-${pos}-next`);
    next.setAttribute("aria-label", "下一页");
    next.textContent = "下页 ›";
    next.disabled = isLastOfBook;
    next.addEventListener("click", () => {
      goNextPage();
    });
    d.append(prev, info, next);
    void pos;
    return d;
  };
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName ?? "";
    // 输入类控件一律不拦截；按钮上的空格=激活按钮（不翻页），方向键按钮不用→翻页。
    // 根因：点完翻页按钮焦点留在按钮上，旧逻辑见 BUTTON 就全禁，方向键当场失灵。
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    if (tag === "BUTTON" && event.key === " ") return;
    // Esc 退出阅读全屏（浏览器全屏的 Esc 由浏览器接管并触发 fullscreenchange；
    // 这里同时去类，双保险；词详情 sheet 自己的 Esc 已 stopPropagation，不冲突）。
    if (event.key === "Escape") {
      try {
        if (document.body.classList.contains("reader-fullscreen")) {
          document.body.classList.remove("reader-fullscreen");
          if (document.fullscreenElement) {
            try {
              void (document.exitFullscreen() as Promise<void>)?.catch?.(() => undefined);
            } catch {
              // ignore
            }
          }
          event.preventDefault();
          sync();
          return;
        }
      } catch {
        // ignore
      }
      return;
    }
    const forward = event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ";
    const back = event.key === "ArrowLeft" || event.key === "PageUp";
    if (!forward && !back) return;
    event.preventDefault();
    if (forward) goNextPage();
    else goPrevPage();
  };
  // Replace the previous page handler on every render instead of stacking
  // listeners; keyboard paging must continue working after each re-render.
  window.onkeydown = onKey;
  // 单页只留底部一套 pager（顶部不再挂载，防底部两套重复）；body 空壳先挂，占位 注释中…。
  // 书式对开容器：移动单栏、桌面双栏（CSS 媒体查询 + JS 单列只用左列）；左右按高度均衡分配。
  const body = document.createElement("div");
  body.className = "book-spread";
  body.setAttribute("data-testid", "book-spread");
  body.setAttribute("aria-label", "阅读区");
  body.setAttribute("role", "region");
  // 源语言标记：文档是 zh-CN，正文却是外语—— 不标 lang 会让屏读用中文发音念英文。
  // auto 无法预知源语言，不标。
  if (book.lang !== "auto") body.setAttribute("lang", book.lang);
  body.setAttribute("data-chapter", String(state.chapterIdx));
  body.setAttribute("data-page", String(state.page));
  // 首绘加载态：绝对定位居中的 spinner（.book-loading 不进列内文流，不影响分页几何）
  {
    const loading = document.createElement("div");
    loading.className = "book-loading";
    loading.setAttribute("role", "status");
    loading.textContent = "注释中…";
    body.appendChild(loading);
  }
  main.appendChild(body);
  fitReaderChrome();
  await nextFrame();
  if (seq !== readerSeq) return;

  try {
    // Auto 万能：不经词典/分词包，直接整句送 LLM 做分词+注（源语言自动识别，只需目标 zh/en）。
    // Mode 强制走 LLM（B 亦不例外）；无 key 直接导设置，不做任何词典回退。
    // 注意：单页 pager 挂载仍只留顶+底各一处（verify pager 计数口径），auto 无 key 不另挂 bottom，走统一页脚。
    if (book.lang === "auto") {
      // 伪 token 探针：fallback 切分（无释义；.gloss 恒单行，盒高与注出后一致）→ 行级精确分页；
      // LLM 只注当前页原文段（纯 LLM 费用语义不变）。伪切分与 LLM 切分边界或有差，rAF 自检兜底。
      if (!state.pack || state.pack.code !== book.lang) {
        state.pack = await loadLanguagePack(book.lang);
        if (seq !== readerSeq) return;
      }
      const packAuto = state.pack;
      const knownFnAuto = (lemma: string) => isKnown(book.lang, lemma);
      const paragraphs = ch.paragraphs;
      const fullKeyAuto = `${book.title}::${state.chapterIdx}::auto::${s.target}`;
      // auto 跨页注出缓存（原文段下标维，已注不再调 LLM；切章后清旧章，防内存膨胀）
      const autoPrefix = `${book.title}::${state.chapterIdx}::${s.target}::`;
      for (const k of [...autoAnnCache.keys()]) {
        if (!k.startsWith(autoPrefix)) autoAnnCache.delete(k);
      }
      for (const k of [...autoDetectedLang.keys()]) {
        if (!k.startsWith(autoPrefix)) autoDetectedLang.delete(k);
      }
      const pseudo: AnnotatedParagraph[] = paragraphs.map((text) => ({
        text,
        tokens: tokenizeParagraph(packAuto, book.lang, text, knownFnAuto),
      }));
      // 空段不进流（无内容可丢）
      const { flow: flowAuto, orig: flowAutoOrig } = chapterFlow(ch, pseudo, (src) =>
        bookImageUrls.get(src)
      );
      flowOrig = flowAutoOrig;
      // 已注缓存先回填再分页：分页几何与实际渲染的 token 一致（LLM 切分边界与伪切分
      // 或有差，否则已注页仍按伪切分装箱，切片错位会丢字；空缓存时此循环无操作）。
      {
        const prefix = `${book.title}::${state.chapterIdx}::${s.target}::`;
        for (const [ck, ann] of autoAnnCache) {
          if (!ck.startsWith(prefix)) continue;
          const oi = Number(ck.slice(prefix.length));
          if (!Number.isInteger(oi)) continue;
          const fi = flowAutoOrig.indexOf(oi);
          if (fi >= 0) flowAuto[fi].tokens = ann.tokens;
        }
      }
      const single0 = isSingleNow();
      const cap0 = Math.max(80, getColumnContentHeight(single0) - lastChromeReserved);
      const colW0 = colWidthNow(single0);
      const probeOptsAuto = {
        mode: s.mode,
        showGloss: s.showGloss,
        filters: {
          hideStopwords: s.hideStopwords,
          hideKnown: s.hideKnown,
          freqHideTopN: s.freqHideTopN,
        },
        lang: book.lang,
        showAIButton: false,
      };
      capUsedForPaging = cap0;
      columnsUsed = single0 ? 1 : 2;
      flowCacheKey = fullKeyAuto + "::noai";
      flowColW = colW0;
      flowProbeOpts = probeOptsAuto;
      const planAuto = paginateChapterFlow(
        flowAuto,
        flowCacheKey,
        cap0,
        columnsUsed,
        colW0,
        probeOptsAuto
      );
      totalPages = Math.max(1, planAuto.pages.length);
      rememberFlowPages(flowCacheKey, planAuto.pages);
      if (pendingFlowAnchor != null) {
        state.page = findFlowPage(planAuto.pages, pendingFlowAnchor);
        pendingFlowAnchor = null;
      }
      state.page = Math.max(0, Math.min(state.page, totalPages - 1));
      const pgAuto = planAuto.pages[state.page];
      const cutAuto = single0 ? pgAuto.endTok : pgAuto.cutTok;
      leftSlices = slicesForTokenRange(planAuto.geom, pgAuto.startTok, cutAuto);
      rightSlices = single0 ? [] : slicesForTokenRange(planAuto.geom, cutAuto, pgAuto.endTok);
      renderFlow = flowAuto;
      // 当前页 flow 段（去重保序）→ 只注这些原文段（费用语义不变）
      const seenAuto = new Set<number>();
      const pageFlowIdx: number[] = [];
      for (const sl of [...leftSlices, ...rightSlices]) {
        if (!seenAuto.has(sl.para)) {
          seenAuto.add(sl.para);
          pageFlowIdx.push(sl.para);
        }
      }
      const pageOrigIdx = pageFlowIdx.map((fi) => flowAutoOrig[fi]).filter((oi) => oi >= 0);
      if (!s.apiKey && pageOrigIdx.length) {
        errBox.textContent =
          "Auto 万能模式需 LLM Key：去「设置」填写（仅存 localStorage，浏览器直调），再阅读。";
        state.error = "Auto 万能模式需 LLM Key：去「设置」填写（仅存 localStorage，浏览器直调）。";
        // 无 key：不调 LLM、不走词典，显示伪切分原文（可读，释义全“—”），走统一渲染+页脚。
        if (seq !== readerSeq) return;
        state.annotated = pageFlowIdx.map((fi) => flowAuto[fi]);
        slice = state.annotated;
        state.annotatedFull = [];
        state.annotatedFullKey = "";
      } else {
        // 有 key：当前页原文段逐段 autoSegmentGloss（缓存命中零费用；失败段保留伪切分原文，不编造）。
        // 注出写回 flow（同一引用），切片 [from,to) 按需钳制（LLM 切分边界与伪切分或有差）。
        let spentAuto = 0;
        for (const oi of pageOrigIdx) {
          if (seq !== readerSeq) return;
          const ck = `${book.title}::${state.chapterIdx}::${s.target}::${oi}`;
          const cached = autoAnnCache.get(ck);
          if (cached) {
            const fi = flowAutoOrig.indexOf(oi);
            if (fi >= 0) flowAuto[fi].tokens = cached.tokens;
            continue;
          }
          if (s.costUsedUSD + spentAuto >= s.costCapUSD) {
            state.error = `已达费用上限 ${s.costCapUSD} USD（已用 ${formatUSD(s.costUsedUSD)}），Auto 停止。本页剩余段落未注。`;
            break;
          }
          try {
            const { tokens, costUSD, detectedLang } = await autoSegmentGloss(
              { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model },
              s.target,
              paragraphs[oi]
            );
            spentAuto += costUSD;
            autoDetectedLang.set(ck, normalizeLangTag(detectedLang));
            const ann: AnnotatedParagraph = {
              text: paragraphs[oi],
              tokens: tokens.map((t) => ({
                surface: t.surface,
                lemma: t.lemma,
                isWord: true,
                gloss: t.gloss,
                glossSource: "llm" as const,
                known: knownFnAuto(t.lemma),
                stopword: false,
              })),
            };
            autoAnnCache.set(ck, ann);
            const fi = flowAutoOrig.indexOf(oi);
            if (fi >= 0) flowAuto[fi].tokens = ann.tokens;
          } catch (e) {
            state.error = `Auto LLM 失败：${(e as Error).message}`;
            // 失败段保留伪切分原文（可读、无注），其余已注段仍显示。
            break;
          }
        }
        if (spentAuto > 0) {
          s.costUsedUSD = +(s.costUsedUSD + spentAuto).toFixed(4);
          save();
        }
        if (seq !== readerSeq) return;
        if (spentAuto > 0) {
          // 首访本页：LLM 刚改写了 token 边界，按新几何重排一次，锚定本页首段不跳页
          //（否则切片仍是伪切分口径，变长段的尾部 token 在任何页都不可达）。
          const anchorFi = pageFlowIdx.length ? pageFlowIdx[0] : 0;
          const idx2 = flowIndexOf(flowAuto);
          const anchorTok = landAtChapterEnd
            ? Number.POSITIVE_INFINITY
            : anchorFi < idx2.paraStart.length - 1
              ? idx2.paraStart[anchorFi]
              : 0;
          const planAuto2 = paginateChapterFlow(
            flowAuto,
            flowCacheKey,
            cap0,
            columnsUsed,
            colW0,
            probeOptsAuto
          );
          if (planAuto2.pages.length) {
            totalPages = planAuto2.pages.length;
            rememberFlowPages(flowCacheKey, planAuto2.pages);
            state.page = Math.max(
              0,
              Math.min(findFlowPage(planAuto2.pages, anchorTok), totalPages - 1)
            );
            const pg2 = planAuto2.pages[state.page];
            const cut2 = single0 ? pg2.endTok : pg2.cutTok;
            leftSlices = slicesForTokenRange(planAuto2.geom, pg2.startTok, cut2);
            rightSlices = single0 ? [] : slicesForTokenRange(planAuto2.geom, cut2, pg2.endTok);
            const seen2 = new Set<number>();
            const idxs2: number[] = [];
            for (const sl of [...leftSlices, ...rightSlices]) {
              if (!seen2.has(sl.para)) {
                seen2.add(sl.para);
                idxs2.push(sl.para);
              }
            }
            state.annotated = idxs2.map((fi) => flowAuto[fi]);
            slice = state.annotated;
          } else {
            state.annotated = pageFlowIdx.map((fi) => flowAuto[fi]);
            slice = state.annotated;
          }
        } else {
          state.annotated = pageFlowIdx.map((fi) => flowAuto[fi]);
          slice = state.annotated;
        }
        // auto 无全章词典注出，annotatedFull 留空；resize 时按 token 锚点重排（pendingFlowAnchor）。
        state.annotatedFull = [];
        state.annotatedFullKey = `auto::${state.chapterIdx}::${s.target}`;
      }
      refreshBookEnds();
    } else {
      if (!state.pack || state.pack.code !== book.lang) {
        state.pack = await loadLanguagePack(book.lang);
        // 长章加载慢，await 后若已有更新的 sync（翻页/切章/切 Tab），直接丢弃旧续体。
        if (seq !== readerSeq) return;
      }
      const pack = state.pack;
      const knownFn = (lemma: string) => isKnown(book.lang, lemma);
      // 全章先纯词典注出并缓存（翻页/resize 复用，不重复调词典）。
      const paragraphs = ch.paragraphs;
      const fullKey = `${book.title}::${state.chapterIdx}::${book.lang}::${s.target}`;
      if (state.annotatedFullKey !== fullKey || state.annotatedFull.length !== paragraphs.length) {
        state.annotatedFull = await annotateParagraphs(
          pack,
          book.lang,
          s.target,
          paragraphs,
          knownFn
        );
        state.annotatedFullKey = fullKey;
        if (seq !== readerSeq) return;
      }
      const full = state.annotatedFull;
      // 多语自适应（段级路由）：主包注完全章后，拼写信号改判的段用对应包重注。
      // 不看词典命中率（小词典包原文命中也低），只看停用词/文字信号；信号不足不断言。
      // B 模式同样生效（仍零 LLM）。改判记录在 fallbackLang（原文段下标->语言，随 full 缓存）。
      {
        const routed = new Map<SourceLang, number[]>();
        const routedBefore =
          fallbackArrByKey.get(fullKey) === full ? fallbackLangByKey.get(fullKey) : undefined;
        full.forEach((p, oi) => {
          if (p.tokens.length === 0 || routedBefore?.has(oi)) return;
          const det = detectParaLang(p.text);
          if (det && det !== book.lang) {
            const list = routed.get(det) ?? [];
            list.push(oi);
            routed.set(det, list);
          }
        });
        for (const [det, candIdx] of routed) {
          if (seq !== readerSeq) return;
          const detPack = await loadLanguagePack(det);
          if (seq !== readerSeq) return;
          const detKnown = (lemma: string) => isKnown(det, lemma);
          const detAnn = await annotateParagraphs(
            detPack,
            det,
            s.target,
            candIdx.map((oi) => full[oi].text),
            detKnown
          );
          if (seq !== readerSeq) return;
          let rec = fallbackLangByKey.get(fullKey);
          if (!rec) {
            rec = new Map<number, SourceLang>();
            fallbackLangByKey.set(fullKey, rec);
            if (fallbackLangByKey.size > 8) {
              const first = fallbackLangByKey.keys().next();
              if (!first.done) {
                fallbackLangByKey.delete(first.value);
                fallbackArrByKey.delete(first.value);
              }
            }
          }
          // 绑定改判记录到本次的 full 数组（并发渲染的正确性钥匙，见声明处注释）。
          fallbackArrByKey.set(fullKey, full);
          detAnn.forEach((a, k) => {
            const oi = candIdx[k];
            if (a.tokens.length > 0) {
              full[oi].tokens = a.tokens;
              rec.set(oi, det);
            }
          });
        }
      }
      // 短行认领：歌词式短行等拼写信号不足的段落，若左右最近的有判定段落同语言
      // （非主语言），则试用该语言包；命中率反超主包才保留，否则回退。
      // 交错对照（左右判定不一致）不认领；单语书无改判锚点时零成本跳过。
      {
        const rec0 = fallbackLangByKey.get(fullKey);
        if (rec0 && rec0.size > 0) {
          const detOf = (oi: number): SourceLang | null => {
            const r = fallbackLangByKey.get(fullKey)?.get(oi);
            if (r) return r;
            return detectParaLang(full[oi].text);
          };
          const hitRate = (toks: Token[]): number => {
            let t = 0;
            let h = 0;
            for (const tk of toks) {
              if (tk.isWord) {
                t++;
                if (tk.gloss) h++;
              }
            }
            return t ? h / t : 0;
          };
          const adoptByLang = new Map<SourceLang, number[]>();
          full.forEach((p, oi) => {
            if (p.tokens.length === 0 || fallbackLangByKey.get(fullKey)?.has(oi)) return;
            if (detectParaLang(p.text) !== null) return;
            let L: SourceLang | null = null;
            let R: SourceLang | null = null;
            for (let j = oi - 1; j >= Math.max(0, oi - 8); j--) {
              const d = detOf(j);
              if (d) {
                L = d;
                break;
              }
            }
            for (let j = oi + 1; j < Math.min(full.length, oi + 9); j++) {
              const d = detOf(j);
              if (d) {
                R = d;
                break;
              }
            }
            if (!L || !R || L !== R || L === book.lang) return;
            const list = adoptByLang.get(L) ?? [];
            list.push(oi);
            adoptByLang.set(L, list);
          });
          for (const [L, idxs] of adoptByLang) {
            if (seq !== readerSeq) return;
            const detPack = await loadLanguagePack(L);
            if (seq !== readerSeq) return;
            const detKnown = (lemma: string) => isKnown(L, lemma);
            const detAnn = await annotateParagraphs(
              detPack,
              L,
              s.target,
              idxs.map((oi) => full[oi].text),
              detKnown
            );
            if (seq !== readerSeq) return;
            const rec = fallbackLangByKey.get(fullKey);
            if (!rec) return;
            detAnn.forEach((a, k) => {
              const oi = idxs[k];
              if (a.tokens.length > 0 && hitRate(a.tokens) > hitRate(full[oi].tokens) + 0.1) {
                full[oi].tokens = a.tokens;
                rec.set(oi, L);
              }
            });
          }
        }
      }
      // 行级 flow 分页：探针实测行高 + 行首切分（列高算术精确，无截断无内滚）。
      // 空段不进流（无内容可丢）；仅消费几何变化/跨章回退显式设置的 pendingFlowAnchor。
      // flowOrig 与 flow 同下标：原文段下标（改判语言/统计用）。
      const merged = chapterFlow(ch, full, (src) => bookImageUrls.get(src));
      const flow = merged.flow;
      flowOrig = merged.orig;
      const single = isSingleNow();
      const cap = Math.max(80, getColumnContentHeight(single) - lastChromeReserved);
      const colW = colWidthNow(single);
      const aiFlag = s.mode === Mode.A;
      const probeOpts = {
        mode: s.mode,
        showGloss: s.showGloss,
        filters: {
          hideStopwords: s.hideStopwords,
          hideKnown: s.hideKnown,
          freqHideTopN: s.freqHideTopN,
        },
        lang: book.lang,
        showAIButton: aiFlag,
      };
      capUsedForPaging = cap;
      columnsUsed = single ? 1 : 2;
      flowCacheKey = fullKey + (aiFlag ? "::ai" : "::noai");
      flowColW = colW;
      flowProbeOpts = probeOpts;
      const plan = paginateChapterFlow(flow, flowCacheKey, cap, columnsUsed, colW, probeOpts);
      totalPages = Math.max(1, plan.pages.length);
      rememberFlowPages(flowCacheKey, plan.pages);
      if (pendingFlowAnchor != null) {
        state.page = findFlowPage(plan.pages, pendingFlowAnchor);
        pendingFlowAnchor = null;
      }
      state.page = Math.max(0, Math.min(state.page, totalPages - 1));
      const pg = plan.pages[state.page];
      const cut = single ? pg.endTok : pg.cutTok;
      leftSlices = slicesForTokenRange(plan.geom, pg.startTok, cut);
      rightSlices = single ? [] : slicesForTokenRange(plan.geom, cut, pg.endTok);
      renderFlow = flow;
      slice = [];
      {
        const seenP = new Set<number>();
        for (const sl of [...leftSlices, ...rightSlices]) {
          if (!seenP.has(sl.para)) {
            seenP.add(sl.para);
            const fp = flow[sl.para];
            if (fp) slice.push(fp);
          }
        }
      }

      // 一页要注的段落 → 批量任务；同一段只取一次。C 模式送全词表，A 模式只送缺词。
      const jobsOfSlices = (
        slices: FlowSlice[],
        kind: "a" | "c"
      ): { text: string; missing: string[] }[] => {
        const seen = new Set<number>();
        const out: { text: string; missing: string[] }[] = [];
        for (const sl of slices) {
          if (seen.has(sl.para)) continue;
          seen.add(sl.para);
          const p = renderFlow[sl.para];
          if (!p || p.image) continue;
          const missing =
            kind === "c"
              ? [
                  ...new Set(
                    pack
                      .segment(p.text)
                      .map((t) => pack.lemmatize(t))
                      .filter((l) => /[\p{L}]/u.test(l))
                  ),
                ].slice(0, 40)
              : [
                  ...new Set(p.tokens.filter((t) => t.isWord && !t.gloss).map((t) => t.lemma)),
                ].slice(0, 40);
          if (missing.length) out.push({ text: p.text, missing });
        }
        return out;
      };
      // 请求上下文（输入，不是输出）：整章原文，超出预算就从本页两侧由近到远收。
      // 输入 token 便宜、几乎不增加首字延迟，而选义质量随上下文单调变好；实测一章
      // 通常 1-3K tok，等于「整章随请求发过去」。输出（生成）才是延迟/费用主项，
      // 所以注出目标仍按页切（见 nextPageJobs / fetchGlossBatches）。
      const CONTEXT_TOKEN_BUDGET = 16000;
      const contextOfSlices = (slices: FlowSlice[]): string => {
        const cur: number[] = [];
        const seen = new Set<number>();
        for (const sl of slices) {
          if (seen.has(sl.para)) continue;
          seen.add(sl.para);
          const oi = sl.para >= 0 && sl.para < flowOrig.length ? flowOrig[sl.para] : -1;
          if (oi >= 0) cur.push(oi);
        }
        if (!cur.length) return "";
        const join = (a: number, b: number): string => paragraphs.slice(a, b + 1).join("\n");
        let from = Math.min(...cur);
        let to = Math.max(...cur);
        if (estimateTokens(join(from, to)) > CONTEXT_TOKEN_BUDGET) return join(from, to);
        // 由本页向两侧同时扩：近处上下文优先保住，预算满即停。
        for (;;) {
          const nf = from > 0 ? from - 1 : from;
          const nt = to < paragraphs.length - 1 ? to + 1 : to;
          if (nf === from && nt === to) break;
          if (estimateTokens(join(nf, nt)) > CONTEXT_TOKEN_BUDGET) break;
          from = nf;
          to = nt;
        }
        return join(from, to);
      };
      /** 下一页的注出任务（预取用）：翻页即命中句缓存，注出不再等网络。跨章不预取。 */
      const nextPageJobs = (
        kind: "a" | "c"
      ): { jobs: { text: string; missing: string[] }[]; context: string } | null => {
        const np = plan.pages[state.page + 1];
        if (!np) return null;
        const cutN = single ? np.endTok : np.cutTok;
        const lN = slicesForTokenRange(plan.geom, np.startTok, cutN);
        const rN = single ? [] : slicesForTokenRange(plan.geom, cutN, np.endTok);
        const allN = [...lN, ...rN];
        const jobs = jobsOfSlices(allN, kind);
        return jobs.length ? { jobs, context: contextOfSlices(allN) } : null;
      };
      const buildBackfill = (kind: "a" | "c"): void => {
        const cur = [...leftSlices, ...rightSlices];
        const jobs = jobsOfSlices(cur, kind);
        llmBackfill = null;
        if (!jobs.length) return;
        llmBackfill = {
          kind,
          jobs,
          context: contextOfSlices(cur),
          glossaryKey: `${book.title}::${book.lang}::${s.target}`,
          next: nextPageJobs(kind),
        };
      };

      state.annotated = slice;
      if (s.mode === Mode.C) {
        // 首绘先出词典（不等待网络）；整页 LLM 在一次批量请求后回填。
        if (!s.apiKey) {
          state.error = "C 模式需 LLM Key：去「设置」填写，或切到 A/B。本页仅显示词典。";
        } else {
          buildBackfill("c");
        }
      } else if (s.mode === Mode.A && s.apiKey) {
        // A mode is dictionary-first, but with a user-supplied key it also
        // backfills dictionary misses for the current page in one batched
        // request. B remains strictly offline. The whole-book glossary is a
        // background job that must never gate the page: it is read from cache
        // only, and started *after* the first page's backfill so page content
        // always wins the first round trip (see post-mount block).
        buildBackfill("a");
      }
      refreshBookEnds();
    } // end non-auto (词典包)分支；Auto 分支已在上设 state.annotated
    // 旧续体丢弃：翻页/切章后旧 await 恢复时不再挂 bottom，避免底部两套。
    if (seq !== readerSeq) return;

    // 列绘制（含边沟点翻/滑动翻页）：收敛环可重入（只换列内容，不重建 chrome）。
    // 行级分页直渲：slices 已是当前页内容（探针实测行高，列高算术精确），无内滚、无截断；
    // 行高恒远小于页高，单段超高在行级语义下不存在，data-overflow 兜底不再设置。
    const singleColForPaint = isSingleColumnViewport();
    paintColumns = (): { left: HTMLElement; right: HTMLElement } => {
      body.innerHTML = "";
      const singleCol = singleColForPaint;
      const left = document.createElement("div");
      left.className = "book-page book-page-left";
      left.setAttribute("data-testid", "book-page-left");
      const right = document.createElement("div");
      right.className = "book-page book-page-right";
      right.setAttribute("data-testid", "book-page-right");
      const leftReader = document.createElement("div");
      const rightReader = document.createElement("div");
      left.appendChild(leftReader);
      right.appendChild(rightReader);
      body.append(left, right);
      // 分页与渲染同帧同视口，列数不会翻转；窄屏合流到左列（右列 display:none 但保留 DOM，保证 e2e/verify 口径）。
      // 合流时左右切片本就首尾相接（同页 token 区间），续排类依然正确。
      const lSlices = singleCol ? [...leftSlices, ...rightSlices] : leftSlices;
      const rSlices = singleCol ? [] : rightSlices;
      if (singleCol) right.style.display = "none";
      else right.style.display = "";
      const opts = {
        mode: s.mode,
        showGloss: s.showGloss,
        filters: {
          hideStopwords: s.hideStopwords,
          hideKnown: s.hideKnown,
          freqHideTopN: s.freqHideTopN,
        },
        lang: book.lang,
        // Auto 已是纯 LLM 整段注出，无需“释义本句”按钮（重渲染即重试）；非 Auto 保持 A 才显示。
        showAIButton: book.lang === "auto" ? false : s.mode === Mode.A,
        onTokenClick: (t: Token, sentence: string) => showSheet(main, book.lang, t, sentence, sync),
        onSentenceAI: (sentence: string) => {
          void explainSentence(book.lang, sentence, sync);
        },
      };
      renderSlices(leftReader, renderFlow, lSlices, opts);
      renderSlices(rightReader, renderFlow, rSlices, opts);
      // 增量回填入口：只更新有变化的 .gloss，不重建列 DOM（保留选中态/滚动/焦点）。
      patchPaintedGlosses = (): void => {
        for (const col of [leftReader, rightReader]) patchGlosses(col, renderFlow, opts);
      };
      // 改判段标 lang（屏读按段切换发音；无改判时空操作）。
      try {
        const fb = fallbackLangByKey.get(
          `${book.title}::${state.chapterIdx}::${book.lang}::${s.target}`
        );
        if (fb && fb.size) {
          for (const col of [leftReader, rightReader]) {
            col.querySelectorAll(".para[data-pi]").forEach((el) => {
              const fi = Number((el as HTMLElement).dataset.pi ?? -1);
              const oi = fi >= 0 && fi < flowOrig.length ? flowOrig[fi] : -1;
              const lang = oi >= 0 ? fb.get(oi) : undefined;
              if (lang) (el as HTMLElement).setAttribute("lang", lang);
            });
          }
        }
      } catch {
        // 测量失败不阻塞渲染
      }
      // 边沟点翻：书页沿透明带（上一页/下一页；token 点选不受影响，stopPropagation 已在 token 层处理）
      const mkGutter = (dir: "prev" | "next"): HTMLButtonElement => {
        const g = document.createElement("button");
        g.type = "button";
        g.className = `page-gutter ${dir}`;
        g.setAttribute("data-testid", `page-gutter-${dir}`);
        g.setAttribute("aria-label", dir === "prev" ? "上一页" : "下一页");
        g.textContent = dir === "prev" ? "‹" : "›";
        g.disabled = dir === "prev" ? isFirstOfBook : isLastOfBook;
        g.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (dir === "prev") goPrevPage();
          else goNextPage();
        });
        return g;
      };
      body.append(mkGutter("prev"), mkGutter("next"));
      // 滑动翻页：水平滑动>48px 且主导方向为水平时翻页（垂直滑动不拦截，阅读区本身无滚动）。
      // 监听器挂 body 上，paintColumns 重入时只挂一次（dataset 守卫），避免一次滑动翻多页。
      if (!body.dataset.swipeWired) {
        body.dataset.swipeWired = "1";
        let swipeX = 0;
        let swipeY = 0;
        let swiping = false;
        body.addEventListener(
          "touchstart",
          (ev) => {
            const t = ev.changedTouches[0];
            swipeX = t.clientX;
            swipeY = t.clientY;
            swiping = true;
          },
          { passive: true }
        );
        body.addEventListener(
          "touchend",
          (ev) => {
            if (!swiping) return;
            swiping = false;
            const t = ev.changedTouches[0];
            const dx = t.clientX - swipeX;
            const dy = t.clientY - swipeY;
            if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.6) {
              if (dx < 0) goNextPage();
              else goPrevPage();
            }
          },
          { passive: true }
        );
      }
      body.setAttribute("data-page", String(state.page));
      return { left, right };
    };
    // 本轮章节处理中产生的新错（C 模式等）在首绘前同步进 errBox。
    if (state.error) errBox.textContent = state.error;
    paintedCols = paintColumns?.() ?? null;
    // 自检：行级算术应保证零溢出；>2px 即记 warn（浏览器证据口径，不做静默修正）。
    checkColumns = (): number => {
      let worst = 0;
      try {
        const pc = paintedCols;
        if (!pc) return 0;
        for (const col of [pc.left, pc.right]) {
          if (col.style.display === "none") continue;
          const ov = col.scrollHeight - col.clientHeight;
          if (ov > worst) worst = ov;
          if (ov > 2) {
            console.warn(
              `[paginate] column overflow ${ov}px (page=${state.page} ch=${state.chapterIdx})`
            );
          }
        }
      } catch {
        // 测量失败不阻塞渲染
      }
      return worst;
    };
    // 单页缺词率 notice（DOM 可断言口径：命中 X/Y + 缺词 N + 无 key 退化导向设置）：
    // 根因：之前 notice 只写模式说明，seeds 裸奔时整页全空用户无从得知缺了多少、去哪补。
    // Auto 万能：明示纯 LLM 费用（无词典命中口径，改为 LLM 注词数 + 上限）。
    // 收敛环可重入：重排后刷新统计（跨页长段只计本页区间）。
    paintNotice = (): void => {
      // 本页实际渲染 token（跨页长段只计本页区间，与 DOM .tok 一一对应）
      const renderedToks: Token[] = [];
      for (const sl of [...leftSlices, ...rightSlices]) {
        const p = renderFlow[sl.para];
        if (p)
          renderedToks.push(
            ...p.tokens.slice(Math.max(0, sl.from), Math.max(0, sl.to)).filter((t) => t.isWord)
          );
      }
      const toks = renderedToks.length
        ? renderedToks
        : state.annotated.flatMap((p) => p.tokens).filter((t) => t.isWord);
      if (book.lang === "auto") {
        const llmHits = toks.filter((t) => !!t.gloss).length;
        // 已注段落的识别语言多数票（LLM 每段自报 detectedLang，此前直接丢掉）。
        let voteText = "";
        try {
          const prefix = `${book.title}::${state.chapterIdx}::${s.target}::`;
          const votes = new Map<string, number>();
          for (const [k, v] of autoDetectedLang) {
            if (k.startsWith(prefix) && v) votes.set(v, (votes.get(v) ?? 0) + 1);
          }
          const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
          if (ranked.length) {
            const nameOf = (tag: string): string =>
              (SOURCE_LANG_NAMES as Record<string, string>)[tag] ?? tag;
            voteText = ` · 识别：${ranked.map(([t, n]) => `${nameOf(t)} ${n}`).join(" / ")}`;
            const top = ranked[0][0];
            if (top) body.setAttribute("lang", top);
          }
        } catch {
          // 统计失败不阻塞渲染
        }
        setNotice(
          `${modeText}本页 Auto 纯 LLM 已注 ${llmHits}/${toks.length} 词` +
            `${toks.length - llmHits > 0 ? `，未注 ${toks.length - llmHits} 词` : ""}` +
            `（无词典，纯 LLM 费用，已用 ${formatUSD(s.costUsedUSD)} / 上限 $${s.costCapUSD}）。${voteText}`
        );
      } else {
        const misses = toks.filter((t) => !t.gloss);
        const hits = toks.length - misses.length;
        const rate = toks.length
          ? (Math.round((hits / toks.length) * 1000) / 10).toFixed(1)
          : "100.0";
        const missLemmas = [...new Set(misses.map((t) => t.lemma))].slice(0, 8).join("、");
        // 专名拆分（Westminster/Confession/Neumann/WeWork 首字母大写豁免标记）：
        // 总缺词数 == DOM .gloss.missing 数（含专名，保持对上）；括号内另报其中专名数，
        // 专名 DOM 另带 .proper，title 注明原形保留，缺词不再莫名。
        const properMisses = misses.filter((t) => isProperNounSurface(book.lang, t.surface));
        let extra = `命中 ${hits}/${toks.length}（${rate}%）· 缺词 ${misses.length}`;
        if (properMisses.length > 0 && book.lang === "en") {
          const properLemmas = [...new Set(properMisses.map((t) => t.surface))]
            .slice(0, 4)
            .join("、");
          extra += ` · 专名 ${properMisses.length}（${properLemmas}）`;
        }
        if (book.lang === "ja" && s.target === "zh") extra += " · 日→中覆盖有限，缺词可用 LLM";
        if (s.mode === Mode.A && !s.apiKey && misses.length > 0) extra += " · 填 key 可补词";
        // 改判统计：本页被路由到其他词典包的段（多语书）。
        try {
          const fb = fallbackLangByKey.get(
            `${book.title}::${state.chapterIdx}::${book.lang}::${s.target}`
          );
          if (fb && fb.size) {
            const seenP = new Set<number>();
            const langs = new Set<string>();
            let n = 0;
            for (const sl of [...leftSlices, ...rightSlices]) {
              const oi = sl.para >= 0 && sl.para < flowOrig.length ? flowOrig[sl.para] : -1;
              const lang = oi >= 0 ? fb.get(oi) : undefined;
              if (lang && !seenP.has(oi)) {
                seenP.add(oi);
                langs.add(SOURCE_LANG_NAMES[lang] ?? lang);
                n++;
              }
            }
            if (n > 0) extra += ` · 其中 ${n} 段自动用${[...langs].join("、")}注出`;
          }
        } catch {
          // 统计失败不阻塞渲染
        }
        setNotice(extra);
      }
    };
    paintNotice?.();
    // pager/cost 终稿挂载后刷新（收敛环复用：只改文本与禁用态，不重建 DOM）。
    updatePagerChrome = (): void => {
      try {
        refreshBookEnds();
        const info = main.querySelector('[data-testid="pager-bottom-info"]');
        if (info) {
          info.setAttribute("data-chapter", String(state.chapterIdx));
          info.setAttribute("data-page", String(state.page));
          info.textContent = `第${state.chapterIdx + 1}/${totalChapters}章 · ${ch.title} · ${state.page + 1}/${totalPages} 页（${slice.length}段）`;
        }
        const prev = main.querySelector(
          '[data-testid="pager-bottom-prev"]'
        ) as HTMLButtonElement | null;
        const next = main.querySelector(
          '[data-testid="pager-bottom-next"]'
        ) as HTMLButtonElement | null;
        if (prev) prev.disabled = isFirstOfBook;
        if (next) next.disabled = isLastOfBook;
        const gp = body.querySelector(
          '[data-testid="page-gutter-prev"]'
        ) as HTMLButtonElement | null;
        const gn = body.querySelector(
          '[data-testid="page-gutter-next"]'
        ) as HTMLButtonElement | null;
        if (gp) gp.disabled = isFirstOfBook;
        if (gn) gn.disabled = isLastOfBook;
      } catch {
        // ignore
      }
    };
  } catch (e) {
    if (seq !== readerSeq) return;
    body.innerHTML = "";
    errBox.textContent = `渲染失败：${(e as Error).message}`;
  }
  // 单页只留顶+底各一套：旧续体已在上一步 return，此处只挂一次 bottom。
  if (seq !== readerSeq) return;
  // 防御：若因极端竞态已有 bottom（理论上不应发生），先清再挂，保证 ==2。
  main.querySelectorAll('[data-testid="pager-bottom"]').forEach((n) => n.remove());
  main.appendChild(pager("bottom"));

  // 页脚状态行：本页统计（左）+ 费用/key 去向（右）挤在同一条，
  // 把原先“书页上方一条 notice + 书页下方一条 cost”合成一条，多出的纵向空间全给正文。
  const statusRow = document.createElement("div");
  statusRow.className = "reader-status";
  const cost = document.createElement("div");
  cost.className = "cost";
  // 费用是主信息，口径说明（Auto 纯 LLM / key 只存本机）窄屏折叠，避免页脚换行。
  cost.innerHTML =
    `费用 ${formatUSD(s.costUsedUSD)} / 上限 $${s.costCapUSD}` +
    `<span class="lbl-ext">${
      book.lang === "auto"
        ? " · Auto 纯 LLM 分词+注 · key 仅存 localStorage"
        : " · key 仅存 localStorage"
    }</span>`;
  statusRow.append(notice, cost);
  main.appendChild(statusRow);
  // 全屏悬浮退出（全屏时工具条被隐藏，必须留一个可见出口；Esc 同样可退）。
  {
    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "fs-exit";
    exit.setAttribute("data-testid", "exit-fullscreen");
    exit.setAttribute("aria-label", "退出全屏");
    exit.textContent = "退出全屏";
    exit.addEventListener("click", async () => {
      try {
        document.body.classList.remove("reader-fullscreen");
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // ignore
      }
      sync();
    });
    main.appendChild(exit);
  }
  // 页面 LLM 回填（首绘之后异步跑，不挡正文）：本页缺词/整句批量按预算切块，
  // **每块返回即增量填词**（大请求与小请求的网络延迟一样，能填就先填）。
  // 术语表口径（用户口径）：
  // - A：与词典同屏即刻并行后台提炼，不等（本页缺词回填不需要它）；
  // - C：整页由 LLM 注词，术语表影响全书一致性，先等它（失败则冷却后空表继续）。
  // 随后预取下一页的注出，翻到下一页即命中句缓存，注出不再等网络。
  const refreshCost = (): void => {
    cost.innerHTML =
      `费用 ${formatUSD(s.costUsedUSD)} / 上限 $${s.costCapUSD}` +
      `<span class="lbl-ext">${book.lang === "auto" ? " · Auto 纯 LLM 分词+注 · key 仅存 localStorage" : " · key 仅存 localStorage"}</span>`;
  };
  const wantsGlossary = !!s.apiKey && s.bookGlossary && (s.mode === Mode.A || s.mode === Mode.C);
  if (llmBackfill && llmBackfill.jobs.length > 0) {
    const backfill = llmBackfill;
    llmBackfill = null;
    const modeLabel = backfill.kind === "c" ? "C 模式" : "A 模式";
    void (async () => {
      const mySeq = seq;
      // 增量填词：每块返回就 patch 一次；失败回退整列重画兜底。
      const applyPartial = (override: Map<string, Record<string, string>>, spent: number): void => {
        if (mySeq !== readerSeq) return;
        if (spent > 0) {
          s.costUsedUSD = +(s.costUsedUSD + spent).toFixed(4);
          save();
        }
        if (applyOverrideToSlice(slice, override) === 0) return;
        state.annotated = slice;
        // 增量重绘：token 边界（同包同文本）不变，只改 .gloss 文本/类名，不重建列 DOM。
        if (patchPaintedGlosses) patchPaintedGlosses();
        else paintedCols = paintColumns?.() ?? paintedCols;
        paintNotice?.();
        refreshCost();
        updatePagerChrome?.();
      };
      try {
        let glossary = bookGlossaryCache.get(backfill.glossaryKey) ?? {};
        if (wantsGlossary && backfill.kind === "c" && !Object.keys(glossary).length) {
          // C 模式先等术语表（首访一次；失败有冷却，不会每页重启）。
          try {
            glossary = await ensureBookGlossary(book, s, save);
          } catch {
            glossary = {};
          }
          if (mySeq !== readerSeq) return;
        } else if (wantsGlossary && backfill.kind === "a") {
          // A 模式并行起术语表，不等：词典已同屏，缺词回填与其同时进行。
          void ensureBookGlossary(book, s, save);
        }
        const { override, spent, lastErr } = await fetchGlossBatches(
          s,
          book.lang,
          s.target,
          backfill.jobs,
          backfill.context,
          glossary,
          applyPartial
        );
        if (mySeq !== readerSeq) return;
        if (override.size === 0 && lastErr) {
          state.error = `${modeLabel} LLM 失败（已保留词典结果）：${lastErr}`;
          errBox.textContent = state.error;
        }
        // 预取下一页：只入缓存、不改 DOM；失败静默（用户翻到该页时会照常自己补）。
        if (
          backfill.next &&
          backfill.next.jobs.length &&
          mySeq === readerSeq &&
          s.costUsedUSD < s.costCapUSD
        ) {
          const nxt = backfill.next;
          void fetchGlossBatches(s, book.lang, s.target, nxt.jobs, nxt.context, glossary)
            .then((r) => {
              if (r.spent > 0) {
                s.costUsedUSD = +(s.costUsedUSD + r.spent).toFixed(4);
                save();
                if (mySeq === readerSeq) refreshCost();
              }
            })
            .catch(() => undefined);
        }
      } catch {
        // 首绘已出，回填失败静默（整页全失败已在上挂条）。
      }
    })();
  } else if (wantsGlossary) {
    // 本页无缺词可补：直接后台暖术语表，供后续页面的专名/术语一致。
    void ensureBookGlossary(book, s, save);
  }
  // chrome 微调 + 收敛环：pager/cost/notice 终稿挂载后列高落定；预算漂移>2px 则按锚点重排，
  // 最多修正 2 次（重排只换列内容，chrome 高度不变，故必收敛；释义文本不影响盒高，无需重复注出）。
  requestAnimationFrame(() => {
    if (seq !== readerSeq) return;
    fitReaderChrome();
    checkColumns?.();
    let rounds = 0;
    const stabilize = (): void => {
      if (seq !== readerSeq || rounds >= 2 || !flowProbeOpts || !paintColumns) return;
      let realCap = 0;
      try {
        realCap = getColumnContentHeight(columnsUsed === 1);
      } catch {
        return;
      }
      if (Math.abs(realCap - capUsedForPaging) <= 2) return;
      rounds++;
      try {
        console.log(
          `[paginate] stabilize drift=${realCap - capUsedForPaging} realCap=${realCap} rounds=${rounds}`
        );
      } catch {
        /* ignore */
      }
      // 提炼真实预留，供下次首绘直接命中
      lastChromeReserved = Math.max(0, lastChromeReserved + (capUsedForPaging - realCap));
      capUsedForPaging = realCap;
      const anchor = landAtChapterEnd
        ? Number.POSITIVE_INFINITY
        : (lastFlowPages[state.page]?.startTok ?? 0);
      const plan2 = paginateChapterFlow(
        renderFlow,
        flowCacheKey,
        realCap,
        columnsUsed,
        flowColW,
        flowProbeOpts
      );
      if (!plan2.pages.length) return;
      rememberFlowPages(flowCacheKey, plan2.pages);
      totalPages = plan2.pages.length;
      state.page = Math.max(0, Math.min(findFlowPage(plan2.pages, anchor), totalPages - 1));
      const pg2 = plan2.pages[state.page];
      const cut2 = columnsUsed === 1 ? pg2.endTok : pg2.cutTok;
      leftSlices = slicesForTokenRange(plan2.geom, pg2.startTok, cut2);
      rightSlices = columnsUsed === 1 ? [] : slicesForTokenRange(plan2.geom, cut2, pg2.endTok);
      slice = [];
      {
        const seen = new Set<number>();
        for (const sl of [...leftSlices, ...rightSlices]) {
          if (!seen.has(sl.para)) {
            seen.add(sl.para);
            const fp = renderFlow[sl.para];
            if (fp) slice.push(fp);
          }
        }
      }
      state.annotated = slice;
      paintedCols = paintColumns();
      paintNotice?.();
      updatePagerChrome?.();
      requestAnimationFrame(() => {
        if (seq !== readerSeq) return;
        fitReaderChrome();
        checkColumns?.();
        stabilize();
      });
    };
    stabilize();
  });
}

/** 阅读页导出按钮 thin wrapper：禁用态 + 委托全量导出（章节保留/费用上限，见 exportCurrentBookAsEpub） */
async function handleExportEpub(btn: HTMLButtonElement): Promise<void> {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "导出中…";
  try {
    await exportCurrentBookAsEpub();
  } catch (e) {
    btn.title = `导出失败：${(e as Error).message}`;
  } finally {
    btn.disabled = false;
    if (orig != null) btn.textContent = orig;
  }
}

/** A 模式点句：LLM 释义整句缺词，结果写入句缓存后重渲染；Auto 万能强制走 LLM（B 亦不拦截） */
async function explainSentence(
  lang: SourceLang,
  sentence: string,
  sync: () => void
): Promise<void> {
  const s = state.settings;
  const isAutoLang = lang === "auto";
  if (s.mode === Mode.B && !isAutoLang) {
    state.error = "B 模式不调用 LLM，切到 A 或 C 再用 AI 释义。";
    sync();
    return;
  }
  if (!s.apiKey) {
    state.error = "缺少 API Key：去「设置」填写（仅存 localStorage，浏览器直调）。";
    state.tab = "settings";
    sync();
    return;
  }
  // Auto 万能：不经分词包，整句 autoSegmentGloss（点词/点句均强制 LLM；B 亦不拦截）。
  if (isAutoLang) {
    const estAuto = estimateCostUSD(sentence, sentence);
    if (s.costUsedUSD + estAuto > s.costCapUSD) {
      state.error = `费用将超上限（${formatUSD(s.costUsedUSD)} + ~${formatUSD(estAuto)} > $${s.costCapUSD}），已拦截。`;
      sync();
      return;
    }
    state.status = "";
    state.error = "";
    try {
      const { costUSD } = await autoSegmentGloss(
        { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model },
        s.target,
        sentence
      );
      s.costUsedUSD = +(s.costUsedUSD + costUSD).toFixed(4);
      save();
      state.error = "";
    } catch (e) {
      state.error = `AI 释义失败：${(e as Error).message}`;
    }
    sync();
    return;
  }
  if (!state.pack) return;
  const est = estimateCostUSD(sentence, sentence);
  if (s.costUsedUSD + est > s.costCapUSD) {
    state.error = `费用将超上限（${formatUSD(s.costUsedUSD)} + ~${formatUSD(est)} > $${s.costCapUSD}），已拦截。`;
    sync();
    return;
  }
  state.status = "";
  state.error = "";
  try {
    const lemmas = [
      ...new Set(
        state.pack
          .segment(sentence)
          .map((t) => state.pack!.lemmatize(t))
          .filter((l) => /[\p{L}]/u.test(l))
          .slice(0, 40)
      ),
    ];
    const { glossSentence } = await import("../llm/provider.js");
    const { costUSD } = await glossSentence(
      { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model },
      lang,
      s.target,
      sentence,
      lemmas
    );
    s.costUsedUSD = +(s.costUsedUSD + costUSD).toFixed(4);
    save();
    state.error = "";
  } catch (e) {
    state.error = `AI 释义失败：${(e as Error).message}`;
  }
  sync();
}

// ---------------- 点词详情 ----------------

function showSheet(
  main: HTMLElement,
  lang: SourceLang,
  t: Token,
  sentence: string,
  sync: () => void
): void {
  main.querySelector(".sheet")?.remove();
  const s = state.settings;
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  // 对话语义：屏读能宣告“词详情”并拿到焦点；Esc 关闭，关闭后焦点回到正文。
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", `词详情：${t.surface}`);
  sheet.tabIndex = -1;
  const opener = document.activeElement as HTMLElement | null;
  const closeSheet = (): void => {
    sheet.remove();
    try {
      opener?.focus?.();
    } catch {
      // ignore
    }
  };
  sheet.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      closeSheet();
    }
  });
  const known = isKnown(lang, t.lemma);
  const glossBlock =
    t.glosses && t.glosses.length > 1
      ? `<ol class="kv gloss-all">${t.glosses.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ol>`
      : `<div class="kv">释义：<b>${escapeHtml(t.gloss ?? "（词典缺词）")}</b> <span class="src-tag">${t.glossSource ?? ""}</span></div>`;
  sheet.innerHTML =
    `<h3 lang="${lang === "auto" ? "" : lang}">${escapeHtml(t.surface)}</h3>` +
    `<div class="kv muted">lemma: ${escapeHtml(t.lemma)}${t.stopword ? " · 停用词" : ""}${known ? " · 已认识" : ""}</div>` +
    glossBlock +
    `<div class="kv muted sheet-sentence">${escapeHtml(sentence.slice(0, 120))}</div>`;
  const row = document.createElement("div");
  row.className = "row";

  const knownBtn = document.createElement("button");
  knownBtn.type = "button";
  knownBtn.textContent = known ? "标为不认识" : "认识了 ✓";
  knownBtn.addEventListener("click", () => {
    setKnown(lang, t.lemma, !known);
    sheet.remove();
    sync();
  });
  const vocabBtn = document.createElement("button");
  vocabBtn.type = "button";
  vocabBtn.textContent = "+ 生词本";
  vocabBtn.addEventListener("click", () => {
    addVocab({
      lemma: t.lemma,
      lang,
      gloss: t.gloss ?? "",
      sentence,
      addedAt: Date.now(),
      known: false,
    });
    vocabBtn.textContent = "已加入 ✓";
  });
  const aiBtn = document.createElement("button");
  aiBtn.type = "button";
  aiBtn.className = "primary";
  aiBtn.textContent = "✦ AI 释义";
  // Auto 万能强制走 LLM：B 模式亦不禁用；非 Auto 保持 B 禁用。
  const autoSheet = lang === "auto";
  aiBtn.disabled = s.mode === Mode.B && !autoSheet;
  aiBtn.title = autoSheet
    ? "Auto 万能点词 LLM（纯 LLM 费用）"
    : s.mode === Mode.B
      ? "B 模式不调 LLM"
      : "Mode A 点词 LLM";
  aiBtn.addEventListener("click", async () => {
    aiBtn.disabled = true;
    aiBtn.textContent = "查询中…";
    await explainSentence(lang, sentence, () => undefined);
    sheet.remove();
    sync();
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "ghost";
  close.textContent = "关闭";
  close.addEventListener("click", closeSheet);
  row.append(knownBtn, vocabBtn, aiBtn, close);
  sheet.appendChild(row);
  main.appendChild(sheet);
  try {
    sheet.focus({ preventScroll: true });
  } catch {
    // ignore
  }
}

// ---------------- 生词本 ----------------

function renderVocab(main: HTMLElement, sync: () => void): void {
  const list = listVocab();
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = '<h2 class="card-title">生词本</h2>';
  const row = document.createElement("div");
  row.className = "row";
  const exp = document.createElement("button");
  exp.type = "button";
  exp.textContent = "导出 JSON";
  exp.addEventListener("click", () => {
    const blob = new Blob([exportVocabJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "vocab.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  const count = document.createElement("span");
  count.className = "muted";
  count.textContent = `共 ${list.length} 条（localStorage+IndexedDB 镜像，刷新不丢）`;
  row.append(exp, count);
  card.appendChild(row);
  main.appendChild(card);

  if (list.length === 0) {
    const d = document.createElement("div");
    d.className = "empty";
    d.innerHTML =
      `<div class="empty-mark" aria-hidden="true">📝</div>` +
      `<strong>生词本还是空的</strong>` +
      `<div class="muted">阅读时点一个词，在弹出的词详情里选“+ 生词本”，就会出现在这里。</div>`;
    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "去阅读";
    go.addEventListener("click", () => {
      state.tab = "reader";
      sync();
    });
    d.appendChild(go);
    main.appendChild(d);
    return;
  }
  const listWrap = document.createElement("div");
  listWrap.className = "card vocab-list";
  for (const v of list.slice(0, 300)) {
    const d = document.createElement("div");
    d.className = "vocab-item";
    d.innerHTML =
      `<div class="vocab-head"><b lang="${v.lang === "auto" ? "" : v.lang}">${escapeHtml(v.lemma)}</b>` +
      `<span class="badge">${v.lang}</span>` +
      `<span class="vocab-gloss">${escapeHtml(v.gloss)}</span></div>` +
      `<div class="muted">${escapeHtml(v.sentence.slice(0, 100))}</div>`;
    const row2 = document.createElement("div");
    row2.className = "row";
    const k = document.createElement("button");
    k.type = "button";
    k.textContent = isKnown(v.lang, v.lemma) ? "已认识 ✓" : "标为认识";
    k.setAttribute("aria-pressed", String(isKnown(v.lang, v.lemma)));
    k.addEventListener("click", () => {
      setKnown(v.lang, v.lemma, !isKnown(v.lang, v.lemma));
      sync();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      removeVocab(v.lang, v.lemma);
      sync();
    });
    row2.append(k, del);
    d.appendChild(row2);
    listWrap.appendChild(d);
  }
  main.appendChild(listWrap);
}

// ---------------- 设置 ----------------

function renderSettings(main: HTMLElement, sync: () => void): void {
  const s = state.settings;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2 class="card-title">LLM（OpenAI 兼容）</h2><div class="muted">只做 OpenAI 兼容协议；Response API 首版不做。key 只存浏览器 localStorage，浏览器直调。</div>`;

  // 字段：<label> 包住控件（隐式关联，屏读可报名），样式全在 .field 里
  const field = (label: string, input: HTMLElement): HTMLElement => {
    const l = document.createElement("label");
    l.className = "field";
    const sp = document.createElement("span");
    sp.textContent = label;
    l.append(sp, input);
    return l;
  };
  const base = document.createElement("input");
  base.type = "url";
  base.value = s.baseUrl;
  base.placeholder = "https://api.openai.com/v1";
  base.addEventListener("change", () => {
    s.baseUrl = base.value.trim() || s.baseUrl;
    save();
    state.error = "";
    sync();
  });
  const key = document.createElement("input");
  key.type = "password";
  key.value = s.apiKey;
  key.placeholder = "sk-…（仅 localStorage）";
  key.autocomplete = "off";
  key.addEventListener("change", () => {
    s.apiKey = key.value.trim();
    save();
    state.error = "";
    sync();
  });
  const model = document.createElement("input");
  model.type = "text";
  model.value = s.model;
  model.addEventListener("change", () => {
    s.model = model.value.trim() || s.model;
    save();
    state.error = "";
    sync();
  });
  const keyWarning = document.createElement("div");
  keyWarning.className = "muted";
  keyWarning.id = "api-key-security-warning";
  keyWarning.innerHTML =
    "<strong>⚠️ 密钥安全：本程序无法从技术上防御本机恶意软件。</strong><br>密钥保存在浏览器 localStorage 中；能访问你电脑的恶意程序或恶意浏览器扩展可能窃取它并耗尽余额。建议使用设置了消费限额/低余额的专用密钥，在服务商后台 Usage / Billing / Limits 设置额度（预算提醒不一定是硬限额）；定期轮换，发现异常立即在服务商后台吊销。";
  key.setAttribute("aria-describedby", keyWarning.id);
  card.append(
    field("Base URL", base),
    field("API Key（只存本机）", key),
    keyWarning,
    field("Model", model)
  );

  const row = document.createElement("div");
  row.className = "row";
  const test = document.createElement("button");
  test.type = "button";
  test.textContent = "测试连接";
  const testMsg = document.createElement("span");
  testMsg.className = "muted";
  testMsg.setAttribute("role", "status");
  test.addEventListener("click", async () => {
    testMsg.textContent = "连接中…";
    try {
      testMsg.textContent = await testConnection({
        baseUrl: s.baseUrl,
        apiKey: s.apiKey,
        model: s.model,
      });
    } catch (e) {
      testMsg.textContent = (e as Error).message;
    }
  });
  const clearKey = document.createElement("button");
  clearKey.type = "button";
  clearKey.className = "danger";
  clearKey.textContent = "清除 Key";
  clearKey.addEventListener("click", () => {
    s.apiKey = "";
    save();
    sync();
  });
  row.append(test, clearKey, testMsg);
  card.appendChild(row);
  main.appendChild(card);

  // 模型质量自测（金标 7 语）：内置难句+参考只放内存，不渲染原文/参考（防抄）。
  // 用当前 baseUrl/model 跑 glossBatch，本地规则判分，输出 verdict+分项+换模型建议。
  {
    const qcard = document.createElement("div");
    qcard.className = "card";
    const title = document.createElement("h2");
    title.className = "card-title";
    title.textContent = "模型质量自测（金标 7 语）";
    const desc = document.createElement("div");
    desc.className = "muted";
    desc.textContent =
      "内置 7 段难句（en/de/fr/it/es/ru/ja）+参考释义，用当前 Base URL/Model 跑 glossBatch，本地判分。原文与参考不展示，结果仅分数与建议。约 7 次请求。";
    qcard.append(title, desc);

    const qrow = document.createElement("div");
    qrow.className = "row";
    const qbtn = document.createElement("button");
    qbtn.type = "button";
    qbtn.className = "primary";
    qbtn.setAttribute("data-testid", "quality-test");
    qbtn.textContent = "测模型质量";
    const judgeLabel = document.createElement("label");
    judgeLabel.className = "set";
    const judgeBox = document.createElement("input");
    judgeBox.type = "checkbox";
    judgeBox.checked = false;
    judgeBox.setAttribute("data-testid", "quality-judge");
    judgeLabel.append(judgeBox, document.createTextNode("强模型复核（默认关，无二次花费）"));
    qrow.append(qbtn, judgeLabel);
    qcard.appendChild(qrow);

    const qres = document.createElement("div");
    qres.className = "muted result-block";
    qres.setAttribute("data-testid", "quality-result");
    qres.setAttribute("role", "status");
    qres.setAttribute("data-verdict", "untested");
    qres.textContent = "未测试：点击上方按钮，用当前模型跑 7 语金标。";
    qcard.appendChild(qres);

    qbtn.addEventListener("click", () => {
      qbtn.disabled = true;
      const prev = qbtn.textContent;
      qbtn.textContent = "测试中…（约 7 次请求）";
      qres.setAttribute("data-verdict", "running");
      qres.textContent = "测试中…逐语调用当前模型，请稍候。";
      const cfg = { baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model };
      const judgeEnabled = judgeBox.checked;
      void import("../llm/quality.js")
        .then((m) => m.runQualityTest(cfg, fetch, { judgeEnabled }))
        .then((r) => {
          const pct = (x: number): string => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
          qres.setAttribute("data-verdict", r.pass ? "pass" : "fail");
          qres.innerHTML = "";
          const v = document.createElement("div");
          v.textContent = `${r.verdict} · 综合 ${pct(r.overall)}（命中 ${pct(r.hitAvg)} / 中文 ${pct(r.langAvg)} / 干净 ${pct(r.cleanAvg)}）· ${r.model} · ${(r.latencyMs / 1000).toFixed(1)}s；`;
          const per = document.createElement("div");
          per.textContent = r.perLang
            .map(
              (p) =>
                `${p.lang} 命中${p.hits}/${p.total} 中文${pct(p.langScore)} 干净${pct(p.cleanScore)} ${pct(p.score)}${p.error ? `（错：${p.error}）` : ""}`
            )
            .join("；");
          const sug = document.createElement("div");
          sug.textContent = `建议：${r.suggestion}`;
          const judge = document.createElement("div");
          judge.textContent = r.judgeNote;
          qres.append(v, per, sug, judge);
        })
        .catch((e) => {
          qres.setAttribute("data-verdict", "error");
          qres.textContent = `测试失败：${(e as Error).message}`;
        })
        .finally(() => {
          qbtn.disabled = false;
          if (prev != null) qbtn.textContent = prev;
        });
    });
    main.appendChild(qcard);
  }

  const card2 = document.createElement("div");
  card2.className = "card";
  card2.innerHTML = `<h2 class="card-title">阅读</h2>`;
  const mkCheck = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => {
    const l = document.createElement("label");
    l.className = "set";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = get();
    c.addEventListener("change", () => {
      set(c.checked);
      save();
      sync();
    });
    l.append(c, document.createTextNode(label));
    return l;
  };
  const tgtSel = document.createElement("select");
  for (const t of TARGET_LANGS) {
    const o = document.createElement("option");
    o.value = t;
    o.textContent = t === "zh" ? "中文" : "English";
    tgtSel.appendChild(o);
  }
  tgtSel.value = s.target;
  tgtSel.addEventListener("change", () => {
    s.target = tgtSel.value as Settings["target"];
    save();
    sync();
  });
  const modeSel = document.createElement("select");
  modeSel.setAttribute("data-testid", "mode-switch");
  for (const m of [Mode.A, Mode.B, Mode.C]) {
    const o = document.createElement("option");
    o.value = modeToContractValue(m);
    o.textContent = m === Mode.A ? "A·词典+点查（默认）" : m === Mode.B ? "B·纯词典" : "C·整章LLM";
    modeSel.appendChild(o);
  }
  modeSel.value = modeToContractValue(s.mode);
  modeSel.addEventListener("change", () => {
    s.mode = modeFromContractValue(modeSel.value) ?? Mode.A;
    save();
    sync();
  });
  card2.append(
    field("目标语言（ZH+EN 可切换）", tgtSel),
    field("模式 A/B/C", modeSel),
    mkCheck(
      "隐藏停用词释义",
      () => s.hideStopwords,
      (v) => (s.hideStopwords = v)
    ),
    mkCheck(
      "隐藏已认识词释义",
      () => s.hideKnown,
      (v) => (s.hideKnown = v)
    ),
    mkCheck(
      "全书术语表（整书一次，提升专名/术语一致性）",
      () => s.bookGlossary,
      (v) => (s.bookGlossary = v)
    )
  );
  const capRow = document.createElement("div");
  capRow.className = "row";
  const cap = document.createElement("input");
  cap.type = "number";
  cap.min = "0";
  cap.step = "1";
  cap.value = String(s.costCapUSD);
  cap.className = "num";
  cap.setAttribute("aria-label", "费用上限（美元）");
  cap.addEventListener("change", () => {
    s.costCapUSD = Math.max(0, Number(cap.value) || 0);
    save();
    sync();
  });
  const used = document.createElement("span");
  used.className = "muted";
  used.textContent = `费用上限 $（已用 ${formatUSD(s.costUsedUSD)}）`;
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "清零已用";
  reset.addEventListener("click", () => {
    s.costUsedUSD = 0;
    save();
    sync();
  });
  capRow.append("上限", cap, used, reset);
  card2.appendChild(capRow);

  const pgRow = document.createElement("div");
  pgRow.className = "row";
  const pg = document.createElement("input");
  pg.type = "number";
  pg.min = "5";
  pg.max = "100";
  pg.value = String(s.pageSize);
  pg.className = "num";
  pg.setAttribute("aria-label", "每页段落数");
  pg.addEventListener("change", () => {
    s.pageSize = Math.max(5, Math.min(100, Number(pg.value) || 20));
    save();
    sync();
  });
  const pgHint = document.createElement("span");
  pgHint.className = "muted";
  pgHint.textContent = "每页段落数（长章分页，不一次全渲染）";
  pgRow.append("分页", pg, pgHint);
  card2.appendChild(pgRow);

  // 导出 EPUB（设置页入口，与阅读页按钮同逻辑；无 key 纯词典，有 key 可回填）。
  const expRow = document.createElement("div");
  expRow.className = "row";
  const expBtn = document.createElement("button");
  expBtn.type = "button";
  expBtn.setAttribute("data-testid", "export-epub-settings");
  expBtn.textContent = state.book
    ? `导出 EPUB（${state.book.chapters.length} 章）`
    : "导出 EPUB（无书）";
  expBtn.disabled = !state.book;
  expBtn.title = s.apiKey ? "含词典注出 + 缺词 LLM 回填" : "无 key：纯词典导出";
  expBtn.addEventListener("click", () => {
    expBtn.disabled = true;
    const prev = expBtn.textContent;
    expBtn.textContent = "导出中…";
    void exportCurrentBookAsEpub()
      .catch((e) => {
        state.error = `导出失败：${(e as Error).message}`;
      })
      .finally(() => {
        expBtn.disabled = !state.book;
        expBtn.textContent = prev;
        sync();
      });
  });
  const expHint = document.createElement("span");
  expHint.className = "muted";
  expHint.textContent = s.apiKey
    ? "有 key：词典 + LLM 回填对照（小字括号）"
    : "无 key：纯词典对照导出，去上方填 key 可回填";
  expRow.append(expBtn, expHint);
  card2.appendChild(expRow);
  main.appendChild(card2);

  const danger = document.createElement("div");
  danger.className = "card";
  danger.innerHTML =
    '<h2 class="card-title">本地数据</h2>' +
    '<div class="muted">设置 / key / 生词 / 缓存全存在这台浏览器里，没有服务端副本。清空后不可恢复。</div>';
  const wipe = document.createElement("button");
  wipe.type = "button";
  wipe.className = "danger";
  wipe.textContent = "清空本地数据（设置/key/生词/缓存）";
  wipe.addEventListener("click", () => {
    if (!confirm("清空本机所有 interlinear 数据？")) return;
    for (const k of Object.keys(localStorage)) if (k.startsWith("ilr.")) localStorage.removeItem(k);
    location.reload();
  });
  const dangerRow = document.createElement("div");
  dangerRow.className = "row";
  dangerRow.appendChild(wipe);
  danger.appendChild(dangerRow);
  main.appendChild(danger);

  const about = document.createElement("section");
  about.className = "card";
  about.setAttribute("data-testid", "about-third-party");
  about.innerHTML = `<h2 class="card-title">关于 · 第三方代码</h2>
    <p class="muted">感谢以下开源项目。JSZip 双许可为 MIT 或 GPLv3；本项目选择 MIT。</p>
    <ul>
      <li><a href="https://github.com/johnfactotum/foliate-js" target="_blank" rel="noopener noreferrer">Foliate.js</a> — MIT；vendored mobi.js，1.0.1，KF8 HTML 容错回退修改。</li>
      <li><a href="https://github.com/Stuk/jszip" target="_blank" rel="noopener noreferrer">JSZip</a> — MIT（可选 GPLv3）；EPUB ZIP 读写。</li>
      <li><a href="https://github.com/markedjs/marked" target="_blank" rel="noopener noreferrer">marked</a> — MIT；Markdown 解析。</li>
      <li><a href="https://github.com/nodeca/pako" target="_blank" rel="noopener noreferrer">pako</a> — MIT / Zlib；JSZip 内含的压缩实现。</li>
      <li>JSZip 内含运行时辅助代码：<a href="https://github.com/calvinmetcalf/lie" target="_blank" rel="noopener noreferrer">lie</a>、<a href="https://github.com/calvinmetcalf/immediate" target="_blank" rel="noopener noreferrer">immediate</a>、<a href="https://github.com/YuzuJS/setImmediate" target="_blank" rel="noopener noreferrer">setImmediate</a>、<a href="https://github.com/nodejs/readable-stream" target="_blank" rel="noopener noreferrer">readable-stream</a>（MIT）。</li>
    </ul>
    <p class="muted">Foliate 完整 MIT 声明随 MOBI 解析代码发布，并在导入时输出到浏览器控制台。源码仓库中的 FOLIATE-MOBI-LICENSE.md 记录来源与分发要求。</p>`;
  main.appendChild(about);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}
