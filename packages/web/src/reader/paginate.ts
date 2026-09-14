import type { AnnotatedParagraph } from './render.js';

/**
 * 响应式分页（替代固定 WORDS_PER_SPREAD 按词切）。
 * - 纯函数 + 确定性估高，可在 jsdom/无布局环境单测（响应式：不同视口页数不同）。
 * - 浏览器有布局时调用方用隐藏测量器测得真实高度再贪心装箱，本模块的估高即兜底。
 * 结构：pages[pageIdx][columnIdx][paraIdx]；单列时 pages[i] = [[...paras]]，
 * 双列时 pages[i] = [leftParas, rightParas]（两列高度均衡，最小化高度差）。
 */

export function countWordsOfPara(p: AnnotatedParagraph | string): number {
  if (typeof p === 'string') return (p.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  if (p.tokens.length) return p.tokens.filter((t) => t.isWord).length;
  return (p.text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/**
 * 单段估高（px）。与 .para/.tok 的 interlinear 行高对齐：
 * 每行约 surface(17px)+gloss(11px)+padding ≈ 46px，段间距 26px。
 * colWidth 越小每行容词越少、行数越多 → 高度越大（响应式来源之一）。
 */
export function estimateParaHeightPx(para: AnnotatedParagraph | string, colWidthPx = 360): number {
  const text = typeof para === 'string' ? para : para.text;
  const words = countWordsOfPara(para);
  const w = Math.max(200, Math.min(800, Math.floor(colWidthPx || 360)));
  const tokensPerLine = Math.max(1, Math.floor(w / 64));
  const charsPerLine = Math.max(18, Math.floor(w / 8.6));
  const linesByWords = Math.max(1, Math.ceil(Math.max(1, words) / tokensPerLine));
  const linesByChars = Math.max(1, Math.ceil(Math.max(1, text.length) / charsPerLine));
  const lines = Math.max(linesByWords, linesByChars);
  return lines * 46 + 26;
}

/** 窄屏单列判定：与 CSS @media (max-width: 899px) 同口径。 */
export function isSingleColumnViewport(viewportWidth?: number): boolean {
  try {
    if (typeof viewportWidth === 'number') return viewportWidth <= 899;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(max-width: 899px)').matches;
    }
    if (typeof window !== 'undefined' && typeof (window as { innerWidth?: number }).innerWidth === 'number') {
      return (window as { innerWidth: number }).innerWidth <= 899;
    }
  } catch {
    // ignore
  }
  return false;
}

/** 视口尺寸（jsdom 无布局时回退到传入值/默认桌面）。 */
export function getViewportSize(): { w: number; h: number } {
  try {
    if (typeof window !== 'undefined') {
      const w = (window as { innerWidth?: number }).innerWidth;
      const h = (window as { innerHeight?: number }).innerHeight;
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) return { w, h };
    }
  } catch {
    // ignore
  }
  return { w: 1280, h: 800 };
}

/**
 * 可用页高 = book-spread 内容盒高度（clientHeight - 上下 padding）。
 * 无布局（jsdom/首帧）时按视口高减 chrome 估算，保证响应式（手机/桌面容量不同）。
 */
export function getPageCapacityPx(viewportH?: number): number {
  try {
    if (typeof document !== 'undefined') {
      const el = document.querySelector('.book-spread') as HTMLElement | null;
      if (el && typeof el.clientHeight === 'number' && el.clientHeight > 0) {
        let pad = 0;
        try {
          const cs = getComputedStyle(el);
          pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        } catch {
          pad = 0;
        }
        return Math.max(120, Math.floor(el.clientHeight - pad));
      }
    }
  } catch {
    // ignore
  }
  let h = viewportH;
  try {
    if (h == null && typeof window !== 'undefined') h = (window as { innerHeight?: number }).innerHeight;
  } catch {
    // ignore
  }
  h = typeof h === 'number' && h > 0 ? h : 800;
  const chrome = isSingleColumnViewport() ? 300 : 240;
  return Math.max(200, Math.floor(h - chrome));
}

/** 列宽：有布局读 .book-page 内容盒，否则按视口宽估算（单列整宽/双列对半）。 */
export function getColumnWidthPx(isSingle: boolean, viewportW?: number): number {
  try {
    if (typeof document !== 'undefined') {
      const el = document.querySelector('.book-page') as HTMLElement | null;
      if (el && typeof el.clientWidth === 'number' && el.clientWidth > 0) {
        let pad = 0;
        try {
          const cs = getComputedStyle(el);
          pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        } catch {
          pad = 0;
        }
        const w = Math.floor(el.clientWidth - pad);
        if (w >= 160) return w;
      }
    }
  } catch {
    // ignore
  }
  let w = viewportW;
  try {
    if (w == null && typeof window !== 'undefined') w = (window as { innerWidth?: number }).innerWidth;
  } catch {
    // ignore
  }
  w = typeof w === 'number' && w > 0 ? w : 1280;
  if (isSingle) return Math.max(280, Math.min(720, Math.floor(w - 48)));
  return Math.max(220, Math.min(640, Math.floor((w - 80) / 2)));
}

/**
 * 按实际渲染高度分页（贪心装箱，保证每页内容高度 <= 可用高度）。
 * - 单列：累计高度超 cap 即换页。
 * - 双列：页内按原文顺序连续切分左右列（左列为前半、右列为后半，选高度差最小且两列都不超 cap 的切点；
 *   找不到则页内只放能放下的段，余下换页）。保证阅读顺序不交错、两列高度均衡。
 * - 单个 para 超过一页高：独占一页（调用方渲染时加 data-overflow="single-para" 并允许该页 overflow:auto，绝不丢字）。
 */
export function measurePaginate(
  annotated: AnnotatedParagraph[],
  pageCapacityPx: number,
  isTwoColumn: boolean,
  colWidthPx?: number,
): AnnotatedParagraph[][][] {
  const cap = Math.max(120, Math.floor(pageCapacityPx || 600));
  const colW = colWidthPx ?? (isTwoColumn ? 340 : 360);
  const heights = annotated.map((p) => estimateParaHeightPx(p, colW));
  return paginateWithHeights(annotated, heights, cap, isTwoColumn);
}

/** 纯文本分页（auto/未注出/跨章页数估算用，与 measurePaginate 同贪心语义）。 */
export function paginateTextHeights(
  heights: number[],
  pageCapacityPx: number,
  isTwoColumn: boolean,
): number[][] {
  const cap = Math.max(120, Math.floor(pageCapacityPx || 600));
  const pages: number[][] = [];
  if (!heights.length) return pages;
  if (!isTwoColumn) {
    let cur: number[] = [];
    let curH = 0;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h > cap) {
        if (cur.length) {
          pages.push(cur);
          cur = [];
          curH = 0;
        }
        pages.push([i]);
        continue;
      }
      if (cur.length && curH + h > cap) {
        pages.push(cur);
        cur = [];
        curH = 0;
      }
      cur.push(i);
      curH += h;
    }
    if (cur.length) pages.push(cur);
    return pages;
  }
  // 双列：总量 2*cap 收页，页内连续切分（返回页内下标升序，调用方按切点分列即得左右）。
  const splitBalancedIdx = (idx: number[]): void => {
    if (!idx.length) return;
    if (idx.length === 1) {
      pages.push([...idx]);
      return;
    }
    const total = idx.reduce((a, i) => a + heights[i], 0);
    let bestK = 1;
    let bestDiff = Number.POSITIVE_INFINITY;
    let acc = 0;
    for (let k = 1; k < idx.length; k++) {
      acc += heights[idx[k - 1]];
      const l = acc;
      const r = total - acc;
      if (l > cap || r > cap) continue;
      const diff = Math.abs(l - r);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestK = k;
      }
    }
    void bestK;
    void bestDiff;
    // 页内顺序即阅读顺序，直接整页返回（调用方需要分列时再按同一切点切分）
    pages.push([...idx].sort((a, b) => a - b));
  };
  let cur: number[] = [];
  let curH = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h > cap) {
      if (cur.length) {
        splitBalancedIdx(cur);
        cur = [];
        curH = 0;
      }
      pages.push([i]);
      continue;
    }
    if (cur.length && curH + h > cap * 2) {
      splitBalancedIdx(cur);
      cur = [];
      curH = 0;
    }
    cur.push(i);
    curH += h;
  }
  if (cur.length) splitBalancedIdx(cur);
  return pages;
}

/** 全局 para 下标 → 新分页页号（resize 保持阅读位置用，按对象引用，重复文本不混淆）。 */
export function findPageForParaRef(
  pages: AnnotatedParagraph[][][],
  target: AnnotatedParagraph,
): number {
  for (let i = 0; i < pages.length; i++) {
    for (const col of pages[i]) {
      if (col.includes(target)) return i;
    }
  }
  return 0;
}

// ============================================================================
// 行级 flow 分页（自适应排版真翻页）：
// - 探针把整章以目标列宽渲染一次，逐 token 测得 (top, bottom)，按行分组；
// - 分页只在行首切分（行内贪心断行状态与真实列完全一致 → 高度算术精确，零截断）；
// - .tok 永不拆散；段可跨页（续排 .frag）；空段不进流（无内容可丢）。
// 本节除文末两个列度量外均为纯函数，可在 node 单测（行盒可手工构造）。
// ============================================================================

/** 探针测得的单个 token 盒（文档顺序，origin 为探针内容盒顶部） */
export interface FlowTokenBox {
  top: number;
  bottom: number;
  /** flow 数组下标 */
  para: number;
  /** 段内 token 下标（AI 按钮取段 token 总数，排序在段尾） */
  tok: number;
  /** 全局 flow token 下标（AI 按钮取其段尾的下一 token 下标，即归属段的结束位置） */
  g: number;
  /** AI 按钮块：无 token 归属，高度并入上一行（永不自成一行，避免分页切在词与按钮之间） */
  ai?: boolean;
}

/** 行（含行内 token 区间 [firstTok, lastTok]，全局 flow token 下标） */
export interface FlowLine {
  top: number;
  bottom: number;
  firstTok: number;
  lastTok: number;
  para: number;
}

/** 章节流几何：行表 + token→行映射 + 段首 token 累计 */
export interface FlowGeom {
  lines: FlowLine[];
  /** 全局 token 下标 → 行号 */
  tokenLine: number[];
  /** 段首全局 token 下标（flow[i] 起始），长度 flow.length+1，末项为总数 */
  paraStart: number[];
  /** token 总数 */
  total: number;
  /** 每段 token 数 */
  paraLens: number[];
}

/** 一页：全局 token 区间 [startTok, endTok)，双列时 cutTok 为右列起点（单列 cutTok=endTok） */
export interface FlowPage {
  startTok: number;
  endTok: number;
  cutTok: number;
}

/** flow 切片（renderSlices 用）：para 为 flow 下标，[from, to) 为段内 token 下标 */
export interface FlowSlice {
  para: number;
  from: number;
  to: number;
}

/** token 盒 → 行表（纯）：同行判定 top < 行底 - eps（同行基线差 < 行高恒成立，换行 top>=行底）；
 * AI 按钮块永不自成一行，直接并入上一行行高（按钮跟段尾走，分页不断开它）。 */
export function groupTokensToLines(boxes: FlowTokenBox[], total: number): FlowGeom {
  const lines: FlowLine[] = [];
  const tokenLine: number[] = new Array(Math.max(0, total)).fill(-1);
  const EPS = 1;
  let cur: FlowLine | null = null;
  boxes.forEach((b) => {
    const g = b.g;
    if (b.ai && cur) {
      if (b.top < cur.top) cur.top = b.top;
      if (b.bottom > cur.bottom) cur.bottom = b.bottom;
      return;
    }
    if (!cur || b.top >= cur.bottom - EPS) {
      cur = { top: b.top, bottom: b.bottom, firstTok: g, lastTok: g, para: b.para };
      lines.push(cur);
    } else {
      if (b.top < cur.top) cur.top = b.top;
      if (b.bottom > cur.bottom) cur.bottom = b.bottom;
      cur.lastTok = g;
    }
    if (!b.ai && g >= 0 && g < tokenLine.length) tokenLine[g] = lines.length - 1;
  });
  return { lines, tokenLine, paraStart: [], total, paraLens: [] };
}

/** 行级贪心装箱（纯）：每页（每列）装到整行恰好 <= cap；双列页预算 2*cap，切点均衡且两列都不超 */
export function paginateFlowLines(
  lines: FlowLine[],
  totalTokens: number,
  pageCapacityPx: number,
  columns: 1 | 2,
): FlowPage[] {
  const cap = Math.max(40, Math.floor(pageCapacityPx || 400));
  const pages: FlowPage[] = [];
  const n = lines.length;
  if (!n || !totalTokens) return [];
  const endTokOf = (lb: number): number => (lb < n ? lines[lb].firstTok : totalTokens);
  let la = 0;
  while (la < n) {
    const pageTop = lines[la].top;
    // lb 上界：整行高度 <= 预算（单列 cap，双列 2*cap）
    const budget = columns === 2 ? cap * 2 : cap;
    let lb = la + 1;
    while (lb < n && lines[lb].bottom - pageTop <= budget) lb++;
    // lb 回退到行首语义天然成立（lb 本就是行号）；保证至少一行
    if (columns === 1) {
      pages.push({ startTok: lines[la].firstTok, endTok: endTokOf(lb), cutTok: endTokOf(lb) });
      la = lb;
      continue;
    }
    // 双列：在 (la, lb] 内找切点 lc（行号），左右均衡且都不超 cap。
    // 若无可行切点（贪心 lb 吃多、两列无法均衡），lb 逐行回退直到可行；
    // 单行高恒远小于 cap（行 ~46px，cap>=80），故必终止，不会死循环。
    const feasibleCut = (llo: number): number => {
      // 可行切点区间：左<=cap ⟺ lc<=K1；右<=cap ⟺ lc>=K0（右列高度随 lc 增大单调减）
      const pageBottom = lines[llo - 1].bottom;
      let K0 = la + 1;
      while (K0 < llo && pageBottom - lines[K0].top > cap) K0++;
      let K1 = llo - 1;
      while (K1 > la && lines[K1 - 1].bottom - pageTop > cap) K1--;
      if (K0 > K1) return -1;
      // 区间内找 |左-右| 最小（二分找零点再邻域确认，左右高度单调）
      const diff = (k: number): number => (lines[k - 1].bottom - pageTop) - (pageBottom - lines[k].top);
      let lo = K0;
      let hi = K1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (diff(mid) < 0) lo = mid + 1;
        else hi = mid;
      }
      let lc = lo;
      let best = Math.abs(diff(lc));
      for (const k of [lo - 1, lo + 1]) {
        if (k < K0 || k > K1) continue;
        const d = Math.abs(diff(k));
        if (d < best) {
          best = d;
          lc = k;
        }
      }
      return lc;
    };
    let lc = feasibleCut(lb);
    while (lc < 0 && lb > la + 1) {
      lb--;
      lc = feasibleCut(lb);
    }
    if (lc < 0) {
      // 物理不可达兜底（单行超 cap，行高恒 <cap）：左列尽量装满
      lc = Math.max(la + 1, lb - 1);
    }
    lc = Math.max(la + 1, Math.min(lb, lc));
    pages.push({ startTok: lines[la].firstTok, endTok: endTokOf(lb), cutTok: lc < lb ? lines[lc].firstTok : endTokOf(lb) });
    la = lb;
  }
  return pages;
}

/** token 区间 → flow 切片（含首尾段的段内 from/to；调用方保证 [a,b) 非空） */
export function slicesForTokenRange(geom: FlowGeom, a: number, b: number): FlowSlice[] {
  const out: FlowSlice[] = [];
  if (b <= a) return out;
  const { paraStart, paraLens } = geom;
  // 二分定位 a 所在段
  let lo = 0;
  let hi = paraStart.length - 2;
  let pa = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (paraStart[mid + 1] <= a) lo = mid + 1;
    else if (paraStart[mid] > a) hi = mid - 1;
    else {
      pa = mid;
      break;
    }
  }
  let pb = pa;
  while (pb + 1 < paraStart.length - 1 && paraStart[pb + 1] < b) pb++;
  // b 恰落段首时不含该段
  while (pb > pa && paraStart[pb] >= b) pb--;
  for (let p = pa; p <= pb; p++) {
    const from = p === pa ? a - paraStart[p] : 0;
    const to = p === pb ? Math.min(b - paraStart[p], paraLens[p]) : paraLens[p];
    if (to > from || paraLens[p] === 0) out.push({ para: p, from, to });
  }
  return out;
}

/** 全局 token 下标 → 页号（二分；越界钳制） */
export function findFlowPage(pages: FlowPage[], tok: number): number {
  if (!pages.length) return 0;
  let lo = 0;
  let hi = pages.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].startTok <= tok) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 列内容盒高度 = 可见 .book-spread 的 clientHeight - 列上下 padding（分页预算的唯一口径）。
 * 只依赖 spread（列高与断点无关），跨断点 resize 时旧列 DOM 不可信，故不用列高；
 * padding 按当前断点取 CSS 定值（桌面 14*2 / 移动 12*2，与 styles.css 同口径）。
 * 另扣 PAGE_SAFETY_PX：行盒 fractional 高度在真实列内按整像素累积取整，
 * 8 段一页可累出约 2.5px（实测）超出预算；CSS 契约 28/24 不动，安全余量另计。
 * 旧 getPageCapacityPx 读的是 spread 高却不减列 padding，比列内容盒大出整整列 padding，
 * 按它装箱的满页必溢出 ~28px（桌面静默截断的根因之一）。无布局时回退旧口径减 padding 估算。
 */
const PAGE_SAFETY_PX = 4;
export function getColumnContentHeight(single?: boolean): number {
  const s = single ?? isSingleColumnViewport();
  try {
    if (typeof document !== 'undefined') {
      const spread = document.querySelector('.book-spread') as HTMLElement | null;
      if (spread && spread.clientHeight > 0) {
        return Math.max(80, Math.floor(spread.clientHeight - (s ? 24 : 28) - PAGE_SAFETY_PX));
      }
    }
  } catch {
    // ignore
  }
  return Math.max(80, Math.floor(getPageCapacityPx() - 28));
}

/**
 * 探针宽度 = 列 border-box 宽 - 1px（右列有 1px 分隔边框，内容比左列窄 1px；
 * 探针取窄侧做保守测量：测得高度 >= 真实高度，只会让页稍疏、永不溢出）。
 * 只依赖 spread 宽（断点切换时旧列宽不可信）：单列取 spread 全宽，双列对半再减分隔边框。
 * 旧 probeHeights 把“内容宽”直接设为探针 border-box 宽，CSS padding 又占一次，
 * 探针内容比真实列窄 ~77px，系统性测高 ~16%（每页只装一段的根因之一）。
 */
export function getProbeColumnWidthPx(single?: boolean): number | null {
  const s = single ?? isSingleColumnViewport();
  try {
    if (typeof document !== 'undefined') {
      const spread = document.querySelector('.book-spread') as HTMLElement | null;
      if (spread && spread.clientWidth > 0) {
        const col = s ? spread.clientWidth : (spread.clientWidth - 1) / 2;
        return Math.max(160, Math.floor(col) - 1);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 用已测得的真实高度分页（隐藏测量器命中时用，贪心语义与 measurePaginate 一致）。
 * heights[i] 对应 annotated[i] 的实测 px（含段间距）；单段超高同样独占一页。
 */
export function paginateWithHeights(
  annotated: AnnotatedParagraph[],
  heights: number[],
  pageCapacityPx: number,
  isTwoColumn: boolean,
): AnnotatedParagraph[][][] {
  const cap = Math.max(120, Math.floor(pageCapacityPx || 600));
  const pages: AnnotatedParagraph[][][] = [];
  if (!annotated.length) return pages;
  const hs = annotated.map((_, i) => Math.max(20, Math.floor(heights[i] ?? 80)));
  if (!isTwoColumn) {
    let cur: AnnotatedParagraph[] = [];
    let curH = 0;
    for (let i = 0; i < annotated.length; i++) {
      const h = hs[i];
      if (h > cap) {
        if (cur.length) {
          pages.push([cur]);
          cur = [];
          curH = 0;
        }
        pages.push([[annotated[i]]]);
        continue;
      }
      if (cur.length && curH + h > cap) {
        pages.push([cur]);
        cur = [];
        curH = 0;
      }
      cur.push(annotated[i]);
      curH += h;
    }
    if (cur.length) pages.push([cur]);
    return pages;
  }
  // 双列：先按总量 2*cap 贪心收段成页（顺序连续），再在页内找最均衡的连续切点分左右列。
  const splitBalanced = (idx: number[]): [number[], number[]] => {
    if (idx.length <= 1) return [idx, []];
    const total = idx.reduce((a, i) => a + hs[i], 0);
    let bestK = 1;
    let bestDiff = Number.POSITIVE_INFINITY;
    let acc = 0;
    for (let k = 1; k < idx.length; k++) {
      acc += hs[idx[k - 1]];
      const l = acc;
      const r = total - acc;
      if (l > cap || r > cap) continue;
      const diff = Math.abs(l - r);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestK = k;
      }
    }
    if (bestDiff === Number.POSITIVE_INFINITY) {
      // 无切点两列都不超：退化为按总量尽量均分（仍可能一列超 cap，调用方按单段超高处理不了时换页逻辑已保证总量<=2cap）
      acc = 0;
      for (let k = 1; k <= idx.length; k++) {
        acc += hs[idx[k - 1]];
        if (acc >= total / 2) {
          bestK = k;
          break;
        }
      }
    }
    return [idx.slice(0, bestK), idx.slice(bestK)];
  };
  let curIdx: number[] = [];
  let curH = 0;
  for (let i = 0; i < annotated.length; i++) {
    const h = hs[i];
    if (h > cap) {
      if (curIdx.length) {
        const [l, r] = splitBalanced(curIdx);
        pages.push([l.map((k) => annotated[k]), r.map((k) => annotated[k])]);
        curIdx = [];
        curH = 0;
      }
      pages.push([[annotated[i]], []]);
      continue;
    }
    if (curIdx.length && curH + h > cap * 2) {
      const [l, r] = splitBalanced(curIdx);
      pages.push([l.map((k) => annotated[k]), r.map((k) => annotated[k])]);
      curIdx = [];
      curH = 0;
    }
    curIdx.push(i);
    curH += h;
  }
  if (curIdx.length) {
    const [l, r] = splitBalanced(curIdx);
    pages.push([l.map((k) => annotated[k]), r.map((k) => annotated[k])]);
  }
  return pages;
}
