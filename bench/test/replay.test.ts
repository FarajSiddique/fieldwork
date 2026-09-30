import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError, generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { fakeTextModel } from "fieldwork/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResponseCache } from "../src/cache.ts";
import { buildJevRequest } from "../src/systems/jev.ts";
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

  it("retries 429s with backoff, honours Retry-After, and caches the success once", async () => {
    const send = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(ok());
    const waits: number[] = [];
    const backoff = {
      retries: 4,
      baseMs: 100,
      maxMs: 1000,
      random: () => 0.5,
      sleep: async (ms: number) => void waits.push(ms),
    };
    const f = replayFetch(cache, tally, { delay: false, fetch: send, backoff });

    expect((await f(SYSTEM_ONE, post())).status).toBe(200);
    expect((await f(SYSTEM_ONE, post())).status).toBe(200);

    expect(send).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 100]);
    expect(tally).toEqual({ replayed: 1, live: 1 });
  });

  it("times only the successful attempt", async () => {
    const send = vi
      .fn<Fetch>()
      .mockImplementationOnce(async () => {
        await sleep(150);
        return new Response("{}", { status: 429 });
      })
      .mockResolvedValueOnce(ok());
    const backoff = { retries: 2, baseMs: 1, maxMs: 1, sleep: async () => {} };

    await replayFetch(cache, tally, { delay: false, fetch: send, backoff })(SYSTEM_ONE, post());
    const replay = replayFetch(cache, tally, { delay: true, fetch: vi.fn<Fetch>() });
    const started = performance.now();
    await replay(SYSTEM_ONE, post());

    expect(performance.now() - started).toBeLessThan(100);
  });

  it("returns the last failure uncached after the retries run out", async () => {
    const send = vi.fn<Fetch>(async () => new Response("{}", { status: 429 }));
    const backoff = { retries: 2, baseMs: 1, maxMs: 1, sleep: async () => {} };
    const f = replayFetch(cache, tally, { delay: false, fetch: send, backoff });

    expect((await f(SYSTEM_ONE, post())).status).toBe(429);
    expect((await f(SYSTEM_ONE, post())).status).toBe(429);

    expect(send).toHaveBeenCalledTimes(6);
    expect(tally).toEqual({ replayed: 0, live: 2 });
  });

  it("does not retry a 400", async () => {
    const send = vi.fn<Fetch>(async () => new Response("{}", { status: 400 }));
    const backoff = { retries: 2, baseMs: 1, maxMs: 1, sleep: async () => {} };

    await replayFetch(cache, tally, { delay: false, fetch: send, backoff })(SYSTEM_ONE, post());

    expect(send).toHaveBeenCalledTimes(1);
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

describe("replayFetch through a real TypeSafeClient", () => {
  // The SDK's per-request timeout wraps the whole call, including replayFetch's backoff waits.
  const call = (timeout: number, send: Fetch, replay = {}) => {
    const backoff = { retries: 3, baseMs: 60, maxMs: 60, random: () => 1 };
    const client = new TypeSafeClient({
      apiKey: "test",
      retry: { maxRetries: 0 },
      logLevel: "off",
      timeout,
      fetch: replayFetch(cache, tally, { delay: false, fetch: send, backoff, ...replay }),
    });
    return client.systemOne(buildJevRequest("where is #4471902").request);
  };
  const flakyGateway = () =>
    vi
      .fn<Fetch>()
      .mockImplementationOnce(async () => new Response("{}", { status: 429 }))
      .mockImplementationOnce(async () => new Response("{}", { status: 429 }))
      .mockImplementation(async () => ok());

  it("rides out waits longer than a small SDK timeout when the client's timeout covers them", async () => {
    const send = flakyGateway();

    await expect(call(5000, send)).resolves.toBeDefined();

    expect(send).toHaveBeenCalledTimes(3);
  });

  it("would time out inside the SDK's window if the client's timeout were small", async () => {
    await expect(call(100, flakyGateway())).rejects.toThrow(/timed out/i);
  });

  it("retries an attempt that outlives its own timeout", async () => {
    const hang: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason));
      });
    const send = vi
      .fn<Fetch>()
      .mockImplementationOnce(hang)
      .mockImplementation(async () => ok());

    await expect(call(5000, send, { attemptTimeoutMs: 30 })).resolves.toBeDefined();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the caller aborts", async () => {
    const send = flakyGateway();
    const controller = new AbortController();
    controller.abort(new Error("deadline"));

    const f = replayFetch(cache, tally, {
      delay: false,
      fetch: send,
      backoff: { retries: 3, baseMs: 1, maxMs: 1 },
    });

    await expect(f(SYSTEM_ONE, { ...post(), signal: controller.signal })).rejects.toThrow();
    expect(send.mock.calls.length).toBeLessThanOrEqual(1);
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

  const slowModel = (ms: number) =>
    new MockLanguageModelV4({
      modelId: "slow",
      doGenerate: async () => {
        await sleep(ms);
        return {
          content: [{ type: "text", text: "It has shipped." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 15, text: 15, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });

  it("waits the original latency on a hit", async () => {
    await ask(replayModel(slowModel(60), cache, tally, { delay: false }));
    const inner = fakeTextModel("unused", "slow");
    const replay = replayModel(inner, cache, tally, { delay: true });

    const started = performance.now();
    await ask(replay);

    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    expect(inner.doGenerateCalls).toHaveLength(0);
  });

  it("stops waiting when the signal aborts", async () => {
    await ask(replayModel(slowModel(300), cache, tally, { delay: false }));
    const replay = replayModel(fakeTextModel("unused", "slow"), cache, tally, { delay: true });

    const started = performance.now();
    await expect(
      generateText({
        model: replay,
        prompt: "Where is my order?",
        abortSignal: AbortSignal.timeout(20),
        maxRetries: 0,
      }),
    ).rejects.toThrow();

    expect(performance.now() - started).toBeLessThan(200);
  });

  const rateLimit = () =>
    new APICallError({
      message: "No access to this model at this time.",
      url: "u",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
      responseHeaders: { "retry-after": "1" },
    });
  const flaky = (failures: Error[]) => {
    const queue = [...failures];
    return new MockLanguageModelV4({
      modelId: "flaky",
      doGenerate: async () => {
        const err = queue.shift();
        if (err) throw err;
        return {
          content: [{ type: "text", text: "It has shipped." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 15, text: 15, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
  };
  const generate = (model: Model) =>
    generateText({ model, prompt: "Where is my order?", maxRetries: 0 });

  it("retries a retryable error with backoff, then caches the success once", async () => {
    const inner = flaky([rateLimit(), rateLimit()]);
    const waits: number[] = [];
    const backoff = {
      retries: 3,
      baseMs: 100,
      maxMs: 1000,
      random: () => 0,
      sleep: async (ms: number) => void waits.push(ms),
    };
    const model = replayModel(inner, cache, tally, { delay: false, backoff });

    const first = await generate(model);
    const second = await generate(model);

    expect(first.text).toBe("It has shipped.");
    expect(second.text).toBe(first.text);
    expect(inner.doGenerateCalls).toHaveLength(3);
    expect(waits).toEqual([1000, 1000]);
    expect(tally).toEqual({ replayed: 1, live: 1 });
  });

  it("does not retry a non-retryable error", async () => {
    const inner = flaky([new Error("schema mismatch")]);
    const backoff = { retries: 3, baseMs: 1, maxMs: 1, sleep: async () => {} };

    await expect(
      generate(replayModel(inner, cache, tally, { delay: false, backoff })),
    ).rejects.toThrow("schema mismatch");

    expect(inner.doGenerateCalls).toHaveLength(1);
  });

  it("throws the last retryable error once the retries run out", async () => {
    const inner = flaky([rateLimit(), rateLimit(), rateLimit()]);
    const backoff = { retries: 1, baseMs: 1, maxMs: 1, sleep: async () => {} };

    await expect(
      generate(replayModel(inner, cache, tally, { delay: false, backoff })),
    ).rejects.toThrow("No access to this model");

    expect(inner.doGenerateCalls).toHaveLength(2);
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
