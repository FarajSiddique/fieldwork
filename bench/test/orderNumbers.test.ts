import { describe, expect, it } from "vitest";
import { findOrderNumbers, normalizeOrderNumber } from "../src/orderNumbers.ts";

describe("findOrderNumbers", () => {
  it("finds candidates in order of appearance, without duplicates", () => {
    expect(findOrderNumbers("order #482913, not invoice #12588 or #482913")).toEqual([
      "#482913",
      "#12588",
    ]);
    expect(findOrderNumbers("order732201349959")).toEqual(["732201349959"]);
    expect(findOrderNumbers("refund of $45.99")).toEqual([]);
  });
});

describe("normalizeOrderNumber", () => {
  it("trims and drops a leading #", () => {
    expect(normalizeOrderNumber(" #482913 ")).toBe("482913");
    expect(normalizeOrderNumber(null)).toBeNull();
  });
});
