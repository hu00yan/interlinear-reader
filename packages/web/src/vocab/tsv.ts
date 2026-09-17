import type { VocabEntry } from "./store.js";

function field(value: string): string {
  // Plain-text import: each record stays on one line with exactly seven fields.
  return value
    .replace(/[\t\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

// No header row: Anki would import it as a card. Import with HTML disabled.
export function buildVocabTSV(entries: readonly VocabEntry[]): string {
  return entries
    .map((entry) =>
      [
        entry.lemma,
        entry.lang,
        entry.gloss,
        entry.sentence,
        new Date(entry.addedAt).toISOString(),
        String(entry.known),
        `ilr lang:${entry.lang}`,
      ]
        .map(field)
        .join("\t")
    )
    .join("\n");
}
