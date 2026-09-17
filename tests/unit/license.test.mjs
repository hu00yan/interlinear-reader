import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  parseLicense,
  isVocabExportUnlocked,
  saveVocabExportLicense,
  LICENSE_STORAGE_KEY,
  supportsLicenseVerification,
} from "../../packages/web/src/vocab/license.ts";

// No fixtures or signing material: every run creates a throwaway keypair in memory.
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
const keys = await webcrypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const publicKey = Buffer.from(await webcrypto.subtle.exportKey("raw", keys.publicKey)).toString(
  "base64url"
);
const valid = { plan: "vocab-export", exp: "2099-01-01T00:00:00.000Z", name: "Alice 爱丽丝" };
async function token(data = valid) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = await webcrypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${Buffer.from(sig).toString("base64url")}`;
}

test("valid Ed25519 license returns only the verified payload", async () => {
  assert.deepEqual(await parseLicense(await token(), publicKey), valid);
  assert.deepEqual(await parseLicense(`  ${await token()}  `, publicKey), valid);
  assert.equal(await supportsLicenseVerification(), true);
});

test("expired and malformed signed payloads are rejected", async () => {
  for (const data of [
    { ...valid, exp: "2000-01-01T00:00:00.000Z" },
    { ...valid, exp: new Date().toISOString() },
    { ...valid, exp: "2099-02-31T00:00:00.000Z" },
    { ...valid, exp: "not-a-date" },
    { ...valid, exp: 9999999999999 },
    { ...valid, plan: "other" },
    { ...valid, name: " " },
    { ...valid, name: 7 },
    null,
    [],
  ])
    assert.equal(await parseLicense(await token(data), publicKey), null);
});

test("payload/signature tampering and a different public key are rejected", async () => {
  const signed = await token();
  const [payload, signature] = signed.split(".");
  const modified = Buffer.from(JSON.stringify({ ...valid, name: "Mallory" })).toString("base64url");
  assert.equal(await parseLicense(`${modified}.${signature}`, publicKey), null);
  const bytes = Buffer.from(signature, "base64url");
  bytes[0] ^= 1;
  assert.equal(await parseLicense(`${payload}.${bytes.toString("base64url")}`, publicKey), null);
  assert.equal(await parseLicense(signed), null); // production key is never replaced
});

test("garbage, bad encodings, and oversized inputs fail closed", async () => {
  for (const input of ["", "garbage", "a.b.c", "=.abc", "a.b", "x".repeat(8193), null, {}, "😀.😀"])
    assert.equal(await parseLicense(input, publicKey), null);
});

test("localStorage is an untrusted token cache, not an unlock boolean", async () => {
  const data = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
    },
  });
  for (const cached of ["true", '{"unlocked":true}', await token()]) {
    data.set(LICENSE_STORAGE_KEY, cached);
    assert.equal(await isVocabExportUnlocked(), false);
  }
  data.clear();
  assert.equal(await saveVocabExportLicense("garbage"), false);
  assert.equal(data.size, 0);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  assert.equal(await isVocabExportUnlocked(), false);
  delete globalThis.localStorage;
});

test("unsupported browsers fail closed without an exception", async () => {
  Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
  try {
    assert.equal(await supportsLicenseVerification(), false);
    assert.equal(await parseLicense(await token(), publicKey), null);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
  }
});
