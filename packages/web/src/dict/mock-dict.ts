// Mock 词典：仅覆盖 fixture + demo 句，保证 `npm run dev` 无 Track C 时可逐词注出。
// TODO(依赖TrackC): 换成 R2 托管的真实词典分片 + dict-loader 动态 import，
// 本文件仅保留为离线 fallback / 单元测试。

import type { SourceLang, TargetLang } from '../types.js';

// lemma(小写) -> { zh, en }
const MOCK: Record<string, { zh: string; en: string }> = {
  hello: { zh: '你好', en: 'greeting' },
  world: { zh: '世界', en: 'the earth' },
  cat: { zh: '猫', en: 'small feline animal' },
  cats: { zh: '猫（复数）', en: 'small feline animals' },
  dog: { zh: '狗', en: 'canine animal' },
  read: { zh: '读', en: 'to look at words' },
  reads: { zh: '读（三单）', en: 'reads' },
  reading: { zh: '阅读', en: 'the act of reading' },
  book: { zh: '书', en: 'a written work' },
  books: { zh: '书（复数）', en: 'written works' },
  morning: { zh: '早晨', en: 'early day' },
  sun: { zh: '太阳', en: 'the star' },
  shines: { zh: '照耀', en: 'gives light' },
  shine: { zh: '照耀', en: 'give light' },
  small: { zh: '小的', en: 'little' },
  big: { zh: '大的', en: 'large' },
  water: { zh: '水', en: 'water' },
  drink: { zh: '喝', en: 'to drink' },
  drinks: { zh: '喝（三单）', en: 'drinks' },
  milk: { zh: '牛奶', en: 'milk' },
  like: { zh: '喜欢', en: 'to like' },
  likes: { zh: '喜欢（三单）', en: 'likes' },
  fish: { zh: '鱼', en: 'fish' },
  bird: { zh: '鸟', en: 'bird' },
  sings: { zh: '唱歌', en: 'sings' },
  sing: { zh: '唱歌', en: 'to sing' },
  song: { zh: '歌', en: 'song' },
  night: { zh: '夜晚', en: 'night' },
  day: { zh: '白天', en: 'day' },
  friend: { zh: '朋友', en: 'friend' },
  house: { zh: '房子', en: 'house' },
  tree: { zh: '树', en: 'tree' },
  garden: { zh: '花园', en: 'garden' },
  // KJV/高频离线兜底（与 public/dict/en 真分片首释义一致；dist 无 /dict/* 时走此 fallback，
  // 与脚本 annotate 链同一 getGlossWithSource 出口，source 仍记 dict）。
  // 取值口径：真分片 `lemma\tzh1\x1f…\ten1\x1f…` 的首段（python 实读 public/dict/en/*.dict 核对）。
  the: { zh: '这', en: 'the' },
  a: { zh: '一', en: 'a' },
  an: { zh: '一', en: 'an' },
  and: { zh: '和', en: 'and' },
  in: { zh: '在…里', en: 'in' },
  of: { zh: '的', en: 'of' },
  to: { zh: '到', en: 'to' },
  he: { zh: '他', en: 'he' },
  be: { zh: '是', en: 'be' },
  have: { zh: '有', en: 'have' },
  do: { zh: '做', en: 'do' },
  say: { zh: '说', en: 'say' },
  make: { zh: '制作', en: 'make' },
  word: { zh: '词', en: 'word' },
  good: { zh: '好', en: 'good' },
  sit: { zh: 'vi. 坐, 就座, 坐落', en: 'v. be seated' },
  number: { zh: 'n. 数, 数字, 数目, 号码', en: 'n. the property possessed by a sum or total or indefinite quantity of units or individuals' },
  // DE demo
  katze: { zh: '猫', en: 'cat' },
  hund: { zh: '狗', en: 'dog' },
  buch: { zh: '书', en: 'book' },
  welt: { zh: '世界', en: 'world' },
  // FR demo
  chat: { zh: '猫', en: 'cat' },
  chien: { zh: '狗', en: 'dog' },
  livre: { zh: '书', en: 'book' },
  monde: { zh: '世界', en: 'world' },
  bonjour: { zh: '你好', en: 'hello' },
  // ES/IT demo
  gato: { zh: '猫', en: 'cat' },
  perro: { zh: '狗', en: 'dog' },
  libro: { zh: '书', en: 'book' },
  mundo: { zh: '世界', en: 'world' },
  hola: { zh: '你好', en: 'hello' },
  // RU demo
  кот: { zh: '猫', en: 'cat' },
  собака: { zh: '狗', en: 'dog' },
  книга: { zh: '书', en: 'book' },
  мир: { zh: '世界', en: 'world' },
  // JA demo
  ねこ: { zh: '猫', en: 'cat' },
  猫: { zh: '猫', en: 'cat' },
  いぬ: { zh: '狗', en: 'dog' },
  犬: { zh: '狗', en: 'dog' },
  本: { zh: '书', en: 'book' },
  世界: { zh: '世界', en: 'world' },
};

export function mockLookup(lang: SourceLang, target: TargetLang, lemma: string): string | null {
  void lang; // mock 不分语言（同形词取 EN 为主），真词典按 lang 分片
  const hit = MOCK[lemma.toLowerCase()] ?? MOCK[lemma];
  if (!hit) return null;
  return target === 'zh' ? hit.zh : hit.en;
}
