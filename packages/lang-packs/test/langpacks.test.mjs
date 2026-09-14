import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, lemmatize, isStopword, SUPPORTED_LANGS } from "../src/index.mjs";
import { isTrustedEnStem } from "../src/en.mjs";
import * as ja from "../src/ja.mjs";

test("all 7 langs: segment/lemmatize/stopwords smoke", () => {
  assert.deepEqual(SUPPORTED_LANGS, ["en", "de", "fr", "it", "es", "ru", "ja"]);
  assert.deepEqual(segment("en", "Hello, world!"), ["Hello", "world"]);
  assert.ok(segment("de", "Grüße aus München").length >= 3);
  assert.ok(segment("fr", "l'amour de l'eau").includes("amour"));
  assert.ok(segment("it", "l'amore dell'acqua").includes("amore"));
  assert.ok(segment("es", "El niño come").length >= 3);
  assert.ok(segment("ru", "Дети читают книгу").length >= 3);
  assert.ok(segment("ja", "本を読む").length >= 2);
});

test("lemmatize: irregulars + plurals/conjugations", () => {
  assert.equal(lemmatize("en", "children"), "child");
  assert.equal(lemmatize("en", "running"), "run");
  assert.equal(lemmatize("en", "studies"), "study");
  assert.equal(lemmatize("de", "Männer"), "mann");
  assert.equal(lemmatize("de", "geht"), "gehen");
  assert.equal(lemmatize("fr", "chevaux"), "cheval");
  assert.equal(lemmatize("fr", "suis"), "être");
  assert.equal(lemmatize("it", "sono"), "essere");
  assert.equal(lemmatize("es", "tengo"), "tener");
  assert.equal(lemmatize("ru", "люди"), "человек");
  assert.equal(lemmatize("ru", "меня"), "я");
  assert.equal(lemmatize("ja", "読む"), "読む"); // builtin = identity
  // 审计矩阵回归锁（scripts/lemma-audit.mjs）：各语言屈折直还原则
  assert.equal(lemmatize("en", "houses"), "house");
  assert.equal(lemmatize("de", "gelesen"), "lesen");
  assert.equal(lemmatize("de", "Schulen"), "schule");
  assert.equal(lemmatize("fr", "parlent"), "parler");
  assert.equal(lemmatize("fr", "mangeons"), "manger");
  assert.equal(lemmatize("it", "parlate"), "parlare");
  assert.equal(lemmatize("it", "letto"), "leggere");
  assert.equal(lemmatize("es", "hablamos"), "hablar");
  assert.equal(lemmatize("es", "hablarán"), "hablar");
  assert.equal(lemmatize("es", "comiendo"), "comer");
  assert.equal(lemmatize("ru", "читают"), "читать");
  assert.equal(lemmatize("ru", "книгу"), "книга");
});

test("stopwords", () => {
  assert.equal(isStopword("en", "the"), true);
  assert.equal(isStopword("en", "book"), false);
  assert.equal(isStopword("de", "und"), true);
  assert.equal(isStopword("fr", "les"), true);
  assert.equal(isStopword("ja", "は"), true);
  assert.equal(isStopword("ja", "本"), false);
});

// 过剥回归（issue #1）：Porter stem 会把派生词砍到另一个真词（limerence->limer）。
// lemmatize 是词形还原不是词干化：只有 surface 能由 stem 合法屈折/派生得到才采用，
// 否则保留 surface（dict 查不到就 miss，绝不因 coincidental 真词展示错误释义）。
test("en over-strip guard: derivational stem only when morphologically valid", () => {
  // 过剥 -> 保留 surface（这些 stem 恰好都是真词）
  assert.equal(lemmatize("en", "limerence"), "limerence");
  assert.equal(lemmatize("en", "durable"), "durable");
  assert.equal(lemmatize("en", "after"), "after");
  assert.equal(lemmatize("en", "dure"), "dure");
  assert.equal(lemmatize("en", "aft"), "aft");
  assert.equal(lemmatize("en", "floccinaucinihilipilification"), "floccinaucinihilipilification");
  // 独立词仍按原形（limer/dure/aft 都是词典真词，保留正常释义）
  assert.equal(lemmatize("en", "limer"), "limer");
  // 正常屈折仍还原
  assert.equal(lemmatize("en", "cats"), "cat");
  assert.equal(lemmatize("en", "walked"), "walk");
  assert.equal(lemmatize("en", "houses"), "house");
  assert.equal(lemmatize("en", "studies"), "study");
  assert.equal(lemmatize("en", "running"), "run");
  assert.equal(lemmatize("en", "cities"), "city");
  assert.equal(lemmatize("en", "children"), "child");
  // 合法派生档仍可用（不是整档禁掉）：stem 通过单后缀+长度校验
  assert.equal(lemmatize("en", "introduction"), "introduct");
  assert.equal(lemmatize("en", "westminster"), "westminst");
  assert.equal(lemmatize("en", "government"), "govern");
  // 校验函数口径
  assert.equal(isTrustedEnStem("cats", "cat"), true);
  assert.equal(isTrustedEnStem("walked", "walk"), true);
  assert.equal(isTrustedEnStem("children", "child"), true);
  assert.equal(isTrustedEnStem("confessions", "confess"), false); // 链式派生：交给 loader 的复数规则
  assert.equal(isTrustedEnStem("limerence", "limer"), false);
  assert.equal(isTrustedEnStem("durable", "dur"), false);
  assert.equal(isTrustedEnStem("after", "aft"), false);
  assert.equal(isTrustedEnStem("conference", "confer"), true); // -ence 需 stem>=6
  assert.equal(isTrustedEnStem("floccinaucinihilipilification", "floccinaucinihilipilif"), false);
  // 古英语不被误伤（identity / 后缀不在过剥档）
  assert.equal(lemmatize("en", "hath"), "hath");
  assert.equal(lemmatize("en", "thou"), "thou");
});

test("ja loadLindera wires v6 API via injected importer (no network)", async () => {
  const calls = [];
  const fakeTk = {
    tokenize: (text) => text === "読む"
      ? [{ surface: "読む", details: ["動詞", "*", "*", "*", "五段・マ行", "基本形", "読む", "ヨム", "*"] }]
      : [...text].map((ch) => ({ surface: ch, details: ["*", "*", "*", "*", "*", "*", "*", "*", "*"] })),
  };
  const fakeMod = {
    default: async () => calls.push("init"),
    loadDictionaryFromBytes: (...a) => (calls.push(["dict", a.length]), { fake: "dict" }),
    TokenizerBuilder: class {
      setDictionaryInstance(d) { calls.push(["dictInstance", !!d]); }
      setMode(m) { calls.push(["mode", m]); }
      build() { return fakeTk; }
    },
  };
  await ja.loadLindera({ importer: async () => fakeMod, dictFiles: new Array(9).fill(new Uint8Array([1])) });
  assert.equal(ja.getBackend(), "lindera-wasm");
  assert.deepEqual(ja.segment("あい"), ["あ", "い"]);
  assert.equal(ja.lemmatize("読む"), "読む");
  ja.setWasmTokenizer(null);
  assert.equal(ja.getBackend(), "builtin");
  await assert.rejects(() => ja.loadLindera({ importer: async () => fakeMod }));
});

test("ja backend switch keeps contract", async () => {
  assert.equal(ja.getBackend(), "builtin");
  ja.setWasmTokenizer({ tokenize: (t) => ["MOCK", t], lemmatize: (t) => "MOCKLEMMA:" + t }, "mock-wasm");
  assert.deepEqual(ja.segment("anything"), ["MOCK", "anything"]);
  assert.equal(ja.lemmatize("読む"), "MOCKLEMMA:読む");
  ja.setWasmTokenizer(null);
  assert.equal(ja.getBackend(), "builtin");
  assert.ok(ja.segmentBuiltin("本を読む").includes("本"));
});
