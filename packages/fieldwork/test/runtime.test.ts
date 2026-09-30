import { APIError, APITimeoutError, RateLimitError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldError, jevError, textError, thrownError, TimeoutReached } from "../src/errors.ts";
import { buildState, estimateTokens, stateValue, tooLarge } from "../src/state.ts";
import { limit, settle } from "../src/time.ts";
import { callTrace, JEV_PRICE, totalCost } from "../src/trace.ts";
import type { AnyResult } from "../src/types.ts";

const call = {
  model: "m",
  fields: ["a"],
  status: "ok" as const,
  ms: 5,
  inputTokens: 1_000_000,
  outputTokens: 2_000_000,
};

function timers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

describe("field errors", () => {
  it("cuts messages to 200 characters", () => {
    expect(fieldError("x", "a".repeat(500)).message).toHaveLength(200);
    expect(fieldError("x", "short")).toEqual({ code: "x", message: "short" });
  });

  it("reports a jev HTTP error by status, never by body", () => {
    const body = { error: { message: "secret customer text" } };
    const err = new APIError(500, body, new Headers());
    expect(jevError(err)).toEqual({ code: "jev_error", message: "jev: HTTP 500" });
    expect(JSON.stringify(jevError(err))).not.toContain("secret");
  });

  it("names rate limits and timeouts", () => {
    expect(jevError(new RateLimitError(429, {}, new Headers())).code).toBe("rate_limited");
    expect(jevError(new APITimeoutError(50))).toEqual({
      code: "timeout",
      message: "jev: no response within 50 ms",
    });
    expect(jevError(new TimeoutReached("run deadline of 10 ms reached"))).toEqual({
      code: "timeout",
      message: "run deadline of 10 ms reached",
    });
  });

  it("reports a text failure by class and status, never by message", () => {
    const err = Object.assign(new Error("provider said: secret"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    expect(textError(err)).toEqual({ code: "text_error", message: "AI_APICallError: HTTP 503" });
  });

  it("keeps a thrown function's message only", () => {
    expect(thrownError("tool_error", new Error("no such order"))).toEqual({
      code: "tool_error",
      message: "no such order",
    });
    expect(thrownError("tool_error", "plain string")).toEqual({
      code: "tool_error",
      message: "plain string",
    });
  });
});

describe("limit and settle", () => {
  it("rejects with a TimeoutReached once the time limit passes", async () => {
    const l = limit(undefined, 10, "slow: no result within 10 ms");
    const never = new Promise<string>(() => {});
    await expect(settle(never, l.signal)).rejects.toThrow("slow: no result within 10 ms");
    l.release();
  });

  it("follows the parent's abort and its reason", async () => {
    const parent = new AbortController();
    const l = limit(parent.signal, undefined, "unused");
    const pending = settle(new Promise(() => {}), l.signal);
    parent.abort(new TimeoutReached("run deadline of 5 ms reached"));
    await expect(pending).rejects.toThrow("run deadline of 5 ms reached");
    l.release();
  });

  it("starts aborted when the parent already is", () => {
    const parent = new AbortController();
    parent.abort(new TimeoutReached("done"));
    expect(limit(parent.signal, 1_000, "x").signal.aborted).toBe(true);
  });

  it("passes work through when it finishes in time", async () => {
    const l = limit(undefined, 1_000, "x");
    await expect(settle(Promise.resolve(7), l.signal)).resolves.toBe(7);
    await expect(settle(Promise.reject(new Error("boom")), l.signal)).rejects.toThrow("boom");
    l.release();
  });

  it("leaves no timer behind after release", () => {
    const before = timers();
    const l = limit(undefined, 60_000, "x");
    expect(timers()).toBe(before + 1);
    l.release();
    expect(timers()).toBe(before);
  });
});

describe("trace costs", () => {
  it("prices jev at TypeSafe's list price unless told otherwise", () => {
    expect(JEV_PRICE).toEqual({ inputPerMTok: 0.042, outputPerMTok: 0 });
    expect(callTrace({ ...call, worker: "jev" }).estCostUsd).toBeCloseTo(0.042);
    const custom = callTrace(
      { ...call, worker: "jev" },
      { jev: { inputPerMTok: 1, outputPerMTok: 1 } },
    );
    expect(custom.estCostUsd).toBeCloseTo(3);
  });

  it("prices text only from the table, by model id", () => {
    const prices = { text: { m: { inputPerMTok: 1, outputPerMTok: 5 } } };
    expect(callTrace({ ...call, worker: "text" }, prices).estCostUsd).toBeCloseTo(11);
    expect(callTrace({ ...call, worker: "text", model: "other" }, prices).estCostUsd).toBeNull();
    expect(callTrace({ ...call, worker: "text", model: "toString" }, prices).estCostUsd).toBeNull();
  });

  it("makes tool calls free", () => {
    expect(callTrace({ ...call, worker: "tool", model: null }).estCostUsd).toBe(0);
  });

  it("totals costs, or null when any call has no price", () => {
    const a = callTrace({ ...call, worker: "jev" });
    const b = callTrace({ ...call, worker: "text" });
    expect(totalCost([a, a])).toBeCloseTo(0.084);
    expect(totalCost([a, b])).toBeNull();
    expect(totalCost([])).toBe(0);
  });
});

describe("state", () => {
  const filled: AnyResult = {
    status: "filled",
    passed: true,
    worker: "jev",
    model: "jev-1.13.0",
    ms: 12,
    choice: "track_order",
    confidence: 0.9,
  };

  it("keeps a filled result's values and drops its metadata", () => {
    expect(stateValue(filled)).toEqual({ choice: "track_order", confidence: 0.9 });
  });

  it("gives null for a skipped or failed result", () => {
    expect(stateValue({ status: "skipped", passed: false, reason: "when returned false" })).toBe(
      null,
    );
    expect(stateValue({ status: "failed", passed: false, error: fieldError("x", "y") })).toBe(null);
  });

  it("adds only the named results to the inputs", () => {
    const skipped: AnyResult = { status: "skipped", passed: false, reason: "r" };
    const state = buildState({ ticket: "hi" }, { intent: filled, other: skipped }, ["intent"]);
    expect(state).toEqual({ ticket: "hi", intent: { choice: "track_order", confidence: 0.9 } });
  });

  it("estimates tokens high, at three characters of JSON each", () => {
    expect(estimateTokens("ab")).toBe(2); // '"ab"' is 4 characters
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("flags state plus the longest question over 32k tokens", () => {
    const big = "x".repeat(3 * 32_000);
    expect(tooLarge({ ticket: big }, { q: "?" })).toBe(true);
    expect(tooLarge({ ticket: "x".repeat(3 * 31_000) }, { q: "?" })).toBe(false);
  });

  it("flags a whole request over 64k tokens even when each question fits", () => {
    const question = "q".repeat(3 * 20_000);
    const questions = { a: question, b: question, c: question, d: question };
    expect(tooLarge({ ticket: "hi" }, questions)).toBe(true);
    expect(tooLarge({ ticket: "hi" }, { a: question })).toBe(false);
  });
});
