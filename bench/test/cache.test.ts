import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cachedCall, cacheKey, ResponseCache, stableStringify } from "../src/cache.ts";

const newCache = async () => new ResponseCache(await mkdtemp(join(tmpdir(), "cache-")));

describe("cacheKey", () => {
  it("ignores key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      stableStringify({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
    expect(cacheKey({ a: 1, b: 2 })).toBe(cacheKey({ b: 2, a: 1 }));
  });

  it("changes when the model or prompt changes", () => {
    const base = { system: "structured", modelId: "a/cheap", prompt: "p" };
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, modelId: "b/cheap" }));
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, prompt: "p2" }));
  });
});

describe("cachedCall", () => {
  it("calls once, then serves the cached value with its original timing", async () => {
    const cache = await newCache();
    const fn = vi.fn(async () => ({ answer: 42 }));
    const first = await cachedCall(cache, { q: 1 }, fn);
    const second = await cachedCall(cache, { q: 1 }, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(first.hit).toBe(false);
    expect(second).toEqual({ value: { answer: 42 }, ms: first.ms, hit: true });
  });

  it("never caches a failure", async () => {
    const cache = await newCache();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    await expect(cachedCall(cache, { q: 2 }, fn)).rejects.toThrow("boom");
    expect((await cachedCall(cache, { q: 2 }, fn)).value).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("returns undefined for a missing key", async () => {
    expect(await (await newCache()).get("nope")).toBeUndefined();
  });
});
