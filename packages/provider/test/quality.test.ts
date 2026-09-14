// 金标判分单测：7 语齐全 + 命中率/语言/空复制三项 + 阈值 + mock 联调（MOCK 必不合格）。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { GOLDEN_SENTENCES, GOLDEN_TARGET, GOLDEN_VERSION } from "../golden/golden.ts";
import {
  QUALITY_THRESHOLDS,
  JUDGE_DEFAULT_OFF,
  applyJudge,
  scoreQuality,
  suggestModel,
} from "../golden/score.ts";
import { createClient } from "../src/client.ts";
import { startMockServer, type MockServer } from "../src/mock-server.ts";
import { TEST_KEY } from "./helpers.ts";

test("golden: 7 langs x zh target, refs non-empty", () => {
  const langs = GOLDEN_SENTENCES.map((g) => g.lang).sort();
  assert.deepEqual(langs, ["de", "en", "es", "fr", "it", "ja", "ru"]);
  assert.equal(GOLDEN_TARGET, "zh");
  assert.match(GOLDEN_VERSION, /^v\d+/);
  for (const g of GOLDEN_SENTENCES) {
    assert.equal(g.target, "zh");
    assert.ok(g.text.length >= 20, `${g.id} too short`);
    assert.ok(g.tokens.length >= 5, `${g.id} tokens`);
    assert.ok(g.refs.length >= 5, `${g.id} refs`);
    for (const r of g.refs) {
      assert.ok(r.expects.length >= 1, `${g.id}/${r.lemma}`);
      assert.ok(
        g.tokens.some((t) => t.lemma.toLowerCase() === r.lemma.toLowerCase()),
        `${g.id}: ref ${r.lemma} must match a token lemma`,
      );
    }
  }
});

test("score: perfect zh glosses pass", () => {
  const actual: Record<string, Array<{ i: number; lemma: string; gloss: string }>> = {};
  for (const g of GOLDEN_SENTENCES) {
    actual[g.id] = g.refs.map((r, k) => ({ i: k, lemma: r.lemma, gloss: r.expects[0] }));
  }
  const s = scoreQuality(actual, GOLDEN_SENTENCES);
  assert.equal(s.pass, true);
  assert.ok(s.overall >= QUALITY_THRESHOLDS.overall, `overall=${s.overall}`);
  assert.equal(suggestModel(s), "当前模型可用，无需更换（金标 7 语全项达标）。");
});

test("score: mock MOCK:<lemma> fails (hit=0, lang=0)", () => {
  const actual: Record<string, Array<{ i: number; lemma: string; gloss: string }>> = {};
  for (const g of GOLDEN_SENTENCES) {
    actual[g.id] = g.tokens.map((t) => ({ i: t.i, lemma: t.lemma, gloss: `MOCK:${t.lemma}` }));
  }
  const s = scoreQuality(actual, GOLDEN_SENTENCES);
  assert.equal(s.pass, false);
  // 注：ja 专名（帝国/奢侈）原文即汉字，MOCK 回显会误中 2/49，不为 0 但远低于阈值。
  assert.ok(s.hitAvg < QUALITY_THRESHOLDS.hit, `hit=${s.hitAvg}`);
  assert.ok(s.langAvg < QUALITY_THRESHOLDS.lang, `lang=${s.langAvg}`);
  assert.ok(s.cleanAvg > 0.9, `mock has no empty/copy, clean=${s.cleanAvg}`);
  assert.ok(s.overall < QUALITY_THRESHOLDS.overall);
  const tip = suggestModel(s);
  assert.match(tip, /命中率低/);
  assert.match(tip, /语言不合规/);
});

test("score: empty + copy are penalized via cleanScore", () => {
  const g = GOLDEN_SENTENCES[0];
  const actual = {
    [g.id]: [
      { i: 0, lemma: g.tokens[0].lemma, gloss: "" },
      { i: 1, lemma: g.tokens[1].lemma, gloss: g.tokens[1].lemma },
      ...g.refs.slice(2).map((r, k) => ({ i: k + 2, lemma: r.lemma, gloss: r.expects[0] })),
    ],
  };
  const s = scoreQuality(actual, [g]);
  const one = s.perLang[0];
  assert.equal(one.empty, 1);
  assert.equal(one.copied, 1);
  assert.ok(one.cleanScore < QUALITY_THRESHOLDS.clean, `clean=${one.cleanScore}`);
  assert.equal(s.pass, false);
});

test("judge: default off, local verdict wins", () => {
  assert.deepEqual(JUDGE_DEFAULT_OFF, { enabled: false });
  const actual: Record<string, Array<{ i: number; lemma: string; gloss: string }>> = {};
  for (const g of GOLDEN_SENTENCES) {
    actual[g.id] = g.refs.map((r, k) => ({ i: k, lemma: r.lemma, gloss: r.expects[0] }));
  }
  const judged = applyJudge(scoreQuality(actual, GOLDEN_SENTENCES));
  assert.equal(judged.judge.enabled, false);
  assert.equal(judged.pass, true);
  assert.match(judged.judge.note, /默认/);
  const on = applyJudge(scoreQuality(actual, GOLDEN_SENTENCES), { enabled: true });
  assert.equal(on.pass, true);
  assert.equal(on.judge.enabled, true);
});

let mock: MockServer;
test("setup mock", async () => {
  mock = await startMockServer();
});
after(async () => {
  await mock?.close();
});

test("integration: glossBatch(mock) scores 不合格", async () => {
  mock.reset();
  const client = createClient({
    baseUrl: mock.url,
    apiKey: TEST_KEY,
    model: "mock-model",
    baseDelayMs: 5,
  });
  const actual: Record<string, Array<{ i: number; lemma: string; gloss: string }>> = {};
  for (const g of GOLDEN_SENTENCES) {
    const out = await client.glossBatch({
      lang: g.lang,
      target: "zh",
      sentences: [
        {
          id: g.id,
          text: g.text,
          tokens: g.tokens.map((t) => ({ i: t.i, surface: t.surface, lemma: t.lemma })),
        },
      ],
    });
    actual[g.id] = out[g.id] ?? [];
  }
  const s = scoreQuality(actual, GOLDEN_SENTENCES);
  assert.equal(s.pass, false);
  assert.equal(mock.chatRequests.length, GOLDEN_SENTENCES.length);
});
