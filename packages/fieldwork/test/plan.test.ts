import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldwork } from "../src/builder.ts";
import { DefinitionError } from "../src/errors.ts";
import { plan } from "../src/plan.ts";
import type { FieldSpec } from "../src/types.ts";

const names = (steps: FieldSpec[][]) => steps.map((step) => step.map((f) => f.name));

/** A field as an untyped caller would build it. */
const field = (name: string, after: string[] = []): FieldSpec => ({
  kind: "tool",
  name,
  after,
  call: () => null,
});

describe("plan", () => {
  it("returns no steps for no fields", () => {
    expect(plan([])).toEqual([]);
  });

  it("puts fields with no after in the first step, in declaration order", () => {
    expect(names(plan([field("a"), field("b"), field("c")]))).toEqual([["a", "b", "c"]]);
  });

  it("puts each field in the step after the latest step it reads", () => {
    const steps = plan([
      field("a"),
      field("b", ["a"]),
      field("c"),
      field("d", ["b", "c"]),
      field("e", ["a"]),
    ]);
    expect(names(steps)).toEqual([["a", "c"], ["b", "e"], ["d"]]);
  });

  it("plans a field that lists the same dependency twice once", () => {
    expect(names(plan([field("a"), field("b", ["a", "a"])]))).toEqual([["a"], ["b"]]);
  });

  it("plans the triage example in four steps", () => {
    const triage = fieldwork<{ ticket: string }>()
      .judge("intent", choice("The primary intent", { track_order: null, get_refund: null }))
      .tool("category", { after: ["intent"], call: () => ({ category: "order", probability: 1 }) })
      .judge("complexity", score("How complex", ["simple", "judgment", "unusual"]), { gate: 0.85 })
      .judge("isRepeat", noul("Happened before?"))
      .pick("orderNumber", { instructions: "The order number", candidates: () => [] })
      .tool("order", { after: ["category", "orderNumber"], call: () => null })
      .text("reply", { after: ["category", "complexity", "order"], instructions: "Reply" })
      .text("escalationNote", {
        after: ["category", "complexity", "isRepeat", "order"],
        instructions: "Summarize",
      });

    expect(names(plan(triage.fields))).toEqual([
      ["intent", "complexity", "isRepeat", "orderNumber"],
      ["category"],
      ["order"],
      ["reply", "escalationNote"],
    ]);
  });

  it("rejects an after naming an unknown field", () => {
    expect(() => plan([field("a", ["nope"])])).toThrow(DefinitionError);
    expect(() => plan([field("a", ["nope"])])).toThrow('Field "a" reads unknown field "nope"');
  });

  it("rejects an after naming a field declared later", () => {
    expect(() => plan([field("a", ["b"]), field("b")])).toThrow(
      'Field "a" reads "b", which is declared after it',
    );
  });

  it("rejects a field that reads itself", () => {
    expect(() => plan([field("a", ["a"])])).toThrow('Field "a" reads itself');
  });

  it("rejects a name declared twice", () => {
    expect(() => plan([field("a"), field("a")])).toThrow('Field "a" is declared more than once');
  });
});
