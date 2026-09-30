import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { ResponseCache } from "../src/cache.ts";
import { INTENT_NAMES } from "../src/intents.ts";
import { buildTriagePrompt, runTriageStructured } from "../src/systems/triageStructured.ts";
import {
  COMPLEXITY_LEVELS,
  COMPLEXITY_QUESTION,
  ESCALATION_NOTE,
  INTENT_INSTRUCTIONS,
  IS_REPEAT_QUESTION,
  ORDER_NUMBER_TARGET,
  REPLY,
} from "../src/wording.ts";

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 200, text: 200, reasoning: 0 },
};

function mockModel(output: unknown) {
  return new MockLanguageModelV4({
    modelId: "mock-frontier",
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
  });
}

const ticket = { id: "wr-900", text: "Where is order #4471902? Invoice #12588 is already paid." };
const prices = { "mock-frontier": { inputPerMTok: 4, outputPerMTok: 20 } };

const simple = {
  intent: "track_order",
  intentConfidence: 0.95,
  complexity: 0,
  complexityConfidence: 0.9,
  isRepeat: false,
  isRepeatConfidence: 0.9,
  orderNumber: "#4471902",
  orderNumberConfidence: 0.95,
  reply: "Your order has shipped.",
  escalationNote: "Customer asks where order #4471902 is.",
};

let cache: ResponseCache;
beforeEach(async () => {
  cache = new ResponseCache(await mkdtemp(join(tmpdir(), "triage-structured-")));
});

const run = (output: unknown) =>
  runTriageStructured(
    ticket,
    { name: "frontier", model: mockModel(output), modelId: "mock-frontier" },
    cache,
    prices,
  );

describe("buildTriagePrompt", () => {
  // The spec: all three systems use the same instruction wording.
  it("uses the shared wording for every field, and includes the ticket", () => {
    const prompt = buildTriagePrompt(ticket.text);

    for (const text of [
      INTENT_INSTRUCTIONS,
      COMPLEXITY_QUESTION,
      ...COMPLEXITY_LEVELS,
      IS_REPEAT_QUESTION,
      ORDER_NUMBER_TARGET,
      REPLY.instructions,
      REPLY.style,
      ESCALATION_NOTE.instructions,
      ESCALATION_NOTE.style,
      ...INTENT_NAMES,
    ]) {
      expect(prompt).toContain(text);
    }
    expect(prompt).toContain(JSON.stringify(ticket.text));
  });
});

describe("runTriageStructured", () => {
  it("answers a sure, simple ticket and keeps the reply", async () => {
    const p = await run(simple);

    expect(p).toMatchObject({
      system: "frontier",
      status: "ok",
      intent: "track_order",
      category: "order",
      categoryConfidence: 0.95,
      complexity: 0,
      isRepeat: false,
      orderNumber: "#4471902",
      escalates: false,
      reply: "Your order has shipped.",
      escalationNote: null,
      fieldErrors: [],
    });
    expect(p.estCostUsd).toBeCloseTo((1000 * 4 + 200 * 20) / 1e6);
  });

  it("escalates by the schema's rule and keeps the note", async () => {
    const complex = await run({ ...simple, complexity: 2 });
    expect(complex).toMatchObject({ escalates: true, reply: null });
    expect(complex.escalationNote).toBe(simple.escalationNote);

    const unsure = await run({ ...simple, intentConfidence: 0.6 });
    expect(unsure).toMatchObject({ escalates: true });

    const unsureComplexity = await run({ ...simple, complexityConfidence: 0.5 });
    expect(unsureComplexity).toMatchObject({ escalates: true });
  });

  it("fails the prediction on an answer outside the schema, and escalates", async () => {
    const p = await run({ ...simple, complexity: 3 });

    // The AI SDK or our own parse may reject it first; either way the prediction fails.
    expect(p).toMatchObject({ status: "failed", intent: null, escalates: true, reply: null });
    expect(p.error).toEqual(expect.any(String));
  });

  it("serves a repeated ticket from the cache", async () => {
    const model = mockModel(simple);
    const system = { name: "frontier", model, modelId: "mock-frontier" };

    await runTriageStructured(ticket, system, cache, prices);
    const again = await runTriageStructured(ticket, system, cache, prices);

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(again.cached).toBe(true);
  });
});
