import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import { fakeTextModel } from "fieldwork/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCache } from "../src/cache.ts";
import {
  replayFetch,
  replayModel,
  sleep,
  type Fetch,
  type Model,
  type Tally,
} from "../src/replay.ts";

const SYSTEM_ONE = "https://ai-gateway.vercel.sh/typesafe/v1/system-one";
const body = { model: "typesafe-ai/jev", state: { ticket: "where is #4471902" }, questions: {} };
const post = (): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const ok = () =>
  new Response(
    JSON.stringify({ model: "jev-1", answers: {}, usage: { input_tokens: 9, output_tokens: 0 } }),
    { status: 200 },
  );
const slowOk =
  (ms: number): Fetch =>
  async () => {
    await sleep(ms);
    return ok();
  };

let dir: string;
let cache: ResponseCache;
let tally: Tally;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-"));
  cache = new ResponseCache(dir);
  tally = { replayed: 0, live: 0 };
});

describe("replayFetch", () => {
  it("sends a miss live with TypeSafe-only routing, then replays it", async () => {
    const send = vi.fn<Fetch>(async () => ok());
    const f = replayFetch(cache, tally, { delay: false, fetch: send });

    const first = await f(SYSTEM_ONE, post());
    const second = await f(SYSTEM_ONE, post());

    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({
      ...body,
      providerOptions: { gateway: { only: ["typesafe-ai"] } },
    });
    expect(await second.json()).toEqual(await first.json());
    expect(tally).toEqual({ replayed: 1, live: 1 });
  });

  it("passes a 429 through uncached, so the next call goes live", async () => {
    const send = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(ok());
    const f = replayFetch(cache, tally, { delay: false, fetch: send });

    expect((await f(SYSTEM_ONE, post())).status).toBe(429);
    expect((await f(SYSTEM_ONE, post())).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("waits the original latency on a hit", async () => {
    await replayFetch(cache, tally, { delay: false, fetch: slowOk(60) })(SYSTEM_ONE, post());
    const replay = replayFetch(cache, tally, { delay: true, fetch: vi.fn<Fetch>() });

    const started = performance.now();
    await replay(SYSTEM_ONE, post());

    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("stops waiting when the signal aborts", async () => {
    await replayFetch(cache, tally, { delay: false, fetch: slowOk(300) })(SYSTEM_ONE, post());
    const replay = replayFetch(cache, tally, { delay: true, fetch: vi.fn<Fetch>() });

    const started = performance.now();
    await expect(
      replay(SYSTEM_ONE, { ...post(), signal: AbortSignal.timeout(20) }),
    ).rejects.toThrow();

    expect(performance.now() - started).toBeLessThan(200);
  });

  it("in a dry run, records a miss and answers 400 without sending", async () => {
    const offline = new ResponseCache(dir, { offline: true });
    const send = vi.fn<Fetch>(async () => ok());

    const response = await replayFetch(offline, tally, { delay: false, fetch: send })(
      SYSTEM_ONE,
      post(),
    );

    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect([...offline.missed.values()]).toEqual([
      expect.objectContaining({ system: "fieldwork-jev", model: "typesafe-ai/jev" }),
    ]);
  });
});

describe("replayModel", () => {
  const ask = (model: Model, prompt = "Where is my order?") => generateText({ model, prompt });

  it("serves a repeated generation from the cache with the same text and usage", async () => {
    const inner = fakeTextModel("It has shipped.", "fake-low");
    const model = replayModel(inner, cache, tally, { delay: false });

    const first = await ask(model);
    const second = await ask(model);

    expect(inner.doGenerateCalls).toHaveLength(1);
    expect(second.text).toBe(first.text);
    expect(second.usage.inputTokens).toBe(first.usage.inputTokens);
    expect(model.modelId).toBe("fake-low");
    expect(tally).toEqual({ replayed: 1, live: 1 });
  });

  it("sends a different prompt live", async () => {
    const inner = fakeTextModel((prompt) => `echo ${prompt.length}`);
    const model = replayModel(inner, cache, tally, { delay: false });

    await ask(model, "one");
    await ask(model, "two");

    expect(inner.doGenerateCalls).toHaveLength(2);
  });

  it("does not cache a generation that throws", async () => {
    const failing = replayModel(fakeTextModel(new Error("provider down")), cache, tally, {
      delay: false,
    });
    await expect(ask(failing)).rejects.toThrow();

    const working = fakeTextModel("It has shipped.");
    await ask(replayModel(working, cache, tally, { delay: false }));

    expect(working.doGenerateCalls).toHaveLength(1);
  });

  it("in a dry run, records a miss and throws without generating", async () => {
    const offline = new ResponseCache(dir, { offline: true });
    const inner = fakeTextModel("It has shipped.");

    await expect(ask(replayModel(inner, offline, tally, { delay: false }))).rejects.toThrow(
      "not in the cache (dry run)",
    );

    expect(inner.doGenerateCalls).toHaveLength(0);
    expect(offline.missed.size).toBe(1);
  });
});
