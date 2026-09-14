// Pair cache: one complete source→target dictionary per cache key.
// Table remains backward-compatible at the storage layer, but keys are now
// `${lang}/${target}` rather than per-lemma shards.
const DB_NAME = "interlinear-dict";
const STORE = "shards";
const mem = new Map(); // fallback + Node

let dbPromise = null;

function idb() {
  if (typeof indexedDB === "undefined") return null;
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function cacheGet(lang, shard) {
  const key = `${lang}/${shard}`;
  if (mem.has(key)) return { data: mem.get(key), from: "memory" };
  const db = idb();
  if (!db) return { data: null, from: "none" };
  try {
    const d = await db;
    const val = await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readonly");
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result ?? null);
      rq.onerror = () => reject(rq.error);
    });
    if (val) mem.set(key, val);
    return { data: val, from: val ? "indexeddb" : "none" };
  } catch {
    return { data: null, from: "none" };
  }
}

export async function cacheSet(lang, shard, data) {
  const key = `${lang}/${shard}`;
  mem.set(key, data);
  const db = idb();
  if (!db) return;
  try {
    const d = await db;
    await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(data, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* quota/offline: memory cache still serves */ }
}

export function cacheClear() {
  mem.clear();
}

export function cacheStats() {
  return { memoryShards: mem.size, keys: [...mem.keys()] };
}
