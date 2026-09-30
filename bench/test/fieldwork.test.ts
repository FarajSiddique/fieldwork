import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  answer,
  FAKE_JEV_MODEL,
  fakeTextModel,
  fakeTypeSafe,
  type JevCall,
} from "fieldwork/testing";
import { describe, expect, it, vi } from "vitest";
import { ResponseCache } from "../src/cache.ts";
import { replayFetch, replayModel, type Fetch } from "../src/replay.ts";
import { runFieldwork, type FieldworkFactory } from "../src/systems/fieldwork.ts";

const ticket = { id: "wr-900", text: "Where is order #4471902? Invoice #12588 is already paid." };
const LOW = "anthropic/claude-haiku-4.5";
const HIGH = "anthropic/claude-sonnet-5.5";
const prices = {
  text: {
    [LOW]: { inputPerMTok: 1, outputPerMTok: 5 },
    [HIGH]: { inputPerMTok: 2, outputPerMTok: 10 },
  },
};

/** jev's answers by question id; `complexity` levels are simple, judgment, unusual. */
function jev(complexity: readonly number[]) {
  const answers: Record<string, unknown> = {
    intent: answer.choice({ track_order: 0.9, delivery_period: 0.08, get_refund: 0.02 }),
    complexity: answer.score(complexity),
    isRepeat: answer.noul(0.1),
    orderNumber: answer.choice({ "#4471902": 0.93, "#12588": 0.05, none: 0.02 }),
  };
  return (call: JevCall) => ({
    answers: Object.fromEntries(
      Object.keys(call.questions).map((id) => [id, answers[id] ?? answer.noul(0.9)]),
    ),
  });
}

const textModels = () => ({
  low: fakeTextModel("Your order has shipped.", LOW),
  high: fakeTextModel("Order #4471902: customer asks where it is.", HIGH),
});

const withClient =
  (typesafe: TypeSafeClient): FieldworkFactory =>
  () => ({
    typesafe,
    models: textModels(),
    prices,
    jevModel: "typesafe-ai/jev",
    deadlineMs: 5_000,
  });

describe("runFieldwork", () => {
  it("maps an answered ticket to a prediction", async () => {
    const { client } = fakeTypeSafe(jev([0.9, 0.08, 0.02]));

    const p = await runFieldwork(ticket, withClient(client));

    expect(p).toMatchObject({
      system: "fieldwork",
      ticketId: "wr-900",
      status: "ok",
      error: null,
      intent: "track_order",
      category: "order",
      orderNumber: "#4471902",
      isRepeat: false,
      escalates: false,
      reply: "Your order has shipped.",
      escalationNote: null,
      fieldErrors: [],
      model: FAKE_JEV_MODEL,
    });
    expect(p.categoryConfidence).toBeCloseTo(0.9);
    expect(p.complexity).toBeCloseTo(0.12);
    expect(p.estCostUsd).toBeGreaterThan(0);
    expect(p.inputTokens).toBeGreaterThan(0);
  });

  it("escalates a complex ticket with a note", async () => {
    const { client } = fakeTypeSafe(jev([0.05, 0.15, 0.8]));

    const p = await runFieldwork(ticket, withClient(client));

    expect(p).toMatchObject({
      status: "ok",
      escalates: true,
      reply: null,
      escalationNote: "Order #4471902: customer asks where it is.",
    });
  });

  it("fails the prediction when jev is down, and escalates", async () => {
    const { client } = fakeTypeSafe({ status: 503 });

    const p = await runFieldwork(ticket, withClient(client));

    expect(p).toMatchObject({ status: "failed", intent: null, escalates: true });
    expect(p.error).toContain("jev: HTTP 503");
    expect(p.fieldErrors).toContain("intent: jev_error");
  });

  it("keeps the prediction but lists a failed text field", async () => {
    const { client } = fakeTypeSafe(jev([0.9, 0.08, 0.02]));
    const factory: FieldworkFactory = () => ({
      ...withClient(client)({ replayed: 0, live: 0 }),
      models: { ...textModels(), low: fakeTextModel(new Error("provider down"), LOW) },
    });

    const p = await runFieldwork(ticket, factory);

    expect(p).toMatchObject({ status: "ok", intent: "track_order", reply: null, escalates: true });
    expect(p.fieldErrors).toEqual(["reply: text_error"]);
  });

  it("serves a second run entirely from the cache with the same fields", async () => {
    const cache = new ResponseCache(await mkdtemp(join(tmpdir(), "fieldwork-")));
    const answerFor = jev([0.9, 0.08, 0.02]);
    const send = vi.fn<Fetch>(async (_url, init) => {
      const call = JSON.parse(String(init?.body)) as JevCall;
      const body = {
        model: FAKE_JEV_MODEL,
        answers: answerFor(call).answers,
        usage: { input_tokens: 100, output_tokens: 0 },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const { low, high } = textModels();
    const factory: FieldworkFactory = (tally) => ({
      typesafe: new TypeSafeClient({
        apiKey: "test",
        logLevel: "off",
        retry: { maxRetries: 0 },
        fetch: replayFetch(cache, tally, { delay: false, fetch: send }),
      }),
      models: {
        low: replayModel(low, cache, tally, { delay: false }),
        high: replayModel(high, cache, tally, { delay: false }),
      },
      prices,
      jevModel: "typesafe-ai/jev",
      deadlineMs: 5_000,
    });

    const first = await runFieldwork(ticket, factory);
    const sent = send.mock.calls.length;
    const second = await runFieldwork(ticket, factory);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(send.mock.calls.length).toBe(sent);
    expect(low.doGenerateCalls).toHaveLength(1);
    expect({ ...second, ms: 0, cached: true }).toEqual({ ...first, ms: 0, cached: true });
  });
});
