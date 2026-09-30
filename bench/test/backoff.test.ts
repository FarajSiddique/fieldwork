import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  isRetryableError,
  parseRetryAfter,
  retriesFromEnv,
  retryAfterMs,
  withBackoff,
  type Attempt,
  type BackoffOptions,
} from "../src/backoff.ts";

const options = (extra: Partial<BackoffOptions> = {}): BackoffOptions => ({
  retries: 3,
  baseMs: 100,
  maxMs: 1000,
  random: () => 1,
  ...extra,
});

describe("backoffDelay", () => {
  it("grows exponentially up to the cap", () => {
    const delays = [0, 1, 2, 3, 4, 10].map((n) => backoffDelay(n, options()));

    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000]);
  });

  it("is jittered within [0, cap]", () => {
    expect(backoffDelay(2, options({ random: () => 0 }))).toBe(0);
    expect(backoffDelay(2, options({ random: () => 0.5 }))).toBe(200);
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelay(9, options({ random: Math.random }));
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });

  it("honours Retry-After when it is longer, but never past twice the cap", () => {
    const o = options({ random: () => 0.1 });

    expect(backoffDelay(0, o, 700)).toBe(700);
    expect(backoffDelay(0, o, 5)).toBe(10);
    expect(backoffDelay(0, o, 60_000)).toBe(2000);
  });
});

describe("withBackoff", () => {
  const script = (results: Attempt<string>[]) => {
    const queue = [...results];
    return vi.fn(async () => queue.shift()!);
  };
  const retry = (retryAfterMs?: number): Attempt<string> => ({ retry: "429", retryAfterMs });

  it("succeeds after retryable failures, waiting between them", async () => {
    const wait = vi.fn<NonNullable<BackoffOptions["sleep"]>>(async () => {});
    const attempt = script([retry(), retry(500), { done: "ok" }]);

    const result = await withBackoff(attempt, options({ sleep: wait }), () => "gave up");

    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map((c) => c[0])).toEqual([100, 500]);
  });

  it("gives up after the retries, handing the last reason to onGiveUp", async () => {
    const wait = vi.fn(async () => {});
    const attempt = script([retry(), retry(), retry(), retry(), { done: "never" }]);

    const result = await withBackoff(attempt, options({ sleep: wait }), (r) => `gave up ${r}`);

    expect(result).toBe("gave up 429");
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("does not retry a throw", async () => {
    const attempt = vi.fn(async (): Promise<Attempt<string>> => {
      throw new Error("bad request");
    });

    await expect(withBackoff(attempt, options(), () => "x")).rejects.toThrow("bad request");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not wait when there are no retries", async () => {
    const wait = vi.fn(async () => {});

    const result = await withBackoff(
      script([retry()]),
      options({ retries: 0, sleep: wait }),
      () => "gave up",
    );

    expect(result).toBe("gave up");
    expect(wait).not.toHaveBeenCalled();
  });

  it("rejects with the signal's reason when aborted during a wait, leaving no timer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = withBackoff(
        script([retry(), { done: "ok" }]),
        options({ signal: controller.signal }),
        () => "x",
      );
      const assertion = expect(pending).rejects.toBe("stop");
      await vi.advanceTimersByTimeAsync(10);

      controller.abort("stop");
      await assertion;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isRetryableError", () => {
  const apiError = (fields: Partial<ConstructorParameters<typeof APICallError>[0]>) =>
    new APICallError({ message: "failed", url: "u", requestBodyValues: {}, ...fields });

  it("recognises an AI SDK error that says it is retryable", () => {
    expect(isRetryableError(apiError({ isRetryable: true }))).toBe(true);
    expect(isRetryableError(apiError({ isRetryable: false, statusCode: 400 }))).toBe(false);
  });

  it("recognises retryable statuses", () => {
    for (const statusCode of [408, 429, 500, 503]) {
      expect(isRetryableError(Object.assign(new Error("x"), { statusCode }))).toBe(true);
    }
    expect(isRetryableError(Object.assign(new Error("x"), { statusCode: 403 }))).toBe(false);
  });

  it("recognises the gateway's rate limit and the AI SDK's retry wrapper around it", () => {
    const limit = new Error("No access to this model at this time.");
    limit.name = "GatewayRateLimitError";
    const wrapped = Object.assign(
      new Error(
        "Failed after 3 attempts. Last error: GatewayRateLimitError: No access to this model at this time.",
      ),
      { name: "AI_RetryError" },
    );

    expect(isRetryableError(limit)).toBe(true);
    expect(isRetryableError(wrapped)).toBe(true);
    expect(isRetryableError(Object.assign(new Error("x"), { lastError: limit }))).toBe(true);
  });

  it("does not retry anything else", () => {
    expect(isRetryableError(new Error("schema mismatch"))).toBe(false);
    expect(isRetryableError("HTTP 429")).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("retry-after", () => {
  it("parses seconds and HTTP dates", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");

    expect(parseRetryAfter("3", now)).toBe(3000);
    expect(parseRetryAfter("Tue, 29 Sep 2026 12:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Tue, 29 Sep 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it("reads an error's response header", () => {
    const err = Object.assign(new Error("x"), { responseHeaders: { "retry-after": "2" } });

    expect(retryAfterMs(err)).toBe(2000);
    expect(retryAfterMs(new Error("x"))).toBeUndefined();
  });
});

describe("retriesFromEnv", () => {
  it("defaults, parses a non-negative integer and rejects the rest", () => {
    expect(retriesFromEnv(undefined)).toBe(6);
    expect(retriesFromEnv("0")).toBe(0);
    expect(retriesFromEnv("4")).toBe(4);
    for (const bad of ["-1", "2.5", "many"]) {
      expect(() => retriesFromEnv(bad)).toThrow("BENCH_RETRIES");
    }
  });
});
