// KJV 古英语 -> 现代 lemma（hath/doth/saith 等；-eth/-est 通规则由 lemmatize 兜底）。
// 根因：fallback 之前只做小写+粗糙去复数，hath/doth 原样进词典必 miss，KJV 整页全空。
import type { LanguagePack, SourceLang } from '../../types.js';

const ARCHAIC_EN: Record<string, string> = {
  hath: 'have', hast: 'have', hadst: 'have', haveth: 'have', havest: 'have',
  doth: 'do', dost: 'do', doest: 'do', doeth: 'do', didst: 'do',
  saith: 'say', sayeth: 'say', sayest: 'say', sayst: 'say',
  maketh: 'make', makest: 'make', cometh: 'come', comest: 'come',
  goeth: 'go', goest: 'go', seeth: 'see', seest: 'see',
  knoweth: 'know', knowest: 'know', thinketh: 'think', thinkest: 'think',
  giveth: 'give', givest: 'give', taketh: 'take', takest: 'take',
  loveth: 'love', lovest: 'love', liveth: 'live', livest: 'live',
  speaketh: 'speak', speakest: 'speak', writeth: 'write', writest: 'write',
  readeth: 'read', readest: 'read', worketh: 'work', workest: 'work',
  // KJV 高频古代词/助动词（创1之外整卷 KJV 必见；缺了它们整章注出率掉 5-10pt）
  thou: 'you', thee: 'you', thy: 'your', thine: 'yours', ye: 'you',
  art: 'be', wast: 'be', wert: 'be',
  wilt: 'will', shalt: 'shall', canst: 'can',
  wouldst: 'would', shouldst: 'should', couldst: 'could',
};

// 常见不规则（KJV 高频过去式；真包 Track B 有全量，此处只保 KJV 小节注出率）。
const IRREGULAR_EN: Record<string, string> = {
  was: 'be', were: 'be', been: 'be', am: 'be', is: 'be', are: 'be',
  had: 'have', has: 'have', having: 'have',
  did: 'do', done: 'do', does: 'do', doing: 'do',
  said: 'say', says: 'say', saying: 'say',
  made: 'make', making: 'make',
  took: 'take', taken: 'take', taking: 'take',
  came: 'come', coming: 'come',
  went: 'go', gone: 'go', going: 'go',
  saw: 'see', seen: 'see', seeing: 'see',
  knew: 'know', known: 'know', knowing: 'know',
  thought: 'think', thinking: 'think',
  gave: 'give', given: 'give', giving: 'give',
  spoke: 'speak', spoken: 'speak', speaking: 'speak',
  wrote: 'write', written: 'write', writing: 'write',
  broke: 'break', broken: 'break',
  chose: 'choose', chosen: 'choose',
  drove: 'drive', driven: 'drive',
  ate: 'eat', eaten: 'eat', eating: 'eat',
  fell: 'fall', fallen: 'fall',
  ran: 'run', running: 'run',
  children: 'child', men: 'man', women: 'woman',
  lives: 'life', wives: 'wife', leaves: 'leaf',
};

function archaicStemEn(lower: string): string | null {
  // 通规则：-eth/-est 去缀回 base（breaketh->break）；需补 e 的（mak->make）由 dict-loader 双试 base/base+e。
  // 显式表优先（saith/doth 等不规则去缀会错，已在上一步返回）。
  if (lower.length > 4 && lower.endsWith('eth')) {
    const base = lower.slice(0, -3);
    if (!base) return null;
    return base;
  }
  if (lower.length > 4 && lower.endsWith('est')) {
    const base = lower.slice(0, -3);
    if (!base) return null;
    return base;
  }
  return null;
}

function makeFallback(code: SourceLang): LanguagePack {
  return {
    code,
    segment(text: string): string[] {
      try {
        const seg = new Intl.Segmenter(code === 'ja' ? 'ja' : code, { granularity: 'word' });
        return [...seg.segment(text)].map((s) => s.segment);
      } catch {
        // 极老浏览器：按空白+标点粗切
        return text.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]|\s+/gu) ?? [text];
      }
    },
    lemmatize(token: string): string {
      const t = token.normalize('NFKC').replace(/^[‘’'"]+|[‘’'"]+$/g, '');
      // 日语/俄语首版不做变形还原（Track B 接管），其他语言小写即可
      if (code === 'ja' || code === 'ru') return t;
      let lower = t.toLowerCase();
      // 所有格剥离（Westminster's->westminster / dogs'->dogs；须在复数/古英语前，
      // 否则 westminster's 进词典必 miss，复现 DOM lemma=westminster' 残留引号）。
      if (code === 'en') {
        if (lower.length > 3 && (lower.endsWith("'s") || lower.endsWith('’s'))) lower = lower.slice(0, -2);
        else if (lower.length > 2 && (lower.endsWith("'") || lower.endsWith('’'))) lower = lower.slice(0, -1);
        // 曲引号内嵌（we’re 等缩写不剥，只剥尾部所有格，上已处理）
      }
      if (code !== 'en') return lower;
      // KJV 双试第一试：古英语显式映射（hath->have / doth->do / saith->say）
      const arch = ARCHAIC_EN[lower];
      if (arch) return arch;
      const irr = IRREGULAR_EN[lower];
      if (irr) return irr;
      const stem = archaicStemEn(lower);
      if (stem) return stem;
      // 英语粗糙去复数（真 lemmatizer 由 Track B 提供；此处只做保守的 STEP1 子集，
      // 对齐 packages/lang-packs/src/en.mjs STEP1：sses->ss / ies->y / ss 保护 / 单 s）。
      // 根因：之前 `(es|s)$` 一刀切把 houses->hous、lives->liv 过剥（lives 靠上表保住，
      // houses 则必 miss）；现只去单 s，houses->house、cats->cat，classes/wishes
      // 等留给 Track B 真包（单试 miss 由调用方送 LLM，不再错切）。
      if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) {
        if (lower.endsWith('sses')) return lower.slice(0, -2); // classes->class
        if (lower.endsWith('ies') && lower.length > 4) return lower.slice(0, -3) + 'y'; // stories->story
        return lower.slice(0, -1); // cats->cat, houses->house, laws->law
      }
      return lower;
    },
  };
}

export const fallbackPack = makeFallback('en');
export function getFallbackPack(code: SourceLang): LanguagePack {
  return code === 'en' ? fallbackPack : makeFallback(code);
}
