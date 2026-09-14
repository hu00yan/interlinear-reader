// Prompt builder: choice-style disambiguation over Track B dictionary candidates.
// Unknown words (no candidates) go straight to LLM composition.

import type { SentenceInput } from "./types.ts";

export const GLOSS_JSON_SHAPE = `{"sentences":[{"id":"<sentence id>","glosses":[{"i":<token index>,"lemma":"<lemma>","gloss":"<gloss>"}]}]}`;

const SYSTEM_PROMPT =
  "You are an interlinear gloss engine. " +
  "For each token, write ONE short gloss in the target language, using the full sentence as context. " +
  "Rules: (1) when CANDIDATES are listed for a token, pick the candidate that best fits the context " +
  "unless none fits, in which case compose a better gloss; " +
  "(2) when no candidates are listed, the word is unknown to our dictionary — compose a concise gloss from context; " +
  "(3) keep proper names as-is; " +
  "(4) reply with strict JSON only, exactly this shape: " +
  GLOSS_JSON_SHAPE +
  " No markdown fences, no commentary.";

export interface GlossMessages {
  system: string;
  user: string;
}

export function buildGlossMessages(args: {
  lang: string;
  target: string;
  sentences: SentenceInput[];
}): GlossMessages {
  const payload = {
    lang: args.lang,
    target: args.target,
    instruction: `Gloss every listed token into ${args.target}. Prefer CANDIDATES by contextual fit.`,
    sentences: args.sentences.map((s) => ({
      id: s.id,
      text: s.text,
      tokens: s.tokens.map((t) => ({
        i: t.i,
        surface: t.surface,
        lemma: t.lemma,
        candidates: (t.candidates ?? []).map((c) =>
          c.pos ? `${c.gloss} (${c.pos})` : c.gloss,
        ),
      })),
    })),
  };
  return { system: SYSTEM_PROMPT, user: JSON.stringify(payload) };
}
