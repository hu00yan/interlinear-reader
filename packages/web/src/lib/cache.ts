// 释义缓存：localStorage 落盘（小字典常驻）+ 内存 Map（本会话热路径）。
// key 全部走 lib/hash 的 sha1 契约。IndexedDB 大缓存由 Track D 接管（TODO）。
//
// 性能口径（浏览器实测，见 PR 说明）：逐词 cacheSet 曾是整章注出的最大开销——
// 原实现每次 set 都 Object.keys(m) 扫全表做 LRU（空缓存 23µs/次，满 2000 条 84µs/次，
// 1,170 词一章就吃掉 ~139ms，占到 400 段注出的 55%）。
// 现改为内存 Map：size 是 O(1)，只有超限时才删最旧（Map 保插入序），摊还到近零。

const LS_KEY = 'ilr.gloss-cache.v1';
const MAX_ENTRIES = 2000;

/** 落盘形态（对象插入序 = LRU 时间序） */
type CacheRecord = Record<string, string>;

function readLS(): CacheRecord {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') as CacheRecord;
  } catch {
    return {};
  }
}

function writeLS(m: Map<string, string>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(m)));
  } catch {
    // 配额满：清空重试一次
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      /* ignore */
    }
  }
}

// 内存常驻 + 防抖刷盘：逐词查词不再走整 JSON parse/stringify。
// 首次 get/set 时 readLS 一次；之后读写只碰内存，set 后 300ms 合并写盘。
let mem: Map<string, string> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushListenersBound = false;

/** 超限时删最旧的一半（O(超出量)，非每次写都扫全表） */
function prune(m: Map<string, string>): void {
  if (m.size <= MAX_ENTRIES) return;
  const drop = Math.floor(m.size / 2);
  let n = 0;
  for (const k of m.keys()) {
    m.delete(k);
    if (++n >= drop) break;
  }
}

function flush(): void {
  if (flushTimer !== null) {
    try {
      clearTimeout(flushTimer);
    } catch {
      /* ignore */
    }
    flushTimer = null;
  }
  if (mem === null) return;
  prune(mem);
  writeLS(mem);
}

function scheduleFlush(): void {
  if (flushTimer !== null) return; // trailing 防抖：合并多次 set，只刷一次
  try {
    flushTimer = setTimeout(flush, 300);
    const t = flushTimer as unknown as { unref?: () => void };
    if (typeof t?.unref === 'function') t.unref();
  } catch {
    flushTimer = null;
  }
}

function bindFlushListeners(): void {
  if (flushListenersBound) return;
  flushListenersBound = true;
  try {
    const g = globalThis as unknown as {
      addEventListener?: (type: string, cb: () => void) => void;
      document?: { visibilityState?: string };
    };
    if (typeof g.addEventListener !== 'function') return;
    g.addEventListener('pagehide', flush);
    g.addEventListener('visibilitychange', () => {
      try {
        if (g.document?.visibilityState === 'hidden') flush();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* localStorage/事件不可用时内存照常用 */
  }
}

function ensureMem(): Map<string, string> {
  if (mem === null) mem = new Map(Object.entries(readLS()));
  bindFlushListeners();
  return mem;
}

export function cacheGet(key: string): string | null {
  return ensureMem().get(key) ?? null;
}

export function cacheSet(key: string, value: string): void {
  const m = ensureMem();
  // delete+set 保证重复写把该键移到最新（Map 插入序 = LRU 序）
  if (m.has(key)) m.delete(key);
  m.set(key, value);
  if (m.size > MAX_ENTRIES) prune(m);
  scheduleFlush();
}

const memSentence = new Map<string, Record<string, string>>();

export function sentenceMemGet(key: string) {
  return memSentence.get(key) ?? null;
}
export function sentenceMemSet(key: string, v: Record<string, string>) {
  if (memSentence.size > 500) memSentence.clear();
  memSentence.set(key, v);
}
