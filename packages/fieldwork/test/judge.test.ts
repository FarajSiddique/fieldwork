import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldwork } from "../src/builder.ts";
import { askJev, type JevField } from "../src/resolvers/judge.ts";
import { cleanCandidates, NONE_DESCRIPTION, pickQuestion } from "../src/resolvers/pick.ts";
import type { AnyResult } from "../src/types.ts";
import { answer, FAKE_JEV_MODEL, fakeTypeSafe, type JevReply } from "./fakes.ts";

const INTENTS = { track_order: null, get_refund: null } as const;
const LEVELS = ["simple", "judgment", "unusual"] as const;
const findNumbers = (input: { ticket: string }) => input.ticket.match(/#?\d{5,}/g) ?? [];

const schema = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent", INTENTS), { gate: 0.8 })
  .judge("complexity", score("How complex", LEVELS))
  .judge("isRepeat", noul("Has this happened before?"), { yesAbove: 0.8 })
  .pick("orderNumber", { instructions: "The order number", candidates: findNumbers });
const fields = schema.fields as JevField[];
const byName = (name: string) => fields.find((f) => f.name === name)!;

const input = { ticket: "Where is order #12345? Invoice #99999 is fine." };

function ask(reply: JevReply, only: JevField[] = fields, results: Record<string, AnyResult> = {}) {
  const { client, calls } = fakeTypeSafe(reply);
  const signal = new AbortController().signal;
  return { calls, pending: askJev(only, input, results, { client, signal }) };
}

const good = {
  answers: {
    intent: answer.choice({ track_order: 0.9, get_refund: 0.1 }),
    complexity: answer.score([0.1, 0.1, 0.8]),
    isRepeat: answer.noul(0.5),
    orderNumber: answer.choice({ "#12345": 0.7, "#99999": 0.2, none: 0.1 }),
  },
  inputTokens: 250,
};

describe("pick questions", () => {
  it("keeps candidates in first-seen order without repeats or empty strings", () => {
    expect(cleanCandidates(["#2", "", "#1", "#2"])).toEqual(["#2", "#1"]);
  });

  it("rejects anything but an array of strings", () => {
    expect(cleanCandidates("#1")).toBeNull();
    expect(cleanCandidates([1, 2])).toBeNull();
  });

  it("adds a described none option after the candidates", () => {
    const pick = pickQuestion("The order number", ["#1", "#2"]);
    expect(pick.none).toBe("none");
    expect(pick.question).toEqual({
      type: "choice",
      instructions: "The order number",
      criteria: { "#1": null, "#2": null, none: NONE_DESCRIPTION },
    });
  });

  it("renames none when a candidate is spelled none", () => {
    const pick = pickQuestion("x", ["none", "_none"]);
    expect(pick.none).toBe("__none");
    expect(Object.keys(pick.question.criteria)).toEqual(["none", "_none", "__none"]);
  });
});

describe("askJev", () => {
  it("asks every judgment and pick in one request keyed by field name", async () => {
    const { pending, calls } = ask(good);
    await pending;
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual([
      "intent",
      "complexity",
      "isRepeat",
      "orderNumber",
    ]);
    expect(calls[0]!.state).toEqual(input);
    expect(calls[0]!.questions.orderNumber).toMatchObject({
      criteria: { "#12345": null, "#99999": null, none: NONE_DESCRIPTION },
    });
  });

  it("maps each answer to a typed, filled result", async () => {
    const { results, call } = await ask(good).pending;
    expect(results.intent).toMatchObject({
      status: "filled",
      passed: true,
      worker: "jev",
      model: FAKE_JEV_MODEL,
      choice: "track_order",
      confidence: 0.9,
      probabilities: { track_order: 0.9, get_refund: 0.1 },
    });
    expect(results.complexity).toMatchObject({
      status: "filled",
      passed: true,
      score: expect.closeTo(1.7),
      confidence: 0.8,
    });
    expect(results.orderNumber).toMatchObject({ value: "#12345", confidence: 0.7, passed: true });
    expect(call).toMatchObject({
      worker: "jev",
      model: FAKE_JEV_MODEL,
      fields: ["intent", "complexity", "isRepeat", "orderNumber"],
      status: "ok",
      inputTokens: 250,
      outputTokens: 0,
    });
    expect(call!.estCostUsd).toBeCloseTo((250 * 0.042) / 1e6);
  });

  it("gates on confidence", async () => {
    const reply = {
      answers: { ...good.answers, intent: answer.choice({ track_order: 0.6, get_refund: 0.4 }) },
    };
    const { results } = await ask(reply).pending;
    expect(results.intent).toMatchObject({ status: "filled", passed: false, confidence: 0.6 });
  });

  it("leaves yes unset and fails the gate when a Noul is between the thresholds", async () => {
    const { results } = await ask(good).pending;
    expect(results.isRepeat).toMatchObject({
      status: "filled",
      passed: false,
      noul: 0.5,
      yes: undefined,
    });
  });

  it("sets yes on either side of yesAbove", async () => {
    for (const [p, yes] of [
      [0.85, true],
      [0.1, false],
    ] as const) {
      const { results } = await ask({ answers: { isRepeat: answer.noul(p) } }, [byName("isRepeat")])
        .pending;
      expect(results.isRepeat).toMatchObject({ passed: true, noul: p, yes });
    }
  });

  it("returns null for a pick when jev chooses none", async () => {
    const reply = {
      answers: { orderNumber: answer.choice({ "#12345": 0.1, "#99999": 0.1, none: 0.8 }) },
    };
    const { results } = await ask(reply, [byName("orderNumber")]).pending;
    expect(results.orderNumber).toMatchObject({ status: "filled", value: null, confidence: 0.8 });
  });

  it("answers none without asking when there are no candidates", async () => {
    const { client, calls } = fakeTypeSafe(good);
    const signal = new AbortController().signal;
    const { results, call } = await askJev(
      [byName("orderNumber")],
      { ticket: "no numbers" },
      {},
      {
        client,
        signal,
      },
    );
    expect(calls).toHaveLength(0);
    expect(call).toBeNull();
    expect(results.orderNumber).toMatchObject({
      status: "filled",
      passed: true,
      value: null,
      confidence: 1,
      model: null,
    });
  });

  it("fails only the field whose answer is missing or outside its options", async () => {
    const reply = {
      answers: {
        intent: { ...answer.choice({ track_order: 0.9 }), choice: "cancel_order" },
        complexity: good.answers.complexity,
        orderNumber: answer.choice({ "#55555": 0.9, none: 0.1 }),
      },
    };
    const { results } = await ask(reply).pending;
    expect(results.intent).toMatchObject({ status: "failed", error: { code: "bad_answer" } });
    expect(results.isRepeat).toMatchObject({ status: "failed", error: { code: "bad_answer" } });
    expect(results.orderNumber).toMatchObject({ status: "failed", error: { code: "bad_answer" } });
    expect(results.complexity).toMatchObject({ status: "filled" });
  });

  it("fails an answer of the wrong type", async () => {
    const reply = { answers: { complexity: answer.noul(0.5) } };
    const { results } = await ask(reply, [byName("complexity")]).pending;
    expect(results.complexity).toMatchObject({
      status: "failed",
      error: { code: "bad_answer", message: "complexity: expected a score answer" },
    });
  });

  it("fails every field in the request when jev errors, without the response body", async () => {
    const reply = { status: 500, body: { error: { message: "secret ticket text" } } };
    const { results, call } = await ask(reply).pending;
    for (const name of ["intent", "complexity", "isRepeat", "orderNumber"]) {
      expect(results[name]).toEqual({
        status: "failed",
        passed: false,
        error: { code: "jev_error", message: "jev: HTTP 500" },
      });
    }
    expect(call).toMatchObject({ status: "failed", inputTokens: 0 });
  });

  it("fails a pick whose candidates function throws or returns a non-list", async () => {
    const schema2 = fieldwork<{ ticket: string }>()
      .pick("a", {
        instructions: "x",
        candidates: () => {
          throw new Error("regex broke");
        },
      })
      .pick("b", { instructions: "x", candidates: () => "#1" as unknown as string[] });
    const { results, call } = await ask(good, schema2.fields as JevField[]).pending;
    expect(results.a).toMatchObject({
      status: "failed",
      error: { code: "candidates_error", message: "regex broke" },
    });
    expect(results.b).toMatchObject({ status: "failed", error: { code: "candidates_error" } });
    expect(call).toBeNull();
  });

  it("adds the after fields the questions list to state, and only those", async () => {
    const later = fieldwork<{ ticket: string }>()
      .judge("intent", choice("The primary intent", INTENTS))
      .judge("complexity", score("How complex", LEVELS))
      .judge("isRepeat", noul("Has this happened before?"), { after: ["intent"] });
    const intent: AnyResult = {
      status: "filled",
      passed: true,
      worker: "jev",
      model: FAKE_JEV_MODEL,
      ms: 3,
      choice: "track_order",
      confidence: 0.9,
      probabilities: { track_order: 0.9, get_refund: 0.1 },
    };
    const complexity: AnyResult = { status: "skipped", passed: false, reason: "r" };
    const { pending, calls } = ask(
      { answers: { isRepeat: answer.noul(0.1) } },
      [later.fields[2] as JevField],
      { intent, complexity },
    );
    await pending;
    expect(calls[0]!.state).toEqual({
      ...input,
      intent: {
        choice: "track_order",
        confidence: 0.9,
        probabilities: { track_order: 0.9, get_refund: 0.1 },
      },
    });
  });

  it("fails the request's fields with state_too_large instead of sending", async () => {
    const { client, calls } = fakeTypeSafe(good);
    const signal = new AbortController().signal;
    const huge = { ticket: "#12345 " + "x".repeat(100_000) };
    const { results, call } = await askJev(fields, huge, {}, { client, signal });
    expect(calls).toHaveLength(0);
    expect(call).toBeNull();
    expect(results.intent).toMatchObject({ status: "failed", error: { code: "state_too_large" } });
    expect(results.orderNumber).toMatchObject({ error: { code: "state_too_large" } });
  });

  it("sends the pinned jev model when one is given", async () => {
    const { client, calls } = fakeTypeSafe(good);
    const signal = new AbortController().signal;
    await askJev(fields, input, {}, { client, signal, model: "jev-1.13.2" });
    expect(calls[0]!.model).toBe("jev-1.13.2");
  });
});
