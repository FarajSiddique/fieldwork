import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import type { BitextTicket } from "../src/bitext/sample.ts";
import { ResponseCache } from "../src/cache.ts";
import { INTENT_NAMES, type Intent } from "../src/intents.ts";
import { findOrderNumbers, runJev } from "../src/systems/jev.ts";

function fakeTypeSafe(body: unknown, status = 200) {
  const calls: { url: string; body: { model: string; state: unknown; questions: object } }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch: fetchImpl,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
  return { client, calls };
}

const probs = (top: Intent, p: number) =>
  Object.fromEntries(INTENT_NAMES.map((i) => [i, i === top ? p : (1 - p) / 26]));

const intentAnswer = (choice: string, confidence = 0.91) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: probs("track_order", confidence),
});

const ticket = (text: string): BitextTicket => ({
  id: "bx-1",
  text,
  intent: "track_order",
  category: "order",
  orderNumber: null,
  flags: "B",
});

const usage = { input_tokens: 812, output_tokens: 0 };

let cache: ResponseCache;
beforeEach(async () => {
  cache = new ResponseCache(await mkdtemp(join(tmpdir(), "jev-")));
});

describe("findOrderNumbers", () => {
  it("finds candidates in order of appearance, without duplicates", () => {
    expect(findOrderNumbers("order #482913, not invoice #12588 or #482913")).toEqual([
      "#482913",
      "#12588",
    ]);
    expect(findOrderNumbers("order732201349959")).toEqual(["732201349959"]);
    expect(findOrderNumbers("refund of $45.99")).toEqual([]);
  });
});

describe("runJev", () => {
  it("asks the intent and the order number in one request with the pinned model", async () => {
    const { client, calls } = fakeTypeSafe({
      model: "jev-1.13.0",
      answers: {
        intent: intentAnswer("track_order"),
        orderNumber: {
          type: "choice",
          choice: "#482913",
          confidence: 0.97,
          probabilities: { "#482913": 0.97, none: 0.03 },
        },
      },
      usage,
    });
    const p = await runJev(ticket("where is order #482913"), client, cache);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/v1\/systemone$/);
    expect(calls[0]!.body).toMatchObject({
      model: "jev-1.13.0",
      state: { ticket: "where is order #482913" },
    });
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["intent", "orderNumber"]);
    expect(p).toMatchObject({
      system: "jev",
      status: "ok",
      intent: "track_order",
      intentConfidence: 0.91,
      category: "order",
      orderNumber: "#482913",
      orderNumberConfidence: 0.97,
      model: "jev-1.13.0",
      inputTokens: 812,
      cached: false,
    });
    expect(p.categoryConfidence).toBeGreaterThan(0.91);
  });

  it("maps a none pick to a null order number", async () => {
    const { client } = fakeTypeSafe({
      model: "jev-1.13.0",
      answers: {
        intent: intentAnswer("get_invoice"),
        orderNumber: {
          type: "choice",
          choice: "none",
          confidence: 0.88,
          probabilities: { "#12588": 0.12, none: 0.88 },
        },
      },
      usage,
    });
    const p = await runJev(ticket("download bill #12588"), client, cache);
    expect(p).toMatchObject({ status: "ok", orderNumber: null, orderNumberConfidence: 0.88 });
  });

  it("skips the order-number question when the ticket has no candidates", async () => {
    const { client, calls } = fakeTypeSafe({
      model: "jev-1.13.0",
      answers: { intent: intentAnswer("track_order") },
      usage,
    });
    const p = await runJev(ticket("where is my package"), client, cache);
    expect(Object.keys(calls[0]!.body.questions)).toEqual(["intent"]);
    expect(p).toMatchObject({ status: "ok", orderNumber: null, orderNumberConfidence: 1 });
  });

  it("returns a failed prediction when the API errors", async () => {
    const { client } = fakeTypeSafe({ error: { message: "server error" } }, 500);
    const p = await runJev(ticket("where is my package"), client, cache);
    expect(p).toMatchObject({
      status: "failed",
      intent: null,
      intentConfidence: 0,
      model: "jev-1.13.0",
    });
    expect(p.error).not.toBeNull();
    expect(p.error!.length).toBeLessThanOrEqual(200);
  });

  it("fails the prediction when jev answers outside the intent options", async () => {
    const { client } = fakeTypeSafe({
      model: "jev-1.13.0",
      answers: { intent: intentAnswer("weather") },
      usage,
    });
    const p = await runJev(ticket("where is my package"), client, cache);
    expect(p).toMatchObject({ status: "failed" });
  });

  it("fails the prediction when the order-number answer is missing", async () => {
    const { client } = fakeTypeSafe({
      model: "jev-1.13.0",
      answers: { intent: intentAnswer("track_order") },
      usage,
    });
    const p = await runJev(ticket("where is order #482913"), client, cache);
    expect(p).toMatchObject({ status: "failed" });
  });

  it("serves a repeated ticket from the cache", async () => {
    const { client, calls } = fakeTypeSafe({
      model: "jev-1.13.0",
      answers: { intent: intentAnswer("track_order") },
      usage,
    });
    await runJev(ticket("where is my package"), client, cache);
    const second = await runJev(ticket("where is my package"), client, cache);
    expect(calls).toHaveLength(1);
    expect(second).toMatchObject({ status: "ok", cached: true });
  });
});
