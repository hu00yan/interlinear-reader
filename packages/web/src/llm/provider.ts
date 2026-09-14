// OpenAI 兼容协议客户端（锁死：只做 OpenAI 兼容，Response API 首版不做）。
// key 只存浏览器 localStorage、浏览器直调 LLM，无代理、无服务端。
// 缺词走 `provider.glossSentence()`（契约锁死）。

import type { SourceLang, TargetLang } from '../types.js';
import { sentenceCacheKey } from '../lib/hash.js';
import { sentenceMemGet, sentenceMemSet } from '../lib/cache.js';
import { estimateCostUSD, estimateTokens } from '../lib/cost.js';

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class ProviderError extends Error {
  status?: number;
  constructor(msg: string, status?: number) {
    super(msg);
    this.status = status;
  }
}

function cleanBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * 整句释义：输入原文句 + 待查 lemma 列表，返回 lemma->gloss。
 * prompt 要求模型只输出 JSON，便于解析；解析失败抛错由调用方降级。
 */
export async function glossSentence(
  cfg: ProviderConfig,
  lang: SourceLang,
  target: TargetLang,
  sentence: string,
  lemmas: string[],
  fetchFn: typeof fetch = fetch,
): Promise<{ glosses: Record<string, string>; raw: string; costUSD: number }> {
  if (!cfg.apiKey) throw new ProviderError('缺少 API Key（设置页填写，仅存 localStorage）');
  const key = await sentenceCacheKey(lang, target, sentence + '‖' + lemmas.join(','));
  const mem = sentenceMemGet(key);
  if (mem) return { glosses: mem, raw: '', costUSD: 0 };

  const targetName = target === 'zh' ? '简体中文' : 'simple English';
  const sys =
    `You are a dictionary for language learners. Source language: ${lang}. ` +
    `Gloss each requested lemma in ${targetName}, very short (1-4 words/字). ` +
    `Return ONLY a JSON object mapping lemma to gloss. No markdown, no extra text.`;
  const user = `Sentence: ${sentence}\nLemmas: ${JSON.stringify(lemmas)}`;

  const url = `${cleanBase(cfg.baseUrl)}/chat/completions`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0 }),
    });
  } catch (e) {
    throw new ProviderError(`网络请求失败（浏览器直调）：${(e as Error).message}`);
  }
  if (!resp.ok) throw new ProviderError(`LLM ${resp.status}：${(await resp.text()).slice(0, 300)}`, resp.status);
  const data = (await resp.json()) as ChatResponse;
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  const glosses = parseGlossJson(raw);
  sentenceMemSet(key, glosses);
  const costUSD = estimateCostUSD(sys + user, raw);
  return { glosses, raw, costUSD };
}

/** 整页/整章批量释义：一次请求带多句 + 上下文（一词多义靠上下文选义）。
 * 与 glossSentence 同缓存口径（句键含 lemmas），命中句不发网；返回 id->lemma->gloss。
 *
 * 上下文自适应（用户口径：一本书的上下文最充足，但长书一次装不下）：
 * - `context` 为局部上文（当前页/章附近，成本低、必带）；
 * - `glossary` 为全书术语表（书名/专名/作者自造词 → 固定译法），整书提炼一次、分块复用；
 * - 调用方按 `chunkBudget` 自适应切块（见 chunkByChars），先塞满预算再发下一批。 */
export interface BatchSentence {
  id: string;
  text: string;
  lemmas: string[];
}

export interface BatchOptions {
  /** 全书术语表（term -> 固定译法）：保证同一专名全书一致。 */
  glossary?: Record<string, string>;
  /** 单次请求的上下文字符预算（正文+上下文），超出即切块。 */
  maxChars?: number;
}

/** 按累计字符预算切块：单句超预算时独占一块（不切句，保证句内上下文完整）。 */
export function chunkByChars<T>(items: T[], sizeOf: (t: T) => number, maxChars: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const it of items) {
    const s = sizeOf(it);
    if (cur.length && n + s > maxChars) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(it);
    n += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

export async function glossBatchPage(
  cfg: ProviderConfig,
  lang: SourceLang,
  target: TargetLang,
  context: string,
  sentences: BatchSentence[],
  fetchFn: typeof fetch = fetch,
  options: BatchOptions = {},
): Promise<{ glosses: Map<string, Record<string, string>>; raw: string; costUSD: number }> {
  const out = new Map<string, Record<string, string>>();
  const pending = [];
  for (const s of sentences) {
    if (!cfg.apiKey) throw new ProviderError('缺少 API Key（设置页填写，仅存 localStorage）');
    const key = await sentenceCacheKey(lang, target, s.text + '‖' + s.lemmas.join(','));
    const mem = sentenceMemGet(key);
    if (mem) {
      const picked: Record<string, string> = {};
      for (const l of s.lemmas) if (mem[l] !== undefined) picked[l] = mem[l];
      out.set(s.id, picked);
    } else {
      pending.push(s);
    }
  }
  if (pending.length === 0) return { glosses: out, raw: '', costUSD: 0 };

  const targetName = target === 'zh' ? '简体中文' : 'simple English';
  const glossary = options.glossary ?? {};
  const glossaryTerms = Object.keys(glossary);
  const sys =
    `You are a dictionary for language learners. Source language: ${lang}. ` +
    `A CHAPTER excerpt is given for context only (do not gloss it). ` +
    `Gloss each requested lemma in ${targetName}, very short (1-4 words/字). ` +
    `Use the chapter context to pick the correct sense of polysemous words. ` +
    (glossaryTerms.length
      ? `This book has an established glossary — use these fixed renderings whenever the term appears: ` +
        `${JSON.stringify(glossary)}. `
      : '') +
    `Use the requested lemma strings EXACTLY as given as the JSON keys — never correct, ` +
    `re-spell, normalize, or replace them. ` +
    `Return ONLY a JSON object mapping sentence id to {lemma: gloss}. No markdown, no extra text.`;
  const user = JSON.stringify({
    chapter: context,
    sentences: pending.map((s) => ({ id: s.id, text: s.text, lemmas: s.lemmas })),
  });

  const url = `${cleanBase(cfg.baseUrl)}/chat/completions`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0 }),
    });
  } catch (e) {
    throw new ProviderError(`网络请求失败（浏览器直调）：${(e as Error).message}`);
  }
  if (!resp.ok) throw new ProviderError(`LLM ${resp.status}：${(await resp.text()).slice(0, 300)}`, resp.status);
  const data = (await resp.json()) as ChatResponse;
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed = parseBatchJson(raw);
  for (const s of pending) {
    // 键对齐：模型偶尔把 lemma 回写成自然拼写（如请求 borborygmu 却回 borborygmus，
    // 词典包的过剥形与原形差一个后缀），此处按请求词表把返回键对回原 lemma，
    // 否则 annotateParagraphs 按 t.lemma 取值会整页 miss。
    const got = alignGlossKeys(parsed.get(s.id) ?? {}, s.lemmas);
    out.set(s.id, got);
    if (Object.keys(got).length) {
      const key = await sentenceCacheKey(lang, target, s.text + '‖' + s.lemmas.join(','));
      sentenceMemSet(key, got);
    }
  }
  const costUSD = estimateCostUSD(sys + user, raw);
  return { glosses: out, raw, costUSD };
}

/** 把模型返回的释义键对回请求的 lemma 词表（精确 > 忽略大小写 > 前缀互为包含）。
 * 命中的原键同时保留，正文侧 lemma/surface 两种取值都能命中。 */
export function alignGlossKeys(input: Record<string, string>, lemmas: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const lc = new Map<string, string>();
  for (const l of lemmas) if (l) lc.set(l.toLowerCase(), l);
  for (const [k, v] of Object.entries(input)) {
    if (!v) continue;
    let key = k;
    const lk = k.toLowerCase();
    if (!lc.has(lk)) {
      for (const l of lemmas) {
        const ll = l.toLowerCase();
        // 过剥形 borborygmu 与自然形 borborygmus 互为前缀；len>=4 防短词误配
        if (ll.length >= 4 && (lk.startsWith(ll) || ll.startsWith(lk))) {
          key = l;
          break;
        }
      }
    }
    out[key] = v;
    if (key !== k) out[k] = v;
  }
  return out;
}

function parseBatchJson(raw: string): Map<string, Record<string, string>> {
  const cleaned = raw.replace(/^```json\s*|^```\s*|```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ProviderError(`LLM 返回非 JSON：${raw.slice(0, 200)}`);
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const out = new Map<string, Record<string, string>>();
  for (const [id, v] of Object.entries(obj)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    const m: Record<string, string> = {};
    for (const [k, g] of Object.entries(v as Record<string, unknown>)) m[k] = String(g).slice(0, 60);
    out.set(id, m);
  }
  return out;
}

/** 单词点查（Mode A 点词）：复用 glossSentence，lemmas=[lemma] */
export async function glossWord(
  cfg: ProviderConfig,
  lang: SourceLang,
  target: TargetLang,
  sentence: string,
  lemma: string,
  fetchFn: typeof fetch = fetch,
) {
  return glossSentence(cfg, lang, target, sentence, [lemma], fetchFn);
}

/** Auto 万能分词+注 token（不经词典/分词包，源语言由 LLM 自动识别）。 */
export interface AutoGlossToken {
  surface: string;
  lemma: string;
  gloss: string;
}

/**
 * Auto/万能整句分词+注：直接整句送 LLM（源语言自动识别，只需指定目标 zh/en）。
 * 无包语言（如阿语）可用。不经词典/分词包。
 * 缓存键沿用 sha1(`auto|target|lemma|句`) 口径：句级键 = sentenceCacheKey('auto', target, 句)
 * （同 lib/hash sha1，lang 槽固定 'auto'；命中后零费用；key 为 40 hex，经 workers KEY_RE）。
 */
export async function autoSegmentGloss(
  cfg: ProviderConfig,
  target: TargetLang,
  sentence: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ tokens: AutoGlossToken[]; detectedLang: string; raw: string; costUSD: number }> {
  if (!cfg.apiKey) throw new ProviderError('缺少 API Key（设置页填写，仅存 localStorage）');
  if (!sentence.trim()) return { tokens: [], detectedLang: '', raw: '', costUSD: 0 };
  // sha1(auto|target||归一化句)：与 glossSentence 同函数、lang 固定 'auto'（见 lib/hash.ts）。
  const key = await sentenceCacheKey('auto', target, sentence);
  const mem = sentenceMemGet(key);
  if (mem) {
    const cached = parseAutoMem(mem);
    if (cached) return { tokens: cached.tokens, detectedLang: cached.detectedLang, raw: '', costUSD: 0 };
  }

  const targetName = target === 'zh' ? '简体中文' : 'simple English';
  const sys =
    `You are an interlinear gloss engine for ANY language (universal mode). ` +
    `Auto-detect the source language of each sentence (do NOT ask the user). ` +
    `Segment each sentence into words (keep punctuation out of tokens), ` +
    `then write ONE short gloss per token in ${targetName} (1-4 words/字, proper names as-is). ` +
    `Reply with strict JSON only, exactly this shape: ` +
    `{"sentences":[{"id":"s1","detectedLang":"<bcp47>","tokens":[{"i":0,"surface":"<word>","lemma":"<word>","gloss":"<gloss>"}]}]} ` +
    `No markdown fences, no commentary.`;
  const user = JSON.stringify({
    lang: 'auto',
    target,
    instruction: `Auto-detect source language. Segment every sentence into words and gloss each token into ${target}.`,
    sentences: [{ id: 's1', text: sentence }],
  });

  const url = `${cleanBase(cfg.baseUrl)}/chat/completions`;
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0 }),
    });
  } catch (e) {
    throw new ProviderError(`网络请求失败（浏览器直调）：${(e as Error).message}`);
  }
  if (!resp.ok) throw new ProviderError(`LLM ${resp.status}：${(await resp.text()).slice(0, 300)}`, resp.status);
  const data = (await resp.json()) as ChatResponse;
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  const { tokens, detectedLang } = parseAutoGlossJson(raw);
  // 句级记忆：gloss map 存 surface->gloss + 保留 tokens/detectedLang（JSON 包一层，前缀 AUTO1|）。
  const memOut: Record<string, string> = { __auto__: JSON.stringify({ tokens, detectedLang }) };
  for (const t of tokens) memOut[t.surface] = t.gloss;
  sentenceMemSet(key, memOut);
  const costUSD = estimateCostUSD(sys + user, raw);
  return { tokens, detectedLang, raw, costUSD };
}

function parseAutoMem(mem: Record<string, string>): { tokens: AutoGlossToken[]; detectedLang: string } | null {
  try {
    const raw = mem['__auto__'];
    if (!raw) return null;
    const o = JSON.parse(raw) as { tokens?: AutoGlossToken[]; detectedLang?: string };
    if (!Array.isArray(o.tokens)) return null;
    return { tokens: o.tokens, detectedLang: o.detectedLang ?? '' };
  } catch {
    return null;
  }
}

/** 解析 Auto LLM 返回：兼容 sentences/results/数组/Record + tokens/glosses 别名 + fence/散文。 */
export function parseAutoGlossJson(raw: string): { tokens: AutoGlossToken[]; detectedLang: string } {
  const data = extractAutoJson(raw);
  if (data === undefined) throw new ProviderError(`LLM 返回非 JSON：${raw.slice(0, 200)}`);
  const entries = autoSentenceEntries(data);
  // 本 web 客户端每次只送单句 s1；取首个命中句的 tokens。
  const first = entries.find((e) => Array.isArray(e.tokens) && (e.tokens as unknown[]).length > 0) ?? entries[0];
  if (!first || !Array.isArray(first.tokens)) throw new ProviderError(`LLM 返回非 JSON：${raw.slice(0, 200)}`);
  const tokens: Array<AutoGlossToken & { i: number }> = [];
  const seen = new Set<number>();
  (first.tokens as unknown[]).forEach((t, idx) => {
    const c = coerceAutoToken(t, idx);
    if (!c || seen.has(c.i)) return;
    seen.add(c.i);
    tokens.push({ i: c.i, surface: c.surface, lemma: c.lemma, gloss: c.gloss });
  });
  if (tokens.length === 0) throw new ProviderError(`LLM 返回非 JSON：${raw.slice(0, 200)}`);
  tokens.sort((a, b) => a.i - b.i);
  // 去掉排序用的 i（不外泄）
  const cleaned = tokens.map((t) => ({ surface: t.surface, lemma: t.lemma, gloss: t.gloss }));
  const detectedLang = typeof first.detectedLang === 'string' ? first.detectedLang : '';
  return { tokens: cleaned, detectedLang };
}

function coerceAutoToken(raw: unknown, fallbackIndex: number): { i: number; surface: string; lemma: string; gloss: string } | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const i = typeof r['i'] === 'number' ? (r['i'] as number) : fallbackIndex;
  const surface =
    typeof r['surface'] === 'string' && (r['surface'] as string).trim() !== ''
      ? (r['surface'] as string)
      : typeof r['lemma'] === 'string'
        ? (r['lemma'] as string)
        : '';
  const lemma =
    typeof r['lemma'] === 'string' && (r['lemma'] as string).trim() !== ''
      ? (r['lemma'] as string)
      : surface;
  const gloss = typeof r['gloss'] === 'string' ? (r['gloss'] as string).trim() : '';
  if (!Number.isInteger(i) || i < 0 || !surface || !gloss) return null;
  return { i, surface, lemma, gloss };
}

function autoSentenceEntries(data: unknown): Array<{ tokens: unknown; detectedLang?: unknown }> {
  if (Array.isArray(data)) {
    return data
      .filter((s) => s !== null && typeof s === 'object' && typeof (s as Record<string, unknown>)['id'] === 'string')
      .map((s) => {
        const r = s as Record<string, unknown>;
        return { tokens: r['tokens'] ?? r['glosses'] ?? [], detectedLang: r['detectedLang'] };
      });
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return [];
  const r = data as Record<string, unknown>;
  const list = Array.isArray(r['sentences']) ? (r['sentences'] as unknown[]) : Array.isArray(r['results']) ? (r['results'] as unknown[]) : null;
  if (list) {
    return list
      .filter((s) => s !== null && typeof s === 'object' && typeof (s as Record<string, unknown>)['id'] === 'string')
      .map((s) => {
        const sr = s as Record<string, unknown>;
        return { tokens: sr['tokens'] ?? sr['glosses'] ?? [], detectedLang: sr['detectedLang'] };
      });
  }
  const out: Array<{ tokens: unknown }> = [];
  for (const arr of Object.values(r)) if (Array.isArray(arr)) out.push({ tokens: arr });
  return out;
}

function extractAutoJson(content: string): unknown {
  const direct = tryJson(content.trim());
  if (direct !== undefined) return direct;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    const p = tryJson(fence[1].trim());
    if (p !== undefined) return p;
  }
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    let start = content.indexOf(open);
    while (start >= 0) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let k = start; k < content.length; k++) {
        const ch = content[k];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            const p = tryJson(content.slice(start, k + 1));
            if (p !== undefined) return p;
            break;
          }
        }
      }
      start = content.indexOf(open, start + 1);
    }
  }
  return undefined;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 连接测试：GET {baseUrl}/models */
export async function testConnection(cfg: ProviderConfig, fetchFn: typeof fetch = fetch): Promise<string> {
  if (!cfg.apiKey) throw new ProviderError('缺少 API Key');
  const resp = await fetchFn(`${cleanBase(cfg.baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!resp.ok) throw new ProviderError(`连接失败 ${resp.status}：${(await resp.text()).slice(0, 200)}`, resp.status);
  return '连接成功';
}

function parseGlossJson(raw: string): Record<string, string> {
  const cleaned = raw.replace(/^```json\s*|^```\s*|```$/gm, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ProviderError(`LLM 返回非 JSON：${raw.slice(0, 200)}`);
  const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = String(v).slice(0, 60);
  return out;
}

// ---------------- 全书术语表（用户口径：一本书的上下文最充足） ----------------

/** 拿不到 /models 元数据时的保守上下文窗口（tokens）。 */
export const DEFAULT_CONTEXT_TOKENS = 32768;
/** 术语表产出预留（输出 tokens）：避免 context - output 溢出。 */
const GLOSSARY_RESERVE_TOKENS = 4096;

/** 取模型上下文窗口（tokens）。GET {base}/models 按 id 精确匹配，其次按 id 前缀匹配；
 * 拿不到返回 null（调用方用 DEFAULT_CONTEXT_TOKENS）。 */
export async function fetchModelContext(
  cfg: ProviderConfig,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const resp = await fetchFn(`${cleanBase(cfg.baseUrl)}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as unknown;
    const list = (data as { data?: unknown }).data;
    if (!Array.isArray(list)) return null;
    const entries = list.filter(
      (m): m is { id?: unknown; context_length?: unknown } => m !== null && typeof m === 'object',
    );
    const pick = (m: { id?: unknown; context_length?: unknown }): number | null =>
      typeof m.context_length === 'number' && m.context_length > 0 ? m.context_length : null;
    const exact = entries.find((m) => m.id === cfg.model);
    if (exact) {
      const c = pick(exact);
      if (c) return c;
    }
    const prefixed = entries.find((m) => typeof m.id === 'string' && m.id.startsWith(cfg.model));
    if (prefixed) {
      const c = pick(prefixed);
      if (c) return c;
    }
    return null;
  } catch {
    return null;
  }
}

/** 按 token 预算切块：尽量填满（用户口径“能填 200K 就填到 200K”）。
 * 段落粒度优先（不切断句内上下文）；单段超预算时按字符硬切。 */
export function chunkByTokenBudget(
  paragraphs: string[],
  budgetTokens: number,
): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  const pushCur = (): void => {
    if (cur.length) {
      out.push(cur);
      cur = [];
      n = 0;
    }
  };
  for (const p of paragraphs) {
    const text = p.trim();
    if (!text) continue;
    const t = estimateTokens(text);
    if (t > budgetTokens) {
      pushCur();
      // 单段超预算：按字符数近似切（保留段落边界语义，仅对超长段硬切）
      const perChar = estimateTokens('x'.repeat(100)) / 100;
      const maxChars = Math.max(200, Math.floor(budgetTokens / Math.max(perChar, 0.01)));
      for (let i = 0; i < text.length; i += maxChars) out.push([text.slice(i, i + maxChars)]);
      continue;
    }
    if (cur.length && n + t > budgetTokens) pushCur();
    cur.push(text);
    n += t;
  }
  pushCur();
  return out;
}

export interface BookGlossaryResult {
  glossary: Record<string, string>;
  chunks: number;
  costUSD: number;
  contextTokens: number | null;
  /** 每块真正用到的 token 预算（诊断用：是否填满上下文） */
  budgetTokens: number;
}

/** 全书术语表：把整本书按上下文预算切块（能填满就填满），逐块提炼并合并。
 * 产物供 glossBatchPage({glossary}) 使用，保证同一专名/术语全书译法一致。
 * 失败策略：单块失败跳过（lastErr 记原因），已有块的结果仍返回；
 * 全部失败且无结果时抛最后一个错误，调用方决定是否降级为“无术语表继续”。 */
export async function extractBookGlossary(
  cfg: ProviderConfig,
  lang: SourceLang,
  target: TargetLang,
  paragraphs: string[],
  opts: {
    maxContextTokens?: number;
    reserveTokens?: number;
    onProgress?: (done: number, total: number) => void;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<BookGlossaryResult> {
  if (!cfg.apiKey) throw new ProviderError('缺少 API Key（设置页填写，仅存 localStorage）');
  const fetchFn = opts.fetchFn ?? fetch;
  const contextTokens = opts.maxContextTokens ?? (await fetchModelContext(cfg, fetchFn)) ?? DEFAULT_CONTEXT_TOKENS;
  const budgetTokens = Math.max(1024, contextTokens - (opts.reserveTokens ?? GLOSSARY_RESERVE_TOKENS));
  const chunks = chunkByTokenBudget(paragraphs, budgetTokens);
  const targetName = target === 'zh' ? '简体中文' : 'simple English';
  const sys =
    `You are a terminology extractor for a ${lang} book being read with interlinear glosses. ` +
    `Extract the book's glossary: proper nouns (people, places, gods, artefacts), archaic or unusual words, ` +
    `and recurring key terms. For each, give ONE short fixed rendering in ${targetName} (1-6 words/字). ` +
    `Prefer renderings that stay consistent across the whole book. ` +
    `Return ONLY a JSON object {term: rendering}. No markdown, no commentary.`;
  const glossary: Record<string, string> = {};
  let costUSD = 0;
  let lastErr: unknown;
  let done = 0;
  for (const chunk of chunks) {
    if (opts.signal?.aborted) break;
    const user = JSON.stringify({ book: chunk.join('\n\n') });
    try {
      const resp = await fetchFn(`${cleanBase(cfg.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
          ],
          temperature: 0,
        }),
        signal: opts.signal,
      });
      if (!resp.ok) throw new ProviderError(`LLM ${resp.status}：${(await resp.text()).slice(0, 200)}`, resp.status);
      const data = (await resp.json()) as ChatResponse;
      const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
      // 合并：先到先得（首块看到的译法更可能来自书名/开篇的规范表述）
      for (const [k, v] of Object.entries(parseGlossJson(raw))) {
        if (glossary[k] === undefined && k.trim()) glossary[k] = v;
      }
      costUSD += estimateCostUSD(sys + user, raw);
    } catch (e) {
      if (opts.signal?.aborted) break;
      lastErr = e;
    }
    done += 1;
    opts.onProgress?.(done, chunks.length);
  }
  if (Object.keys(glossary).length === 0 && lastErr) throw lastErr;
  return { glossary, chunks: chunks.length, costUSD, contextTokens, budgetTokens };
}
