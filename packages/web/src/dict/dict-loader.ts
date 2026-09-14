// 查词统一入口（契约锁死）：`dict-loader.getGloss(lang,target,lemma)`。
// 流程：sha1 词缓存 -> mock/真词典分片（动态 import，首屏不打包）-> 未命中返回 null（由调用方决定是否走 LLM）。
// TODO(依赖TrackC): 在 DICTS 里注册各语言分片 `dict/${lang}.ts`（R2 构建产物），
// 并把 mockLookup 降级为离线 fallback。

import type { SourceLang, TargetLang } from '../types.js';
import { wordCacheKey } from '../lib/hash.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { mockLookup } from './mock-dict.js';
import { deinflectJa, isJaKanaFragment } from './ja-inflect.mjs';
type CompactPair = Map<string, string[]>;
const shardMem = new Map<string, CompactPair | null>();
/** 在途 loadPair 去重表（见 loadPair 注释；完成即删，不缓存失败语义之外的任何东西） */
const shardInflight = new Map<string, Promise<CompactPair | null>>();

function normalize(lang: SourceLang, lemma: string): string {
  let value = String(lemma ?? '').trim();
  if (lang !== 'ja') value = value.toLowerCase();
  if (lang === 'de') value = value.replace(/ß/g, 'ss');
  if (lang === 'ru') value = value.replace(/ё/g, 'е');
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function shardFor(lang: SourceLang, lemma: string): string {
  const key = normalize(lang, lemma);
  if (!key) return 'misc';
  const head = [...key].slice(0, 2).join('');
  if (/^[a-z]{1,2}$/.test(head)) return head;
  if (/^[0-9]/.test(head)) return '0-9';
  return `u${[...key].slice(0, 2).map((c) => c.codePointAt(0)!.toString(16)).join('')}`;
}

// KJV 古英语双试：normalize 原形 miss 时试现代形（hath->have / doth->do / saith->say + -eth/-est 通规则）。
// 根因：之前 realLookup 只查 normalize(lemma) 单键，古英语原样进 ha/do/sa 分片必 miss，KJV 整页全空。
const ARCHAIC_EN_LOOKUP: Record<string, string> = {
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
  // KJV 高频古代词/助动词（与 fallback.ts ARCHAIC_EN 同步；两表任一缺都会让整章 KJV 掉注出率）
  thou: 'you', thee: 'you', thy: 'your', thine: 'yours', ye: 'you',
  art: 'be', wast: 'be', wert: 'be',
  wilt: 'will', shalt: 'shall', canst: 'can',
  wouldst: 'would', shouldst: 'should', couldst: 'could',
};

/** 专名判定（en 首字母大写豁免用；de 全名词大写不适用，故仅 en）：长度>=2、首字母大写、仅字母/’'/- */
export function isProperNounSurface(lang: SourceLang, surface: string): boolean {
  if (lang !== 'en') return false;
  const s = String(surface ?? '').trim();
  if (s.length < 2) return false;
  if (!/^[A-Z]/.test(s)) return false;
  if (!/^[A-Za-z’'‑-]+$/.test(s)) return false;
  return true;
}

/** 英语屈折/派生候选（复数/过去/进行/副词/名词化）：返回 normalize 后待查形，去重、排除原形 */
function inflectionCandidates(lang: SourceLang, lemma: string): string[] {
  if (lang !== 'en') return [];
  const base = normalize(lang, lemma);
  if (!base || base.length < 3) return [];
  const out: string[] = [];
  const push = (c: string): void => {
    const nk = normalize(lang, c);
    if (nk && nk !== base && !out.includes(nk)) out.push(nk);
  };
  let w = base;
  // 所有格先剥（westminster's->westminster；Track B 真包不剥，此处双试兜底）
  if (w.length > 3 && (w.endsWith("'s") || w.endsWith('’s'))) {
    w = w.slice(0, -2);
    push(w);
  } else if (w.length > 2 && (w.endsWith("'") || w.endsWith('’'))) {
    w = w.slice(0, -1);
    push(w);
  }
  const stem = w;
  // 复数：sses->ss / ies->y / (s|x|z|ch|sh)es 去 es / 单 s
  if (stem.length > 3 && stem.endsWith('sses')) push(stem.slice(0, -2));
  else if (stem.length > 4 && stem.endsWith('ies')) push(stem.slice(0, -3) + 'y');
  else if (stem.length > 4 && stem.endsWith('es') && /(s|x|z|ch|sh)es$/.test(stem)) push(stem.slice(0, -2));
  else if (stem.length > 3 && stem.endsWith('s') && !stem.endsWith('ss')) push(stem.slice(0, -1));
  // -ing：reading->read / making->mak+ e=make / running->runn->run
  if (stem.length > 5 && stem.endsWith('ing')) {
    const b = stem.slice(0, -3);
    if (b) {
      push(b);
      push(`${b}e`);
      if (/(.)\1$/.test(b)) push(b.slice(0, -1));
    }
  }
  // -ed：walked->walk / loved->lov+e=love / stopped->stopp->stop
  if (stem.length > 4 && stem.endsWith('ed')) {
    const b = stem.slice(0, -2);
    if (b) {
      push(b);
      push(`${b}e`);
      if (/(.)\1$/.test(b)) push(b.slice(0, -1));
    }
  }
  // -ly：quickly->quick / happily->happi->happy
  if (stem.length > 5 && stem.endsWith('ly')) {
    const b = stem.slice(0, -2);
    if (b) {
      push(b);
      if (b.endsWith('i')) push(`${b.slice(0, -1)}y`);
    }
  }
  // 名词化 -ion：confession->confess；-tion +e：introduction->introduc+e=introduce
  if (stem.length > 5 && stem.endsWith('ion')) {
    push(stem.slice(0, -3));
    if (stem.endsWith('tion')) {
      const c = stem.slice(0, -4);
      if (c) {
        push(c);
        push(`${c}e`);
      }
    }
  }
  // -ness/-ment：goodness->good
  if (stem.length > 6 && stem.endsWith('ness')) push(stem.slice(0, -4));
  if (stem.length > 6 && stem.endsWith('ment')) push(stem.slice(0, -4));
  return out.slice(0, 10);
}
/** 古英语候选现代形（显式表 + -eth/-est 通规则返回 base / base+e 双候选）。 */
function archaicCandidates(lang: SourceLang, lemma: string): string[] {
  if (lang !== 'en') return [];
  const lower = String(lemma ?? '').trim().toLowerCase();
  if (!lower) return [];
  const hit = ARCHAIC_EN_LOOKUP[lower];
  if (hit) return [hit];
  if (lower.length > 4 && lower.endsWith('eth')) {
    const base = lower.slice(0, -3);
    if (!base) return [];
    if (base.endsWith('e') || base.endsWith('o') || base.endsWith('w') || base.endsWith('y')) return [base];
    return [base, `${base}e`];
  }
  if (lower.length > 4 && lower.endsWith('est')) {
    const base = lower.slice(0, -3);
    if (!base) return [];
    if (base.endsWith('e') || base.endsWith('o') || base.endsWith('w') || base.endsWith('y')) return [base];
    return [base, `${base}e`];
  }
  return [];
}

/** 德语屈折候选（动词人称/名词格/形容词尾）：normalize 后待查形，去重、排除原形。
 * 根因：de 包只有原形，liest/Helden/alte 原样进词典必 miss，德语整段全“—”。
 * 只增候选不减原形（原形优先命中），过剥误伤极少（剥后形多为非词）。 */
function germanCandidates(lemma: string): string[] {
  if (lemma === undefined) return [];
  const base = normalize('de', lemma);
  if (!base || base.length < 3) return [];
  const out: string[] = [];
  const push = (c: string): void => {
    const nk = normalize('de', c);
    if (nk && nk !== base && !out.includes(nk)) out.push(nk);
  };
  // 高频不规则（sein/haben/werden 系；normalize 后键）
  const irr: Record<string, string> = {
    ist: 'sein', sind: 'sein', bist: 'sein', war: 'sein', waren: 'sein',
    hat: 'haben', hast: 'haben', habe: 'haben', hatte: 'haben', hatten: 'haben',
    wird: 'werden', wirst: 'werden', wurde: 'werden', wurden: 'werden',
    kann: 'konnen', musst: 'mussen', musste: 'mussen', darf: 'durfen', soll: 'sollen',
  };
  if (irr[base]) push(irr[base]);
  const w = base;
  // 动词三单/二单：schützt->schütz/schütze/schützen；lässt->lass/lasse/lassen
  if (w.length > 4 && w.endsWith('st')) {
    const b = w.slice(0, -2);
    push(b);
    push(`${b}e`);
    push(`${b}en`);
  } else if (w.length > 4 && w.endsWith('t')) {
    const b = w.slice(0, -1);
    push(b);
    push(`${b}e`);
    push(`${b}en`);
  }
  // 名词复数/弱变化：Helden->Held；形容词尾：altem/guter/alte->alt/gut
  if (w.length > 4 && w.endsWith('en')) {
    push(w.slice(0, -2));
    push(w.slice(0, -1));
  } else if (w.length > 5 && w.endsWith('n')) {
    push(w.slice(0, -1));
  }
  if (w.length > 5 && /(em|er|es)$/.test(w)) push(w.slice(0, -2));
  // 二格 -s：Lebens->leben / Abends->abend（原形优先试过，本条只增候选）。
  if (w.length > 5 && w.endsWith('s')) push(w.slice(0, -1));
  if (w.length > 4 && w.endsWith('e')) push(w.slice(0, -1));
  return out.slice(0, 8);
}

/** 桥接英译文的可用形态：去括号注，>4 词的例句式变体直接丢弃（首词回退会撞出错误释义，
 * 如 "She dropped the parcel…" 首词 she）；单字母形一律丢弃（"D"->data 这类短路比缺词更坏）。
 * 介词/冠词首词同样丢弃：ja "to think" 首词 to 会撞出 en->zh 的 "to->到"，
 * 出る/思う/書く/聞く全注成“到”（pivot 串味比缺词更坏，宁缺毋错）。
 * 返回 [精确形, 首词]（相同则只留精确形）。 */
const PIVOT_HEAD_STOP = new Set(
  ['to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'as', 'a', 'an', 'the', 'and', 'or'],
);
function pivotEnForms(variant: string): string[] {
  const clean = variant
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    .toLowerCase();
  if (!clean) return [];
  const toks = clean.match(/[a-z]+(?:'[a-z]+)?/g) ?? [];
  if (toks.length === 0 || toks.length > 4) return [];
  const head = toks[0] as string;
  if (head.length < 2) return [];
  if (head === clean) return [clean];
  if (PIVOT_HEAD_STOP.has(head)) return [clean];
  return [clean, head];
}

/** 桥接（pivot）：小语种→目标缺词时，经英语转译（如 de→zh 经 de→en + en→zh）。
 * 根因：de/zh 等小对只有几十词（52 行），de/en 却有 4340 词；直接判 miss 整段全“—”。
 * 只在中转表够大时启用；德语先做屈折展开；英语侧精确形优先、首词回退。 */
async function pivotLookup(
  lang: SourceLang,
  target: TargetLang,
  lemma: string,
  surface?: string,
): Promise<string | null> {
  if (lang === 'en' || target === 'en') return null;
  // 日语单假名碎片永不桥接：は→en feather→zh 羽毛这类串味与直查同罪（诚实门禁锁）。
  if (lang === 'ja' && isJaKanaFragment(surface ?? lemma)) return null;
  const mid = await loadPair(lang, 'en');
  if (!mid || mid.size < 500) return null;
  const enMap = await loadPair('en', target);
  if (!enMap || enMap.size < 1000) return null;
  const keys = [normalize(lang, lemma)];
  if (lang === 'de') {
    for (const c of germanCandidates(lemma)) if (c && !keys.includes(c)) keys.push(c);
  }
  if (surface) {
    const sk = normalize(lang, surface);
    if (sk && !keys.includes(sk)) keys.push(sk);
  }
  for (const key of keys) {
    if (!key) continue;
    const variants = mid.get(key);
    if (!variants || !variants.length) continue;
    for (const v of variants.slice(0, 5)) {
      for (const ev of pivotEnForms(v)) {
        const hit = enMap.get(ev)?.[0] ?? null;
        if (hit) return hit;
        if (ev.includes(' ')) continue;
        for (const c of inflectionCandidates('en', ev).slice(0, 3)) {
          const h2 = enMap.get(c)?.[0] ?? null;
          if (h2) return h2;
        }
      }
    }
  }
  return null;
}

async function fetchDictText(url: string, sameOrigin: boolean): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'text/plain' } });
    if (!res.ok) return null;
    const text = await res.text();
    // 同源缺文件时 SPA 回退吐 index.html（200 text/html）—— 当缺失处理，走分片/R2。
    if (sameOrigin && (/text\/html/i.test(res.headers?.get?.('content-type') ?? '') || /^\s*<!doctype html/i.test(text))) return null;
    return text;
  } catch {
    return null;
  }
}

function parseDictText(text: string): CompactPair {
  const map = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const lemma = line.slice(0, tab);
    const gloss = line.slice(tab + 1);
    if (lemma) map.set(lemma, gloss ? gloss.split('\x1f') : []);
  }
  return map;
}

// R2 公开源（canonical 全量整包；同源缺失时的最后兜底；无 Worker，直读 r2.dev）。
const R2_PUBLIC = (import.meta.env?.VITE_R2_PUBLIC as string | undefined)
  ?? 'https://pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev';

async function loadPair(lang: SourceLang, target: TargetLang): Promise<CompactPair | null> {
  const key = `${lang}/${target}`;
  if (shardMem.has(key)) return shardMem.get(key) ?? null;
  // 在途合并：整章注出时数万查词同时触发 loadPair，去重到每对一次 fetch。
  // 根因：无去重时数千并发读同一静态文件，dev 服务器截断响应 producing 不完整 Map，
  // 先完成的完整 Map 又被后到的截断 Map 覆盖（shardMem 后写赢），整章德语全 miss。
  const ongoing = shardInflight.get(key);
  if (ongoing) return ongoing;
  const p = (async (): Promise<CompactPair | null> => {
    const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
    // 1) 同源整包（常规小包；copy-dict 进 dist，Pages 同源直取）。
    const whole = await fetchDictText(`${base}/dict/${lang}/${target}.dict`, true);
    if (whole !== null) return parseDictText(whole);
    // 2) 同源分片（超 20MB 整包被 split-dict 切掉，Pages 只发 .00/.01…）。
    const merged = new Map<string, string[]>();
    for (let n = 0; n < 16; n++) {
      const part = await fetchDictText(`${base}/dict/${lang}/${target}.dict.${String(n).padStart(2, '0')}`, true);
      if (part === null) break;
      for (const [lemma, gloss] of parseDictText(part)) merged.set(lemma, gloss);
    }
    if (merged.size > 0) return merged;
    // 3) R2 公开整包（canonical；跨源，需桶 CORS 放行 pages 域）。
    const r2 = await fetchDictText(`${R2_PUBLIC}/dict/${lang}/${target}.dict.br`, false);
    if (r2 !== null) return parseDictText(r2);
    return null;
  })().then(
    (map) => {
      shardMem.set(key, map);
      shardInflight.delete(key);
      return map;
    },
    () => {
      shardMem.set(key, null);
      shardInflight.delete(key);
      return null;
    },
  );
  shardInflight.set(key, p);
  return p;
}

async function realLookup(lang: SourceLang, target: TargetLang, lemma: string, surface?: string): Promise<string | null> {
  // 多试（与 TrackB getGloss 双试+单数回退对齐）：normalize lemma -> 古英语现代形 ->
  // 屈折/派生形（en）-> surface 原形（TrackB 真包过剥 base 形时兜底，如 de Haus->hau，
  // surface Haus 仍命中；lemma 优先，surface 只做最后回退）。
  // 根因：Westminster 页 of 命中而 Westminster/Confession 全 miss——除专名缺词外，
  // founded/confessions/introduction 类屈折/派生只查原形必 miss，需双试派生形（如 founded->found）。
  const keys = [normalize(lang, lemma)];
  for (const c of archaicCandidates(lang, lemma)) {
    const nk = normalize(lang, c);
    if (nk && !keys.includes(nk)) keys.push(nk);
  }
  for (const c of inflectionCandidates(lang, lemma)) {
    if (c && !keys.includes(c)) keys.push(c);
  }
  // 德语屈折展开（动词人称/名词格/形容词尾；原形优先，见 germanCandidates）。
  if (lang === 'de') {
    for (const c of germanCandidates(lemma)) {
      if (c && !keys.includes(c)) keys.push(c);
    }
  }
  // 日语活用展开（deinflectJa，原形优先）：買いました→買う、高かった→高い。
  // 根因：Intl.Segmenter 对活用形按词切分（買いました/高かった不断），lemmatize 又是
  // 恒等映射，活用形原样进词典必 miss，真日文整段全“—”。候选只增不减，猜错形在词典
  // 里不存在自然落选（ja-inflect.mjs，owner: packages/lang-packs/src/ja.mjs）。
  // 单字假名（は/を/ま/た/っ…）直接判 miss：多为助词碎片，直查只会串味（は→feather），
  // 比缺词更坏；单字汉字（家/本）不受影响。
  if (lang === 'ja') {
    // 日语 token 经恒等 lemmatize，lemma 即 surface：单字假名直接 miss。
    if (isJaKanaFragment(surface ?? lemma)) return null;
    const tryDeinflect = (form: string): void => {
      for (const c of deinflectJa(form).slice(0, 8)) {
        const nk = normalize(lang, c);
        if (nk && !keys.includes(nk)) keys.push(nk);
      }
    };
    tryDeinflect(lemma);
    if (surface && surface !== lemma) tryDeinflect(surface);
  }
  // Common English pack lemmatizers intentionally strip suffixes; restore
  // conservative dictionary candidates before declaring a miss.
  if (lang === 'en') {
    const suffixCandidates: Record<string, string[]> = {
      introduct: ['introduction'], westminst: ['westminster'], chapt: ['chapter'],
      scriptur: ['scripture'], languag: ['language'], compar: ['compare'],
      argu: ['argue'], confess: ['confession'], excelleth: ['excel'],
      occindent: ['occidental'], dispell: ['dispel'],
    };
    for (const c of suffixCandidates[normalize(lang, lemma)] ?? []) if (!keys.includes(c)) keys.push(c);
  }
  if (surface) {
    const sk = normalize(lang, surface);
    if (sk && !keys.includes(sk)) keys.push(sk);
  }
  const data = await loadPair(lang, target);
  for (const key of keys) {
    if (!key) continue;
    const hit = data?.get(key)?.[0] ?? null;
    if (hit) return hit;
  }
  return null;
}

export type GlossSource = 'cache' | 'dict';

/** 查词并区分来源：本地缓存命中 -> 'cache'，词典分片/mock 命中 -> 'dict'，缺词 -> null（由调用方送 LLM） */
export async function getGlossWithSource(
  lang: SourceLang,
  target: TargetLang,
  lemma: string,
  surface?: string,
): Promise<{ gloss: string | null; source: GlossSource | null }> {
  const key = await wordCacheKey(lang, target, lemma);
  const cached = cacheGet(key);
  if (cached) return { gloss: cached, source: 'cache' };

  let hit: string | null = null;
  try {
    hit = await realLookup(lang, target, lemma, surface);
  } catch {
    hit = null;
  }
  // 离线 fallback：真分片 miss 时试 mock（hello-en fixture + 无网可读；KJV 古英语已在上一步转现代形）。
  if (!hit) {
    try {
      hit = mockLookup(lang, target, lemma) ?? null;
      // mock 键为小写 lemma，古英语/屈折直查 miss 时再试现代形/派生形
      if (!hit && lang === 'en') {
        for (const c of archaicCandidates(lang, lemma)) {
          hit = mockLookup(lang, target, c) ?? null;
          if (hit) break;
        }
        if (!hit) {
          for (const c of inflectionCandidates(lang, lemma)) {
            hit = mockLookup(lang, target, c) ?? null;
            if (hit) break;
          }
        }
      }
    } catch {
      hit = null;
    }
  }
  if (hit) {
    cacheSet(key, hit);
    return { gloss: hit, source: 'dict' };
  }
  // 桥接转译（小语种->zh 经英语； shipped 数据，不新增来源口径，仍记 dict）。
  try {
    hit = await pivotLookup(lang, target, lemma, surface);
  } catch {
    hit = null;
  }
  if (hit) {
    cacheSet(key, hit);
    return { gloss: hit, source: 'dict' };
  }
  return { gloss: null, source: null };
}

export async function getGloss(lang: SourceLang, target: TargetLang, lemma: string): Promise<string | null> {
  return (await getGlossWithSource(lang, target, lemma)).gloss;
}

/** 批量查词（段落级），复用单查缓存 */
export async function getGlosses(
  lang: SourceLang,
  target: TargetLang,
  lemmas: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(
    lemmas.map(async (l) => {
      out.set(l, await getGloss(lang, target, l));
    }),
  );
  return out;
}

/** 批量查词并保留来源（render 层标注 glossSource 用；surfaces 与 lemmas 等长对齐，缺省即 lemma 本身） */
export async function getGlossesWithSource(
  lang: SourceLang,
  target: TargetLang,
  lemmas: string[],
  surfaces?: Array<string | null>,
): Promise<Map<string, { gloss: string | null; source: GlossSource | null }>> {
  const out = new Map<string, { gloss: string | null; source: GlossSource | null }>();
  await Promise.all(
    lemmas.map(async (l, i) => {
      out.set(l, await getGlossWithSource(lang, target, l, surfaces?.[i] ?? undefined));
    }),
  );
  return out;
}
