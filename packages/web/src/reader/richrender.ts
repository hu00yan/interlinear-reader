import {
  Mode,
  type Book,
  type BookChapter,
  type LanguagePack,
  type SourceLang,
  type Token,
} from "../types.js";
import { tokenizeParagraph } from "./tokenize.js";
import { paragraphFreqRank, shouldShowGloss, type FilterSettings } from "./filters.js";
import { applyGlossState, modeToContract, type AnnotatedParagraph } from "./render.js";

export interface RichRenderOpts {
  mode: Mode;
  showGloss: boolean;
  filters: FilterSettings;
  lang: SourceLang;
  showAIButton: boolean;
  onTokenClick: (t: Token, sentence: string, el: HTMLElement) => void;
  onSentenceAI: (sentence: string, paraIndex: number) => void;
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 行内块级文本容器：这些元素的文本节点会被注入逐词释义 span。 */
const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, li, blockquote, td, th, dt, dd, figcaption, pre";

/** 书 CSS 的 body 选择器改成容器类，防止连坐全局 body 样式。 */
export function scopeBookStyles(css: string): string {
  return css
    .replace(/\bbody\b/g, ".rich-doc")
    .replace(/@import[^;]+;/g, "")
    .replace(/url\((['"]?)[^)'"]+\1\)/g, "url(about:blank)");
}

interface TextPiece {
  node: Text;
  start: number;
}

/** 把一个 token 覆盖的文本区间替换成 .tok > .surface + .gloss（跨节点拆成多份，各自带释义）。 */
function wrapTokenRange(
  pieces: TextPiece[],
  doc: Document,
  from: number,
  to: number,
  t: Token,
  pi: number,
  ti: number,
  sentence: string,
  opts: RichRenderOpts,
  rankMap: Map<string, number>
): void {
  let part = 0;
  for (const piece of pieces) {
    const len = piece.node.nodeValue?.length ?? 0;
    const pieceEnd = piece.start + len;
    if (pieceEnd <= from) continue;
    const cutStart = Math.max(0, from - piece.start);
    const cutEnd = Math.min(len, to - piece.start);
    if (cutEnd <= cutStart) continue;
    const isFirst = part === 0;
    const splitsMore = to > pieceEnd;
    const target = piece.node;
    const after = target.splitText(cutEnd);
    const mid = cutStart > 0 ? target.splitText(cutStart) : target;
    const wrap = doc.createElement("span");
    wrap.className =
      "tok token" +
      (t.known ? " known" : "") +
      (t.stopword ? " stop" : "") +
      (isFirst ? "" : " cont") +
      (isFirst && splitsMore ? " split-start" : "");
    wrap.setAttribute("data-term", t.lemma);
    wrap.setAttribute("data-pi", String(pi));
    wrap.setAttribute("data-ti", String(ti));
    if (t.glossSource === "llm") wrap.classList.add("from-llm");
    const surf = doc.createElement("span");
    surf.className = "surface";
    surf.textContent = mid.nodeValue;
    wrap.appendChild(surf);
    const gl = doc.createElement("span");
    gl.className = "gloss";
    applyGlossState(
      wrap,
      gl,
      t,
      opts.showGloss && shouldShowGloss(t, opts.filters, rankMap),
      opts.lang
    );
    wrap.appendChild(gl);
    wrap.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const root = wrap.closest(".rich-doc");
      root
        ?.querySelectorAll(".tok.selected, .token.tapped")
        .forEach((n) => n.classList.remove("selected", "tapped"));
      wrap.classList.add("selected", "tapped");
      opts.onTokenClick(t, sentence, wrap);
    });
    mid.parentNode?.replaceChild(wrap, mid);
    piece.node = after;
    piece.start = piece.start + cutEnd;
    from = Math.max(from, piece.start);
    part++;
    if (from >= to) break;
  }
}

/** 逐词注入：按 token 的 surface 在块级文本中顺序消费对齐（空白容忍）。 */
function injectTokensIntoBlock(
  doc: Document,
  block: Element,
  para: AnnotatedParagraph,
  pi: number,
  opts: RichRenderOpts
): void {
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const pieces: TextPiece[] = [];
  let n: Node | null;
  let offset = 0;
  while ((n = walker.nextNode())) {
    pieces.push({ node: n as Text, start: offset });
    offset += (n as Text).nodeValue?.length ?? 0;
  }
  if (!pieces.length) return;
  const raw = pieces.map((p) => p.node.nodeValue ?? "").join("");
  const rankMap = paragraphFreqRank(para.tokens);
  let pos = 0;
  for (let ti = 0; ti < para.tokens.length; ti++) {
    const t = para.tokens[ti];
    if (t.isWord) {
      while (pos < raw.length && /\s/.test(raw[pos])) pos++;
    }
    if (pos >= raw.length) break;
    if (!t.isWord) {
      // 标点/空白 token：与原文消费对齐；找不到就跳过，不注 span（与原渲染一致）。
      if (t.surface && raw.startsWith(t.surface, pos)) pos += t.surface.length;
      else {
        const idx = t.surface ? raw.indexOf(t.surface, pos) : -1;
        if (idx >= 0 && idx - pos <= 24) pos = idx + t.surface.length;
      }
      continue;
    }
    const s = t.surface;
    if (raw.startsWith(s, pos)) {
      wrapTokenRange(pieces, doc, pos, pos + s.length, t, pi, ti, para.text, opts, rankMap);
      pos += s.length;
      continue;
    }
    const idx = raw.indexOf(s, pos);
    if (idx >= 0 && idx - pos <= 24) {
      wrapTokenRange(pieces, doc, idx, idx + s.length, t, pi, ti, para.text, opts, rankMap);
      pos = idx + s.length;
    }
  }
}

/**
 * 保真原版式渲染：注入 chapter.html（保留格式/行内图），在文本节点叠加逐词释义。
 * 不再做列式分页；容器用 CSS 在屏幕宽度内自然排版（reflow），宽度自适应。
 */
export function renderRich(
  container: HTMLElement,
  book: Book,
  chapter: BookChapter,
  annotated: AnnotatedParagraph[],
  opts: RichRenderOpts,
  resolveImage: (src: string) => string | undefined
): void {
  const doc = container.ownerDocument;
  container.innerHTML = "";
  container.setAttribute("data-testid", "reader");
  container.setAttribute("data-mode", modeToContract(opts.mode));
  if (book.styles) {
    const style = doc.createElement("style");
    style.setAttribute("data-book-styles", "");
    style.textContent = scopeBookStyles(book.styles);
    container.appendChild(style);
  }
  const wrap = doc.createElement("div");
  wrap.className = "rich-doc";
  wrap.innerHTML =
    chapter.html?.trim() || chapter.paragraphs.map((t) => `<p>${escapeHtml(t)}</p>`).join("");
  container.appendChild(wrap);
  // 链接统一拦截（捕获阶段，先于词元点击）：外链新窗口；锚点页内滚动；EPUB 内部章节引用（ch2.xhtml 等）
  // 在阅读器里无法直跳（按章节拆分存储），绝不让浏览器冒顶导航把应用冲白。
  wrap.addEventListener(
    "click",
    (ev) => {
      const a = (ev.target as HTMLElement | null)?.closest?.("a");
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
      const href = a.getAttribute("href") ?? "";
      if (/^https?:/i.test(href)) {
        window.open(href, "_blank", "noopener,noreferrer");
      } else if (href.startsWith("#")) {
        const el = wrap.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
        el?.scrollIntoView({ block: "start" });
      }
    },
    true
  );
  for (const img of wrap.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src) continue;
    const url = resolveImage(src);
    if (url) img.setAttribute("src", url);
  }
  // 段文本 -> AnnotatedParagraph（同章消重文本取首项即可）。
  const byText = new Map<string, { para: AnnotatedParagraph; pi: number }>();
  annotated.forEach((p, pi) => {
    const key = norm(p.text);
    if (key && !byText.has(key)) byText.set(key, { para: p, pi });
  });
  const blocks = wrap.querySelectorAll(BLOCK_SELECTOR);
  blocks.forEach((block) => {
    // 已处理过的祖先块不重复注（嵌套 blockquote > p 只注 p）。
    if (block.parentElement?.closest(BLOCK_SELECTOR) && block.tagName !== "P") {
      // p 优先交给块本身处理；li 内 p 也允许注。
    }
    const hit = byText.get(norm(block.textContent ?? ""));
    if (!hit) return;
    block.classList.add("para");
    injectTokensIntoBlock(doc, block, hit.para, hit.pi, opts);
    if (opts.showAIButton) {
      const btn = doc.createElement("button");
      btn.className = "ai-btn";
      btn.textContent = "✦ 释义本句";
      btn.addEventListener("click", () => opts.onSentenceAI(hit.para.text, hit.pi));
      block.appendChild(btn);
    }
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
