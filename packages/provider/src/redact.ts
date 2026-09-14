// Key-material guards + log redaction. The apiKey must never reach logs,
// persistence, or any request bound for our own domain (remote shared cache).

const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{8,}|sk-or-[A-Za-z0-9_-]{8,}|rk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g;
const KEY_ASSIGNMENT = /(api[_-]?key|authorization|x-api-key)\s*[:=]\s*["']?[^"'\s,}]+["']?/gi;
/** Header/field names that must never appear in extraHeaders or logs. */
export const SENSITIVE_FIELD = /^(authorization|api[_-]?key|x-api-key|proxy-authorization)$/i;

/** True when a string looks like it carries key material. */
export function containsKeyMaterial(value: unknown): boolean {
  if (typeof value !== "string") return false;
  SECRET_VALUE.lastIndex = 0;
  KEY_ASSIGNMENT.lastIndex = 0;
  return SECRET_VALUE.test(value) || KEY_ASSIGNMENT.test(value);
}

/** Mask key material inside free text. Safe to run twice (idempotent). */
export function redactApiKeyText(text: string): string {
  return text
    .replace(SECRET_VALUE, "***REDACTED***")
    .replace(KEY_ASSIGNMENT, "$1=***REDACTED***");
}

/**
 * Deep-clone a value for logging/event payloads, masking sensitive fields
 * (authorization / apiKey / x-api-key, any casing) and scrubbing secrets
 * inside string values.
 */
export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") return redactApiKeyText(value);
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_FIELD.test(k) ? "***REDACTED***" : sanitizeForLog(v);
    }
    return out;
  }
  return value;
}
