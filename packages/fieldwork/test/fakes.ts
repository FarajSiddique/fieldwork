import { TypeSafeClient, type Question } from "@typesafe-ai/sdk";
import { MockLanguageModelV4 } from "ai/test";

/** The versioned jev id the fake reports unless a reply overrides it. */
export const FAKE_JEV_MODEL = "jev-1.13.0";

/** One request as the fake TypeSafe server received it. */
export interface JevCall {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}

/** What the fake server does with a request: answer it, fail with a status, or hang. */
export type JevReply =
  | { answers: Record<string, unknown>; model?: string; inputTokens?: number }
  | { status: number; body?: unknown }
  | { hangMs: number };

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A real `TypeSafeClient` whose `fetch` is scripted, so tests exercise the SDK's own parsing,
 * error classes and timeouts. Retries are off; `timeoutMs` is the SDK's per-attempt timeout.
 */
export function fakeTypeSafe(
  reply: JevReply | ((call: JevCall, index: number) => JevReply),
  options: { timeoutMs?: number } = {},
) {
  const calls: JevCall[] = [];
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const call = JSON.parse(String(init?.body)) as JevCall;
    calls.push(call);
    const r = typeof reply === "function" ? reply(call, calls.length - 1) : reply;
    if ("hangMs" in r) {
      await sleep(r.hangMs, init?.signal);
      return json({});
    }
    if ("status" in r) return json(r.body ?? { error: { message: "fake failure" } }, r.status);
    return json({
      model: r.model ?? FAKE_JEV_MODEL,
      answers: r.answers,
      usage: { input_tokens: r.inputTokens ?? 100, output_tokens: 0 },
    });
  };
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch,
    defaultModel: FAKE_JEV_MODEL,
    retry: { maxRetries: 0 },
    timeout: options.timeoutMs ?? 1_000,
    logLevel: "off",
  });
  return { client, calls };
}

/** Answer builders in the shape jev returns. */
export const answer = {
  /** The most probable label is the choice, and its probability is the confidence. */
  choice(probabilities: Record<string, number>) {
    const [choice, confidence] = Object.entries(probabilities).reduce((best, entry) =>
      entry[1] > best[1] ? entry : best,
    );
    return { type: "choice", choice, confidence, probabilities };
  },
  /** `probabilities[i]` is the probability of level `i`; the score is the expected level. */
  score(probabilities: readonly number[], confidence = Math.max(...probabilities)) {
    return {
      type: "score",
      score: probabilities.reduce((sum, p, level) => sum + p * level, 0),
      confidence,
      probabilities: Object.fromEntries(probabilities.map((p, level) => [String(level), p])),
    };
  },
  noul(probability: number) {
    return { type: "noul", noul: probability };
  },
};

/** What the fake text model does: reply with text, compute it from the prompt, or throw. */
export type TextReply = string | Error | ((prompt: string) => string);

/**
 * An AI SDK mock model. The function form receives the prompt's text parts joined with newlines.
 * `doGenerateCalls` on the returned model records every call.
 */
export function fakeTextModel(reply: TextReply, modelId = "fake-text") {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async (options) => {
      if (reply instanceof Error) throw reply;
      const prompt = options.prompt
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        .join("\n");
      const text = typeof reply === "function" ? reply(prompt) : reply;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: prompt.length,
            noCache: prompt.length,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: text.length, text: text.length, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}
