import { describe, expect, it } from "vitest";
import { summarizeWritten } from "../src/evaluateWritten.ts";
import { failedTriage, type TriagePrediction } from "../src/systems/prediction.ts";
import type { WrittenTicket } from "../src/written.ts";

const SEED = 7;
const prices = {};

const ticket = (id: string, o: Partial<WrittenTicket> = {}): WrittenTicket => ({
  id,
  split: "dev",
  status: "final",
  synthetic: true,
  text: "ticket text",
  intent: "track_order",
  complexity: 0,
  needsEscalation: false,
  isRepeat: false,
  orderNumber: null,
  hardCases: [],
  ...o,
});

const prediction = (ticketId: string, o: Partial<TriagePrediction> = {}): TriagePrediction => ({
  system: "s",
  ticketId,
  status: "ok",
  error: null,
  intent: "track_order",
  intentConfidence: 0.9,
  category: "order",
  categoryConfidence: 0.9,
  orderNumber: null,
  orderNumberConfidence: 1,
  model: "m",
  provider: null,
  ms: 100,
  inputTokens: 10,
  outputTokens: 0,
  cached: false,
  estCostUsd: 0.001,
  complexity: 0,
  complexityConfidence: 0.9,
  isRepeat: false,
  escalates: false,
  reply: "Hello",
  escalationNote: null,
  fieldErrors: [],
  ...o,
});

describe("summarizeWritten", () => {
  it("counts escalation recall and precision with 95% intervals", () => {
    const tickets = [
      ticket("a", { needsEscalation: true }),
      ticket("b", { needsEscalation: true }),
      ticket("c"),
      ticket("d"),
    ];
    const predictions = [
      prediction("a", { escalates: true }),
      prediction("b", { escalates: false }),
      prediction("c", { escalates: true }),
      prediction("d", { escalates: false }),
    ];

    const s = summarizeWritten("s", tickets, predictions, prices, SEED);

    expect(s.escalationRecall.value).toBe(0.5);
    expect(s.escalationPrecision.value).toBe(0.5);
    expect(s.escalationRecall.ci[0]).toBeGreaterThanOrEqual(0);
    expect(s.escalationRecall.ci[1]).toBeLessThanOrEqual(1);
  });

  it("rounds the expected complexity to the nearest level", () => {
    const tickets = [ticket("a", { complexity: 1 }), ticket("b", { complexity: 1 })];
    const predictions = [
      prediction("a", { complexity: 1.4 }),
      prediction("b", { complexity: 1.6 }),
    ];

    expect(summarizeWritten("s", tickets, predictions, prices, SEED).complexityAccuracy.value).toBe(
      0.5,
    );
  });

  it("counts a failed prediction as escalated and wrong elsewhere", () => {
    const tickets = [ticket("a", { needsEscalation: true, orderNumber: null })];
    const predictions = [{ ...failedTriage("s", "a", "m", new Error("down")) }];

    const s = summarizeWritten("s", tickets, predictions, prices, SEED);

    expect(s.failed).toBe(1);
    expect(s.escalationRecall.value).toBe(1);
    expect(s.intentAccuracy.value).toBe(0);
    expect(s.orderNumberExactMatch.value).toBe(0);
    expect(s.isRepeatAccuracy.value).toBe(0);
  });

  it("matches order numbers with or without the #", () => {
    const tickets = [ticket("a", { orderNumber: "#582041" }), ticket("b")];
    const predictions = [prediction("a", { orderNumber: "582041" }), prediction("b")];

    expect(
      summarizeWritten("s", tickets, predictions, prices, SEED).orderNumberExactMatch.value,
    ).toBe(1);
  });

  it("breaks results down by hard case, and reports NaN for a tag with no tickets", () => {
    const tickets = [
      ticket("a", { hardCases: ["mixed_intents"], intent: "cancel_order", needsEscalation: true }),
      ticket("b"),
    ];
    const predictions = [prediction("a", { escalates: true }), prediction("b")];

    const { hardCases } = summarizeWritten("s", tickets, predictions, prices, SEED);
    const mixed = hardCases.find((h) => h.tag === "mixed_intents")!;
    const injected = hardCases.find((h) => h.tag === "injected_instructions")!;

    expect(mixed).toEqual({
      tag: "mixed_intents",
      tickets: 1,
      intentAccuracy: 0,
      escalationAccuracy: 1,
      orderNumberExactMatch: 1,
    });
    expect(injected.tickets).toBe(0);
    expect(injected.escalationAccuracy).toBeNaN();
  });

  it("gives a finite recall interval even when some resamples have no positives", () => {
    const tickets = Array.from({ length: 20 }, (_, i) =>
      ticket(`t${i}`, { needsEscalation: i === 0 }),
    );
    const predictions = tickets.map((t) => prediction(t.id, { escalates: t.needsEscalation }));

    const { escalationRecall } = summarizeWritten("s", tickets, predictions, prices, SEED);

    expect(escalationRecall.value).toBe(1);
    expect(escalationRecall.ci.every(Number.isFinite)).toBe(true);
  });

  it("counts partial failures, and prices each ticket from its own estimate", () => {
    const tickets = [ticket("a"), ticket("b")];
    const predictions = [
      prediction("a", { fieldErrors: ["reply: text_error"], estCostUsd: 0.002 }),
      prediction("b", { estCostUsd: 0.004 }),
    ];

    const s = summarizeWritten("s", tickets, predictions, prices, SEED);

    expect(s.partialFailures).toBe(1);
    expect(s.costPerTicketUsd).toBeCloseTo(0.003);
    expect(
      summarizeWritten(
        "s",
        tickets,
        [predictions[0]!, prediction("b", { estCostUsd: null })],
        prices,
        SEED,
      ).costPerTicketUsd,
    ).toBeNull();
  });

  it("throws when a ticket has no prediction", () => {
    expect(() => summarizeWritten("s", [ticket("a")], [], prices, SEED)).toThrow(
      "No s prediction for a",
    );
  });
});
