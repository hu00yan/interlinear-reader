import test from "node:test";
import assert from "node:assert/strict";
import {
  KeySettings,
  CONFIG,
  SESSION_ONLY,
  CONFIRMED_ENDPOINT,
  maskKey,
  keySummary,
  providerConsole,
} from "../src/security.mjs";

function fixture(initial = []) {
  const values = new Map(initial),
    writes = [];
  const get = (key, fallback) => (values.has(key) ? structuredClone(values.get(key)) : fallback);
  const set = (key, value) => {
    writes.push([key, structuredClone(value)]);
    values.set(key, structuredClone(value));
  };
  return { values, writes, get, set, settings: new KeySettings(get, set) };
}

test("masked display includes update time and rotation hint, never a complete secret", () => {
  assert.equal(maskKey("sk-example-1234"), "sk-…1234");
  for (const key of ["a", "1234", "12345678"]) assert.equal(maskKey(key), "••••");
  assert.equal(maskKey(""), "未设置");
  const summary = keySummary({
    key: "sk-example-1234",
    rememberKey: true,
    keyUpdatedAt: "2026-09-17T00:00:00.000Z",
  });
  assert.ok(summary.includes("sk-…1234 · 已记住（本地磁盘） · 更新：2026-09-17T00:00:00.000Z"));
  assert.ok(summary.includes("轮换"));
  assert.ok(!summary.includes("sk-example-1234"));
  assert.ok(keySummary({ key: "legacy-key" }).includes("未知（旧配置）"));
});

test("default persists key and timestamp across reload, and clearing key erases it", () => {
  const f = fixture();
  const before = Date.now();
  f.settings.configure("https://provider.example/v1", "model", "test-key");
  assert.equal(f.values.get(CONFIG).key, "test-key");
  assert.equal(f.values.get(CONFIG).rememberKey, true);
  assert.ok(Date.parse(f.settings.config.keyUpdatedAt) >= before);
  assert.deepEqual(new KeySettings(f.get, f.set).config, f.settings.config);
  f.settings.configure("https://provider.example/v1", "model", "");
  assert.equal(f.values.get(CONFIG), null);
});

test("opt-out erases disk key, retains page key, survives reload and can be reversed", () => {
  const f = fixture();
  f.settings.configure("https://provider.example/v1", "model", "test-key");
  f.settings.setSessionOnly(true);
  assert.equal(f.values.get(CONFIG), null);
  assert.equal(f.values.get(SESSION_ONLY), true);
  assert.equal(f.settings.config.key, "test-key");
  const reloaded = new KeySettings(f.get, f.set);
  assert.equal(reloaded.config, null);
  reloaded.configure("https://provider.example/v1", "model", "next-key");
  assert.equal(f.values.get(CONFIG), null);
  assert.equal(new KeySettings(f.get, f.set).config, null);
  reloaded.setSessionOnly(false);
  assert.equal(f.values.get(CONFIG).key, "next-key");
});

test("legacy persisted keys are retained with unknown timestamp; explicit opt-out wins", () => {
  const saved = { endpoint: "https://provider.example/v1", model: "model", key: "legacy-key" };
  const f = fixture([[CONFIG, saved]]);
  assert.equal(f.settings.config.key, "legacy-key");
  assert.equal(f.settings.config.rememberKey, true);
  assert.ok(keySummary(f.settings.config).includes("未知（旧配置）"));
  const optedOut = fixture([
    [CONFIG, saved],
    [SESSION_ONLY, true],
  ]);
  assert.equal(optedOut.settings.config.key, "");
  assert.equal(optedOut.values.get(CONFIG), null);
});

test("endpoint changes require confirmation, including after reload and returning to an earlier endpoint", () => {
  const f = fixture();
  const a = "https://a.example/v1",
    b = "https://b.example/v1";
  assert.equal(f.settings.needsEndpointConfirmation(a), true);
  f.settings.confirmEndpoint(a);
  assert.equal(f.values.get(CONFIRMED_ENDPOINT), a);
  assert.equal(f.settings.needsEndpointConfirmation(a), false);
  assert.equal(f.settings.needsEndpointConfirmation(b), true);
  f.settings.confirmEndpoint(b);
  assert.equal(f.settings.needsEndpointConfirmation(a), true);
  f.settings.configure(b, "model", "key");
  assert.equal(f.settings.needsEndpointConfirmation(b), true);
  assert.equal(new KeySettings(f.get, f.set).needsEndpointConfirmation(b), true);
});

test("provider console links use exact recognized domains and fixed HTTPS destinations", () => {
  for (const host of [
    "api.openai.com",
    "api.anthropic.com",
    "api.deepseek.com",
    "api.moonshot.cn",
    "api.moonshot.ai",
  ]) {
    assert.ok(providerConsole(`https://${host}/v1`).url.startsWith("https://"));
  }
  for (const endpoint of [
    "https://api.openai.com.attacker.example",
    "https://attacker.example/api.openai.com",
    "bad",
    undefined,
  ]) {
    assert.equal(providerConsole(endpoint), null);
  }
});
