#!/usr/bin/env node
// 复现 Westminster 页三问题（合成 EPUB，镜像真书结构）：
// - 标题重复：head<title>Introduction</title> + h2 Introduction + 首段 Introduction
// - 缺词：Westminster Confession of Faith（of 命中，Westminster/Confession 缺）
// - 对开：检查 68vh 定高+栏内滚
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
};
globalThis.DOMParser = new JSDOM().window.DOMParser;
globalThis.fetch = async (url) => {
  const m = String(url).match(/dict\/([a-z]+)\/([^/]+)\.dict$/);
  if (!m) return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  try {
    const body = readFileSync(resolve(process.cwd(), '..', '..', 'public', 'dict', m[1], `${m[2]}.dict`), 'utf8');
    return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => body };
  } catch {
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  }
};

const { extractXhtml } = await import('../src/ingest/epub.js');
const { getFallbackPack } = await import('../src/reader/langpacks/fallback.js');
const { getGloss } = await import('../src/dict/dict-loader.js');
const { annotateParagraphs, renderParagraphs } = await import('../src/reader/render.js');

// 1) 标题去重：合成含重复标题的 XHTML（z-lib 常见：nav/title/heading 三处同文）
const XHTML_DUP = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Introduction</title></head><body>
<h2>Introduction</h2>
<p>Introduction</p>
<p>Westminster Confession of Faith was written in 1646.</p>
<p>Adam Neumann founded WeWork.</p>
</body></html>`;
const { title, paragraphs } = extractXhtml(XHTML_DUP);
console.log('TITLE:', JSON.stringify(title));
console.log('PARAS:', JSON.stringify(paragraphs, null, 2));
const titleDupCount = paragraphs.filter((p) => p.trim().toLowerCase() === title.trim().toLowerCase()).length;
console.log(`标题去重检查: title=${JSON.stringify(title)} 首段重复数=${titleDupCount} 总段数=${paragraphs.length}`);
console.log(titleDupCount > 0 ? 'REPRO 重行: FAIL（标题在段落中重复）' : 'REPRO 重行: PASS（无重复）');

// 2) 缺词：of vs Westminster/Confession
const pack = getFallbackPack('en');
for (const w of ['of', 'westminster', 'confession', 'faith', 'introduction', 'westminster\'s', 'confessions', 'neumann', 'wework']) {
  const lemma = pack.lemmatize(w);
  const g = await getGloss('en', 'zh', lemma);
  // 直接查原形 + lemma 双路，模拟 render 链
  const g2 = await getGloss('en', 'zh', w);
  console.log(`查词 ${w} lemma=${lemma} gloss(lemma)=${JSON.stringify(g)} gloss(raw)=${JSON.stringify(g2)}`);
}

// 全链 annotate + DOM
const ann = await annotateParagraphs(pack, 'en', 'zh', paragraphs, () => false);
const toks = ann.flatMap((p) => p.tokens).filter((t) => t.isWord);
const hits = toks.filter((t) => !!t.gloss).length;
const misses = toks.filter((t) => !t.gloss);
console.log(`全链命中 ${hits}/${toks.length} 缺词 ${misses.length} 个：${[...new Set(misses.map((t) => t.lemma))].join('、')}`);

const dom = new JSDOM('<!DOCTYPE html><body></body>');
globalThis.document = dom.window.document;
const holder = dom.window.document.createElement('div');
renderParagraphs(holder, ann, { mode: 'B', showGloss: true, filters: { hideStopwords: false, hideKnown: false, freqHideTopN: 0 }, showAIButton: false, onTokenClick: () => {}, onSentenceAI: () => {} });
const tokEls = holder.querySelectorAll('.tok');
const glossEls = holder.querySelectorAll('.tok .gloss');
const missingEls = holder.querySelectorAll('.tok .gloss.missing');
console.log(`DOM .tok=${tokEls.length} .gloss=${glossEls.length} .missing=${missingEls.length}`);
for (const surf of ['of', 'Westminster', 'Confession', 'Faith', 'Introduction']) {
  const el = [...holder.querySelectorAll('.tok')].find((n) => n.querySelector('.surface')?.textContent === surf);
  if (el) {
    const g = el.querySelector('.gloss');
    console.log(`DOM tok ${surf}: gloss=${JSON.stringify(g?.textContent)} cls=${g?.className} tokCls=${el.className}`);
  } else console.log(`DOM tok ${surf}: NOT FOUND`);
}
// 章节标题去重 DOM 口径：若首段即标题，渲染后首 para 首 tok 即标题词
const firstParaText = holder.querySelector('.para')?.textContent?.slice(0, 60);
console.log('DOM 首段文本:', JSON.stringify(firstParaText));
// notice 数对上口径：notice 缺词数应 == DOM .missing 数
console.log(`notice对齐检查: missLemmas=${misses.length} vs DOM.missing=${missingEls.length} ${misses.length === missingEls.length ? '对上' : '错位 FAIL'}`);

// 3) 对开：检查 68vh 定高+栏内滚
const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const has68vh = css.includes('68vh');
const hasSpreadScroll = /\.book-spread[^}]*overflow/.test(css) || /\.book-page[^}]*overflow/.test(css);
console.log(`对开检查: 68vh=${has68vh} 栏内滚=${hasSpreadScroll}`);
console.log(has68vh || hasSpreadScroll ? 'REPRO 对开: FAIL（定高框内滚作弊仍在）' : 'REPRO 对开: PASS（内容分页无内滚）');
