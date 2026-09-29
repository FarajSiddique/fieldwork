import {
  APITimeoutError,
  choice,
  InternalServerError,
  noul,
  RateLimitError,
  score,
} from "@typesafe-ai/sdk";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { answer, FAKE_JEV_MODEL, fakeTextModel, fakeTypeSafe } from "./fakes.ts";

const questions = {
  intent: choice("The primary intent", { track_order: null, get_refund: null }),
  complexity: score("How complex", ["simple", "judgment", "unusual"]),
  isRepeat: noul("Has this happened before?"),
};

describe("answer builders", () => {
  it("makes the most probable label the choice", () => {
    expect(answer.choice({ track_order: 0.2, get_refund: 0.8 })).toEqual({
      type: "choice",
      choice: "get_refund",
      confidence: 0.8,
      probabilities: { track_order: 0.2, get_refund: 0.8 },
    });
  });

  it("makes the score the expected level, which can fall between levels", () => {
    const a = answer.score([0.1, 0.1, 0.8]);
    expect(a.score).toBeCloseTo(1.7);
    expect(a).toMatchObject({ confidence: 0.8, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } });
    expect(answer.score([0.5, 0.5], 0.3).confidence).toBe(0.3);
  });
});

describe("fakeTypeSafe", () => {
  it("answers through the real SDK and records what was sent", async () => {
    const { client, calls } = fakeTypeSafe({
      answers: {
        intent: answer.choice({ track_order: 0.9, get_refund: 0.1 }),
        complexity: answer.score([0.7, 0.2, 0.1]),
        isRepeat: answer.noul(0.05),
      },
      inputTokens: 321,
    });

    const result = await client.systemOne({ state: { ticket: "where is #12345" }, questions });

    expect(result.model).toBe(FAKE_JEV_MODEL);
    expect(result.usage).toEqual({ input_tokens: 321, output_tokens: 0 });
    expect(result.answers.intent.choice).toBe("track_order");
    expect(result.answers.isRepeat.noul).toBe(0.05);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: FAKE_JEV_MODEL, state: { ticket: "where is #12345" } });
    expect(Object.keys(calls[0]!.questions)).toEqual(["intent", "complexity", "isRepeat"]);
  });

  it("reports the model a reply names", async () => {
    const { client } = fakeTypeSafe({ answers: { isRepeat: answer.noul(1) }, model: "jev-1.14.0" });
    const result = await client.systemOne({
      state: "x",
      questions: { isRepeat: questions.isRepeat },
    });
    expect(result.model).toBe("jev-1.14.0");
  });

  it("scripts a reply per call from the request and its index", async () => {
    const { client } = fakeTypeSafe((call, index) => ({
      answers: { isRepeat: answer.noul(index / 10) },
      model: `jev-${String(call.state)}`,
    }));
    const ask = (state: string) =>
      client.systemOne({ state, questions: { isRepeat: questions.isRepeat } });
    expect((await ask("a")).answers.isRepeat.noul).toBe(0);
    const second = await ask("b");
    expect(second.answers.isRepeat.noul).toBe(0.1);
    expect(second.model).toBe("jev-b");
  });

  it("surfaces an error status as the SDK's error class", async () => {
    const failing = (status: number) =>
      fakeTypeSafe({ status }).client.systemOne({ state: "x", questions });
    await expect(failing(500)).rejects.toBeInstanceOf(InternalServerError);
    await expect(failing(429)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("times out a hung request with the SDK's timeout error", async () => {
    const { client } = fakeTypeSafe({ hangMs: 5_000 }, { timeoutMs: 20 });
    await expect(client.systemOne({ state: "x", questions })).rejects.toBeInstanceOf(
      APITimeoutError,
    );
  });
});

describe("fakeTextModel", () => {
  it("returns its text through generateText", async () => {
    const model = fakeTextModel("Your order ships tomorrow.");
    const { text } = await generateText({ model, prompt: "Reply to the customer" });
    expect(text).toBe("Your order ships tomorrow.");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("passes the prompt text to a reply function", async () => {
    const model = fakeTextModel((prompt) => `echo: ${prompt}`);
    const { text } = await generateText({ model, prompt: "hello" });
    expect(text).toBe("echo: hello");
  });

  it("rejects with the reply's error", async () => {
    const model = fakeTextModel(new Error("provider down"));
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow(
      "provider down",
    );
  });
});
