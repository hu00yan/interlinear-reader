// 标点不丢回归（2026-11 线上事故：Pages 部署停在只出词 run 的旧构建，整页字连着字）。
// 三道防线各有测试：
// 1) tokenizeParagraph 无损校验：分词包连缀 ≠ 原文时回退无损正则，标点永不丢；
// 2) alignAutoTokens：auto 万能模式 LLM 词 token 对齐回插标点/空白缺口；
// 3) deploy-freshness 脚本本身是纯 IO，不在此测（verify 步骤跑真站点）。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tokenizeParagraph } from "../../packages/web/src/reader/tokenize.ts";
import { alignAutoTokens } from "../../packages/web/src/llm/provider.ts";

// 模拟 0bb0813 之前的损坏实现：segment 只返回词 run（String.match 吞掉全部非词段）。
const lossyPack = {
  code: "en",
  segment: (text) => text.match(/[\p{L}\p{M}]+(?:['’'‑‒–—-][\p{L}\p{M}]+)*/gu) ?? [],
  lemmatize: (t) => t.toLowerCase(),
};
const noopKnown = () => false;

describe("tokenizeParagraph lossless guard", () => {
  it("lossy segment output falls back; punctuation and whitespace survive", () => {
    const text = "Hello, world! It's a test.";
    const toks = tokenizeParagraph(lossyPack, "en", text, noopKnown);
    assert.equal(toks.map((t) => t.surface).join(""), text);
    const nonWord = toks
      .filter((t) => !t.isWord)
      .map((t) => t.surface)
      .join("");
    assert.ok(nonWord.includes(","), "comma token");
    assert.ok(nonWord.includes("!"), "bang token");
    assert.ok(nonWord.includes("."), "period token");
    // 回退路径仍按词打 lemma/known/stopword
    const hello = toks.find((t) => t.surface === "Hello");
    assert.ok(hello?.isWord && hello.lemma === "hello");
  });

  it("honest packs are untouched (join check passes, no resegmentation)", () => {
    const text = "He said: “l'amour,” then left.";
    const surfaces = tokenizeParagraph(lossyPack, "en", text, noopKnown);
    // 丢段的 pack 在这里被兜底；对无损 pack 只断言契约本身。
    const honestPack = {
      code: "en",
      segment: (t) => t.match(/[\p{L}\p{M}]+(?:['’'‑‒–—-][\p{L}\p{M}]+)*|[^\p{L}\p{M}]+/gu) ?? [],
      lemmatize: (t) => t.toLowerCase(),
    };
    assert.equal(
      honestPack.segment(text).join(""),
      tokenizeParagraph(honestPack, "en", text, noopKnown)
        .map((t) => t.surface)
        .join("")
    );
    assert.equal(
      tokenizeParagraph(honestPack, "en", text, noopKnown)
        .map((t) => t.surface)
        .join(""),
      text
    );
    void surfaces;
  });

  it("CJK text keeps no-space runs intact via fallback", () => {
    const text = "こんにちは、世界。元気？";
    const toks = tokenizeParagraph(lossyPack, "ja", text, noopKnown);
    assert.equal(toks.map((t) => t.surface).join(""), text);
    assert.ok(toks.some((t) => !t.isWord && t.surface === "、"));
    assert.ok(toks.some((t) => !t.isWord && t.surface === "。"));
  });
});

describe("alignAutoTokens (auto mode punctuation repair)", () => {
  it("reinserts punctuation/whitespace gaps; output joins back to the sentence", () => {
    const sentence = "Hello, world! How are you?";
    const words = [
      { surface: "Hello", lemma: "hello", gloss: "你好" },
      { surface: "world", lemma: "world", gloss: "世界" },
      { surface: "How", lemma: "how", gloss: "如何" },
      { surface: "are", lemma: "be", gloss: "是" },
      { surface: "you", lemma: "you", gloss: "你" },
    ];
    const out = alignAutoTokens(sentence, words);
    assert.equal(out.map((t) => t.surface).join(""), sentence);
    const gaps = out.filter((t) => t.isWord === false);
    // 原文里的每个非词缺口都原样保留：逗号+空格、叹号+空格、词间空格、句尾问号
    assert.deepEqual(
      gaps.map((t) => t.surface),
      [", ", "! ", " ", " ", "?"]
    );
    const how = out.find((t) => t.surface === "How");
    assert.equal(how?.isWord, true);
    assert.equal(how?.gloss, "如何");
  });

  it("drops tokens the model rewrote beyond the original text (no corruption)", () => {
    const sentence = "He went home.";
    const words = [
      { surface: "He", lemma: "he", gloss: "他" },
      { surface: "wentt", lemma: "went", gloss: "去" }, // 模型改写/幻觉形
      { surface: "home", lemma: "home", gloss: "家" },
    ];
    const out = alignAutoTokens(sentence, words);
    assert.equal(out.map((t) => t.surface).join(""), sentence);
    assert.ok(!out.some((t) => t.surface === "wentt"), "改写形不得进正文");
    assert.ok(
      out.some((t) => t.gloss === "家"),
      "后续词释义不受影响"
    );
  });

  it("matches case-insensitively when the model lowercases (length-safe)", () => {
    const sentence = "The Crown fell.";
    const out = alignAutoTokens(sentence, [
      { surface: "the", lemma: "the", gloss: "这" },
      { surface: "crown", lemma: "crown", gloss: "王冠" },
      { surface: "fell", lemma: "fall", gloss: "落下" },
    ]);
    assert.equal(out.map((t) => t.surface).join(""), sentence);
    assert.ok(out.some((t) => t.surface === "Crown" && t.isWord === true));
  });

  it("CJK sentence with no gaps still round-trips", () => {
    const sentence = "これはペンです。";
    const out = alignAutoTokens(sentence, [
      { surface: "これ", lemma: "これ", gloss: "这" },
      { surface: "は", lemma: "は", gloss: "（主题）" },
      { surface: "ペン", lemma: "ペン", gloss: "笔" },
      { surface: "です", lemma: "です", gloss: "是" },
    ]);
    assert.equal(out.map((t) => t.surface).join(""), sentence);
    // 句尾句号是缺口（非词）
    const tail = out[out.length - 1];
    assert.equal(tail.surface, "。");
    assert.equal(tail.isWord, false);
  });

  it("empty word list yields the whole sentence as one non-word token", () => {
    const out = alignAutoTokens("Just text.", []);
    assert.deepEqual(out, [{ surface: "Just text.", lemma: "", gloss: "", isWord: false }]);
  });
});
