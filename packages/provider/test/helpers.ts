// Shared fixtures for provider tests (not a test file itself).

import type { Candidate, SentenceInput } from "../src/types.ts";
import type { DictAdapter } from "../src/modes.ts";

export const TEST_KEY = "sk-test-provider-key-001";

export function enChapter(): SentenceInput[] {
  return [
    {
      id: "s1",
      text: "The cat sits on the mat.",
      tokens: [
        { i: 0, surface: "cat", lemma: "cat" },
        { i: 1, surface: "sits", lemma: "sit" },
        { i: 2, surface: "mat", lemma: "mat" },
      ],
    },
    {
      id: "s2",
      text: "Dogs bark loudly.",
      tokens: [
        { i: 0, surface: "Dogs", lemma: "dog" },
        { i: 1, surface: "bark", lemma: "bark" },
      ],
    },
  ];
}

export function mapDict(entries: Record<string, string[]>): DictAdapter {
  return {
    lookup: ({ lemma }: { lemma: string }): Candidate[] =>
      (entries[lemma] ?? []).map((gloss) => ({ gloss, source: "test-dict" })),
  };
}

export function throwingLlm(): {
  glossBatch: () => Promise<never>;
  calls: () => number;
} {
  let n = 0;
  return {
    glossBatch: async () => {
      n += 1;
      throw new Error("LLM must not be called in this mode");
    },
    calls: () => n,
  };
}
