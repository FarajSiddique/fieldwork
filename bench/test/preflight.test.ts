import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheKey, ResponseCache } from "../src/cache.ts";
import { preflightSystem, renderPreflight } from "../src/preflight.ts";

const prices = { "m/cheap": { inputPerMTok: 1, outputPerMTok: 5 } };
const tokensOf = (v: unknown) => v as { input: number; output: number };

async function cacheWith(entries: [unknown, unknown][]) {
  const cache = new ResponseCache(await mkdtemp(join(tmpdir(), "preflight-")));
  for (const [request, value] of entries) await cache.set(cacheKey(request), { value, ms: 1 });
  return cache;
}

const base = { system: "structured", model: "m/cheap", prices, tokensOf, guessOutputTokens: 0 };

describe("preflightSystem", () => {
  it("counts cached and live requests and prices the live ones from cached usage", async () => {
    const cache = await cacheWith([[{ q: 1 }, { input: 1000, output: 200 }]]);
    const row = await preflightSystem({ ...base, requests: [{ q: 1 }, { q: 2 }, { q: 3 }], cache });
    expect(row).toMatchObject({ calls: 3, cached: 1, live: 2, basis: "cached usage" });
    expect(row.estLiveCostUsd).toBeCloseTo(2 * 0.002);
  });

  it("costs nothing when every request is cached", async () => {
    const cache = await cacheWith([[{ q: 1 }, { input: 1000, output: 200 }]]);
    const row = await preflightSystem({ ...base, requests: [{ q: 1 }], cache });
    expect(row).toMatchObject({ live: 0, estLiveCostUsd: 0, basis: "none" });
  });

  it("guesses from request size when nothing is cached", async () => {
    const row = await preflightSystem({
      ...base,
      requests: [{ prompt: "x".repeat(2990) }],
      cache: await cacheWith([]),
      guessOutputTokens: 100,
    });
    expect(row.basis).toBe("request size");
    expect(row.estLiveCostUsd).toBeGreaterThan(0.001);
  });

  it("reports no estimate for an unpriced model", async () => {
    const row = await preflightSystem({
      ...base,
      model: "m/unpriced",
      requests: [{ q: 9 }],
      cache: await cacheWith([]),
    });
    expect(row.estLiveCostUsd).toBeNull();
    expect(renderPreflight("dev", [row])).toContain("Estimated spend: no price.");
  });
});
