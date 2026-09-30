import { answer, fakeTextModel, fakeTypeSafe, type JevCall } from "fieldwork/testing";
import { describe, expect, it } from "vitest";
import { escalates, triage } from "../src/triage.ts";
import { ORDER_NUMBER_TARGET } from "../src/wording.ts";

const ticket = "Where is order #4471902? Invoice #12588 is already paid.";

/** jev's answers by question id; `complexity` levels are simple, judgment, unusual. */
function jev(complexity: readonly number[]) {
  const answers: Record<string, unknown> = {
    intent: answer.choice({ track_order: 0.9, delivery_period: 0.08, get_refund: 0.02 }),
    complexity: answer.score(complexity),
    isRepeat: answer.noul(0.1),
    orderNumber: answer.choice({ "#4471902": 0.93, "#12588": 0.05, none: 0.02 }),
    reply__supported: answer.noul(0.9),
    reply__style: answer.noul(0.9),
    escalationNote__supported: answer.noul(0.8),
    escalationNote__style: answer.noul(0.7),
  };
  return (call: JevCall) => ({
    answers: Object.fromEntries(Object.keys(call.questions).map((id) => [id, answers[id]])),
  });
}

const models = {
  low: fakeTextModel("Your order has shipped and is on its way.", "cheap"),
  high: fakeTextModel("Order #4471902: customer asks where it is.", "big"),
};

describe("triage example", () => {
  it("answers a simple order question automatically", async () => {
    const { client, calls } = fakeTypeSafe(jev([0.9, 0.08, 0.02]));
    const { fields } = await triage.run({ ticket }, { typesafe: client, models });

    expect(fields.category).toMatchObject({ value: { category: "order" } });
    expect(fields.orderNumber).toMatchObject({ value: "#4471902" });
    expect(fields.order).toMatchObject({
      value: { orderNumber: "#4471902", status: "shipped" },
    });
    expect(fields.reply).toMatchObject({ status: "filled", model: "cheap" });
    expect(fields.escalationNote).toMatchObject({ status: "skipped" });
    expect(escalates(fields)).toBe(false);

    // The pick offers every number the regex found, with the pilot's wording.
    expect(calls[0]!.questions.orderNumber).toMatchObject({
      instructions: `Which of these is ${ORDER_NUMBER_TARGET}?`,
      criteria: { "#4471902": null, "#12588": null },
    });
  });

  it("escalates a complex ticket with a note from the high tier", async () => {
    const { client } = fakeTypeSafe(jev([0.05, 0.15, 0.8]));
    const { fields } = await triage.run({ ticket }, { typesafe: client, models });

    expect(fields.reply).toMatchObject({ status: "skipped" });
    expect(fields.escalationNote).toMatchObject({ status: "filled", model: "big" });
    expect(escalates(fields)).toBe(true);
  });

  it("escalates when jev is down, so no ticket is answered blind", async () => {
    const { client } = fakeTypeSafe({ status: 503 });
    const { fields } = await triage.run({ ticket }, { typesafe: client, models });

    expect(fields.intent).toMatchObject({ status: "failed" });
    expect(fields.category).toMatchObject({ status: "skipped" });
    expect(fields.order).toMatchObject({ status: "skipped" });
    expect(fields.reply).toMatchObject({ status: "skipped" });
    expect(escalates(fields)).toBe(true);
  });
});
