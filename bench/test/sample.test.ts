import { describe, expect, it } from "vitest";
import type { BitextRow } from "../src/bitext/load.ts";
import { isEligible, normalizeText, sampleBitext } from "../src/bitext/sample.ts";
import { CATEGORY_OF, INTENT_NAMES, type Intent } from "../src/intents.ts";

function makeRows(perIntent: number): BitextRow[] {
  const rows: BitextRow[] = [];
  for (const intent of INTENT_NAMES) {
    for (let n = 0; n < perIntent; n++) {
      const withOrder = CATEGORY_OF[intent] === "order" && intent !== "place_order";
      const instruction = withOrder
        ? `${intent} request ${n} for order {{Order Number}}`
        : `${intent} request ${n}`;
      rows.push({ index: rows.length, flags: "B", instruction, intent });
    }
  }
  return rows;
}

const options = { seed: 1, devPerIntent: 2, testPerIntent: 3 };

describe("sampleBitext", () => {
  it("takes the requested number per intent for each split", () => {
    const { dev, test } = sampleBitext(makeRows(10), options);
    expect(dev).toHaveLength(27 * 2);
    expect(test).toHaveLength(27 * 3);
    for (const intent of INTENT_NAMES) {
      expect(dev.filter((t) => t.intent === intent)).toHaveLength(2);
      expect(test.filter((t) => t.intent === intent)).toHaveLength(3);
    }
  });

  it("never puts a ticket in both splits", () => {
    const { dev, test } = sampleBitext(makeRows(10), options);
    const devIds = new Set(dev.map((t) => t.id));
    expect(test.some((t) => devIds.has(t.id))).toBe(false);
  });

  it("is deterministic for a seed and changes with the seed", () => {
    const rows = makeRows(10);
    expect(sampleBitext(rows, options)).toEqual(sampleBitext(rows, options));
    expect(sampleBitext(rows, { ...options, seed: 2 }).dev.map((t) => t.id)).not.toEqual(
      sampleBitext(rows, options).dev.map((t) => t.id),
    );
  });

  it("fills placeholders and labels category and order number", () => {
    const { dev } = sampleBitext(makeRows(10), options);
    for (const t of dev) {
      expect(t.text).not.toContain("{{");
      expect(t.category).toBe(CATEGORY_OF[t.intent]);
      if (t.intent === "track_order") expect(t.orderNumber).toMatch(/^#\d{6}$/);
      if (t.intent === "get_refund") expect(t.orderNumber).toBeNull();
    }
  });

  it("drops duplicate text that differs only in case and spacing", () => {
    const rows = makeRows(5);
    const intent: Intent = "review";
    const duplicateIndex = rows.length;
    rows.push({ index: duplicateIndex, flags: "B", instruction: "  REVIEW   request 0", intent });
    const { dev, test } = sampleBitext(rows, options);
    const sampled = [...dev, ...test].filter((t) => t.intent === intent);
    expect(sampled.some((t) => t.id === `bx-${duplicateIndex}`)).toBe(false);
    expect(new Set(sampled.map((t) => normalizeText(t.text))).size).toBe(sampled.length);
  });

  it("excludes order tickets with a literal number and no placeholder", () => {
    const row: BitextRow = {
      index: 9999,
      flags: "B",
      instruction: "i have to check the ETA of order732201349959",
      intent: "track_order",
    };
    expect(isEligible(row)).toBe(false);
    const { dev, test } = sampleBitext([...makeRows(5), row], options);
    expect([...dev, ...test].some((t) => t.text.includes("732201349959"))).toBe(false);
  });

  it("keeps invoice tickets with literal invoice numbers", () => {
    expect(
      isEligible({ index: 0, flags: "B", instruction: "download bill #12588", intent: "get_invoice" }),
    ).toBe(true);
  });

  it("throws when an intent has too few eligible rows", () => {
    expect(() => sampleBitext(makeRows(4), options)).toThrow("has 4 eligible rows; need 5");
  });
});
