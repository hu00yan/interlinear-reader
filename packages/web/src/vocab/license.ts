// Only the public verification key belongs in the browser bundle.
export const LICENSE_PUBLIC_KEY = "GjAUII81WIvw0-LFdY5T18Z7AMUCT0yTjcq-00nKS0Q";
export const LICENSE_STORAGE_KEY = "ilr.license.v1";
export const LICENSE_UNSUPPORTED =
  "当前浏览器不支持 Ed25519 License 校验，请使用新版 Chrome、Edge、Firefox 或 Safari，并通过 HTTPS 或 localhost 打开。JSON 导出仍可免费使用。";

export interface VocabLicense {
  plan: "vocab-export";
  exp: string;
  name: string;
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  );
  // Reject non-canonical encodings (including mutations of unused padding bits).
  if (
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "") !== value
  )
    throw new Error("Invalid base64url");
  return bytes;
}

function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", decode(publicKey), "Ed25519", false, ["verify"]);
}

export async function supportsLicenseVerification(): Promise<boolean> {
  try {
    await importPublicKey(LICENSE_PUBLIC_KEY);
    return true;
  } catch {
    return false;
  }
}

// Explicit key parameter is a pure verification seam for ephemeral test keys.
// Production callers omit it; persistence/unlocking always uses the embedded key.
export async function parseLicense(
  token: string,
  publicKey = LICENSE_PUBLIC_KEY
): Promise<VocabLicense | null> {
  try {
    if (typeof token !== "string" || token.length > 8192) return null;
    const parts = token.trim().split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    const bytes = decode(payload);
    const sig = decode(signature);
    if (sig.length !== 64) return null;
    const key = await importPublicKey(publicKey);
    if (!(await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(payload))))
      return null;
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !data ||
      data.plan !== "vocab-export" ||
      typeof data.name !== "string" ||
      !data.name.trim() ||
      typeof data.exp !== "string"
    )
      return null;
    const expiry = Date.parse(data.exp);
    if (
      !Number.isFinite(expiry) ||
      new Date(expiry).toISOString() !== data.exp ||
      expiry <= Date.now()
    )
      return null;
    return { plan: data.plan, exp: data.exp, name: data.name };
  } catch {
    return null;
  }
}

export async function saveVocabExportLicense(token: string): Promise<boolean> {
  if (!(await parseLicense(token))) return false;
  localStorage.setItem(LICENSE_STORAGE_KEY, token.trim());
  return true;
}

export async function isVocabExportUnlocked(): Promise<boolean> {
  try {
    // Cache only the signed token, never a trusted boolean. Re-verify on every load
    // and export click so expiry and localStorage edits cannot leave a stale unlock.
    return (await parseLicense(localStorage.getItem(LICENSE_STORAGE_KEY) ?? "")) !== null;
  } catch {
    return false;
  }
}
