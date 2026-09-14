import test from "node:test";
import assert from "node:assert/strict";
import {
  backoffDelay,
  HttpError,
  retryable,
  shouldRetry,
  TimeoutError,
  withTimeout,
} from "../src/retry.ts";
import { BudgetExceededError, BudgetTracker, estimateTokens } from "../src/budget.ts";

test("retryable succeeds after flaky failures", async () => {
  let n = 0;
  const v = await retryable({
    maxRetries: 3,
    baseDelayMs: 1,
    fn: async () => {
      n += 1;
      if (n < 3) throw new HttpError(500, "boom");
      return "ok";
    },
  });
  assert.equal(v, "ok");
  assert.equal(n, 3);
});

test("retryable does not retry definitive client errors", async () => {
  let n = 0;
  await assert.rejects(
    retryable({
      maxRetries: 3,
      baseDelayMs: 1,
      fn: async () => {
        n += 1;
        throw new HttpError(401, "bad key");
      },
    }),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
  assert.equal(n, 1);
});

test("shouldRetry covers timeout/network/5xx/429 only", () => {
  assert.equal(shouldRetry(new TimeoutError("t")), true);
  assert.equal(shouldRetry(new TypeError("fetch failed")), true);
  assert.equal(shouldRetry(new HttpError(429, "slow down")), true);
  assert.equal(shouldRetry(new HttpError(503, "x")), true);
  assert.equal(shouldRetry(new HttpError(400, "bad")), false);
  assert.equal(shouldRetry(new HttpError(401, "no")), false);
  assert.equal(shouldRetry(new BudgetExceededError("cap", {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    tripped: true,
  })), false);
});

test("backoff grows exponentially within jitter band", () => {
  for (let a = 0; a < 4; a++) {
    const d = backoffDelay(a, 100);
    assert.ok(d >= 100 * 2 ** a && d < 100 * 2 ** a + 100, `attempt ${a}: ${d}`);
  }
});

test("withTimeout resolves fast work and rejects slow work", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 200), 7);
  await assert.rejects(withTimeout(new Promise(() => {}), 20), TimeoutError);
});

test("estimateTokens is chars/4 rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("budget trips on token cap and blocks further spend", () => {
  const b = new BudgetTracker({ maxTokens: 10 });
  b.record(4, 4);
  assert.equal(b.tripped, false);
  b.ensure();
  b.record(1, 2); // total 11 > 10
  assert.equal(b.tripped, true);
  assert.throws(() => b.ensure(), BudgetExceededError);
  b.reset();
  assert.equal(b.tripped, false);
  b.ensure();
});

test("budget trips on cost cap when prices are known", () => {
  const b = new BudgetTracker({
    maxCostUsd: 0.001,
    prices: { input: 0.01, output: 0.03 },
  });
  b.record(100, 0); // $0.001, exactly at cap: still ok
  assert.equal(b.tripped, false);
  b.ensure();
  b.record(1, 0); // $0.00101 > cap
  assert.equal(b.tripped, true);
  assert.ok(b.costUsd > 0.001);
});
