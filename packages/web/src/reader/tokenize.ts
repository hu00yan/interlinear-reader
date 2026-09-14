// 分词 + Token 构建（含 isWord 判定）。lemma 归一由 LanguagePack 负责。

import type { LanguagePack, SourceLang, Token } from '../types.js';
import { isStopword } from '../dict/stopwords.js';

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

/** 段落 -> Token[]（gloss 留空，由 render 层按模式填充） */
export function tokenizeParagraph(
  pack: LanguagePack,
  lang: SourceLang,
  text: string,
  isKnown: (lemma: string) => boolean,
): Token[] {
  return pack.segment(text).map((surface) => {
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
