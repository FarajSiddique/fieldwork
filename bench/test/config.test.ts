import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { benchModels, benchSplit, DEFAULT_MODELS, missingPrices, paths } from "../src/config.ts";
import type { PriceTable } from "../src/evaluate.ts";

describe("benchModels", () => {
  it("defaults to the plan's models", () => {
    expect(benchModels({})).toEqual(DEFAULT_MODELS);
  });

  it("reads overrides from BENCH_* variables", () => {
    const env = {
      BENCH_FRONTIER_MODEL: "anthropic/claude-sonnet-5.5",
      BENCH_JUDGE_MODEL: "google/gemini-3.5-flash",
    };

    expect(benchModels(env)).toMatchObject({
      frontier: "anthropic/claude-sonnet-5.5",
      judge: "google/gemini-3.5-flash",
    });
  });

  // The spec: reply quality is judged by a model family not used for generation.
  it("refuses a judge from a provider that also generates", () => {
    expect(() => benchModels({ BENCH_JUDGE_MODEL: "anthropic/claude-opus-5.5" })).toThrow(
      "shares a provider with a generating model",
    );
    expect(() => benchModels({ BENCH_FRONTIER_MODEL: "openai/gpt-5.5" })).toThrow(
      "shares a provider with a generating model",
    );
  });

  it("has a price for every default model", async () => {
    const prices = JSON.parse(await readFile(paths.prices, "utf8")) as PriceTable;

    for (const id of Object.values(DEFAULT_MODELS)) expect(prices[id], id).toBeDefined();
  });
});

describe("missingPrices", () => {
  const priced = Object.fromEntries(Object.values(DEFAULT_MODELS).map((id) => [id, {}]));

  it("is empty when every model has a price", () => {
    expect(missingPrices(DEFAULT_MODELS, priced)).toEqual([]);
  });

  it("names a model that was overridden without a price, once", () => {
    const models = benchModels({ BENCH_FRONTIER_MODEL: "anthropic/claude-new" });

    expect(missingPrices(models, priced)).toEqual(["anthropic/claude-new"]);
    expect(missingPrices({ ...models, cheap: "anthropic/claude-new" }, priced)).toEqual([
      "anthropic/claude-new",
    ]);
  });
});

describe("benchSplit", () => {
  it("defaults to dev", () => {
    expect(benchSplit(undefined, {})).toBe("dev");
  });

  it("rejects an unknown split", () => {
    expect(() => benchSplit("train", {})).toThrow('Unknown split "train"; use dev or test.');
  });

  it("refuses the test split without BENCH_ALLOW_TEST=1", () => {
    expect(() => benchSplit("test", {})).toThrow("run once, after tuning is frozen");
    expect(benchSplit("test", { BENCH_ALLOW_TEST: "1" })).toBe("test");
  });
});
