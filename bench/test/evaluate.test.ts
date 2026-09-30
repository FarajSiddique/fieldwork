import { describe, expect, it } from "vitest";
import type { BitextTicket } from "../src/bitext/sample.ts";
import { costUsd, jevChecks, summarize } from "../src/evaluate.ts";
import { failedPrediction, type Prediction } from "../src/systems/prediction.ts";

const tickets: BitextTicket[] = [
  {
    id: "a",
    text: "where is order #482913",
    intent: "track_order",
    category: "order",
    orderNumber: "#482913",
    flags: "B",
  },
  {
    id: "b",
    text: "cancel my order",
    intent: "cancel_order",
    category: "order",
    orderNumber: null,
    flags: "B",
  },
  {
    id: "c",
    text: "i want a refund",
    intent: "get_refund",
    category: "refund",
    orderNumber: null,
    flags: "B",
  },
  {
    id: "d",
    text: "download bill #12588",
    intent: "get_invoice",
    category: "invoice",
    orderNumber: null,
    flags: "B",
  },
];

const ok = (over: Partial<Prediction> & Pick<Prediction, "ticketId">): Prediction => ({
  system: "jev",
  status: "ok",
  error: null,
  intent: "track_order",
  intentConfidence: 0.9,
  category: "order",
  categoryConfidence: 0.95,
  orderNumber: null,
  orderNumberConfidence: 1,
  model: "jev-1.13.0",
  provider: "typesafe-ai",
  ms: 100,
  inputTokens: 1_000_000,
  outputTokens: 0,
  cached: false,
  ...over,
});

const predictions: Prediction[] = [
  ok({ ticketId: "a", orderNumber: "482913" }), // right; order number matches without "#"
  ok({ ticketId: "b", intent: "change_order", intentConfidence: 0.5 }), // intent wrong, category right
  ok({ ticketId: "c", intent: "get_refund", category: "refund" }),
  failedPrediction("jev", "d", "jev-1.13.0", new Error("boom")),
];

const prices = { "jev-1.13.0": { inputPerMTok: 0.042, outputPerMTok: 0 } };

describe("summarize", () => {
  const summary = summarize("jev", tickets, predictions, prices, 1);

  it("scores intent and category, counting failures as wrong", () => {
    expect(summary.failed).toBe(1);
    expect(summary.intentAccuracy.value).toBe(0.5);
    expect(summary.categoryAccuracy.value).toBe(0.75);
  });

  it("scores the order number with and without candidates", () => {
    expect(summary.orderNumber.withCandidates).toBe(2); // "a" and "d"
    expect(summary.orderNumber.exactMatchWithCandidates).toBe(0.5); // "d" failed
    expect(summary.orderNumber.exactMatchAll).toBe(0.75);
  });

  it("reports cost, latency and models from ok predictions", () => {
    expect(summary.costPerTicketUsd).toBeCloseTo((3 * 0.042) / 4);
    expect(summary.latencyMs).toEqual({ p50: 100, p95: 100 });
    expect(summary.models).toEqual(["jev-1.13.0"]);
  });

  it("throws when a ticket has no prediction", () => {
    expect(() => summarize("jev", tickets, predictions.slice(0, 3), prices, 1)).toThrow(
      "No jev prediction for d",
    );
  });
});

describe("costUsd", () => {
  it("is null when the model has no price", () => {
    expect(costUsd(ok({ ticketId: "a", model: "unknown" }), prices)).toBeNull();
  });
});

describe("jevChecks", () => {
  it("passes one model id, served only by TypeSafe, with usage", () => {
    expect(jevChecks(predictions)).toEqual({
      modelIds: ["jev-1.13.0"],
      oneModel: true,
      providers: ["typesafe-ai"],
      onlyTypeSafe: true,
      usageReported: true,
    });
  });
  it("fails when answers report more than one model id", () => {
    const checks = jevChecks([
      ok({ ticketId: "a", model: "typesafe-ai/jev" }),
      ok({ ticketId: "b", model: "typesafe-ai/jev-1.14.0" }),
    ]);
    expect(checks.oneModel).toBe(false);
  });
  it("fails when another provider or no provider served an answer", () => {
    expect(jevChecks([ok({ ticketId: "a", provider: "digitalocean" })]).onlyTypeSafe).toBe(false);
    expect(jevChecks([ok({ ticketId: "a", provider: null })]).onlyTypeSafe).toBe(false);
  });
  it("fails missing usage", () => {
    expect(jevChecks([ok({ ticketId: "a", inputTokens: 0 })]).usageReported).toBe(false);
  });
});

it("uses a prediction's own cost estimate when it has one", () => {
  const priced = { ...failedPrediction("fieldwork", "a", "typesafe-ai/jev", new Error("x")) };
  const prices = { "typesafe-ai/jev": { inputPerMTok: 0.042, outputPerMTok: 0 } };

  expect(costUsd({ ...priced, estCostUsd: 0.0021 }, prices)).toBe(0.0021);
  expect(costUsd({ ...priced, estCostUsd: null }, prices)).toBeNull();
  expect(costUsd(priced, prices)).toBe(0);
});
