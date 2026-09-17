#!/usr/bin/env node
// Admin-only: this file is never imported by the web app.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

try {
  const { values } = parseArgs({
    options: {
      generate: { type: "boolean" },
      key: { type: "string" },
      name: { type: "string" },
      plan: { type: "string" },
      years: { type: "string" },
    },
  });
  const keyPath = resolve(values.key ?? `${homedir()}/.config/interlinear-reader/license-key.json`);
  const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
  const insideRepo = (path) => {
    const rel = relative(repo, path);
    return (
      rel === "" ||
      (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel))
    );
  };
  if (insideRepo(keyPath)) throw new Error("Signing keys must be stored OUTSIDE the repository.");
  // Resolve the parent to reject a symlink that points back into the repo.
  if (values.generate) await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  const realParent = await realpath(dirname(keyPath));
  if (insideRepo(realParent))
    throw new Error("Signing keys must be stored OUTSIDE the repository.");
  if (values.generate) {
    if (values.name || values.plan || values.years)
      throw new Error("Use --generate separately from signing.");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    // Exclusive creation: never overwrite a deployed signing key. No private bytes on stdout.
    await writeFile(keyPath, JSON.stringify(privateKey.export({ format: "jwk" })), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Private key stored outside repo: ${keyPath}`);
    console.log(`Public key (raw base64url): ${publicKey.export({ format: "jwk" }).x}`);
  } else {
    const years = Number(values.years ?? 1);
    if (
      !values.name?.trim() ||
      Buffer.byteLength(values.name.trim(), "utf8") > 1000 ||
      values.plan !== "vocab" ||
      !Number.isInteger(years) ||
      years < 1 ||
      years > 100
    ) {
      throw new Error(
        "Usage: node sign.mjs --name Alice --plan vocab --years 1 [--key /outside/repo/key.json]\nGenerate first: node sign.mjs --generate"
      );
    }
    if (insideRepo(await realpath(keyPath)))
      throw new Error("Signing keys must be stored OUTSIDE the repository.");
    const privateKey = createPrivateKey({
      key: JSON.parse(await readFile(keyPath, "utf8")),
      format: "jwk",
    });
    if (createPublicKey(privateKey).asymmetricKeyType !== "ed25519")
      throw new Error("Expected an Ed25519 key.");
    const exp = new Date();
    exp.setUTCFullYear(exp.getUTCFullYear() + years);
    const payload = Buffer.from(
      JSON.stringify({ plan: "vocab-export", exp: exp.toISOString(), name: values.name.trim() })
    ).toString("base64url");
    console.log(
      `${payload}.${sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url")}`
    );
  }
} catch (error) {
  // Do not include key file contents in diagnostics.
  console.error(
    error instanceof SyntaxError
      ? "Invalid key file or command arguments."
      : error.code === "EEXIST"
        ? "Key already exists; refusing to overwrite it."
        : error.message
  );
  process.exitCode = 1;
}
