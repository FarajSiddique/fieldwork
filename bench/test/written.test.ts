import { describe, expect, it } from "vitest";
import { paths } from "../src/config.ts";
import {
  labeledSplit,
  loadWrittenSet,
  validateWrittenSet,
  type WrittenTicket,
} from "../src/written.ts";

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

  // The spec asks for other numbers beside the order number; only ones the candidate regex finds
  // give the pick a real choice.
  it("requires a distractor candidate beside the order number", () => {
    expect(() =>
      validateWrittenSet([ticket({ text: "Where is order #582041? It cost $89.99." })]),
    ).toThrow(
      "wr-001: a ticket with an order number needs another candidate number (5+ digits) as a distractor",
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

  const injected = (overrides: Partial<WrittenTicket> = {}) =>
    ticket({
      complexity: 2,
      needsEscalation: true,
      hardCases: ["injected_instructions"],
      injectionSource: "TrustAIRLab/in-the-wild-jailbreak-prompts/jailbreak_2023_12_25#38",
      ...overrides,
    });

  it("accepts an injected-instruction ticket that names its source row", () => {
    expect(validateWrittenSet([injected()])).toEqual([injected()]);
  });

  it("requires a source row exactly when a ticket has injected instructions", () => {
    expect(() => validateWrittenSet([injected({ injectionSource: undefined })])).toThrow(
      "wr-001: an injected-instruction ticket needs injectionSource",
    );
    expect(() =>
      validateWrittenSet([
        ticket({
          injectionSource: "TrustAIRLab/in-the-wild-jailbreak-prompts/jailbreak_2023_12_25#38",
        }),
      ]),
    ).toThrow("wr-001: injectionSource is only for injected-instruction tickets");
    expect(() => validateWrittenSet([injected({ injectionSource: "somewhere#1" })])).toThrow(
      "wr-001: injectionSource:",
    );
  });

  // The labeling guide's two rules that code can check.
  it("requires escalation at complexity 2, and complexity 2 for injected instructions", () => {
    expect(() => validateWrittenSet([ticket({ complexity: 2, needsEscalation: false })])).toThrow(
      "wr-001: complexity 2 needs escalation (labeling guide, rule 3)",
    );
    expect(() => validateWrittenSet([injected({ complexity: 1 })])).toThrow(
      "wr-001: an injected-instruction ticket is complexity 2 (labeling guide, rule 2)",
    );
  });
});

describe("labeledSplit", () => {
  const set = [
    ticket({ id: "wr-001", split: "dev", status: "final" }),
    ticket({ id: "wr-002", split: "test", status: "draft" }),
    ticket({ id: "wr-003", split: "dev", status: "final", orderNumber: null }),
  ];

  it("returns one split's tickets when all are labeled", () => {
    expect(labeledSplit(set, "dev").map((t) => t.id)).toEqual(["wr-001", "wr-003"]);
  });

  it("refuses a split that still has drafts, naming them", () => {
    expect(() => labeledSplit(set, "test")).toThrow(
      "Written set test split has unlabeled drafts: wr-002",
    );
  });
});

describe("the committed written set", () => {
  it("is valid", async () => {
    const tickets = await loadWrittenSet(paths.written);
    expect(tickets.length).toBeGreaterThan(0);
  });
});
