import { choice } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldwork } from "../src/builder.ts";
import { TimeoutReached } from "../src/errors.ts";
import { runText, textPrompt, type TextField } from "../src/resolvers/text.ts";
import { runTool, type ToolField } from "../src/resolvers/tool.ts";
import type { AnyResult } from "../src/types.ts";
import { fakeTextModel } from "./fakes.ts";

const open = () => new AbortController().signal;
const input = { ticket: "Where is my order?\nIt is late." };
const intent: AnyResult = {
  status: "filled",
  passed: true,
  worker: "jev",
  model: "jev-1.13.0",
  ms: 3,
  choice: "track_order",
  confidence: 0.9,
};

const schema = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent", { track_order: null, get_refund: null }))
  .tool("category", {
    after: ["intent"],
    call: (f) => (f.intent.passed ? { category: "order" } : null),
  })
  .text("reply", {
    after: ["intent"],
    instructions: "Reply to the customer",
    style: "warm, under 80 words",
    reasoning: "low",
  })
  .text("note", { instructions: "Summarize", minScore: 0.5 });
const tool = schema.fields[1] as ToolField;
const reply = schema.fields[2] as TextField;
const note = schema.fields[3] as TextField;

describe("runTool", () => {
  it("calls the function with its after fields and the inputs", async () => {
    const { result, call } = await runTool(tool, { intent }, input, open());
    expect(result).toMatchObject({
      status: "filled",
      passed: true,
      worker: "tool",
      model: null,
      value: { category: "order" },
    });
    expect(call).toMatchObject({
      worker: "tool",
      fields: ["category"],
      status: "ok",
      estCostUsd: 0,
    });
  });

  it("awaits an async function", async () => {
    const field = { ...tool, call: async () => 42 };
    const { result } = await runTool(field, {}, input, open());
    expect(result).toMatchObject({ status: "filled", value: 42 });
  });

  it("fails with the message only when the function throws or rejects", async () => {
    const throws = {
      ...tool,
      call: () => {
        throw new Error("no such order");
      },
    };
    const rejects = { ...tool, call: () => Promise.reject(new Error("db down")) };
    expect((await runTool(throws, {}, input, open())).result).toEqual({
      status: "failed",
      passed: false,
      error: { code: "tool_error", message: "no such order" },
    });
    const { result, call } = await runTool(rejects, {}, input, open());
    expect(result).toMatchObject({ error: { code: "tool_error", message: "db down" } });
    expect(call.status).toBe("failed");
  });

  it("fails with timeout when the signal aborts before the function returns", async () => {
    const controller = new AbortController();
    const hangs = { ...tool, call: () => new Promise(() => {}) };
    const pending = runTool(hangs, {}, input, controller.signal);
    controller.abort(new TimeoutReached("category: no result within 20 ms"));
    expect((await pending).result).toMatchObject({
      status: "failed",
      error: { code: "timeout", message: "category: no result within 20 ms" },
    });
  });
});

describe("textPrompt", () => {
  it("puts instructions and style in the system message and data in labeled blocks", () => {
    const { system, prompt } = textPrompt(reply, input, { intent });
    expect(system).toBe(
      "Reply to the customer\n\nStyle: warm, under 80 words\n\n" +
        "Use the data in the message as context. Reply with the text only.",
    );
    expect(prompt).toBe(
      '<data name="ticket">\nWhere is my order?\nIt is late.\n</data>\n\n' +
        '<data name="intent">\n{\n  "choice": "track_order",\n  "confidence": 0.9\n}\n</data>',
    );
  });

  it("never asks for JSON output", () => {
    const { system } = textPrompt(reply, input, { intent });
    expect(system).not.toMatch(/json/i);
  });

  it("shows a skipped dependency as null", () => {
    const { prompt } = textPrompt(reply, input, {
      intent: { status: "skipped", passed: false, reason: "r" },
    });
    expect(prompt).toContain('<data name="intent">\nnull\n</data>');
  });
});

describe("runText", () => {
  it("generates with the tier's model and records usage and cost", async () => {
    const low = fakeTextModel("Your order ships today.", "cheap-model");
    const prices = { text: { "cheap-model": { inputPerMTok: 1, outputPerMTok: 5 } } };
    const { result, call } = await runText(
      reply,
      input,
      { intent },
      {
        models: { low },
        signal: open(),
        prices,
      },
    );
    expect(result).toMatchObject({
      status: "filled",
      passed: true,
      worker: "text",
      model: "cheap-model",
      value: "Your order ships today.",
      score: null,
      heuristic: true,
    });
    expect(low.doGenerateCalls).toHaveLength(1);
    expect(call).toMatchObject({ worker: "text", model: "cheap-model", status: "ok" });
    expect(call!.inputTokens).toBeGreaterThan(0);
    expect(call!.estCostUsd).not.toBeNull();
  });

  it("uses medium when a field names no tier, and a field's own model over any tier", async () => {
    const medium = fakeTextModel("from medium", "mid");
    const own = fakeTextModel("from own", "own");
    const r1 = await runText(note, input, {}, { models: { medium }, signal: open() });
    expect(r1.result).toMatchObject({ value: "from medium", model: "mid" });
    const r2 = await runText(
      { ...note, model: own },
      input,
      {},
      { models: { medium }, signal: open() },
    );
    expect(r2.result).toMatchObject({ value: "from own", model: "own" });
  });

  it("has not passed a minScore gate before grading", async () => {
    const medium = fakeTextModel("text");
    const { result } = await runText(note, input, {}, { models: { medium }, signal: open() });
    expect(result).toMatchObject({ status: "filled", passed: false, score: null });
  });

  it("fails with no_model when the tier has no model", async () => {
    const { result, call } = await runText(reply, input, { intent }, { signal: open() });
    expect(result).toEqual({
      status: "failed",
      passed: false,
      error: { code: "no_model", message: 'reply: no model for reasoning "low"' },
    });
    expect(call).toBeNull();
  });

  it("fails when generation throws, without the provider's message", async () => {
    const low = fakeTextModel(new Error("provider said: secret"));
    const { result, call } = await runText(
      reply,
      input,
      { intent },
      { models: { low }, signal: open() },
    );
    expect(result).toMatchObject({ status: "failed", error: { code: "text_error" } });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(call).toMatchObject({ status: "failed", inputTokens: 0 });
  });

  it("fails when the model returns only whitespace", async () => {
    const low = fakeTextModel("  \n ");
    const { result } = await runText(reply, input, { intent }, { models: { low }, signal: open() });
    expect(result).toMatchObject({ status: "failed", error: { code: "empty_text" } });
  });

  it("fails with timeout when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort(new TimeoutReached("reply: no result within 5 ms"));
    const low = fakeTextModel("late");
    const { result } = await runText(
      reply,
      input,
      { intent },
      {
        models: { low },
        signal: controller.signal,
      },
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "timeout", message: "reply: no result within 5 ms" },
    });
  });
});
