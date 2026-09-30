import { noul } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldwork } from "../src/builder.ts";
import { grade, gradeQuestions } from "../src/grade.ts";
import type { TextField } from "../src/resolvers/text.ts";
import type { AnyResult } from "../src/types.ts";
import { answer, fakeTypeSafe, type JevReply } from "./fakes.ts";

const schema = fieldwork<{ ticket: string }>()
  .tool("category", { call: () => "order" })
  .text("reply", {
    after: ["category"],
    instructions: "Reply",
    style: "warm, under 80 words",
  })
  .text("note", { instructions: "Summarize" });
const reply = schema.fields[1] as TextField;
const note = schema.fields[2] as TextField;
const input = { ticket: "Where is my order?" };
const category: AnyResult = {
  status: "filled",
  passed: true,
  worker: "tool",
  model: null,
  ms: 0,
  value: "order",
};
const items = [
  { field: reply, text: "It ships today." },
  { field: note, text: "Customer asks where the order is." },
];

function run(reply: JevReply) {
  const { client, calls } = fakeTypeSafe(reply);
  const signal = new AbortController().signal;
  return { calls, pending: grade(items, input, { category }, { client, signal }) };
}

describe("gradeQuestions", () => {
  it("asks whether the text is supported and, when there is a style, whether it meets it", () => {
    expect(gradeQuestions(reply)).toEqual({
      reply__supported: noul(
        "Is the text in `reply` supported by the provided context and inputs?",
      ),
      reply__style: noul("Does the text in `reply` meet the style: warm, under 80 words?"),
    });
    expect(Object.keys(gradeQuestions(note))).toEqual(["note__supported"]);
  });
});

describe("grade", () => {
  it("grades every field in one request, with texts and their context in state", async () => {
    const { pending, calls } = run({
      answers: {
        reply__supported: answer.noul(0.9),
        reply__style: answer.noul(0.5),
        note__supported: answer.noul(0.8),
      },
    });
    const { scores, call } = await pending;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toEqual({
      ticket: "Where is my order?",
      category: { value: "order" },
      reply: "It ships today.",
      note: "Customer asks where the order is.",
    });
    expect(scores.reply).toBeCloseTo(0.45);
    expect(scores.note).toBeCloseTo(0.8);
    expect(call).toMatchObject({ worker: "jev", fields: ["reply", "note"], status: "ok" });
  });

  it("gives null for a field whose answers are missing, and keeps the others", async () => {
    const { pending } = run({
      answers: { reply__supported: answer.noul(0.9), note__supported: answer.noul(0.7) },
    });
    const { scores } = await pending;
    expect(scores).toEqual({ reply: null, note: 0.7 });
  });

  it("gives null for every field when the request fails", async () => {
    const { pending } = run({ status: 503 });
    const { scores, call } = await pending;
    expect(scores).toEqual({ reply: null, note: null });
    expect(call).toMatchObject({ status: "failed" });
  });

  it("sends nothing when there is nothing to grade", async () => {
    const { client, calls } = fakeTypeSafe({ answers: {} });
    const signal = new AbortController().signal;
    const { scores, call } = await grade([], input, {}, { client, signal });
    expect(scores).toEqual({});
    expect(call).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("gives null scores instead of sending an oversized request", async () => {
    const { client, calls } = fakeTypeSafe({ answers: {} });
    const signal = new AbortController().signal;
    const long = [{ field: note, text: "x".repeat(100_000) }];
    const { scores, call } = await grade(long, input, {}, { client, signal });
    expect(scores).toEqual({ note: null });
    expect(call).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("grade with responses and state it cannot use", () => {
  it("gives null scores when a 200 response has no answers", async () => {
    const { pending } = run({ answers: undefined as never });
    const { scores } = await pending;
    expect(scores).toEqual({ reply: null, note: null });
  });

  it("gives null scores instead of sending state that cannot be turned into JSON", async () => {
    const { client, calls } = fakeTypeSafe({ answers: {} });
    const signal = new AbortController().signal;
    const { scores, call } = await grade(items, { ticket: 10n }, { category }, { client, signal });
    expect(scores).toEqual({ reply: null, note: null });
    expect(call).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
