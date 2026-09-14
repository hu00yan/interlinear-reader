// Auto/万能模式：无词典/分词包，整句送 LLM 做“源语言自动识别 + 分词 + 注”。
// 适用：阿拉伯语等无包语言。只需指定目标 zh/en。
// 缓存键沿用 token-in-context：sha1(`auto|target|lemma|归一化句`)，即 lang='auto'。

import { cacheKeyForToken } from "./cache.ts";
import { GlossParseError } from "./parse.ts";

export const AUTO_LANG = "auto" as const;

export interface AutoSentenceInput {
  id: string;
  text: string;
}

export interface AutoToken {
  i: number;
  surface: string;
  lemma: string;
  gloss: string;
  source: "llm";
}

export type AutoSegmentOutput = Record<string, AutoToken[]>;

export const AUTO_GLOSS_JSON_SHAPE = `{"sentences":[{"id":"<sentence id>","detectedLang":"<bcp47 or iso>","tokens":[{"i":0,"surface":"<word>","lemma":"<word>","gloss":"<gloss>"}]}]}`;

const AUTO_SYSTEM_PROMPT =
  "You are an interlinear gloss engine for ANY language (universal mode). " +
  "Auto-detect the source language of each sentence (do NOT ask the user). " +
  "Segment each sentence into words (keep punctuation out of tokens), " +
  "then write ONE short gloss per token in the target language " +
  "(1-4 words/字, proper names as-is). " +
  "Use the full sentence as context. " +
  "Reply with strict JSON only, exactly this shape: " +
  AUTO_GLOSS_JSON_SHAPE +
  " No markdown fences, no commentary.";

export function buildAutoSegmentMessages(args: {
  target: string;
  sentences: AutoSentenceInput[];
}): { system: string; user: string } {
  const payload = {
    lang: AUTO_LANG,
    target: args.target,
    instruction:
      `Auto-detect source language. Segment every sentence into words ` +
      `and gloss each token into ${args.target}.`,
    sentences: args.sentences.map((s) => ({ id: s.id, text: s.text })),
  };
  return { system: AUTO_SYSTEM_PROMPT, user: JSON.stringify(payload) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Extract first plausibly-JSON object/array, tolerating fences and prose. */
function extractJson(content: string): unknown {
  const direct = tryParse(content.trim());
  if (direct !== undefined) return direct;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== undefined) return parsed;
  }
  for (const open of ["{", "["]) {
    const close = open === "{" ? "}" : "]";
    let start = content.indexOf(open);
    while (start >= 0) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let k = start; k < content.length; k++) {
        const ch = content[k];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            const parsed = tryParse(content.slice(start, k + 1));
            if (parsed !== undefined) return parsed;
            break;
          }
        }
      }
      start = content.indexOf(open, start + 1);
    }
  }
  return undefined;
}

function coerceAutoToken(raw: unknown, fallbackIndex: number): AutoToken | null {
  if (!isRecord(raw)) return null;
  const i = typeof raw["i"] === "number" ? (raw["i"] as number) : fallbackIndex;
  const surface =
    typeof raw["surface"] === "string" && (raw["surface"] as string).trim() !== ""
      ? (raw["surface"] as string)
      : typeof raw["lemma"] === "string"
        ? (raw["lemma"] as string)
        : "";
  const lemma =
    typeof raw["lemma"] === "string" && (raw["lemma"] as string).trim() !== ""
      ? (raw["lemma"] as string)
      : surface;
  const gloss = typeof raw["gloss"] === "string" ? (raw["gloss"] as string).trim() : "";
  if (!Number.isInteger(i) || i < 0 || surface === "" || gloss === "") return null;
  return { i, surface, lemma, gloss, source: "llm" };
}

function sentenceEntries(data: unknown): Array<{ id: string; tokens: unknown }> {
  if (Array.isArray(data)) {
    return data
      .filter((s) => isRecord(s) && typeof (s as Record<string, unknown>)["id"] === "string")
      .map((s) => ({
        id: (s as Record<string, unknown>)["id"] as string,
        tokens:
          (s as Record<string, unknown>)["tokens"] ??
          (s as Record<string, unknown>)["glosses"] ??
          [],
      }));
  }
  if (!isRecord(data)) return [];
  const list = Array.isArray(data["sentences"])
    ? (data["sentences"] as unknown[])
    : Array.isArray(data["results"])
      ? (data["results"] as unknown[])
      : null;
  if (list) {
    return list
      .filter((s) => isRecord(s) && typeof (s as Record<string, unknown>)["id"] === "string")
      .map((s) => ({
        id: (s as Record<string, unknown>)["id"] as string,
        tokens:
          (s as Record<string, unknown>)["tokens"] ??
          (s as Record<string, unknown>)["glosses"] ??
          [],
      }));
  }
  // Record shape: { "<id>": [{i,surface,lemma,gloss}] }
  const out: Array<{ id: string; tokens: unknown }> = [];
  for (const [id, arr] of Object.entries(data)) {
    if (Array.isArray(arr)) out.push({ id, tokens: arr });
  }
  return out;
}

/**
 * Parse Auto 分词+注 JSON。接受 sentences/results/数组/Record 四形状，
 * token 需 {i?, surface|lemma, gloss}（i 缺省按序补）。
 * 不可解析抛 GlossParseError（调用方回退/报错由上层决定）。
 */
export function parseAutoSegmentContent(
  content: string,
  sentences: AutoSentenceInput[],
): AutoSegmentOutput {
  const wanted = new Set(sentences.map((s) => s.id));
  const data = extractJson(content);
  if (data === undefined) {
    throw new GlossParseError(
      `unparseable auto-segment output (${content.length} chars, ${sentences.length} sentences requested)`,
    );
  }
  const out: AutoSegmentOutput = {};
  for (const { id, tokens } of sentenceEntries(data)) {
    if (!wanted.has(id) || !Array.isArray(tokens)) continue;
    const seen = new Set<number>();
    const items: AutoToken[] = [];
    tokens.forEach((t, idx) => {
      const c = coerceAutoToken(t, idx);
      if (!c || seen.has(c.i)) return;
      seen.add(c.i);
      items.push(c);
    });
    if (items.length === 0) continue;
    items.sort((a, b) => a.i - b.i);
    out[id] = items;
  }
  if (Object.keys(out).length === 0) {
    throw new GlossParseError(
      `unparseable auto-segment output (${content.length} chars, ${sentences.length} sentences requested)`,
    );
  }
  return out;
}

/** Auto token-in-context 缓存键：sha1(`auto|target|lemma|归一化句`)，沿用 provider winner 口径。 */
export function cacheKeyForAutoToken(args: {
  target: string;
  lemma: string;
  sentenceText: string;
}): string {
  return cacheKeyForToken({
    lang: AUTO_LANG,
    target: args.target,
    lemma: args.lemma,
    sentenceText: args.sentenceText,
  });
}
