import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import type { BitextTicket } from "../src/bitext/sample.ts";
import { ResponseCache } from "../src/cache.ts";
import { INTENT_NAMES } from "../src/intents.ts";
import { buildStructuredPrompt, runStructured } from "../src/systems/structured.ts";

const usage = {
  inputTokens: { total: 420, noCache: 420, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 38, text: 38, reasoning: 0 },
};

function mockModel(output: unknown) {
  return new MockLanguageModelV4({
    modelId: "mock-cheap",
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
  });
}

const ticket: BitextTicket = {
  id: "bx-7",
  text: "where is order #482913",
  intent: "track_order",
  category: "order",
  orderNumber: "#482913",
  flags: "B",
};

const good = {
  intent: "track_order",
  intentConfidence: 0.9,
  orderNumber: "#482913",
  orderNumberConfidence: 0.95,
};

let cache: ResponseCache;
beforeEach(async () => {
  cache = new ResponseCache(await mkdtemp(join(tmpdir(), "structured-")));
});

describe("buildStructuredPrompt", () => {
  it("lists every intent and includes the ticket", () => {
    const prompt = buildStructuredPrompt("where is order #482913");
    for (const intent of INTENT_NAMES) expect(prompt).toContain(`- ${intent}: `);
    expect(prompt).toContain('ticket: "where is order #482913"');
  });
});

describe("runStructured", () => {
  it("maps the structured output to a prediction", async () => {
    const model = mockModel(good);
    const p = await runStructured(ticket, { name: "cheap", model, modelId: "test/cheap" }, cache);
    expect(p).toEqual({
      system: "cheap",
      ticketId: "bx-7",
      status: "ok",
      error: null,
      intent: "track_order",
      intentConfidence: 0.9,
      category: "order",
      categoryConfidence: 0.9,
      orderNumber: "#482913",
      orderNumberConfidence: 0.95,
      model: "test/cheap",
      provider: null,
      ms: expect.any(Number),
      inputTokens: 420,
      outputTokens: 38,
      cached: false,
    });
  });

  it("fails the prediction when the intent is outside the options", async () => {
    const model = mockModel({ ...good, intent: "weather" });
    const p = await runStructured(ticket, { name: "cheap", model, modelId: "test/cheap" }, cache);
    expect(p).toMatchObject({ status: "failed", intent: null, intentConfidence: 0 });
  });

  it("fails the prediction when the model call throws", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("provider down");
      },
    });
    const p = await runStructured(ticket, { name: "cheap", model, modelId: "test/cheap" }, cache);
    expect(p).toMatchObject({ status: "failed", model: "test/cheap" });
    expect(p.error).toContain("provider down");
  });

  it("serves a repeated ticket from the cache", async () => {
    const model = mockModel(good);
    const system = { name: "cheap", model, modelId: "test/cheap" };
    await runStructured(ticket, system, cache);
    const second = await runStructured(ticket, system, cache);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(second).toMatchObject({ status: "ok", cached: true });
  });
});
