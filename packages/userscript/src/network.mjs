import { parseDict } from "./core.mjs";

export const R2_PUBLIC = "https://pub-3d23245bf2874c8cbdf740c1d2761ada.r2.dev";
const CACHE_KEY = "ilr-dict-cache-v1";
export const CACHE_BUDGET = 2 * 1024 * 1024;
const MAX_DICT = 32 * 1024 * 1024;

export function request(details, signal, maxBytes = MAX_DICT) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Cancelled", "AbortError"));
      return;
    }
    let handle;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      fn(value);
    };
    const abort = () => {
      finish(reject, new DOMException("Cancelled", "AbortError"));
      handle?.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    handle = GM_xmlhttpRequest({
      ...details,
      anonymous: true,
      redirect: "error",
      timeout: 30000,
      onprogress: (event) => {
        if (event.loaded > maxBytes) {
          finish(reject, new Error("Response too large"));
          handle?.abort();
        }
      },
      onload: (response) => {
        // Final URL check is defense in depth; redirect:error must be honored by the manager.
        if (response.finalUrl && response.finalUrl !== details.url) {
          finish(reject, new Error("Redirect rejected"));
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          finish(reject, new Error(`HTTP ${response.status}`));
          return;
        }
        if (
          typeof response.responseText !== "string" ||
          response.responseText.length * 2 > maxBytes
        ) {
          finish(reject, new Error("Response too large"));
          return;
        }
        finish(resolve, response.responseText);
      },
      onerror: () => finish(reject, new Error("Network request failed")),
      ontimeout: () => finish(reject, new Error("Request timed out")),
      onabort: () => finish(reject, new DOMException("Cancelled", "AbortError")),
    });
  });
}

// Whole-object cache: no per-lemma requests, URLs never contain page words.
// Oversized pairs remain in memory only. GM storage contains dictionary data, never excerpts.
export class Dictionary {
  constructor() {
    this.memory = new Map();
    this.inflight = new Map();
  }
  async load(lang, signal) {
    if (!["ja", "en"].includes(lang)) throw new Error("Unsupported language");
    if (this.memory.has(lang)) return this.memory.get(lang);
    const ongoing = this.inflight.get(lang);
    if (ongoing && ongoing.signal === signal) return ongoing.promise;
    const promise = this.loadFresh(lang, signal);
    this.inflight.set(lang, { promise, signal });
    try {
      return await promise;
    } finally {
      if (this.inflight.get(lang)?.promise === promise) this.inflight.delete(lang);
    }
  }
  async loadFresh(lang, signal) {
    let cache = GM_getValue(CACHE_KEY, []);
    if (!Array.isArray(cache)) cache = [];
    cache = cache.filter(
      (e) =>
        e && ["ja", "en"].includes(e.lang) && typeof e.text === "string" && Number.isFinite(e.at)
    );
    const entry = cache.find((e) => e.lang === lang && Date.now() - e.at < 7 * 86400000);
    if (entry) {
      try {
        const map = parseDict(entry.text);
        this.memory.set(lang, map);
        GM_setValue(CACHE_KEY, boundedCache(cache, { ...entry, used: Date.now() }));
        return map;
      } catch {
        /* corrupt cache: fetch anew */
      }
    }
    let text, map;
    for (const suffix of [".dict.br", ".dict"]) {
      try {
        text = await request(
          {
            method: "GET",
            url: `${R2_PUBLIC}/dict/${lang}/zh${suffix}`,
            headers: { Accept: "text/plain" },
          },
          signal
        );
        // R2 publishes .br with Content-Encoding: br; browser/GM decodes it.
        // Raw compressed bytes are not executable and are rejected, then plain fallback is tried.
        map = parseDict(text);
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    if (!map) throw new Error("Dictionary unavailable");
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    this.memory.set(lang, map);
    // Re-read: concurrent language loads must not clobber one another.
    cache = GM_getValue(CACHE_KEY, []);
    try {
      GM_setValue(
        CACHE_KEY,
        boundedCache(Array.isArray(cache) ? cache : [], {
          lang,
          text,
          at: Date.now(),
          used: Date.now(),
        })
      );
    } catch {
      /* quota: memory still works */
    }
    return map;
  }
  clear() {
    this.memory.clear();
    GM_setValue(CACHE_KEY, []);
  }
}

export function boundedCache(cache, entry, budget = CACHE_BUDGET) {
  const out = cache.filter((e) => e?.lang !== entry.lang && typeof e?.text === "string");
  out.push(entry);
  out.sort((a, b) => (a.used ?? a.at) - (b.used ?? b.at));
  // Conservative UTF-16 serialized-size accounting includes keys/metadata.
  while (out.length && JSON.stringify(out).length * 2 > budget) out.shift();
  return out;
}
