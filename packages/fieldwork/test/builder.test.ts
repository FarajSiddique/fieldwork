import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { Builder, DefinitionError, fieldwork } from "../src/builder.ts";

const ticketSchema = () => fieldwork<{ ticket: string }>();

describe("fieldwork builder", () => {
  it("starts empty", () => {
    const empty = ticketSchema();
    expect(empty).toBeInstanceOf(Builder);
    expect(empty.fields).toEqual([]);
  });

  it("records every field kind in declaration order, with defaults filled in", () => {
    const intent = choice("The primary intent", { track_order: null, get_refund: null });
    const candidates = (input: { ticket: string }) => input.ticket.match(/#\d{5,}/g) ?? [];
    const call = () => 1;
    const schema = ticketSchema()
      .judge("intent", intent, { gate: 0.8 })
      .judge("isRepeat", noul("Has this happened before?"), { yesAbove: 0.9 })
      .pick("orderNumber", { instructions: "The order number", candidates })
      .tool("lookup", { after: ["orderNumber"], call })
      .text("reply", { after: ["intent"], instructions: "Reply to the customer" });

    expect(schema.fields.map((f) => [f.kind, f.name])).toEqual([
      ["judge", "intent"],
      ["judge", "isRepeat"],
      ["pick", "orderNumber"],
      ["tool", "lookup"],
      ["text", "reply"],
    ]);
    expect(schema.fields[0]).toMatchObject({ question: intent, gate: 0.8, after: [] });
    expect(schema.fields[1]).toMatchObject({ yesAbove: 0.9 });
    expect(schema.fields[2]).toMatchObject({ instructions: "The order number", candidates });
    expect(schema.fields[3]).toMatchObject({ call, after: ["orderNumber"] });
    expect(schema.fields[4]).toMatchObject({ grade: true, after: ["intent"] });
  });

  it("keeps a text field's grade: false", () => {
    const schema = ticketSchema().text("note", { instructions: "Summarize", grade: false });
    expect(schema.fields[0]).toMatchObject({ grade: false });
  });

  it("never changes a builder: branches from a shared base stay independent", () => {
    const base = ticketSchema().judge("a", noul("A?"));
    const left = base.judge("b", noul("B?"));
    const right = base.judge("c", noul("C?"));
    expect(base.fields.map((f) => f.name)).toEqual(["a"]);
    expect(left.fields.map((f) => f.name)).toEqual(["a", "b"]);
    expect(right.fields.map((f) => f.name)).toEqual(["a", "c"]);
  });

  it("accepts thresholds at their bounds", () => {
    expect(() =>
      ticketSchema()
        .judge("a", score("How complex", ["low", "high"]), { gate: 0 })
        .judge("b", choice("Which", { x: null, y: null }), { gate: 1 })
        .judge("c", noul("Yes?"), { yesAbove: 0.5 })
        .judge("d", noul("Yes?"), { yesAbove: 1 })
        .text("e", { instructions: "Write", minScore: 0 }),
    ).not.toThrow();
  });

  // The cases below come from untyped (JavaScript) callers; the types reject them at compile time.
  const untyped = () =>
    ticketSchema() as unknown as Record<string, (...args: unknown[]) => unknown>;
  const rejects = (fn: () => unknown, message: RegExp) => {
    expect(fn).toThrow(DefinitionError);
    expect(fn).toThrow(message);
  };

  it("rejects thresholds outside their range, including NaN", () => {
    rejects(
      () => ticketSchema().judge("a", noul("?"), { yesAbove: 0.4 }),
      /a: yesAbove must be between 0.5 and 1/,
    );
    rejects(
      () => ticketSchema().judge("a", choice("?", { x: null, y: null }), { gate: 1.2 }),
      /a: gate must be between 0 and 1, got 1.2/,
    );
    rejects(
      () => ticketSchema().judge("a", choice("?", { x: null, y: null }), { gate: Number.NaN }),
      /a: gate must be between 0 and 1, got NaN/,
    );
    rejects(
      () => ticketSchema().pick("a", { instructions: "?", candidates: () => [], gate: -0.1 }),
      /a: gate must be between 0 and 1/,
    );
    rejects(
      () => ticketSchema().text("a", { instructions: "?", minScore: 2 }),
      /a: minScore must be between 0 and 1/,
    );
  });

  it("rejects a timeout that is not a positive number", () => {
    rejects(
      () => ticketSchema().judge("a", noul("?"), { timeoutMs: 0 }),
      /a: timeoutMs must be a positive number/,
    );
    rejects(
      () => ticketSchema().tool("a", { call: () => 1, timeoutMs: Number.POSITIVE_INFINITY }),
      /a: timeoutMs must be a positive number/,
    );
  });

  it("rejects empty and __proto__ names", () => {
    rejects(() => untyped().judge!("", noul("?")), /non-empty strings/);
    rejects(() => untyped().judge!("__proto__", noul("?")), /"__proto__" cannot be a field name/);
  });

  it("rejects a judge whose question is not a TypeSafe question", () => {
    rejects(
      () => untyped().judge!("a", { type: "free_text" }),
      /a: judge takes a choice\(\), score\(\) or noul\(\)/,
    );
    rejects(() => untyped().judge!("a", "Is this urgent?"), /a: judge takes/);
  });

  it("rejects when, call and candidates that are not functions", () => {
    rejects(() => untyped().judge!("a", noul("?"), { when: true }), /a: when must be a function/);
    rejects(() => untyped().tool!("a", { call: "lookup" }), /a: call must be a function/);
    rejects(() => untyped().pick!("a", { instructions: "?" }), /a: candidates must be a function/);
  });

  it("rejects an after that is not a list of names", () => {
    rejects(
      () => untyped().tool!("a", { after: "intent", call: () => 1 }),
      /a: after must be an array of field names/,
    );
    rejects(() => untyped().tool!("a", { after: [1], call: () => 1 }), /a: after must be an array/);
  });
});
