// 三级过滤：停用词 / 词频 / 已认识 —— 控制“是否显示该词的小字释义”。
// 过滤只隐藏 gloss，不隐藏原文。

import type { Token } from '../types.js';

export interface FilterSettings {
  hideStopwords: boolean;
  hideKnown: boolean;
  freqHideTopN: number;
}

/** 启发式词频：段落内出现次数排名。真词频表由 Track C 提供后替换此函数。 */
export function paragraphFreqRank(tokens: Token[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (!t.isWord) continue;
    counts.set(t.lemma, (counts.get(t.lemma) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const rank = new Map<string, number>();
  sorted.forEach(([lemma], i) => rank.set(lemma, i + 1));
  return rank;
}

export function shouldShowGloss(t: Token, f: FilterSettings, rank?: Map<string, number>): boolean {
  if (!t.isWord || !t.gloss) return false;
  if (t.known && f.hideKnown) return false;
  if (t.stopword && f.hideStopwords) return false;
  if (f.freqHideTopN > 0 && rank) {
    const r = rank.get(t.lemma) ?? Infinity;
    if (r <= f.freqHideTopN) return false;
  }
  return true;
}
