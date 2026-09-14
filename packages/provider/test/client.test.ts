import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createClient, BudgetExceededError } from "../src/client.ts";
import { HttpError, TimeoutError } from "../src/retry.ts";
import { GlossParseError } from "../src/parse.ts";
import { startMockServer, type MockServer } from "../src/mock-server.ts";
import { enChapter, TEST_KEY } from "./helpers.ts";

let mock: MockServer;
test("setup mock", async () => {
  mock = await startMockServer();
  assert.match(mock.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
});
after(async () => {
  await mock?.close();
});

function clientFor(overrides: Record<string, unknown> = {}) {
  return createClient({
    baseUrl: mock.url,
    apiKey: TEST_KEY,
    model: "mock-model",
    baseDelayMs: 5,
    ...overrides,
  } as Parameters<typeof createClient>[0]);
}

test("glossBatch returns deterministic MOCK glosses with source llm", async () => {
  mock.reset();
  const client = clientFor();
  const out = await client.glossBatch({ lang: "en", target: "zh", sentences: enChapter() });
  assert.equal(out["s1"][0].gloss, "MOCK:cat");
  assert.equal(out["s1"][0].source, "llm");
  assert.equal(out["s2"][1].gloss, "MOCK:bark");
  // usage comes from the mock envelope
  assert.equal(client.getUsage().inputTokens, 100);
  assert.equal(client.getUsage().outputTokens, 20);
});

test("client sends Authorization to the provider + JSON mode first", async () => {
  mock.reset();
  const client = clientFor();
  await client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) });
  assert.equal(mock.chatRequests.length, 1);
  assert.equal(mock.chatRequests[0].hasAuth, true);
  const body = JSON.parse(mock.chatRequests[0].body) as Record<string, unknown>;
  assert.deepEqual(body["response_format"], { type: "json_object" });
  assert.equal(body["model"], "mock-model");
});

test("weak-model fallback: 400 on response_format retries as plain text", async () => {
  mock.reset();
  mock.setDefaultBehavior("reject-json");
  try {
    const events: string[] = [];
    const client = clientFor({ onEvent: (e) => events.push(e.type) });
    const out = await client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) });
    assert.equal(out["s1"][0].gloss, "MOCK:cat");
    assert.ok(events.includes("fallback"), `events: ${events.join(",")}`);
    assert.equal(mock.chatRequests.length, 2);
    const retryBody = JSON.parse(mock.chatRequests[1].body) as Record<string, unknown>;
    assert.ok(!("response_format" in retryBody));
  } finally {
    mock.setDefaultBehavior("ok");
  }
});

test("plain-text model output still parses (weak-model content fallback)", async () => {
  mock.reset();
  mock.setDefaultBehavior("plain-text");
  try {
    const client = clientFor();
    const out = await client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) });
    assert.equal(out["s1"][1].gloss, "MOCK:sit");
  } finally {
    mock.setDefaultBehavior("ok");
  }
});

test("unparseable output retries then throws GlossParseError", async () => {
  mock.reset();
  mock.setDefaultBehavior("invalid-json");
  try {
    const client = clientFor({ maxRetries: 2 });
    await assert.rejects(
      client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) }),
      GlossParseError,
    );
    assert.equal(mock.chatRequests.length, 3);
  } finally {
    mock.setDefaultBehavior("ok");
  }
});

test("HTTP 500 retries then throws; flaky-once recovers", async () => {
  mock.reset();
  mock.setDefaultBehavior("error500");
  try {
    const client = clientFor({ maxRetries: 2 });
    await assert.rejects(
      client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) }),
      (e: unknown) => e instanceof HttpError && e.status === 500,
    );
    assert.equal(mock.chatRequests.length, 3);
  } finally {
    mock.setDefaultBehavior("ok");
  }
  mock.reset();
  mock.setDefaultBehavior("flaky-once");
  try {
    const client = clientFor();
    const out = await client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) });
    assert.equal(out["s1"][0].gloss, "MOCK:cat");
    assert.equal(mock.chatRequests.length, 2);
  } finally {
    mock.setDefaultBehavior("ok");
  }
});

test("401 never retries", async () => {
  mock.reset();
  mock.setDefaultBehavior("unauthorized");
  try {
    const client = clientFor({ maxRetries: 3 });
    await assert.rejects(
      client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) }),
      (e: unknown) => e instanceof HttpError && e.status === 401,
    );
    assert.equal(mock.chatRequests.length, 1);
  } finally {
    mock.setDefaultBehavior("ok");
  }
});

test("slow endpoint hits client timeout and retries", async () => {
  mock.reset();
  mock.setDefaultBehavior("slow");
  try {
    const client = clientFor({ maxRetries: 1, timeoutMs: 60 });
    await assert.rejects(
      client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) }),
      TimeoutError,
    );
    assert.equal(mock.chatRequests.length, 2);
  } finally {
    mock.setDefaultBehavior("ok");
  }
});

test("budget breaker blocks spend once the token cap is hit", async () => {
  mock.reset();
  const client = clientFor({ maxTokens: 50 }); // mock reports 120 tokens/request
  await client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) });
  assert.equal(client.getUsage().tripped, true);
  const before = mock.chatRequests.length;
  await assert.rejects(
    client.glossBatch({ lang: "en", target: "zh", sentences: enChapter().slice(0, 1) }),
    BudgetExceededError,
  );
  assert.equal(mock.chatRequests.length, before); // blocked pre-flight: zero new spend
  client.resetBudget();
  assert.equal(client.getUsage().tripped, false);
});

test("empty batch costs nothing; client never exposes the apiKey", async () => {
  mock.reset();
  const client = clientFor();
  assert.deepEqual(await client.glossBatch({ lang: "en", target: "zh", sentences: [] }), {});
  assert.equal(mock.chatRequests.length, 0);
  assert.ok(!JSON.stringify(client).includes(TEST_KEY));
  assert.ok(!Object.values(client).includes(TEST_KEY));
});

test("constructor validates baseUrl/model/key and rejects keyed extraHeaders", () => {
  assert.throws(() => createClient({ baseUrl: "ftp://x", apiKey: "k", model: "m" }), TypeError);
  assert.throws(() => createClient({ baseUrl: mock.url, apiKey: "", model: "m" }), TypeError);
  assert.throws(() =>
    createClient({
      baseUrl: mock.url,
      apiKey: "k",
      model: "m",
      extraHeaders: { Authorization: "Bearer x" },
    }),
  );
});
