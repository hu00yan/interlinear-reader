// Gloss cache: local IndexedDB (+memory fallback) with read-through to the
// Workers shared cache. Write-through is idempotent (same key overwrites).
// Keys NEVER contain key material: sha1(lang|target|lemma|normalized-sentence).

import { sha1Hex } from "./sha1.ts";
import { containsKeyMaterial } from "./redact.ts";

/** NFKC + collapse whitespace + trim. Case is preserved (matters for el/de). */
export function normalizeSentenceText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Token-in-context key (locked spec). Same lemma in another sentence => other key. */
export function cacheKeyForToken(args: {
  lang: string;
  target: string;
  lemma: string;
  sentenceText: string;
}): string {
  return sha1Hex(
    `${args.lang}|${args.target}|${args.lemma}|${normalizeSentenceText(args.sentenceText)}`,
  );
}

/** Whole-sentence key for Mode C chapter caching. */
export function cacheKeyForSentence(args: {
  lang: string;
  target: string;
  sentenceText: string;
}): string {
  return sha1Hex(
    `${args.lang}|${args.target}|__sent__|${normalizeSentenceText(args.sentenceText)}`,
  );
}

export interface CacheEntry {
  gloss: string;
  lemma: string;
  cachedAt: number;
}

export interface GlossCacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: CacheEntry): Promise<void>;
}

function assertCacheSafe(key: string, value: unknown): void {
  if (containsKeyMaterial(key)) {
    throw new Error("cache key must never contain key material");
  }
  if (containsKeyMaterial(JSON.stringify(value))) {
    throw new Error("cache value must never contain key material");
  }
}

export class MemoryCacheStore implements GlossCacheStore {
  private map = new Map<string, CacheEntry>();
  private maxSize: number;

  constructor(maxSize = 5000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<CacheEntry | null> {
    return this.map.get(key) ?? null;
  }

  async set(key: string, value: CacheEntry): Promise<void> {
    assertCacheSafe(key, value);
    if (!this.map.has(key) && this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  /** Test/security helper: every stored key + value. */
  entries(): Array<[string, CacheEntry]> {
    return [...this.map.entries()];
  }
}

function indexedDBHandle(): any {
  const g = globalThis as Record<string, any>;
  return g["indexedDB"] ?? null;
}

export class IndexedDBCacheStore implements GlossCacheStore {
  static isSupported(): boolean {
    return indexedDBHandle() !== null;
  }

  private dbName: string;
  private storeName = "gloss";
  private db: any = null;

  constructor(dbName = "interlinear-gloss") {
    if (!IndexedDBCacheStore.isSupported()) {
      throw new Error("IndexedDB is unavailable in this environment");
    }
    this.dbName = dbName;
  }

  private open(): Promise<any> {
    if (this.db) return Promise.resolve(this.db);
    const idb = indexedDBHandle();
    return new Promise((resolve, reject) => {
      const req = idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(this.storeName, { keyPath: "key" });
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(mode: string, run: (store: any) => any): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, mode);
      const req = run(transaction.objectStore(this.storeName));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  async get(key: string): Promise<CacheEntry | null> {
    const row = await this.tx<{ entry?: CacheEntry } | undefined>("readonly", (s) =>
      s.get(key),
    );
    return row?.entry ?? null;
  }

  async set(key: string, value: CacheEntry): Promise<void> {
    assertCacheSafe(key, value);
    await this.tx("readwrite", (s) => s.put({ key, entry: value }));
  }
}

/** Local default: IndexedDB in browsers, memory elsewhere (tests/SSR). */
export function getDefaultStore(): GlossCacheStore {
  if (IndexedDBCacheStore.isSupported()) return new IndexedDBCacheStore();
  return new MemoryCacheStore();
}

/**
 * Remote Workers shared cache. Read-through GET, idempotent PUT.
 * NEVER sends Authorization or key material: key/value are asserted clean.
 *
 * Two wire shapes (see README § wire):
 * - `"v1"` (default, legacy mock): `GET /v1/gloss-cache?key=` → `{entry}|404`,
 *   `PUT /v1/gloss-cache {key,entry}` → `{ok:true}`.
 * - `"workers"` (locked contract: workers/cache.ts + CONTRACT.md):
 *   `GET /api/cache?key=` → `{hit,value}`,
 *   `PUT /api/cache?key= {value}` → `{ok:true}`.
 * New code must pass `apiVersion: "workers"`. Default stays `"v1"` until
 * web/workers cut over, to keep existing e2e green.
 */
export const SHARED_CACHE_KEY_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
export type SharedCacheApi = "v1" | "workers";

export class RemoteSharedCache {
  readonly baseUrl: string;
  readonly apiVersion: SharedCacheApi;
  private fetchImpl: typeof fetch;

  constructor(args: { baseUrl: string; fetchImpl?: typeof fetch; apiVersion?: SharedCacheApi }) {
    // baseUrl is an origin; tolerate a trailing /v1 since we append the
    // versioned path ourselves (prevents /v1/v1/... footguns).
    this.baseUrl = args.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new TypeError("RemoteSharedCache: baseUrl must be http(s)");
    }
    this.apiVersion = args.apiVersion ?? "v1";
    if (this.apiVersion !== "v1" && this.apiVersion !== "workers") {
      throw new TypeError(`RemoteSharedCache: unknown apiVersion ${args.apiVersion}`);
    }
    this.fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async get(key: string): Promise<CacheEntry | null> {
    assertCacheSafe(key, null);
    if (this.apiVersion === "workers" && !SHARED_CACHE_KEY_RE.test(key)) {
      throw new Error("shared cache key must be 40hex sha1 / 64hex sha256");
    }
    const path =
      this.apiVersion === "workers"
        ? `${this.baseUrl}/api/cache?key=${encodeURIComponent(key)}`
        : `${this.baseUrl}/v1/gloss-cache?key=${encodeURIComponent(key)}`;
    const resp = await this.fetchImpl(path, { method: "GET" });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`shared cache GET failed: HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    if (data["hit"] === false) return null;
    const entry = (data["entry"] ?? data["value"] ?? data) as CacheEntry | null;
    if (!entry || typeof entry !== "object" || typeof entry["gloss"] !== "string") {
      return null;
    }
    return entry as CacheEntry;
  }

  /** Idempotent: same key always converges to the same stored entry. */
  async put(key: string, entry: CacheEntry): Promise<void> {
    assertCacheSafe(key, entry);
    if (this.apiVersion === "workers" && !SHARED_CACHE_KEY_RE.test(key)) {
      throw new Error("shared cache key must be 40hex sha1 / 64hex sha256");
    }
    const path =
      this.apiVersion === "workers"
        ? `${this.baseUrl}/api/cache?key=${encodeURIComponent(key)}`
        : `${this.baseUrl}/v1/gloss-cache`;
    const body =
      this.apiVersion === "workers" ? { value: entry } : { key, entry };
    const resp = await this.fetchImpl(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`shared cache PUT failed: HTTP ${resp.status}`);
  }
}

/** Local-first store with remote read-through + best-effort write-through. */
export class CachedGlossStore implements GlossCacheStore {
  readonly local: GlossCacheStore;
  readonly remote: RemoteSharedCache | null;
  lastRemoteError: unknown = null;

  constructor(args: { local: GlossCacheStore; remote?: RemoteSharedCache | null }) {
    this.local = args.local;
    this.remote = args.remote ?? null;
  }

  async get(key: string): Promise<CacheEntry | null> {
    const hit = await this.local.get(key);
    if (hit || !this.remote) return hit;
    try {
      const entry = await this.remote.get(key);
      if (entry) await this.local.set(key, entry);
      return entry;
    } catch (error) {
      this.lastRemoteError = error;
      return null;
    }
  }

  async set(key: string, value: CacheEntry): Promise<{ remoteOk: boolean }> {
    await this.local.set(key, value);
    if (!this.remote) return { remoteOk: false };
    try {
      await this.remote.put(key, value);
      return { remoteOk: true };
    } catch (error) {
      this.lastRemoteError = error;
      return { remoteOk: false };
    }
  }
}
