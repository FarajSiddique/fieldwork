import { describe, expect, it } from "vitest";
import { INTENTS } from "../src/intents.ts";
import { ORDER_NUMBER_TARGET } from "../src/wording.ts";

describe("wording", () => {
  // The pilot found jev and the baseline answering "when will my package arrive" with
  // track_order, because its description claimed arrival questions from delivery_period.
  it("gives arrival-time questions to delivery_period only", () => {
    expect(INTENTS.delivery_period).toMatch(/arrive/);
    expect(INTENTS.track_order).not.toMatch(/arrive/);
  });

  // The pilot found both systems returning invoice numbers as order numbers.
  it("says an invoice or bill number is not an order number", () => {
    expect(ORDER_NUMBER_TARGET).toMatch(/invoice or bill number is not an order number/);
  });
});
