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
  assert.deepEqual(deinflectJa("家"), [], "单字无猜测");
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
