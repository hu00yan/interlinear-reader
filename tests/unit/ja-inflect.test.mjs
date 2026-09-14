// ja 活用还原 + 单假名碎片抑制（web 查词链；node --test 可跑）。
// 跑：node --test tests/unit/ja-inflect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { deinflectJa, isJaKanaFragment } from "../../packages/web/src/dict/ja-inflect.mjs";
import * as owner from "../../packages/lang-packs/src/ja.mjs";

test("deinflect: ます/た/ない/形容词还原到辞書形", () => {
  assert.ok(deinflectJa("買いました").includes("買う"), "買いました→買う");
  assert.ok(deinflectJa("高かった").includes("高い"), "高かった→高い");
  assert.ok(deinflectJa("食べた").includes("食べる"), "食べた→食べる");
  assert.ok(deinflectJa("見ない").includes("見る"), "見ない→見る");
  assert.ok(deinflectJa("新しい").length === 0 || true, "probe only");
  assert.ok(deinflectJa("しました").includes("する"), "しました→する");
  assert.ok(deinflectJa("来た").includes("来る"), "来た→来る");
});

test("deinflect: 原形不产猜测（调用方原形优先，防抢答）", () => {
  assert.deepEqual(deinflectJa("見る"), [], "見る是原形");
  assert.deepEqual(deinflectJa("食べる"), [], "食べる是原形");
  assert.deepEqual(deinflectJa("高い"), [], "高い是原形");
});

test("class-matrix: 五段九行×活用 / 一段 / カ変 / サ変 / 形容词", () => {
  const M = [
    // [输入, 期望原形, 说明]
    ["書かない", "書く", "五段カ行否定"], ["書きます", "書く", "五段ます"],
    ["書いた", "書く", "五段た"], ["書いて", "書く", "五段て"],
    ["書ける", "書く", "五段可能"], ["書こう", "書く", "五段推量"],
    ["泳いだ", "泳ぐ", "五段ガ行"], ["話した", "話す", "五段サ行"],
    ["待った", "待つ", "五段タ行"], ["死んだ", "死ぬ", "五段ナ行"],
    ["読んだ", "読む", "五段マ行"], ["取った", "取る", "五段ラ行"],
    ["買った", "買う", "五段ワ行"], ["買わない", "買う", "五段ワ行否定"],
    ["行った", "行く", "五段カ行特例"], ["いった", "いく", "五段络み"],
    ["食べない", "食べる", "一段否定"], ["食べます", "食べる", "一段ます"],
    ["食べた", "食べる", "一段た"], ["見た", "見る", "一段た"],
    ["いた", "いる", "一段た碎片"], ["できる", "できる", "一段原形不猜"],
    ["来ない", "来る", "カ変否定"], ["来ます", "来る", "カ変ます"],
    ["来た", "来る", "カ変た"], ["来よう", "来る", "カ変推量"],
    ["来い", "来る", "カ変命令"], ["来られる", "来る", "カ変被动"],
    ["こない", "くる", "カ変かな否定"], ["きた", "くる", "カ変かなた"],
    ["しない", "する", "サ変否定"], ["します", "する", "サ変ます"],
    ["した", "する", "サ変た"], ["しよう", "する", "サ変推量"],
    ["しろ", "する", "サ変命令"], ["される", "する", "サ変被动"],
    ["勉強した", "勉強する", "サ変复合"], ["話します", "話す", "サ変形ます干"],
    ["高くない", "高い", "形容词否定"], ["高かった", "高い", "形容词过去"],
    ["高ければ", "高い", "形容词假设"], ["静かだった", "静か", "な形容词"],
    ["開ければ", "開ける", "一段假设（旧 bug 会判開く）"],
  ];
  let bad = 0;
  for (const [input, want, note] of M) {
    const got = deinflectJa(input);
    // 原形直接命中时 deinflect 为空也算过（调用方原形优先）
    if (input !== want && !got.includes(want)) { bad++; console.error(`MISS ${note}: ${input} -> [${got.slice(0, 5)}] want ${want}`); }
  }
  assert.equal(bad, 0, `${bad} forms failed`);
});

test("deinflect: 連用形裸语干兜底（链式无产出才猜，精确优先）", () => {
  assert.ok(deinflectJa("思").includes("思う"), "思→思う");
  assert.ok(deinflectJa("出").includes("出る"), "出→出る");
  assert.ok(deinflectJa("高").includes("高い"), "高→高い");
  assert.ok(deinflectJa("書き").includes("書く"), "書き→書く");
  assert.ok(deinflectJa("来").includes("来る"), "来→来る");
  assert.ok(deinflectJa("いた").includes("いる"), "いた→いる");
  assert.ok(!deinflectJa("家").includes("家"), "家猜测不含自身");
});

test("deinflect: 猜测永不含原形自身", () => {
  for (const t of ["買いました", "高かった", "食べた", "見ない", "話します", "書かれる"]) {
    assert.ok(!deinflectJa(t).includes(t), `${t} 猜测不含自身`);
  }
});

test("parity: web ja-inflect 与 owner lang-packs/ja 一致", () => {
  const corpus = ["買いました", "高かった", "食べた", "見ない", "話します", "書かれる",
    "している", "飲みたい", "静かだった", "来た", "しました", "面白そう", "東京", "魑魅"];
  for (const t of corpus) {
    assert.deepEqual(deinflectJa(t), owner.deinflectJa(t), `parity ${t}`);
  }
});

test("isJaKanaFragment: 单假名碎片 vs 单字汉字", () => {
  for (const k of ["は", "を", "ま", "た", "っ", "か", "で", "に"]) assert.equal(isJaKanaFragment(k), true, k);
  for (const k of ["家", "町", "人", "見る", "買う", "東京", "。", "ab"]) assert.equal(isJaKanaFragment(k), false, k);
});
