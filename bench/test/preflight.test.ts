import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheKey, ResponseCache } from "../src/cache.ts";
import { preflightSystem, renderDryRun, renderPreflight } from "../src/preflight.ts";

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

describe("renderDryRun", () => {
  const prices = {
    "typesafe-ai/jev": { inputPerMTok: 0.042, outputPerMTok: 0 },
    "anthropic/claude-opus-5.5": { inputPerMTok: 4, outputPerMTok: 20 },
  };

  it("counts missed calls per system and model, as a lower bound with a guessed cost", () => {
    const missed = new Map<string, unknown>([
      [
        "k1",
        { system: "fieldwork-jev", model: "typesafe-ai/jev", body: { state: { ticket: "x" } } },
      ],
      ["k2", { system: "triage-structured", modelId: "anthropic/claude-opus-5.5", prompt: "p" }],
      ["k3", { system: "triage-structured", modelId: "anthropic/claude-opus-5.5", prompt: "q" }],
    ]);

    const out = renderDryRun("dev", missed, prices);

    expect(out).toContain("| fieldwork-jev | typesafe-ai/jev | 1 |");
    expect(out).toContain("| triage-structured | anthropic/claude-opus-5.5 | 2 |");
    expect(out).toContain("Live calls: at least 3. Estimated spend: at least $");
    expect(out).toContain("not reached");
  });

  it("says when a model has no price", () => {
    const missed = new Map<string, unknown>([["k", { system: "reply-judge", modelId: "x/y" }]]);

    const out = renderDryRun("dev", missed, prices);

    expect(out).toContain("| reply-judge | x/y | 1 | no price |");
    expect(out).toContain("Estimated spend: unknown, a model has no price.");
  });
});
