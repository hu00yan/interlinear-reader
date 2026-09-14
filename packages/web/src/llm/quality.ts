// 设置页“测模型质量”运行器：用当前 baseUrl/model 对 7 语金标逐语跑 glossBatch，
// 本地规则判分（命中率+语言+空复制），强模型复核默认关。
// 金标原文/参考只进内存发给模型，返回值与 UI 绝不含 text/expects（防抄）。
// key 只发往配置的 baseUrl（Authorization），永不落盘/日志。

import { GOLDEN_SENTENCES } from '../../../provider/golden/golden.js';
import {
  applyJudge,
  scoreQuality,
  type QualityActual,
} from '../../../provider/golden/score.js';

export interface QualityCfg {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface QualityLangResult {
  lang: string;
  hits: number;
  total: number;
  hitRate: number;
  langScore: number;
  cleanScore: number;
  score: number;
  error?: string;
}

export interface QualityReport {
  verdict: '合格' | '不合格';
  pass: boolean;
  overall: number;
  hitAvg: number;
  langAvg: number;
  cleanAvg: number;
  perLang: QualityLangResult[];
  suggestion: string;
  judgeNote: string;
  model: string;
  baseUrl: string;
  latencyMs: number;
}

const SYS =
  'You are an interlinear gloss engine. ' +
  'For each token, write ONE short gloss in Simplified Chinese, using the full sentence as context. ' +
  'Keep proper names as-is. Reply with strict JSON only, exactly this shape: ' +
  '{"sentences":[{"id":"<sentence id>","glosses":[{"i":<token index>,"lemma":"<lemma>","gloss":"<gloss>"}]}]} ' +
  'No markdown fences, no commentary.';

function cleanBase(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 兼容 provider parse 的 JSON 多形状 + 弱模型纯文本回退（行：id | i | lemma | gloss） */
function toItems(content: string, sid: string): Array<{ i: number; lemma: string; gloss: string }> {
  const data = extractJson(content);
  if (data !== undefined) {
    const map = fromJson(data);
    const hit = map.get(sid);
    if (hit && hit.length > 0) return hit;
  }
  return fromPlainText(content, sid);
}

function fromJson(data: unknown): Map<string, Array<{ i: number; lemma: string; gloss: string }>> {
  const out = new Map<string, Array<{ i: number; lemma: string; gloss: string }>>();
  const push = (id: string, g: unknown, fallbackLemma = ''): void => {
    if (!isRecord(g)) return;
    const i = typeof g['i'] === 'number' ? (g['i'] as number) : -1;
    const gloss = typeof g['gloss'] === 'string' ? (g['gloss'] as string).trim() : '';
    const lemma = typeof g['lemma'] === 'string' ? (g['lemma'] as string) : fallbackLemma;
    if (!Number.isInteger(i) || i < 0 || gloss === '') return;
    const arr = out.get(id) ?? [];
    arr.push({ i, lemma, gloss });
    out.set(id, arr);
  };
  if (Array.isArray(data)) {
    for (const s of data) {
      if (isRecord(s) && typeof s['id'] === 'string' && Array.isArray(s['glosses'])) {
        for (const g of s['glosses'] as unknown[]) push(s['id'] as string, g);
      }
    }
    return out;
  }
  if (!isRecord(data)) return out;
  const list = Array.isArray(data['sentences'])
    ? (data['sentences'] as unknown[])
    : Array.isArray(data['results'])
      ? (data['results'] as unknown[])
      : null;
  if (list) {
    for (const s of list) {
      if (isRecord(s) && typeof s['id'] === 'string' && Array.isArray(s['glosses'])) {
        for (const g of s['glosses'] as unknown[]) push(s['id'] as string, g);
      }
    }
    return out;
  }
  for (const [id, arr] of Object.entries(data)) {
    if (Array.isArray(arr)) for (const g of arr) push(id, g);
  }
  return out;
}

function extractJson(content: string): unknown {
  const direct = tryParse(content.trim());
  if (direct !== undefined) return direct;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    const p = tryParse(fence[1].trim());
    if (p !== undefined) return p;
  }
  for (const open of ['{', '['] as const) {
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
            const p = tryParse(content.slice(start, k + 1));
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

function fromPlainText(content: string, sid: string): Array<{ i: number; lemma: string; gloss: string }> {
  const out: Array<{ i: number; lemma: string; gloss: string }> = [];
  const res: Array<RegExp> = [
    /^\s*([A-Za-z0-9_.-]+)\s*[|:,]\s*(\d+)\s*[|=:,]\s*([^|=]+?)\s*[|=]\s*(.+?)\s*$/,
    /^\s*([A-Za-z0-9_.-]+)\s+#?(\d+)\s+\S+\s*(?:->|=>|:)\s*(.+?)\s*$/,
  ];
  // 金标 id 含连字符（如 en-1），纯文本回退要求 id 完全匹配才收录。
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    for (const re of res) {
      const m = line.match(re);
      if (!m || m[1] !== sid) continue;
      const i = Number(m[2]);
      if (!Number.isInteger(i) || i < 0) break;
      const gloss = (m[4] ?? m[3] ?? '').trim();
      if (!gloss) break;
      out.push({ i, lemma: '', gloss });
      break;
    }
  }
  return out;
}

async function glossOne(
  cfg: QualityCfg,
  lang: string,
  sid: string,
  text: string,
  tokens: Array<{ i: number; surface: string; lemma: string }>,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Array<{ i: number; lemma: string; gloss: string }>> {
  const user = JSON.stringify({
    lang,
    target: 'zh',
    instruction: 'Gloss every listed token into zh (Simplified Chinese).',
    sentences: [{ id: sid, text, tokens: tokens.map((t) => ({ i: t.i, surface: t.surface, lemma: t.lemma })) }],
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${cleanBase(cfg.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: user },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`LLM ${resp.status}：${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') throw new Error('模型返回为空');
    const items = toItems(content, sid).map((g) => ({
      i: g.i,
      lemma: g.lemma || tokens.find((t) => t.i === g.i)?.lemma || '',
      gloss: g.gloss,
    }));
    if (items.length === 0) throw new Error('模型输出无法解析（非 JSON/缺 gloss）');
    return items;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑完全部 7 语并判分。单语失败不中断（该语记 0 分 + error），全部失败则 verdict=不合格。
 * judgeEnabled 默认 false（无二次花费）。
 */
export async function runQualityTest(
  cfg: QualityCfg,
  fetchFn: typeof fetch = fetch,
  opts: { timeoutMs?: number; judgeEnabled?: boolean } = {},
): Promise<QualityReport> {
  if (!cfg.apiKey) throw new Error('缺少 API Key：去设置页填写后重测（仅存 localStorage）。');
  if (!/^https?:\/\//i.test(cfg.baseUrl.trim())) throw new Error('Base URL 非 http(s)，请检查设置页。');
  if (!cfg.model.trim()) throw new Error('Model 为空，请检查设置页。');
  const timeoutMs = opts.timeoutMs ?? 30000;
  const started = Date.now();
  const actual: QualityActual = {};
  const errors: Record<string, string> = {};
  for (const g of GOLDEN_SENTENCES) {
    try {
      actual[g.id] = await glossOne(cfg, g.lang, g.id, g.text, g.tokens, fetchFn, timeoutMs);
    } catch (e) {
      errors[g.id] = (e as Error).message.slice(0, 120);
      actual[g.id] = [];
    }
  }
  const judged = applyJudge(scoreQuality(actual, GOLDEN_SENTENCES), {
    enabled: opts.judgeEnabled ?? false,
  });
  const perLang: QualityLangResult[] = judged.perLang.map((p) => ({
    lang: p.lang,
    hits: p.hits,
    total: p.total,
    hitRate: p.hitRate,
    langScore: p.langScore,
    cleanScore: p.cleanScore,
    score: p.score,
    ...(errors[p.id] ? { error: errors[p.id] } : {}),
  }));
  return {
    verdict: judged.pass ? '合格' : '不合格',
    pass: judged.pass,
    overall: judged.overall,
    hitAvg: judged.hitAvg,
    langAvg: judged.langAvg,
    cleanAvg: judged.cleanAvg,
    perLang,
    suggestion: judged.suggestion,
    judgeNote: judged.judge.note,
    model: cfg.model,
    baseUrl: cleanBase(cfg.baseUrl),
    latencyMs: Date.now() - started,
  };
}
