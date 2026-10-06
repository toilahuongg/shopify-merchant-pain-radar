/**
 * Retry helper with exponential backoff.
 *
 * Retries 429/500/502/503/504 and network failures. Never retries other 4xx
 * (invalid request, auth, not found) — those will not become valid by retrying.
 */

export class NonRetryableError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "NonRetryableError";
    this.status = status;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableError) return false;
  if (error instanceof HttpError) return isRetryableStatus(error.status);
  // AbortError / TypeError from fetch: network level, worth retrying.
  return true;
}

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** Deterministic jitter source for tests; defaults to Math.random. */
  random?: () => number;
}

export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = exponential * 0.25 * random();
  return Math.round(exponential + jitter);
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Runs `fn`, retrying transient failures. `attempt` starts at 1. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const retries = Math.max(0, options.retries);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const canRetry = attempt <= retries && isRetryable(error);
      if (!canRetry) break;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      options.onRetry?.(attempt, error, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}
