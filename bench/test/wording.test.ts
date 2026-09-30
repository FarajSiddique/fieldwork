import { describe, expect, it } from "vitest";
import { INTENTS } from "../src/intents.ts";
import {
  COMPLEXITY_LEVELS,
  COMPLEXITY_QUESTION,
  ESCALATION_NOTE,
  IS_REPEAT_QUESTION,
  ORDER_NUMBER_TARGET,
  REPLY,
} from "../src/wording.ts";

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

  // The triage schema already sends these strings; moving them must not change a request hash.
  it("keeps the week 3 wording, so cached requests stay valid", () => {
    expect(COMPLEXITY_QUESTION).toBe("How complex is this request to resolve");
    expect(COMPLEXITY_LEVELS).toEqual([
      "Simple lookup or standard procedure",
      "Requires some judgment or multi-step process",
      "Unusual situation, edge case, or escalation needed",
    ]);
    expect(IS_REPEAT_QUESTION).toBe("Does the customer say this problem happened before?");
    expect(REPLY).toEqual({
      instructions: "Reply to the customer",
      style: "warm, under 80 words, no promises about dates",
    });
    expect(ESCALATION_NOTE).toEqual({
      instructions: "Summarize the ticket for the on-call agent",
      style: "one line",
    });
  });
});
