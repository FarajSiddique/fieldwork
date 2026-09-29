// Type tests: `pnpm typecheck` checks every assertion and @ts-expect-error below. Vitest runs the
// `it` blocks too, where expectTypeOf is a no-op, so the runtime checks here stay minimal.
import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";
import { fieldwork, type ResultsOf } from "../src/builder.ts";
import type { FieldView, NoulValue } from "../src/types.ts";

const INTENTS = { track_order: "Where an order is", get_refund: "Wants money back" } as const;

/** Stand-in for the app's roll-up; it takes `undefined` because `call` cannot see `when`. */
declare function rollUpToCategory(
  probabilities: { track_order: number; get_refund: number } | undefined,
): { category: "order" | "refund"; probability: number };
declare const orders: { lookup(q: { orderNumber: string }): Promise<{ status: string }> };

/** The spec's triage example, reduced to two intents. */
const triage = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent of this customer message", INTENTS))
  .tool("category", {
    after: ["intent"],
    when: (f) => f.intent.passed,
    call: (f) => rollUpToCategory(f.intent.probabilities),
  })
  .judge(
    "complexity",
    score("How complex is this request to resolve", ["simple", "judgment", "unusual"]),
    { gate: 0.85 },
  )
  .judge("isRepeat", noul("Does the customer say this problem happened before?"))
  .pick("orderNumber", {
    instructions: "The order number the customer is asking about",
    candidates: (input) => input.ticket.match(/#\d{5,}/g) ?? [],
  })
  .tool("order", {
    after: ["category", "orderNumber"],
    when: (f) => f.category.value?.category === "order" && f.orderNumber.value !== null,
    call: (f) => orders.lookup({ orderNumber: f.orderNumber.value! }),
  })
  .text("reply", {
    after: ["category", "complexity", "order"],
    when: (f) =>
      (f.category.value?.probability ?? 0) >= 0.85 &&
      f.complexity.passed &&
      f.complexity.score < 1.5,
    reasoning: "low",
    instructions: "Reply to the customer",
    style: "warm, under 80 words, no promises about dates",
  })
  .text("escalationNote", {
    after: ["category", "complexity", "isRepeat", "order"],
    when: (f) =>
      (f.category.value?.probability ?? 0) < 0.85 ||
      !f.complexity.passed ||
      f.complexity.score >= 1.5,
    reasoning: "high",
    instructions: "Summarize the ticket for the on-call agent",
    style: "one line",
  });

type Results = ResultsOf<typeof triage>;
type FilledOf<K extends keyof Results> = Extract<Results[K], { status: "filled" }>;

describe("builder types", () => {
  it("builds the triage example", () => {
    expect(triage.fields).toHaveLength(8);
  });

  it("infers each field's result from its question or function", () => {
    expectTypeOf<FilledOf<"intent">["choice"]>().toEqualTypeOf<"track_order" | "get_refund">();
    expectTypeOf<FilledOf<"intent">["probabilities"]>().toEqualTypeOf<{
      track_order: number;
      get_refund: number;
    }>();
    expectTypeOf<FilledOf<"complexity">["score"]>().toEqualTypeOf<number>();
    expectTypeOf<FilledOf<"isRepeat">["noul"]>().toEqualTypeOf<number>();
    expectTypeOf<FilledOf<"isRepeat">["yes"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<FilledOf<"orderNumber">["value"]>().toEqualTypeOf<string | null>();
    expectTypeOf<FilledOf<"category">["value"]>().toEqualTypeOf<{
      category: "order" | "refund";
      probability: number;
    }>();
    // A tool that returns a promise yields the resolved value.
    expectTypeOf<FilledOf<"order">["value"]>().toEqualTypeOf<{ status: string }>();
    expectTypeOf<FilledOf<"reply">["value"]>().toEqualTypeOf<string>();
    expectTypeOf<FilledOf<"reply">["score"]>().toEqualTypeOf<number | null>();
  });

  it("makes every result filled, skipped or failed", () => {
    expectTypeOf<Results["intent"]["status"]>().toEqualTypeOf<"filled" | "skipped" | "failed">();
    expectTypeOf<Extract<Results["intent"], { status: "skipped" }>>().toEqualTypeOf<{
      status: "skipped";
      passed: false;
      reason: string;
    }>();
    expectTypeOf<Extract<Results["intent"], { status: "failed" }>["error"]>().toEqualTypeOf<{
      code: string;
      message: string;
    }>();
  });

  it("narrows a dependency's values to defined when passed is checked", () => {
    const view = {} as FieldView<{ score: number }>;
    expectTypeOf(view.score).toEqualTypeOf<number | undefined>();
    if (view.passed) expectTypeOf(view.score).toEqualTypeOf<number>();
  });

  it("gives when and call only the fields named in after, plus the inputs", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      .judge("b", noul("B?"))
      .tool("c", {
        after: ["a"],
        when: (f, input) => {
          expectTypeOf(input).toEqualTypeOf<{ ticket: string }>();
          expectTypeOf(f).toEqualTypeOf<{ a: FieldView<NoulValue> }>();
          return true;
        },
        // @ts-expect-error: b is not in after
        call: (f) => f.b,
      });
  });

  it("gives a field with no after an empty f", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      .tool("b", {
        call: (f) => {
          expectTypeOf(f).toEqualTypeOf<Record<never, never>>();
          return 1;
        },
      });
  });

  it("rejects after names that are not earlier fields", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      // @ts-expect-error: unknown name
      .tool("b", { after: ["nope"], call: () => 1 });
    fieldwork<{ ticket: string }>()
      // @ts-expect-error: a field cannot read itself
      .tool("a", { after: ["a"], call: () => 1 });
  });

  it("rejects a name used twice", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      // @ts-expect-error: duplicate name
      .text("a", { instructions: "Write" });
  });

  // A union name would type both fields while only one exists at runtime; a widened string
  // would skip the duplicate check and give the results a string index.
  it("rejects names that are not a single literal", () => {
    const union = "c" as "c" | "d";
    const wide: string = "c";
    fieldwork<{ ticket: string }>()
      // @ts-expect-error: a union name
      .judge(union, noul("C?"));
    fieldwork<{ ticket: string }>()
      // @ts-expect-error: a widened string name
      .tool(wide, { call: () => 1 });
  });

  it("takes gate for choice and score, yesAbove for noul", () => {
    fieldwork<{ ticket: string }>()
      // @ts-expect-error: noul has no gate
      .judge("a", noul("A?"), { gate: 0.5 })
      // @ts-expect-error: choice has no yesAbove
      .judge("b", choice("B?", { x: null, y: null }), { yesAbove: 0.9 });
  });
});
