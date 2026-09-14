// Retry / backoff / timeout primitives. No key material flows through here.

export class TimeoutError extends Error {
  code = "E_TIMEOUT";
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class HttpError extends Error {
  code = "E_HTTP";
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retryable unless the error is a definitive client rejection. */
export function shouldRetry(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof HttpError) return isRetryableStatus(error.status);
  // TypeError = network failure in fetch; GlossParseError may clear on retry.
  if (error instanceof TypeError) return true;
  if (error instanceof Error && error.name === "GlossParseError") return true;
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter: base * 2^attempt + [0, base). */
export function backoffDelay(attempt: number, baseMs: number): number {
  return baseMs * 2 ** attempt + Math.random() * baseMs;
}

/** Race a promise against a timeout. Does not cancel the loser. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => resolve(v),
        (e) => reject(e),
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Generic retry used by the client. fn(attempt) runs up to maxRetries+1 times;
 * onRetry receives the redacted-safe reason string.
 */
export async function retryable<T>(args: {
  maxRetries: number;
  baseDelayMs: number;
  onRetry?: (attempt: number, error: unknown) => void;
  fn: (attempt: number) => Promise<T>;
}): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= args.maxRetries; attempt++) {
    try {
      return await args.fn(attempt);
    } catch (error) {
      last = error;
      if (attempt >= args.maxRetries || !shouldRetry(error)) throw error;
      args.onRetry?.(attempt, error);
      await sleep(backoffDelay(attempt, args.baseDelayMs));
    }
  }
  throw last;
}
