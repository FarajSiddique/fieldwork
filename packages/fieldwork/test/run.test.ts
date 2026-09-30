import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { Builder, DefinitionError, fieldwork } from "../src/builder.ts";
import type { FieldSpec } from "../src/types.ts";
import { answer, FAKE_JEV_MODEL, fakeTextModel, fakeTypeSafe, type JevCall } from "./fakes.ts";

const INTENTS = { track_order: null, get_refund: null } as const;
const LEVELS = ["simple", "judgment", "unusual"] as const;
const input = { ticket: "Where is order #12345? It happened before." };

/** Answers every question it is asked, by field name, from this table. */
const ANSWERS: Record<string, unknown> = {
  intent: answer.choice({ track_order: 0.9, get_refund: 0.1 }),
  complexity: answer.score([0.8, 0.1, 0.1]),
  isRepeat: answer.noul(0.9),
  orderNumber: answer.choice({ "#12345": 0.95, none: 0.05 }),
  reply__supported: answer.noul(0.9),
  reply__style: answer.noul(0.8),
  note__supported: answer.noul(0.2),
};
function byQuestion(call: JevCall) {
  return {
    answers: Object.fromEntries(Object.keys(call.questions).map((k) => [k, ANSWERS[k]])),
  };
}

const triage = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent", INTENTS), { gate: 0.8 })
  .judge("complexity", score("How complex", LEVELS))
  .pick("orderNumber", {
    instructions: "The order number",
    candidates: (i) => i.ticket.match(/#\d{5,}/g) ?? [],
  })
  .tool("order", {
    after: ["intent", "orderNumber"],
    when: (f) => f.intent.passed && f.orderNumber.value !== null,
    call: (f) => ({ orderNumber: f.orderNumber.value, status: "shipped" }),
  })
  .judge("isRepeat", noul("Has this happened before?"), { after: ["order"], yesAbove: 0.8 })
  .text("reply", {
    after: ["complexity", "order"],
    when: (f) => f.complexity.passed && f.complexity.score < 1.5,
    instructions: "Reply to the customer",
    style: "warm",
    reasoning: "low",
  })
  .text("note", {
    after: ["complexity"],
    when: (f) => !f.complexity.passed || f.complexity.score >= 1.5,
    instructions: "Summarize for the on-call agent",
    reasoning: "high",
  });

const models = { low: fakeTextModel("It shipped today.", "low-model"), high: fakeTextModel("n") };

describe("run", () => {
  it("fills every field step by step and returns them in declaration order", async () => {
    const { client, calls } = fakeTypeSafe(byQuestion);
    const { fields, trace } = await triage.run(input, { typesafe: client, models });

    expect(Object.keys(fields)).toEqual([
      "intent",
      "complexity",
      "orderNumber",
      "order",
      "isRepeat",
      "reply",
      "note",
    ]);
    expect(fields.intent).toMatchObject({ status: "filled", passed: true, choice: "track_order" });
    expect(fields.order).toMatchObject({
      status: "filled",
      value: { orderNumber: "#12345", status: "shipped" },
    });
    expect(fields.isRepeat).toMatchObject({ status: "filled", passed: true, yes: true });
    expect(fields.reply).toMatchObject({ status: "filled", value: "It shipped today." });
    expect(fields.note).toEqual({
      status: "skipped",
      passed: false,
      reason: "when returned false",
    });

    // Step 1 asks intent, complexity and the pick together; step 3 asks isRepeat with the
    // order in state; grading is the last request.
    expect(calls.map((c) => Object.keys(c.questions))).toEqual([
      ["intent", "complexity", "orderNumber"],
      ["isRepeat"],
      ["reply__supported", "reply__style"],
    ]);
    expect(calls[1]!.state).toEqual({
      ...input,
      order: { value: { orderNumber: "#12345", status: "shipped" } },
    });
    expect(trace.steps.map((s) => s.fields)).toEqual([
      ["intent", "complexity", "orderNumber"],
      ["order", "note"],
      ["isRepeat", "reply"],
    ]);
  });

  it("applies grading scores and minScore gates after the last step", async () => {
    const graded = fieldwork<{ ticket: string }>()
      .text("reply", { instructions: "Reply", style: "warm", minScore: 0.5 })
      .text("note", { instructions: "Summarize", minScore: 0.5 })
      .text("raw", { instructions: "Echo", grade: false });
    const { client, calls } = fakeTypeSafe(byQuestion);
    const medium = fakeTextModel("text");
    const { fields, trace } = await graded.run(input, { typesafe: client, models: { medium } });

    expect(fields.reply).toMatchObject({
      status: "filled",
      passed: true,
      score: expect.closeTo(0.72),
      heuristic: true,
    });
    expect(fields.note).toMatchObject({ status: "filled", passed: false, score: 0.2 });
    expect(fields.raw).toMatchObject({ status: "filled", passed: true, score: null });
    expect(Object.keys(calls[0]!.questions)).toEqual([
      "reply__supported",
      "reply__style",
      "note__supported",
    ]);
    expect(trace.grading).toMatchObject({ fields: ["reply", "note"] });
  });

  it("records calls, tokens and costs in the trace", async () => {
    const { client } = fakeTypeSafe((call) => ({ ...byQuestion(call), inputTokens: 1_000_000 }));
    const prices = { text: { "low-model": { inputPerMTok: 0, outputPerMTok: 0 } } };
    const { trace } = await triage.run(input, { typesafe: client, models, prices });

    const jev = trace.steps[0]!.calls[0]!;
    expect(jev).toMatchObject({ worker: "jev", model: FAKE_JEV_MODEL, status: "ok" });
    expect(jev.estCostUsd).toBeCloseTo(0.042);
    expect(trace.steps[1]!.calls).toMatchObject([{ worker: "tool", fields: ["order"] }]);
    expect(trace.grading!.calls).toHaveLength(1);
    // Three jev requests at 1M input tokens each; the priced text model is free.
    expect(trace.estCostUsd).toBeCloseTo(0.126);
    expect(trace.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a null total cost when a text model has no price", async () => {
    const { client } = fakeTypeSafe(byQuestion);
    const { trace } = await triage.run(input, { typesafe: client, models });
    expect(trace.estCostUsd).toBeNull();
  });

  describe("error table", () => {
    it("fails every judgment and pick in a failed request; dependents see passed false", async () => {
      const { client } = fakeTypeSafe({ status: 500, body: "secret ticket text" });
      const { fields } = await triage.run(input, { typesafe: client, models });

      for (const name of ["intent", "complexity", "orderNumber"] as const) {
        expect(fields[name]).toEqual({
          status: "failed",
          passed: false,
          error: { code: "jev_error", message: "jev: HTTP 500" },
        });
      }
      expect(fields.order).toMatchObject({ status: "skipped" });
      expect(fields.reply).toMatchObject({ status: "skipped" });
      // A failed complexity means escalate: the note's when reads passed === false.
      expect(fields.note).toMatchObject({ status: "filled", value: "n" });
    });

    it("fails a request's fields with timeout at the smallest timeoutMs among them", async () => {
      const timed = fieldwork<{ ticket: string }>()
        .judge("intent", choice("The primary intent", INTENTS), { timeoutMs: 30 })
        .judge("complexity", score("How complex", LEVELS), { timeoutMs: 5_000 });
      const { client } = fakeTypeSafe({ hangMs: 2_000 });
      const started = performance.now();
      const { fields } = await timed.run(input, { typesafe: client });

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(fields.intent).toEqual({
        status: "failed",
        passed: false,
        error: { code: "timeout", message: "jev request: no result within 30 ms" },
      });
      expect(fields.complexity).toMatchObject({ status: "failed", error: { code: "timeout" } });
    });

    it("fails only a text field whose generation throws", async () => {
      const { client } = fakeTypeSafe(byQuestion);
      const broken = { low: fakeTextModel(new Error("provider down")), high: models.high };
      const { fields } = await triage.run(input, { typesafe: client, models: broken });
      expect(fields.reply).toMatchObject({ status: "failed", error: { code: "text_error" } });
      expect(fields.isRepeat).toMatchObject({ status: "filled" });
    });

    it("keeps text filled with a null score when grading fails", async () => {
      const { client } = fakeTypeSafe((call, index) =>
        index === 2 ? { status: 503 } : byQuestion(call),
      );
      const { fields, trace } = await triage.run(input, { typesafe: client, models });
      expect(fields.reply).toMatchObject({ status: "filled", passed: true, score: null });
      expect(trace.grading!.calls[0]).toMatchObject({ status: "failed" });
    });

    it("fails a tool that throws with its message only", async () => {
      const schema = fieldwork<{ ticket: string }>()
        .tool("order", {
          call: () => {
            throw new Error("no such order");
          },
        })
        .tool("after", { after: ["order"], call: (f) => f.order.status });
      const { client } = fakeTypeSafe(byQuestion);
      const { fields } = await schema.run(input, { typesafe: client });
      expect(fields.order).toEqual({
        status: "failed",
        passed: false,
        error: { code: "tool_error", message: "no such order" },
      });
      expect(fields.after).toMatchObject({ status: "filled", value: "failed" });
    });

    it("returns what it has when the deadline passes; unsettled and later fields time out", async () => {
      const schema = fieldwork<{ ticket: string }>()
        .tool("fast", { call: () => 1 })
        .tool("slow", { call: () => new Promise(() => {}) })
        .tool("later", { after: ["fast"], call: () => 2 });
      const { client } = fakeTypeSafe(byQuestion);
      const started = performance.now();
      const { fields } = await schema.run(input, { typesafe: client, deadlineMs: 40 });

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(fields.fast).toMatchObject({ status: "filled", value: 1 });
      const timeout = {
        status: "failed",
        passed: false,
        error: { code: "timeout", message: "run deadline of 40 ms reached" },
      };
      expect(fields.slow).toEqual(timeout);
      expect(fields.later).toEqual(timeout);
    });
  });

  it("fails a tool at its own timeoutMs while the rest of the step finishes", async () => {
    const schema = fieldwork<{ ticket: string }>()
      .tool("slow", { call: () => new Promise(() => {}), timeoutMs: 20 })
      .tool("fast", { call: () => "ok" });
    const { client } = fakeTypeSafe(byQuestion);
    const { fields } = await schema.run(input, { typesafe: client });
    expect(fields.slow).toMatchObject({
      status: "failed",
      error: { code: "timeout", message: "slow: no result within 20 ms" },
    });
    expect(fields.fast).toMatchObject({ status: "filled", value: "ok" });
  });

  it("fails only the field whose when throws", async () => {
    const schema = fieldwork<{ ticket: string }>()
      .tool("a", {
        when: () => {
          throw new Error("bad when");
        },
        call: () => 1,
      })
      .tool("b", { call: () => 2 });
    const { client } = fakeTypeSafe(byQuestion);
    const { fields } = await schema.run(input, { typesafe: client });
    expect(fields.a).toEqual({
      status: "failed",
      passed: false,
      error: { code: "when_error", message: "bad when" },
    });
    expect(fields.b).toMatchObject({ status: "filled", value: 2 });
  });

  it("does not ask jev about a field whose when returned false", async () => {
    const schema = fieldwork<{ ticket: string }>()
      .judge("intent", choice("The primary intent", INTENTS))
      .judge("isRepeat", noul("Again?"), { when: () => false });
    const { client, calls } = fakeTypeSafe(byQuestion);
    await schema.run(input, { typesafe: client });
    expect(Object.keys(calls[0]!.questions)).toEqual(["intent"]);
  });

  it("fails only the fields that read a value that cannot be JSON, and still resolves", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const schema = fieldwork<{ ticket: string }>()
      .tool("order", { call: () => circular })
      .judge("isRepeat", noul("Again?"), { after: ["order"] })
      .tool("other", { after: ["order"], call: () => "ok" });
    const { client } = fakeTypeSafe(byQuestion);
    const { fields } = await schema.run(input, { typesafe: client });
    expect(fields.isRepeat).toMatchObject({ status: "failed", error: { code: "bad_state" } });
    expect(fields.other).toMatchObject({ status: "filled", value: "ok" });
  });

  it("leaves no timers running after it returns", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const schema = fieldwork<{ ticket: string }>().tool("a", { call: () => 1, timeoutMs: 60_000 });
    const { client } = fakeTypeSafe(byQuestion);
    const before = timers();
    await schema.run(input, { typesafe: client, deadlineMs: 60_000 });
    expect(timers()).toBe(before);
  });

  describe("definition errors, thrown before anything is sent", () => {
    const { client, calls } = fakeTypeSafe(byQuestion);

    it("rejects a field named like an input, for untyped callers", async () => {
      const spec: FieldSpec = { kind: "tool", name: "ticket", after: [], call: () => 1 };
      await expect(new Builder([spec]).run(input, { typesafe: client })).rejects.toThrow(
        new DefinitionError('Field "ticket" has the same name as an input'),
      );
    });

    it("rejects inputs that are not a plain object", async () => {
      const b = fieldwork<object>();
      await expect(b.run(null as never, { typesafe: client })).rejects.toThrow(DefinitionError);
      await expect(b.run([] as never, { typesafe: client })).rejects.toThrow(DefinitionError);
    });

    it("rejects a missing client and a bad deadline", async () => {
      const b = fieldwork<{ ticket: string }>();
      await expect(b.run(input, {} as never)).rejects.toThrow(
        "run needs a TypeSafeClient as options.typesafe",
      );
      for (const deadlineMs of [0, -1, Number.NaN]) {
        await expect(b.run(input, { typesafe: client, deadlineMs })).rejects.toThrow(
          DefinitionError,
        );
      }
      expect(calls).toHaveLength(0);
    });
  });
});
