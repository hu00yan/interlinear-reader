import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, lemmatize, isStopword, SUPPORTED_LANGS } from "../src/index.mjs";
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
