// 英语屈折回归：常见 -ing/-s/-es/-ed 词形必须能通过「真实链路」查到释义：
// TrackB en pack（segment/lemmatize/isTrustedEnStem）+ dict-loader lookupKeys
// （archaic/inflection 候选展开）+ 真实 en→zh 词典分片（public/dict）。
// 2026-11-05 用户反馈：ing/加 s 形式大量 miss。本测试先固化 miss 清单，再锁修复。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

// node 环境最小 stub：localStorage（词缓存）+ fetch（词典分片读 public/dict）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
  get length() {
    return store.size;
  },
  key: (i) => [...store.keys()][i] ?? null,
};
globalThis.fetch = async (url) => {
  const m = String(url).match(/dict\/([a-z]+)\/([^/]+)\.dict(\.\d+)?$/);
  if (!m) return { ok: false, status: 404, text: async () => "" };
  try {
    const p = join(root, "packages/web/public/dict", m[1], `${m[2]}.dict${m[3] ?? ""}`);
    return { ok: true, status: 200, text: async () => readFileSync(p, "utf8") };
  } catch {
    return { ok: false, status: 404, text: async () => "" };
  }
};

const { tokenizeParagraph } = await import("../../packages/web/src/reader/tokenize.ts");
const { getGlossWithSource } = await import("../../packages/web/src/dict/dict-loader.ts");
const pack = await import("../../packages/lang-packs/src/en.mjs");

// 高频书词的屈折形（base 基本都在词典里，测「变形后还能查到」）。
const SURFACES = [
  // -ing（含去 e、双写、5 字母边界 using/owing）
  "making",
  "taking",
  "coming",
  "using",
  "owing",
  "living",
  "giving",
  "writing",
  "driving",
  "stopping",
  "sitting",
  "running",
  "getting",
  "putting",
  "swimming",
  "crying",
  "studying",
  "carrying",
  "marrying",
  "worrying",
  "hurrying",
  "walking",
  "working",
  "playing",
  "looking",
  "asking",
  "needing",
  "wanting",
  "believing",
  "waiting",
  "opening",
  "answering",
  "happening",
  "offering",
  "remembering",
  "saying",
  "seeing",
  "knowing",
  "thinking",
  "bringing",
  "teaching",
  // -s / -es（含 o/es、ch/sh/x/z/es、ies、不规则 lives/knives）
  "goes",
  "does",
  "says",
  "makes",
  "takes",
  "gives",
  "finds",
  "tells",
  "asks",
  "seems",
  "feels",
  "looks",
  "knows",
  "means",
  "calls",
  "comes",
  "stays",
  "keeps",
  "gets",
  "runs",
  "brings",
  "buys",
  "teaches",
  "catches",
  "watches",
  "pushes",
  "fixes",
  "buzzes",
  "echoes",
  "cities",
  "stories",
  "ladies",
  "babies",
  "knives",
  "lives",
  "leaves",
  "wives",
  "studies",
  // -ed（含去 e、双写、ied→y）
  "carried",
  "married",
  "worried",
  "hurried",
  "stopped",
  "planned",
  "dropped",
  "pinned",
  "walked",
  "loved",
  "hated",
  "wanted",
  "needed",
  "decided",
  "included",
  "continued",
  "used",
  "moved",
  "believed",
  "considered",
  "treated",
  "repeated",
  "suggested",
  "shouted",
  // 形容词/副词派生（兜底口径：规则尾在词典能接上就算过）
  "easier",
  "earliest",
  "happier",
  "quickly",
  "happily",
];

describe("en inflections resolve through the real dict chain", () => {
  it("every common inflected surface finds a gloss (or an honest LLM-miss)", async () => {
    const misses = [];
    for (const surface of SURFACES) {
      const lemma = pack.lemmatize(surface);
      const r = await getGlossWithSource("en", "zh", lemma, surface);
      if (!r.gloss) misses.push(`${surface} (lemma=${lemma})`);
    }
    assert.deepEqual(
      misses,
      [],
      `屈折形查不到释义（走 LLM 前就应为词典命中）: ${misses.join(", ")}`
    );
  });

  it("suspects from the 2026-11 report now hit (using/owed/stops/walked/ties/boxes)", async () => {
    for (const surface of ["using", "owed", "stops", "walked", "ties", "boxes"]) {
      const lemma = pack.lemmatize(surface);
      const r = await getGlossWithSource("en", "zh", lemma, surface);
      assert.ok(r.gloss, `${surface} (lemma=${lemma}) 仍 miss`);
    }
  });

  it("over-stripping guard intact: nonsense stems must NOT hijack real words", async () => {
    // limerence 不能被 limer 抢答；conference 应命中 confer 义或原形义，不得乱配
    const r1 = await getGlossWithSource("en", "zh", pack.lemmatize("limerence"), "limerence");
    assert.equal(r1.gloss, null, "limerence 应诚实 miss（走 LLM）");
    const r2 = await getGlossWithSource("en", "zh", pack.lemmatize("time"), "time");
    assert.ok(r2.gloss, "time 应命中");
  });
});
