import { describe, expect, it } from "vitest";
import { paths } from "../src/config.ts";
import { loadWrittenSet, validateWrittenSet, type WrittenTicket } from "../src/written.ts";

const ticket = (overrides: Partial<WrittenTicket> = {}): WrittenTicket => ({
  id: "wr-001",
  split: "dev",
  status: "draft",
  synthetic: true,
  text: "Where is order #582041? Invoice #20417 says it shipped.",
  intent: "track_order",
  complexity: 1,
  needsEscalation: false,
  isRepeat: false,
  orderNumber: "#582041",
  hardCases: [],
  ...overrides,
});

describe("validateWrittenSet", () => {
  it("accepts well-formed tickets, with or without an order number", () => {
    const tickets = [ticket(), ticket({ id: "wr-002", orderNumber: null })];
    expect(validateWrittenSet(tickets)).toEqual(tickets);
  });

  it("rejects an order number the candidate regex would not find", () => {
    expect(() => validateWrittenSet([ticket({ orderNumber: "#999999" })])).toThrow(
      "wr-001: orderNumber #999999 is not a candidate found in the text",
    );
    // Written without the "#" that the ticket uses: the pick returns the span as written.
    expect(() => validateWrittenSet([ticket({ orderNumber: "582041" })])).toThrow(
      "orderNumber 582041 is not a candidate",
    );
  });

  it("rejects duplicate ids", () => {
    expect(() => validateWrittenSet([ticket(), ticket()])).toThrow("wr-001: duplicate id");
  });

  it("rejects unknown intents, complexity levels outside 0–2 and unknown hard cases", () => {
    const bad = [
      { ...ticket(), intent: "where_is_my_stuff" },
      { ...ticket({ id: "wr-002" }), complexity: 3 },
      { ...ticket({ id: "wr-003" }), hardCases: ["sarcasm"] },
    ];
    expect(() => validateWrittenSet(bad)).toThrow(
      /wr-001: intent: .*\nwr-002: complexity: .*\nwr-003: hardCases\.0: /,
    );
  });

  it("rejects a ticket not marked synthetic, and unexpected fields", () => {
    expect(() => validateWrittenSet([{ ...ticket(), synthetic: false }])).toThrow(
      "wr-001: synthetic:",
    );
    expect(() => validateWrittenSet([{ ...ticket(), escalate: true }])).toThrow("wr-001: record:");
  });

  it("names the line when the id is unreadable", () => {
    expect(() => validateWrittenSet([ticket(), { text: "hello" }])).toThrow("line 2: id:");
  });
});

describe("the committed written set", () => {
  it("is valid", async () => {
    const tickets = await loadWrittenSet(paths.written);
    expect(tickets.length).toBeGreaterThan(0);
  });
});
