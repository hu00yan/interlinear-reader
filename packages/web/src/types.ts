// Track A 对接契约（锁死，不可改）。Track B/C/D 提供实现时替换 mock 即可。
// Mode / LanguagePack / 缓存键规则见本文件注释。

/** 源语言（7 词典包 + auto 万能）。auto 不经词典/分词包，整句送 LLM 自动识别+分词+注。 */
export type SourceLang = 'en' | 'de' | 'fr' | 'it' | 'es' | 'ru' | 'ja' | 'auto';
export const SOURCE_LANGS: SourceLang[] = ['en', 'de', 'fr', 'it', 'es', 'ru', 'ja', 'auto'];

export const SOURCE_LANG_NAMES: Record<SourceLang, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  es: 'Español',
  ru: 'Русский',
  ja: '日本語',
  auto: 'Auto · 万能（LLM）',
};

/** 目标语言 ZH+EN 可切换（锁死） */
export type TargetLang = 'zh' | 'en';
export const TARGET_LANGS: TargetLang[] = ['zh', 'en'];

/**
 * 三种模式（锁死）：
 * A 默认 = 词典全注 + 点词点句 LLM
 * B 纯词典（零 LLM 调用）
 * C 整章 LLM
 */
export enum Mode {
  A = 'A',
  B = 'B',
  C = 'C',
}

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  [Mode.A]: 'A · 词典全注 + 点词/点句 LLM',
  [Mode.B]: 'B · 纯词典（不调 LLM）',
  [Mode.C]: 'C · 整章 LLM',
};

/**
 * LanguagePack 接口 —— 由 Track B 提供时动态 import。
 * Track A 只依赖此形状，不依赖具体实现。
 * 约定懒加载路径：`../reader/langpacks/${lang}.ts`（首屏不打包）。
 */
export interface LanguagePack {
  code: SourceLang;
  /** 把句子切成 surface 序列（含标点，由调用方判断 isWord） */
  segment(text: string): string[];
  /** surface -> lemma（词典查询用 lemma） */
  lemmatize(token: string): string;
}

/** Interlinear 最小 token */
export interface Token {
  surface: string;
  lemma: string;
  isWord: boolean;
  gloss: string | null;
  glossSource: 'dict' | 'llm' | 'cache' | null;
  known: boolean;
  stopword: boolean;
}

/** 内容摄入统一形状（EPUB/TXT/URL 都转成它） */
export interface BookChapter {
  id: string;
  title: string;
  /** 段落原文（保留章节段落结构） */
  paragraphs: string[];
}

export interface Book {
  title: string;
  lang: SourceLang;
  chapters: BookChapter[];
  source: 'epub' | 'txt' | 'url' | 'fixture';
}
