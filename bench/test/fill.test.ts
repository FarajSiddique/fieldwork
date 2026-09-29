import { describe, expect, it } from "vitest";
import { fillPlaceholders } from "../src/bitext/fill.ts";
import { createRng } from "../src/rng.ts";

describe("fillPlaceholders", () => {
  it("replaces every placeholder and records the order number", () => {
    const r = fillPlaceholders("cancel order {{Order Number}} for {{Person Name}}", createRng(1));
    expect(r.text).not.toContain("{{");
    expect(r.orderNumber).toMatch(/^#[1-9]\d{5}$/);
    expect(r.text).toContain(r.orderNumber!);
  });

  it("returns a null order number when the ticket has none", () => {
    const r = fillPlaceholders("I paid {{Currency Symbol}}{{Refund Amount}}", createRng(1));
    expect(r.orderNumber).toBeNull();
    expect(r.text).toMatch(/^I paid [$€£]\d+\.\d{2}$/);
  });

  it("is deterministic for a seed", () => {
    const text = "order {{Order Number}} to {{Delivery City}}";
    expect(fillPlaceholders(text, createRng(4))).toEqual(fillPlaceholders(text, createRng(4)));
  });

  it("fills all nine placeholders Bitext uses", () => {
    const all = [
      "Order Number",
      "Account Type",
      "Person Name",
      "Account Category",
      "Refund Amount",
      "Currency Symbol",
      "Delivery City",
      "Delivery Country",
      "Invoice Number",
    ]
      .map((name) => `{{${name}}}`)
      .join(" ");
    expect(fillPlaceholders(all, createRng(2)).text).not.toContain("{{");
  });

  it("throws on a placeholder it does not know", () => {
    expect(() => fillPlaceholders("hi {{Loyalty Tier}}", createRng(1))).toThrow(
      "Unknown Bitext placeholder {{Loyalty Tier}}",
    );
  });
});
