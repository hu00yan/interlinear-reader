import { Mode, type LanguagePack, type SourceLang, type TargetLang, type Token } from "../types.js";
import { getGlossesWithSource, isProperNounSurface } from "../dict/dict-loader.js";
import { tokenizeParagraph } from "./tokenize.js";
import { paragraphFreqRank, shouldShowGloss, type FilterSettings } from "./filters.js";

/** Track A 内部模式（A/B/C 大写）-> CONTRACT 持久化/选择器口径（a/b/c 小写）。CONTRACT.md 不动，此处只做映射。 */
export function modeToContract(mode: Mode): "a" | "b" | "c" {
  return mode === Mode.B ? "b" : mode === Mode.C ? "c" : "a";
}

/** 段落注释结果 */
export interface AnnotatedParagraph {
  text: string;
  tokens: Token[];
  /** Presentation-only image; tokens stay empty, never annotated. */
  image?: { src: string; alt: string; height: number };
}

/** 词典全注一章中的一页（Mode A/B 公用；Mode C 由调用方传入 llm 覆盖）
 *
 * 性能口径：旧实现对每段 Promise.all 逐词查（400 段 = 400 次微任务批 + 每词一次
 * cacheSet），整章实测 231ms，其中词典匹配 <1ms、缓存写 ~55%、调度/GC ~26%。
 * 现改为「先全章 tokenize → 全局去重 lemma → 一次批量查 → 回填」，同章实测 ~48ms
 * （配合 cache.ts 的 Map LRU 后为个位数十毫秒级）。纯查询路径，无 IO。 */
export async function annotateParagraphs(
  pack: LanguagePack,
  lang: SourceLang,
  target: TargetLang,
  paragraphs: string[],
  isKnown: (lemma: string) => boolean,
  llmOverride?: Map<string, Record<string, string>> // paragraph text -> lemma->gloss
): Promise<AnnotatedParagraph[]> {
  // 1) 全章 tokenize（同步），并按 lemma 全局去重、记首见 surface
  const out: AnnotatedParagraph[] = paragraphs.map((text) => ({
    text,
    tokens: tokenizeParagraph(pack, lang, text, isKnown),
  }));
  const uniq = new Map<string, string>();
  for (const p of out) {
    for (const t of p.tokens) if (t.isWord && !uniq.has(t.lemma)) uniq.set(t.lemma, t.surface);
  }
  // 2) 一次批量查（含 bridge/mock 回退与来源标注）
  const dict = uniq.size
    ? await getGlossesWithSource(lang, target, [...uniq.keys()], [...uniq.values()])
    : new Map();
  // 3) 回填：LLM override 优先，其次词典
  for (const p of out) {
    const llm = llmOverride?.get(p.text);
    for (const t of p.tokens) {
      if (!t.isWord) continue;
      const l =
        llm?.[t.lemma] ??
        llm?.[t.lemma.toLowerCase()] ??
        // surface 回退：词典包过剥形（borborygmus→borborygmu）与模型回写的自然形不一致时兜底
        llm?.[t.surface] ??
        llm?.[t.surface.toLowerCase()];
      if (l) {
        t.gloss = l;
        t.glossSource = "llm";
      } else {
        const d = dict.get(t.lemma);
        if (d?.gloss) {
          t.gloss = d.gloss;
          // 缓存命中记 cache，词典分片/mock 首命中记 dict（B5：此前全部误标 cache）
          t.glossSource = d.source;
          if (d.glosses.length > 1) t.glosses = d.glosses;
        }
      }
    }
  }
  return out;
}

export interface RenderOpts {
  mode: Mode;
  showGloss: boolean;
  filters: FilterSettings;
  /** 点击 token 回调（app 层弹详情/调 LLM） */
  onTokenClick: (t: Token, sentence: string, el: HTMLElement) => void;
  /** 每段落“AI 释义”按钮回调（Mode A 点句 / Mode C 重试） */
  onSentenceAI: (sentence: string, paraIndex: number) => void;
  showAIButton: boolean;
  /** 源语言（专名豁免标记用；缺省 en；仅 en 首字母大写判专名，de 全名词大写不判） */
  lang?: SourceLang;
  /**
   * 测量模式（隐藏探针用，视觉无差）：
   * - 词 token 照常 .tok，另打 data-pi/data-ti；
   * - 非词文本包一层 span.wsep（display:inline，无样式），同样打 data-pi/data-ti，
   *   使每个 token 边界都可被 getBoundingClientRect 定位；行断裂与纯文本节点一致。
   */
  measure?: boolean;
}

/** 章节流中的一段 token 区间（renderSlices 用）：para 为 flow 数组下标，[from, to) 为 token 下标 */
export interface ParaSlice {
  para: number;
  from: number;
  to: number;
}

/**
 * 把 token 的释义状态写进已存在的 `.tok`/`.gloss` 节点（渲染与就地回填共用）。
 * 根因：LLM 回填后只换了 gloss 文本，旧实现整页 paintColumns() 重建 DOM；
 * 抽成纯更新函数后 patchGlosses 可只改有变化的节点，翻页/回填不再闪整页。
 */
function applyGlossState(
  w: HTMLElement,
  gl: HTMLElement,
  t: Token,
  show: boolean,
  lang: SourceLang
): void {
  w.classList.toggle("from-llm", t.glossSource === "llm");
  gl.classList.toggle("hidden-gloss", !show);
  if (!t.gloss) {
    gl.classList.add("missing");
    gl.textContent = "—";
    // 专名豁免标记（Westminster/Confession/Neumann/WeWork）：仍 .missing（B 契约零 LLM 不变），
    // 另加 .proper + 专名 title，notice 拆分“其中专名 N 个”且总数对上 DOM。
    if (isProperNounSurface(lang, t.surface)) {
      w.classList.add("proper");
      gl.classList.add("proper");
      gl.title = "专名（首字母大写），词典无收录，原形保留：可点词用 LLM 确认（A 模式需 key）";
    } else {
      w.classList.remove("proper");
      gl.classList.remove("proper");
      gl.title = "未找到词典释义：点击单词可用 AI 查询";
    }
    return;
  }
  w.classList.remove("proper");
  gl.classList.remove("proper", "missing");
  gl.textContent = show ? t.gloss : "···";
  gl.title = t.glossSource === "llm" ? "LLM 释义（含缺词回填，专名原样返回）" : "词典释义";
}

/** 单段渲染（含分片）：分片只影响首尾 padding/边框（与探针全段盒模型对齐），不拆散任何 .tok */
function renderOnePara(
  doc: Document,
  para: AnnotatedParagraph,
  pi: number,
  from: number,
  to: number,
  opts: RenderOpts
): HTMLElement {
  if (para.image) {
    // A fixed, contained image slot is identical in probe and page. Loading the
    // natural bitmap cannot shift pagination; tall illustrations are never cropped.
    const figure = doc.createElement("figure");
    figure.className = "reader-image";
    figure.dataset.pi = String(pi);
    figure.dataset.ti = "0";
    figure.style.cssText = `display:block;margin:0;padding:0;height:${para.image.height}px;width:100%;`;
    const img = doc.createElement("img");
    img.src = para.image.src;
    img.alt = para.image.alt;
    img.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;";
    figure.appendChild(img);
    return figure;
  }
  const total = para.tokens.length;
  const s = Math.max(0, Math.min(from, total));
  const e = Math.max(s, Math.min(to, total));
  const whole = s <= 0 && e >= total;
  const p = doc.createElement("div");
  p.className =
    "para" + (whole ? "" : ` frag${s > 0 ? " cont-top" : ""}${e < total ? " cont-bottom" : ""}`);
  p.setAttribute("data-pi", String(pi));
  const rank = paragraphFreqRank(para.tokens);
  for (let ti = s; ti < e; ti++) {
    const t = para.tokens[ti];
    if (!t.isWord) {
      if (opts.measure) {
        const sep = doc.createElement("span");
        sep.className = "wsep";
        sep.setAttribute("data-pi", String(pi));
        sep.setAttribute("data-ti", String(ti));
        sep.textContent = t.surface;
        p.appendChild(sep);
      } else {
        p.appendChild(doc.createTextNode(t.surface));
      }
      continue;
    }
    const w = doc.createElement("span");
    w.className = "tok token" + (t.known ? " known" : "") + (t.stopword ? " stop" : "");
    w.setAttribute("data-term", t.lemma);
    // data-pi/data-ti 常驻（探针定位 + 回填后就地 patch 释义，免整页重画）
    w.setAttribute("data-pi", String(pi));
    w.setAttribute("data-ti", String(ti));
    if (t.glossSource === "llm") w.classList.add("from-llm");
    const surf = doc.createElement("span");
    surf.className = "surface";
    surf.textContent = t.surface;
    w.appendChild(surf);
    const gl = doc.createElement("span");
    gl.className = "gloss";
    const show = opts.showGloss && shouldShowGloss(t, opts.filters, rank);
    applyGlossState(w, gl, t, show, opts.lang ?? "en");
    w.appendChild(gl);
    w.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const root = p.parentElement;
      root
        ?.querySelectorAll(".tok.selected, .token.tapped")
        .forEach((n) => n.classList.remove("selected", "tapped"));
      w.classList.add("selected", "tapped");
      opts.onTokenClick(t, para.text, w);
    });
    p.appendChild(w);
    // 原文空白/标点由 pack.segment 的间隔 token（isWord=false）原样带出；只有当下一个
    // token 仍是词（分词包吞掉了间隔，如宽松实现）时才补一个空格，避免与原文空白重复。
    const next = para.tokens[ti + 1];
    if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(t.surface) && (!next || next.isWord)) {
      p.appendChild(doc.createTextNode(" "));
    }
  }
  // AI 按钮只跟段尾走（分片时归属含段尾的那一页；探针与真实渲染同规则，高度一致）。
  // 测量模式下按钮同样打标（data-ai），探针把它并入上一行行高——否则按钮独占一行时
  // 真实列比探针高出一整行（短段落每段一个按钮，满页可溢出数十 px）。
  if (opts.showAIButton && e >= total) {
    const btn = doc.createElement("button");
    btn.className = "ai-btn";
    btn.textContent = "✦ 释义本句";
    if (opts.measure) {
      btn.setAttribute("data-pi", String(pi));
      btn.setAttribute("data-ti", String(total));
      btn.setAttribute("data-ai", "1");
    }
    btn.addEventListener("click", () => opts.onSentenceAI(para.text, pi));
    p.appendChild(btn);
  }
  return p;
}

/** Interlinear DOM：词 inline-block，上原文下小字释义；长章由调用方分页，只渲染当前页 */
export function renderParagraphs(
  container: HTMLElement,
  paras: AnnotatedParagraph[],
  opts: RenderOpts
): void {
  container.innerHTML = "";
  // CONTRACT 选择器口径（只加不改：老 .tok/.selected 保留，新 .token[data-term] 并存）：
  // reader root -> [data-testid="reader"] + data-mode="a|b|c"；token -> .token[data-term]；gloss -> .gloss。
  container.setAttribute("data-testid", "reader");
  container.setAttribute("data-mode", modeToContract(opts.mode));
  const doc = container.ownerDocument;
  paras.forEach((para, pi) => {
    container.appendChild(renderOnePara(doc, para, pi, 0, para.tokens.length, opts));
  });
}

/**
 * 分片渲染：按 slices 渲染 flow 中的 token 区间（同一段可拆到两页，.tok 永不拆散）。
 * - 同一段的多个 slice 按顺序渲染；空段（0 token）渲染空盒（占位高度与探针一致）。
 * - onSentenceAI 收到的 paraIndex 为 flow 下标（调用方负责映射回章节）。
 */
export function renderSlices(
  container: HTMLElement,
  flow: AnnotatedParagraph[],
  slices: ParaSlice[],
  opts: RenderOpts
): void {
  container.innerHTML = "";
  container.setAttribute("data-testid", "reader");
  container.setAttribute("data-mode", modeToContract(opts.mode));
  const doc = container.ownerDocument;
  const byPara = new Map<number, Array<{ from: number; to: number }>>();
  for (const s of slices) {
    const list = byPara.get(s.para) ?? [];
    list.push({ from: s.from, to: s.to });
    byPara.set(s.para, list);
  }
  const order = [...byPara.keys()].sort((a, b) => a - b);
  for (const pi of order) {
    const para = flow[pi];
    if (!para) continue;
    const list = (byPara.get(pi) ?? []).sort((a, b) => a.from - b.from);
    if (!list.length) continue;
    // 空段：token 为空时 from/to 全 0，仍需空盒占位（探针侧同高）
    if (para.tokens.length === 0) {
      container.appendChild(renderOnePara(doc, para, pi, 0, 0, opts));
      continue;
    }
    for (const r of list) {
      if (r.to <= r.from) continue;
      container.appendChild(renderOnePara(doc, para, pi, r.from, r.to, opts));
    }
  }
}

/**
 * 就地回填释义（增量重绘）：按已渲染 `.tok[data-pi][data-ti]` 找到对应 token，
 * 只更新有变化的 `.gloss` 文本/类名，不重建 DOM、不丢选中态、不闪整页。
 * 与 renderSlices 共用同一套 token 下标，故跨页分片（frag）也能各自命中。
 */
export function patchGlosses(
  container: HTMLElement,
  flow: AnnotatedParagraph[],
  opts: Pick<RenderOpts, "showGloss" | "filters" | "lang">
): void {
  const ranks = new Map<number, Map<string, number>>();
  container.querySelectorAll<HTMLElement>(".tok[data-pi][data-ti]").forEach((w) => {
    const pi = Number(w.dataset.pi);
    const ti = Number(w.dataset.ti);
    const para = flow[pi];
    const t = para?.tokens[ti];
    if (!t || !t.isWord) return;
    const gl = w.querySelector<HTMLElement>(".gloss");
    if (!gl) return;
    let rank = ranks.get(pi);
    if (!rank) {
      rank = paragraphFreqRank(para.tokens);
      ranks.set(pi, rank);
    }
    const show = opts.showGloss && shouldShowGloss(t, opts.filters, rank);
    applyGlossState(w, gl, t, show, opts.lang ?? "en");
  });
}

/** 点击显隐：切换整页释义（app 层改 settings.showGloss 后重渲染即可，此为单段折叠辅助） */
export function toggleParagraphGloss(paraEl: HTMLElement, show: boolean): void {
  paraEl.querySelectorAll(".gloss").forEach((g) => g.classList.toggle("hidden-gloss", !show));
}
