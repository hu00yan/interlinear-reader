// Three-mode orchestration.
// Mode A (default): on-demand for tapped sentences; cache first, LLM for the rest
//   (dictionary candidates ride along for choice-style disambiguation).
// Mode B: dictionary + cache only. NEVER calls the LLM.
// Mode C: whole-chapter batch with per-chapter cap, user confirmation, progress.

import type {
  Candidate,
  GlossBatchInput,
  SentenceInput,
} from "./types.ts";
import { cacheKeyForToken, type GlossCacheStore } from "./cache.ts";

export const Mode = { A: "A", B: "B", C: "C" } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export type GlossSource = "dict" | "cache" | "llm";

export interface OrchestratedGloss {
  i: number;
  lemma: string;
  gloss: string;
  source: GlossSource;
  /** Mode B only: no dictionary entry existed; gloss falls back to the lemma. */
  dictMiss?: boolean;
}

export interface OrchestrateStats {
  sentences: number;
  tokens: number;
  fromCache: number;
  fromDict: number;
  fromLlm: number;
  dictMiss: number;
  truncated: number;
}

/** Track B dictionary surface. Empty array = unknown word (straight to LLM in A/C). */
export interface DictAdapter {
  lookup(args: {
    lang: string;
    target: string;
    lemma: string;
    surface: string;
    sentenceText: string;
  }): Candidate[];
}

export interface LlmAdapter {
  glossBatch(input: GlossBatchInput): Promise<Record<string, Array<{ i: number; lemma: string; gloss: string }>>>;
}

export interface ChapterConfirmInfo {
  mode: Mode;
  sentenceCount: number;
  tokenCount: number;
}

export class UserAbortedError extends Error {
  code = "E_ABORTED";
  constructor(message = "chapter gloss was not confirmed by the user") {
    super(message);
    this.name = "UserAbortedError";
  }
}

export interface OrchestrateOptions {
  mode: Mode;
  lang: string;
  target: string;
  sentences: SentenceInput[];
  dict: DictAdapter;
  cache?: GlossCacheStore | null;
  llm?: LlmAdapter | null;
  /** Mode C: called before any LLM spend. Falsy return aborts (UserAbortedError). */
  confirmChapter?: (info: ChapterConfirmInfo) => boolean | Promise<boolean>;
  /** Mode C per-chapter ceiling. Default 200. */
  maxSentencesPerChapter?: number;
  /** Mode C orchestrator batching (client still throttles HTTP). Default 10. */
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface OrchestrateResult {
  glosses: Record<string, OrchestratedGloss[]>;
  stats: OrchestrateStats;
}

function keyFor(lang: string, target: string, lemma: string, text: string): string {
  return cacheKeyForToken({ lang, target, lemma, sentenceText: text });
}

export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const cache = opts.cache ?? null;
  const stats: OrchestrateStats = {
    sentences: 0,
    tokens: 0,
    fromCache: 0,
    fromDict: 0,
    fromLlm: 0,
    dictMiss: 0,
    truncated: 0,
  };
  const glosses: Record<string, OrchestratedGloss[]> = {};
  const { lang, target } = opts;

  if (opts.mode === "B") {
    for (const s of opts.sentences) {
      const items: OrchestratedGloss[] = [];
      for (const t of s.tokens) {
        stats.tokens += 1;
        const hit = cache ? await cache.get(keyFor(lang, target, t.lemma, s.text)) : null;
        if (hit) {
          stats.fromCache += 1;
          items.push({ i: t.i, lemma: t.lemma, gloss: hit.gloss, source: "cache" });
          continue;
        }
        const cands = opts.dict.lookup({
          lang,
          target,
          lemma: t.lemma,
          surface: t.surface,
          sentenceText: s.text,
        });
        if (cands.length > 0) {
          stats.fromDict += 1;
          items.push({ i: t.i, lemma: t.lemma, gloss: cands[0].gloss, source: "dict" });
          if (cache) {
            await cache.set(keyFor(lang, target, t.lemma, s.text), {
              gloss: cands[0].gloss,
              lemma: t.lemma,
              cachedAt: Date.now(),
            });
          }
        } else {
          stats.dictMiss += 1;
          items.push({ i: t.i, lemma: t.lemma, gloss: t.lemma, source: "dict", dictMiss: true });
        }
      }
      items.sort((a, b) => a.i - b.i);
      glosses[s.id] = items;
      stats.sentences += 1;
    }
    return { glosses, stats };
  }

  // Modes A and C share the cache-first + LLM-miss path; C adds cap + confirm.
  let sentences = opts.sentences;
  if (opts.mode === "C") {
    const cap = opts.maxSentencesPerChapter ?? 200;
    if (sentences.length > cap) {
      stats.truncated = sentences.length - cap;
      sentences = sentences.slice(0, cap);
    }
    if (opts.confirmChapter) {
      const tokenCount = sentences.reduce((n, s) => n + s.tokens.length, 0);
      const ok = await opts.confirmChapter({
        mode: "C",
        sentenceCount: sentences.length,
        tokenCount,
      });
      if (!ok) throw new UserAbortedError();
    }
  }
  if (!opts.llm) throw new TypeError(`orchestrate: mode ${opts.mode} requires an llm adapter`);

  const total = sentences.length;
  let done = 0;
  const batchSize = Math.max(1, opts.batchSize ?? 10);
  for (let b = 0; b < sentences.length; b += batchSize) {
    const batch = sentences.slice(b, b + batchSize);
    // 1) cache sweep
    const pending: SentenceInput[] = [];
    const cachedBySentence = new Map<string, OrchestratedGloss[]>();
    for (const s of batch) {
      const cached: OrchestratedGloss[] = [];
      const missing: typeof s.tokens = [];
      for (const t of s.tokens) {
        stats.tokens += 1;
        const hit = cache ? await cache.get(keyFor(lang, target, t.lemma, s.text)) : null;
        if (hit) {
          stats.fromCache += 1;
          cached.push({ i: t.i, lemma: t.lemma, gloss: hit.gloss, source: "cache" });
        } else {
          missing.push({
            ...t,
            candidates: opts.dict.lookup({
              lang,
              target,
              lemma: t.lemma,
              surface: t.surface,
              sentenceText: s.text,
            }),
          });
        }
      }
      cachedBySentence.set(s.id, cached);
      if (missing.length > 0) pending.push({ id: s.id, text: s.text, tokens: missing });
    }
    // 2) one LLM call per orchestrator batch for the misses (even candidate-less ones)
    let llmOut: Record<string, Array<{ i: number; lemma: string; gloss: string }>> = {};
    if (pending.length > 0) {
      llmOut = await opts.llm.glossBatch({ lang, target, sentences: pending });
    }
    // 3) merge + write-through cache
    for (const s of batch) {
      const items = cachedBySentence.get(s.id) ?? [];
      for (const g of llmOut[s.id] ?? []) {
        stats.fromLlm += 1;
        items.push({ i: g.i, lemma: g.lemma, gloss: g.gloss, source: "llm" });
        if (cache) {
          await cache.set(keyFor(lang, target, g.lemma || "", s.text), {
            gloss: g.gloss,
            lemma: g.lemma,
            cachedAt: Date.now(),
          });
        }
      }
      items.sort((a, b) => a.i - b.i);
      glosses[s.id] = items;
      stats.sentences += 1;
      done += 1;
      opts.onProgress?.(done, total);
    }
  }
  return { glosses, stats };
}
