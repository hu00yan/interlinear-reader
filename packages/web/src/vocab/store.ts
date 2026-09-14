// 生词本：localStorage 主存（同步、刷新不丢）+ IndexedDB 镜像（大释义/历史，Track D 可接管扩展）。
// 验收“刷新后已知词还在”依赖本模块的 localStorage 部分。

import type { SourceLang } from '../types.js';

export interface VocabEntry {
  lemma: string;
  lang: SourceLang;
  gloss: string;
  sentence: string;
  addedAt: number;
  known: boolean;
}

const LS_KNOWN = 'ilr.known.v1'; // Record<lang, lemma[]>
const LS_VOCAB = 'ilr.vocab.v1'; // VocabEntry[]
const DB_NAME = 'ilr';
const DB_STORE = 'vocab';

type KnownMap = Record<string, string[]>;

function readJSON<T>(key: string, fb: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fb;
  } catch {
    return fb;
  }
}

export function isKnown(lang: SourceLang, lemma: string): boolean {
  const m = readJSON<KnownMap>(LS_KNOWN, {});
  return (m[`${lang}`] ?? []).includes(lemma.toLowerCase());
}

export function setKnown(lang: SourceLang, lemma: string, known: boolean): void {
  const m = readJSON<KnownMap>(LS_KNOWN, {});
  const k = `${lang}`;
  const set = new Set((m[k] ?? []).map((s) => s.toLowerCase()));
  const l = lemma.toLowerCase();
  if (known) set.add(l);
  else set.delete(l);
  m[k] = [...set];
  localStorage.setItem(LS_KNOWN, JSON.stringify(m));
}

export function listVocab(): VocabEntry[] {
  return readJSON<VocabEntry[]>(LS_VOCAB, []);
}

export function addVocab(e: VocabEntry): void {
  const list = listVocab();
  const i = list.findIndex((x) => x.lang === e.lang && x.lemma.toLowerCase() === e.lemma.toLowerCase());
  if (i >= 0) list[i] = e;
  else list.unshift(e);
  localStorage.setItem(LS_VOCAB, JSON.stringify(list.slice(0, 5000)));
  mirrorToIDB(e).catch(() => undefined);
}

export function removeVocab(lang: SourceLang, lemma: string): void {
  const list = listVocab().filter((x) => !(x.lang === lang && x.lemma.toLowerCase() === lemma.toLowerCase()));
  localStorage.setItem(LS_VOCAB, JSON.stringify(list));
}

export function exportVocabJSON(): string {
  return JSON.stringify({ known: readJSON(LS_KNOWN, {}), vocab: listVocab() }, null, 2);
}

// ---- IndexedDB 镜像（渐进增强，失败静默） ----
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE, { keyPath: ['lang', 'lemma'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function mirrorToIDB(e: VocabEntry): Promise<void> {
  if (!('indexedDB' in window)) return;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put({ ...e });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
