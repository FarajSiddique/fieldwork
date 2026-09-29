import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  CATEGORY_OF,
  INTENT_NAMES,
  isIntent,
  rollUpToCategory,
} from "../src/intents.ts";

describe("intents", () => {
  it("has Bitext's 27 intents", () => {
    expect(INTENT_NAMES).toHaveLength(27);
  });

  it("maps every intent to a category and uses every category", () => {
    for (const intent of INTENT_NAMES) expect(CATEGORIES).toContain(CATEGORY_OF[intent]);
    expect(new Set(INTENT_NAMES.map((i) => CATEGORY_OF[i]))).toEqual(new Set(CATEGORIES));
  });

  it("recognizes intent names", () => {
    expect(isIntent("track_refund")).toBe(true);
    expect(isIntent("weather")).toBe(false);
    expect(isIntent("toString")).toBe(false);
  });
});

describe("rollUpToCategory", () => {
  it("sums intent probabilities within a category", () => {
    const r = rollUpToCategory({ cancel_order: 0.4, track_order: 0.35, complaint: 0.25 });
    expect(r.category).toBe("order");
    expect(r.probability).toBeCloseTo(0.75);
  });

  it("can choose a category whose total beats the single most likely intent", () => {
    const r = rollUpToCategory({ complaint: 0.4, cancel_order: 0.3, change_order: 0.3 });
    expect(r.category).toBe("order");
    expect(r.probability).toBeCloseTo(0.6);
  });

  it("treats missing intents as zero and breaks ties by category order", () => {
    expect(rollUpToCategory({ track_order: 0.5, get_refund: 0.5 })).toEqual({
      category: "order",
      probability: 0.5,
    });
  });
});
