// OpenAI 兼容协议客户端（锁死：只做 OpenAI 兼容，Response API 首版不做）。
// key 只存浏览器 localStorage、浏览器直调 LLM，无代理、无服务端。
// 缺词走 `provider.glossSentence()`（契约锁死）。

import type { SourceLang, TargetLang } from '../types.js';
import { sentenceCacheKey } from '../lib/hash.js';
import { sentenceMemGet, sentenceMemSet } from '../lib/cache.js';
import { estimateCostUSD } from '../lib/cost.js';

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
