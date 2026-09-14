// 停用词表（极简内置版，保证无 Track C 时三级过滤可用）。
// TODO(依赖TrackC): 替换为完整词频表 + 按语言分档的高频词表。

import type { SourceLang } from '../types.js';

const STOP: Record<SourceLang, string[]> = {
  en: 'the a an and or but of to in on at for with is are was were be been it its this that these those as by from he she they we you i not no'.split(' '),
  de: 'der die das und oder aber in auf zu für mit ist sind war waren ein eine einer eines dem den des sich nicht von als es er sie wir'.split(' '),
  fr: 'le la les un une des et ou mais de du à en dans sur pour avec est sont était il elle ils nous vous je ne pas que'.split(' '),
  it: 'il lo la i gli le un uno una di a da in con su per tra fra e o ma che non si è sono era'.split(' '),
  es: 'el la los las un una unos unas de del al en y o pero con por para es son era fue se no que'.split(' '),
  ru: 'и в на с к от для не что это как он она они мы вы я по из у о же'.split(' '),
  ja: 'の に は を が と で も から まで へ より こと これ それ あれ です ます ない'.split(' '),
  // auto 万能：源语言未知，不做停用词折叠（LLM 直注全部显示）。
  auto: [],
};

const SETS: Record<SourceLang, Set<string>> = {
  en: new Set(STOP.en),
  de: new Set(STOP.de),
  fr: new Set(STOP.fr),
  it: new Set(STOP.it),
  es: new Set(STOP.es),
  ru: new Set(STOP.ru),
  ja: new Set(STOP.ja),
  auto: new Set(STOP.auto),
};

export function isStopword(lang: SourceLang, lemma: string): boolean {
  return SETS[lang]?.has(lemma.toLowerCase()) ?? false;
}
