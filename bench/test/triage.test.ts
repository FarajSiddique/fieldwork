import { answer, fakeTextModel, fakeTypeSafe, type JevCall } from "fieldwork/testing";
import { describe, expect, it } from "vitest";
import { escalates, needsPerson, triage } from "../src/triage.ts";
import { COMPLEXITY_QUESTION, IS_REPEAT_QUESTION, ORDER_NUMBER_TARGET } from "../src/wording.ts";

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

  it("counts a ticket as escalated when the escalation note failed", async () => {
    const { client } = fakeTypeSafe(jev([0.05, 0.15, 0.8]));
    const broken = { ...models, high: fakeTextModel(new Error("provider down")) };
    const { fields } = await triage.run({ ticket }, { typesafe: client, models: broken });

    expect(fields.escalationNote).toMatchObject({ status: "failed" });
    expect(fields.reply).toMatchObject({ status: "skipped" });
    expect(escalates(fields)).toBe(true);
  });
});

describe("needsPerson", () => {
  const cases: {
    name: string;
    intent: Record<string, number>;
    complexity: number[];
    expected: boolean;
  }[] = [
    {
      name: "the category is sure and the request simple",
      intent: { track_order: 0.9, delivery_period: 0.1 },
      complexity: [0.9, 0.08, 0.02],
      expected: false,
    },
    {
      name: "the category is unsure",
      intent: { track_order: 0.5, get_refund: 0.5 },
      complexity: [0.9, 0.08, 0.02],
      expected: true,
    },
    {
      name: "the request is complex",
      intent: { track_order: 0.9, delivery_period: 0.1 },
      complexity: [0.05, 0.15, 0.8],
      expected: true,
    },
    {
      name: "the complexity is unsure",
      intent: { track_order: 0.9, delivery_period: 0.1 },
      complexity: [0.6, 0.3, 0.1],
      expected: true,
    },
  ];

  // The baselines are escalated by needsPerson; this keeps it the same rule as the schema's `when`.
  it.each(cases)("agrees with the Fieldwork schema when $name", async (c) => {
    const answers: Record<string, unknown> = {
      intent: answer.choice(c.intent),
      complexity: answer.score(c.complexity),
      isRepeat: answer.noul(0.1),
      orderNumber: answer.choice({ "#4471902": 0.9, "#12588": 0.05, none: 0.05 }),
    };
    const { client } = fakeTypeSafe((call) => ({
      answers: Object.fromEntries(
        Object.keys(call.questions).map((id) => [id, answers[id] ?? answer.noul(0.9)]),
      ),
    }));

    const { fields } = await triage.run({ ticket }, { typesafe: client, models });
    const category = fields.category.status === "filled" ? fields.category.value : null;
    const complexity = fields.complexity;

    expect(escalates(fields)).toBe(c.expected);
    expect(
      needsPerson({
        categoryProbability: category?.probability ?? 0,
        complexity: complexity.status === "filled" ? complexity.score : null,
        complexityConfidence: complexity.status === "filled" ? complexity.confidence : 0,
      }),
    ).toBe(c.expected);
  });

  it("escalates when complexity has no answer", () => {
    expect(
      needsPerson({ categoryProbability: 0.99, complexity: null, complexityConfidence: 0 }),
    ).toBe(true);
  });
});

it("asks the shared complexity and repeat questions", async () => {
  const { client, calls } = fakeTypeSafe(jev([0.9, 0.08, 0.02]));
  await triage.run({ ticket }, { typesafe: client, models });

  expect(calls[0]!.questions.complexity).toMatchObject({ instructions: COMPLEXITY_QUESTION });
  expect(calls[0]!.questions.isRepeat).toMatchObject({ instructions: IS_REPEAT_QUESTION });
});
