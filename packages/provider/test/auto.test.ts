import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AUTO_LANG,
  buildAutoSegmentMessages,
  cacheKeyForAutoToken,
  parseAutoSegmentContent,
} from "../src/auto.ts";
import { cacheKeyForToken } from "../src/cache.ts";
import { GlossParseError } from "../src/parse.ts";
import { startMockServer, type MockServer } from "../src/mock-server.ts";

let mock: MockServer;
test("setup mock", async () => {
  mock = await startMockServer();
});
after(async () => {
  await mock?.close();
});

test("auto prompt: lang=auto + auto-detect + target", () => {
  const { system, user } = buildAutoSegmentMessages({
    target: "zh",
    sentences: [{ id: "s1", text: "مرحبا بالعالم" }],
  });
  assert.match(system, /auto-detect/i);
  assert.match(system, /segment/i);
  const payload = JSON.parse(user) as Record<string, unknown>;
  assert.equal(payload["lang"], "auto");
  assert.equal(payload["target"], "zh");
  assert.deepEqual((payload["sentences"] as Array<unknown>)[0], {
    id: "s1",
    text: "مرحبا بالعالم",
  });
});

test("auto parse: sentences/tokens JSON (+fence/Record 兼容)", () => {
  const sents = [{ id: "s1", text: "مرحبا بالعالم" }];
  const raw = JSON.stringify({
    sentences: [
      {
        id: "s1",
        detectedLang: "ar",
        tokens: [
          { i: 0, surface: "مرحبا", lemma: "مرحبا", gloss: "你好" },
          { i: 1, surface: "بالعالم", lemma: "بالعالم", gloss: "世界" },
        ],
      },
    ],
  });
  const out = parseAutoSegmentContent(raw, sents);
  assert.equal(out["s1"].length, 2);
  assert.equal(out["s1"][0].gloss, "你好");
  assert.equal(out["s1"][0].source, "llm");

  const fenced = "```json\n" + raw + "\n```";
  assert.deepEqual(parseAutoSegmentContent(fenced, sents), out);

  const rec = JSON.stringify({
    s1: [
      { i: 0, surface: "مرحبا", gloss: "你好" },
      { i: 1, surface: "بالعالم", gloss: "世界" },
    ],
  });
  const out2 = parseAutoSegmentContent(rec, sents);
  assert.equal(out2["s1"][1].lemma, "بالعالم"); // lemma 缺省回 surface
  assert.throws(() => parseAutoSegmentContent("no json here {{{", sents), GlossParseError);
});

test("auto cache key: sha1(auto|target|lemma|句)，与 provider 口径一致", () => {
  assert.equal(AUTO_LANG, "auto");
  const k = cacheKeyForAutoToken({
    target: "zh",
    lemma: "مرحبا",
    sentenceText: "مرحبا بالعالم",
  });
  const expected = createHash("sha1")
    .update("auto|zh|مرحبا|مرحبا بالعالم", "utf8")
    .digest("hex");
  assert.equal(k, expected);
  assert.match(k, /^[0-9a-f]{40}$/);
  assert.equal(
    k,
    cacheKeyForToken({ lang: "auto", target: "zh", lemma: "مرحبا", sentenceText: "مرحبا بالعالم" }),
  );
  // 上下文敏感：同 lemma 异句异键；异 target 异键
  assert.notEqual(
    k,
    cacheKeyForAutoToken({ target: "zh", lemma: "مرحبا", sentenceText: "صباح الخير" }),
  );
  assert.notEqual(
    k,
    cacheKeyForAutoToken({ target: "en", lemma: "مرحبا", sentenceText: "مرحبا بالعالم" }),
  );
});

test("auto mock e2e: 阿语整句无词典直出 MOCK 分词+注", async () => {
  mock.reset();
  const { system, user } = buildAutoSegmentMessages({
    target: "zh",
    sentences: [{ id: "s1", text: "مرحبا بالعالم" }],
  });
  const resp = await fetch(`${mock.url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
    body: JSON.stringify({
      model: "mock-model",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
    }),
  });
  assert.equal(resp.status, 200);
  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const out = parseAutoSegmentContent(data.choices[0].message.content, [
    { id: "s1", text: "مرحبا بالعالم" },
  ]);
  assert.ok(out["s1"].length >= 2, `mock 应分出>=2词，got ${JSON.stringify(out)}`);
  for (const t of out["s1"]) {
    assert.match(t.gloss, /^MOCK:/);
    assert.equal(t.source, "llm");
  }
  assert.equal(mock.chatRequests.length, 1);
});
