// 金标判分（本地规则为主）：命中率 + 语言检查 + 空/复制检查。
// 强模型复核：默认关闭（JUDGE_DEFAULT_OFF），开启也只是附加说明，不改变本地 verdict。

export interface ScoredGloss {
  i: number;
  lemma: string;
  gloss: string;
}

export type QualityActual = Record<string, ScoredGloss[]>;

export interface GoldenRefLike {
  lemma: string;
  expects: string[];
}

export interface GoldenItemLike {
  id: string;
  lang: string;
  refs: GoldenRefLike[];
}

/** 评分规则（锁死，单测 pin）：权重 hit 0.7 / lang 0.2 / clean 0.1 */
export const QUALITY_THRESHOLDS = {
  overall: 0.7,
  hit: 0.6,
  lang: 0.7,
  clean: 0.9,
  weights: { hit: 0.7, lang: 0.2, clean: 0.1 },
} as const;

const HAN_RE = /\p{Script=Han}/u;

function norm(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

export interface SentenceScore {
  id: string;
  lang: string;
  hits: number;
  total: number;
  hitRate: number;
  langScore: number;
  cleanScore: number;
  score: number;
  empty: number;
  copied: number;
  returned: number;
}

export function scoreSentence(
  sentenceId: string,
  lang: string,
  actualItems: ScoredGloss[] | undefined,
  refs: GoldenRefLike[],
): SentenceScore {
  const items = Array.isArray(actualItems) ? actualItems : [];
  const byLemma = new Map<string, string>();
  for (const g of items) {
    const k = norm(g.lemma);
    if (!byLemma.has(k)) byLemma.set(k, String(g.gloss ?? ""));
  }
  let hits = 0;
  for (const r of refs) {
    const gloss = byLemma.get(norm(r.lemma)) ?? "";
    const g = norm(gloss);
    if (g !== "" && r.expects.some((e) => g.includes(norm(e)))) hits++;
  }
  const total = refs.length;
  const hitRate = total === 0 ? 0 : hits / total;
  let han = 0;
  let empty = 0;
  let copied = 0;
  for (const g of items) {
    const gloss = String(g.gloss ?? "");
    if (norm(gloss) === "") {
      empty++;
      continue;
    }
    if (HAN_RE.test(gloss)) han++;
    if (norm(gloss) === norm(g.lemma)) copied++;
  }
  const returned = items.length;
  const langScore = returned === 0 ? 0 : han / returned;
  const cleanScore = returned === 0 ? 0 : 1 - (empty + copied) / returned;
  const w = QUALITY_THRESHOLDS.weights;
  const score = w.hit * hitRate + w.lang * langScore + w.clean * cleanScore;
  return {
    id: sentenceId,
    lang,
    hits,
    total,
    hitRate,
    langScore,
    cleanScore,
    score,
    empty,
    copied,
    returned,
  };
}

export interface QualitySummary {
  perLang: SentenceScore[];
  hitAvg: number;
  langAvg: number;
  cleanAvg: number;
  overall: number;
  pass: boolean;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function scoreQuality(
  actual: QualityActual,
  items: GoldenItemLike[],
): QualitySummary {
  const perLang = items.map((it) =>
    scoreSentence(it.id, it.lang, actual[it.id], it.refs),
  );
  const hitAvg = avg(perLang.map((p) => p.hitRate));
  const langAvg = avg(perLang.map((p) => p.langScore));
  const cleanAvg = avg(perLang.map((p) => p.cleanScore));
  const overall = avg(perLang.map((p) => p.score));
  const t = QUALITY_THRESHOLDS;
  const pass =
    overall >= t.overall &&
    hitAvg >= t.hit &&
    langAvg >= t.lang &&
    cleanAvg >= t.clean;
  return { perLang, hitAvg, langAvg, cleanAvg, overall, pass };
}

/** 换模型建议（纯本地规则，不含参考原文，回显安全） */
export function suggestModel(s: Pick<QualitySummary, "pass" | "hitAvg" | "langAvg" | "cleanAvg">): string {
  if (s.pass) return "当前模型可用，无需更换（金标 7 语全项达标）。";
  const tips: string[] = [];
  const t = QUALITY_THRESHOLDS;
  if (s.hitAvg < t.hit) {
    tips.push("命中率低：模型语境释义弱，建议换中文释义强的模型（如 deepseek-chat / gpt-4o-mini 及以上），重试后再测。");
  }
  if (s.langAvg < t.lang) {
    tips.push("语言不合规：多条释义不是中文，检查目标语言是否为 zh（设置页目标=中文），或换中文指令跟随好的模型。");
  }
  if (s.cleanAvg < t.clean) {
    tips.push("空/复制率高：模型在照抄原文或空输出，说明 JSON 跟随差或模型太弱，建议换支持 response_format=json_object 的模型。");
  }
  if (tips.length === 0) {
    tips.push("综合分未达标但分项接近阈值：可重试一次（弱模型输出不稳定），仍不过再换模型。");
  }
  return tips.join(" ");
}

// ---- 强模型复核（可选，默认关） ----

export interface JudgeSetting {
  /** 默认 false：只用本地规则判分，不产生二次花费 */
  enabled: boolean;
}

export const JUDGE_DEFAULT_OFF: JudgeSetting = { enabled: false };

export interface JudgedQuality extends QualitySummary {
  judge: { enabled: boolean; note: string };
  suggestion: string;
}

/** 本地 verdict 为准；复核开时也只附加说明（当前版本不调第二模型）。 */
export function applyJudge(
  summary: QualitySummary,
  setting: JudgeSetting = JUDGE_DEFAULT_OFF,
): JudgedQuality {
  const suggestion = suggestModel(summary);
  if (!setting.enabled) {
    return {
      ...summary,
      suggestion,
      judge: { enabled: false, note: "强模型复核：关（默认）。本地规则判分，无二次花费。" },
    };
  }
  return {
    ...summary,
    suggestion,
    judge: {
      enabled: true,
      note: "强模型复核：开（占位）。当前版本仍以本地规则 verdict 为准，复核模型接线后可复核语义。",
    },
  };
}
