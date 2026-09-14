// 释义缓存：localStorage LRU（小字典常驻）+ 内存 Map（本会话句缓存）。
// key 全部走 lib/hash 的 sha1 契约。IndexedDB 大缓存由 Track D 接管（TODO）。

const LS_KEY = 'ilr.gloss-cache.v1';
const MAX_ENTRIES = 2000;

type CacheMap = Record<string, string>;

function readLS(): CacheMap {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') as CacheMap;
  } catch {
    return {};
  }
}

function writeLS(m: CacheMap): void {
  const keys = Object.keys(m);
  if (keys.length > MAX_ENTRIES) {
    // 简单 LRU：删掉最早写入（对象插入序）的一半
    const drop = keys.slice(0, Math.floor(keys.length / 2));
    for (const k of drop) delete m[k];
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(m));
  } catch {
    // 配额满：清空重试一次
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
  }
}

export function cacheGet(key: string): string | null {
  return readLS()[key] ?? null;
}

export function cacheSet(key: string, value: string): void {
  const m = readLS();
  m[key] = value;
  writeLS(m);
}

const memSentence = new Map<string, Record<string, string>>();

export function sentenceMemGet(key: string) {
  return memSentence.get(key) ?? null;
}
export function sentenceMemSet(key: string, v: Record<string, string>) {
  if (memSentence.size > 500) memSentence.clear();
  memSentence.set(key, v);
}
