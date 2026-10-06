import { describe, expect, it } from "vitest";
import {
  HttpError,
  NonRetryableError,
  backoffDelay,
  isRetryableError,
  isRetryableStatus,
  withRetry,
} from "../src/lib/retry";

describe("retry classification", () => {
  it("retries only transient status codes", () => {
    for (const status of [429, 500, 502, 503, 504]) expect(isRetryableStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) expect(isRetryableStatus(status)).toBe(false);
  });

  it("treats network errors as retryable and NonRetryableError as terminal", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError(new NonRetryableError("bad request", 400))).toBe(false);
    expect(isRetryableError(new HttpError(503, "unavailable"))).toBe(true);
    expect(isRetryableError(new HttpError(400, "bad"))).toBe(false);
    expect(isRetryableError(new Error("custom"))).toBe(true);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and respects the cap", () => {
    expect(backoffDelay(1, 100, 10_000, () => 0)).toBe(100);
    expect(backoffDelay(2, 100, 10_000, () => 0)).toBe(200);
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(400);
    expect(backoffDelay(9, 100, 1_000, () => 0)).toBe(1_000);
  });

  it("adds deterministic jitter from the injected random source", () => {
    expect(backoffDelay(1, 100, 10_000, () => 1)).toBe(125);
  });
});

describe("withRetry", () => {
  it("returns the first successful result without sleeping", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return "ok";
    }, { retries: 3 });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("stops after retries are exhausted and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new HttpError(503, "still down");
        },
        { retries: 2, sleep: async () => {}, random: () => 0 },
      ),
    ).rejects.toThrow(/HTTP 503/);
    expect(calls).toBe(3);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new NonRetryableError("invalid", 422);
        },
        { retries: 4, sleep: async () => {} },
      ),
    ).rejects.toThrow("invalid");
    expect(calls).toBe(1);
  });

  it("reports retry attempts through onRetry", async () => {
    const attempts: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new HttpError(500, "boom");
        return "done";
      },
      { retries: 5, sleep: async () => {}, random: () => 0, onRetry: (attempt) => attempts.push(attempt) },
    );
    expect(attempts).toEqual([1, 2]);
  });
});
