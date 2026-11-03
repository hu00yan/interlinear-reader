// 分词 + Token 构建（含 isWord 判定）。lemma 归一由 LanguagePack 负责。

import type { LanguagePack, SourceLang, Token } from "../types.js";
// .ts 后缀（bundler + allowImportingTsExtensions）：node --test 原生 TS 加载也能解析
// （.js 会去找不存在的 stopwords.js，tests/unit/punctuation.test.mjs 直接 import 本模块）。
import { isStopword } from "../dict/stopwords.ts";

const WORD_RE: Record<SourceLang, RegExp> = {
  en: /[\p{L}']/u,
  de: /[\p{L}']/u,
  fr: /[\p{L}']/u,
  it: /[\p{L}']/u,
  es: /[\p{L}']/u,
  ru: /[\p{L}]/u,
  ja: /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/u,
  // auto 万能：不经分词包时一般不用本表（LLM 直接分词）；兜底按任意字母/数字判词（含阿语等）。
  auto: /[\p{L}\p{N}]/u,
};

export function isWordSurface(lang: SourceLang, surface: string): boolean {
  if (!surface.trim()) return false;
  return WORD_RE[lang].test(surface);
}

/**
 * 无损兜底分词：词 run（含内嵌撇号/连字符）+ 其余（空白/标点/数字）整段，连缀恒等于原文。
 * 契约本就要求 segment(text) 连缀 == 原文（langpacks.test.mjs 已锁），但历史教训是
 * 只出词 run 的实现会经 String.match 静默吞掉全部逗号句号（0bb0813 修复的线上事故：
 * Pages 部署陈旧 + 无运行时防线，整页“字连着字”）。这里对每次 tokenize 做一次
 * 连缀校验，任何分词包（真包/fallback/未来接入）丢段时回退到本正则，保证标点永不丢。
 */
const LOSSLESS_RE = /[\p{L}\p{M}]+(?:['’'‑‒–—-][\p{L}\p{M}]+)*|[^\p{L}\p{M}]+/gu;

/** 段落 -> Token[]（gloss 留空，由 render 层按模式填充） */
export function tokenizeParagraph(
  pack: LanguagePack,
  lang: SourceLang,
  text: string,
  isKnown: (lemma: string) => boolean
): Token[] {
  let surfaces = pack.segment(text);
  // 无损校验：分词包输出连缀 ≠ 原文即视为丢段（丢标点/空白），回退无损分词再构词。
  if (surfaces.join("") !== text) surfaces = text.match(LOSSLESS_RE) ?? [];
  return surfaces.map((surface) => {
    const isWord = isWordSurface(lang, surface);
    const lemma = isWord ? pack.lemmatize(surface) : surface;
    return {
      surface,
      lemma,
      isWord,
      gloss: null,
      glossSource: null,
      known: isWord ? isKnown(lemma) : false,
      stopword: isWord ? isStopword(lang, lemma) : false,
    } as Token;
  });
}
