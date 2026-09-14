// Response parsing: JSON mode first, weak-model plain-text fallback.
// Accepts equivalent JSON shapes; throws GlossParseError when nothing parses.

import type { GlossBatchOutput, GlossItem, SentenceInput } from "./types.ts";

export class GlossParseError extends Error {
  code = "E_PARSE";
  constructor(message: string) {
    super(message);
    this.name = "GlossParseError";
  }
}

interface ParsedGloss {
  i: number;
  lemma?: string;
  gloss?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function coerceGloss(g: unknown): ParsedGloss | null {
  if (!isRecord(g)) return null;
  const i = typeof g["i"] === "number" ? (g["i"] as number) : -1;
  const gloss = typeof g["gloss"] === "string" ? (g["gloss"] as string).trim() : "";
  const lemma = typeof g["lemma"] === "string" ? (g["lemma"] as string) : undefined;
  if (!Number.isInteger(i) || i < 0 || gloss === "") return null;
  return { i, lemma, gloss };
}

/** Normalize the accepted JSON shapes into id -> gloss list. */
function fromJson(data: unknown): Map<string, ParsedGloss[]> {
  const out = new Map<string, ParsedGloss[]>();
  const push = (id: string, g: unknown) => {
    const c = coerceGloss(g);
    if (typeof id === "string" && c) {
      const arr = out.get(id) ?? [];
      arr.push(c);
      out.set(id, arr);
    }
  };
  if (Array.isArray(data)) {
    for (const s of data) {
      if (isRecord(s) && typeof s["id"] === "string" && Array.isArray(s["glosses"])) {
        for (const g of s["glosses"] as unknown[]) push(s["id"] as string, g);
      }
    }
    return out;
  }
  if (!isRecord(data)) return out;
  const list = Array.isArray(data["sentences"])
    ? (data["sentences"] as unknown[])
    : Array.isArray(data["results"])
      ? (data["results"] as unknown[])
      : null;
  if (list) {
    for (const s of list) {
      if (isRecord(s) && typeof s["id"] === "string" && Array.isArray(s["glosses"])) {
        for (const g of s["glosses"] as unknown[]) push(s["id"] as string, g);
      }
    }
    return out;
  }
  // Record shape: { "<sentenceId>": [{i, lemma, gloss}] }
  for (const [id, arr] of Object.entries(data)) {
    if (Array.isArray(arr)) for (const g of arr) push(id, g);
  }
  return out;
}

/** Extract the first plausibly-JSON object/array, tolerating fences and prose. */
function extractJson(content: string): unknown {
  const direct = tryParse(content.trim());
  if (direct !== undefined) return direct;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== undefined) return parsed;
  }
  // Largest balanced {...} or [...] span.
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

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const LINE_PATTERNS: RegExp[] = [
  // s1 | 0 | lemma | gloss   /   s1: 0, lemma = gloss
  /^\s*([A-Za-z0-9_.-]+)\s*[|:,]\s*(\d+)\s*[|=:,]\s*([^|=]+?)\s*[|=]\s*(.+?)\s*$/,
  // s1 #0 lemma -> gloss
  /^\s*([A-Za-z0-9_.-]+)\s+#?(\d+)\s+\S+\s*(?:->|=>|:)\s*(.+?)\s*$/,
];

/** Weak-model fallback: one gloss per line. Returns id -> items. */
function fromPlainText(content: string, wanted: Set<string>): Map<string, ParsedGloss[]> {
  const out = new Map<string, ParsedGloss[]>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    for (const re of LINE_PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      const id = m[1];
      if (!wanted.has(id)) break;
      const i = Number(m[2]);
      if (!Number.isInteger(i) || i < 0) break;
      const gloss = (m[4] ?? m[3] ?? "").trim();
      if (!gloss) break;
      const arr = out.get(id) ?? [];
      arr.push({ i, gloss });
      out.set(id, arr);
      break;
    }
  }
  return out;
}

export function parseGlossContent(
  content: string,
  sentences: SentenceInput[],
): GlossBatchOutput {
  const wanted = new Map(sentences.map((s) => [s.id, s]));
  const lemmaOf = (sid: string, i: number): string => {
    const tok = wanted.get(sid)?.tokens.find((t) => t.i === i);
    return tok ? tok.lemma : "";
  };

  let parsed = new Map<string, ParsedGloss[]>();
  const data = extractJson(content);
  if (data !== undefined) parsed = fromJson(data);
  if (totalItems(parsed) === 0) {
    parsed = fromPlainText(content, new Set(wanted.keys()));
  }
  if (totalItems(parsed) === 0) {
    throw new GlossParseError(
      `unparseable model output (${content.length} chars, ${sentences.length} sentences requested)`,
    );
  }

  const out: GlossBatchOutput = {};
  for (const [sid, items] of parsed) {
    if (!wanted.has(sid)) continue;
    const seen = new Set<number>();
    const glosses: GlossItem[] = [];
    for (const g of items) {
      if (seen.has(g.i)) continue;
      seen.add(g.i);
      glosses.push({
        i: g.i,
        lemma: g.lemma ?? lemmaOf(sid, g.i),
        gloss: g.gloss ?? "",
        source: "llm",
      });
    }
    glosses.sort((a, b) => a.i - b.i);
    out[sid] = glosses;
  }
  return out;
}

function totalItems(m: Map<string, ParsedGloss[]>): number {
  let n = 0;
  for (const arr of m.values()) n += arr.length;
  return n;
}
