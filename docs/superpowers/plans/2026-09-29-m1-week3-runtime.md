# M1 Week 3: Resolvers, Grading, Run and Trace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Fieldwork schema run: resolve judgments, picks, tools and text step by step, grade generated text, enforce timeouts and the deadline, and return typed results with a cost trace. Then prove it end to end with the spec's triage example and a live contract test.

**Architecture:** Each resolver is a function that never throws: it returns field results plus a `CallTrace`, and turns every failure into a `FieldError` without provider or tool payloads. `run.ts` plans the steps, evaluates `when`, and sends each step's judgments and picks as **one** `systemOne` request while tools and text run beside it. Grading is one more `systemOne` request after the last step. Time limits are `AbortSignal`s passed to the TypeSafe SDK and the AI SDK. A race (`settle`) makes sure even a tool that ignores the signal can't overrun its limit. `Builder.run(input, options)` wraps `run` with the schema's types. The triage example lives in `bench/`, where week 4 benchmarks it.

**Tech Stack:** Node 24 type stripping, pnpm 10 workspace, TypeScript 6 strict, Vitest 5, `@typesafe-ai/sdk` 0.6 (`systemOne`, `APIError`/`RateLimitError`/`APITimeoutError`, per-call `signal`), `ai` 7 (`generateText` with `system`, `prompt`, `abortSignal`), ESLint 10, Prettier 3.

**Spec:** `docs/superpowers/specs/2026-09-27-fieldwork-mvp-design.md` (week 3 of "Build order": `resolvers`, `grade`, `run`, `trace`; live contract test; the triage example). This plan builds on week 2's `Builder.fields`, `plan` and the test fakes (`packages/fieldwork/test/fakes.ts`). The M0 pilot's GO is still provisional (`bench/results/pilot-finding.md`); nothing in this plan depends on jev's confidence values.

## Global Constraints

- Node 24, pnpm, strict TypeScript. Runtime dependencies: `@typesafe-ai/sdk` and `ai` (AI SDK), both as peer dependencies.
- Judgment questions are TypeSafe's own `choice()`, `score()` and `noul()` helpers, passed through unchanged. Question ids are the field names.
- Running a step: evaluate `when` for each field (false → `skipped`); all remaining `judge` and `pick` fields go into **one** `systemOne` request whose `state` holds the inputs plus the results of every `after` field those questions list, as named JSON fields; text and tool fields run in parallel with that request; the step finishes when all its fields have settled.
- A missing answer, or a choice outside the question's options, marks only that field `failed`.
- Picks: code finds candidate values, a jev Choice selects one; Fieldwork adds a `none` option; `value` is a candidate string or `null` for none. No model generates arguments.
- Text: the prompt is built from `instructions` and `style`, with the inputs and `after` results given as clearly labeled data blocks. No JSON format instructions are ever sent to a text worker. `reasoning` selects from `models`; `model` overrides the tier; neither means `medium`.
- Grading: after the last step, one `systemOne` request covers every filled text field with `grade: true`: two Nouls per field ("supported by the provided context and inputs", and "meets the style" only when there is a `style`). Score = product of the two `noul` values, always `heuristic: true`. Grading failure → field stays filled with `score: null`.
- Gates: Choice, Score and pick pass when `confidence >= gate`, or always when they have no gate. Noul: `yes` is set only when `noul >= yesAbove` or `noul <= 1 - yesAbove`; otherwise `passed` is false. Tool: always `passed: true`. Text: `score >= minScore` when set.
- Error table: `systemOne` errors or times out → every judgment and pick in that request `failed`; text generation fails → that field `failed`; grading fails → text stays `filled`, `score: null`; tool throws → `failed` with the error message only; `deadlineMs` reached → unsettled fields `failed` with `timeout`, and the run returns what it has.
- A failed field never fails the run. A `when` or `call` function that throws marks only its own field `failed`. `error` is a short code and message, never a raw provider or tool payload.
- Fieldwork does not add its own retries on top of the TypeSafe SDK's retry policy or the AI SDK's `maxRetries`. Logs never include inputs, generated text, or provider response bodies.
- Trace: each step records its fields and calls; each call records worker, model (for jev, the id from the response's `model` field), latency, and input and output tokens. Cost is an estimate from a price table: jev defaults to $0.042 per million input tokens with free output; text-model prices must be supplied by the user.
- jev limits: `state` plus the longest question must fit in 32k tokens, and each request in 64k. Fieldwork checks request size before sending and fails the step's judgments with `state_too_large` rather than sending. Keep state small: only inputs and listed `after` results go into a request.
- Testing: runtime tests with a fake `fetch` passed to `TypeSafeClient` and the AI SDK's mock language model, one per row of the error table plus the triage example end to end; a contract test against real jev and one real text model, run only when `FIELDWORK_LIVE=1`. Vitest, strict TypeScript, ESLint and Prettier.

## Review Focus

These are the inputs a person using Fieldwork is most likely to hit that the spec implies but does not spell out. Each has a test in the task that owns the code.

1. **A dependency that failed or was skipped, read by a later field's `when`.** A reasonable person expects the fallback branch to run. The example is "escalate when complexity failed". A throw or a silent skip is wrong. Tests: Task 5, "fails every judgment and pick in a failed request; dependents see passed false"; Task 6, "escalates when jev is down, so no ticket is answered blind".
2. **Work that never settles.** Examples are a hung tool, a stalled jev request or a slow model. The run returns at the field's `timeoutMs` or the run's `deadlineMs`, the rest of the step still finishes, and no timer keeps the process alive afterwards. Tests: Task 1, "leaves no timer behind after release"; Task 5, "returns what it has when the deadline passes…", "fails a tool at its own timeoutMs…", "leaves no timers running after it returns".
3. **Provider and tool errors that carry customer text.** Examples are a 500 whose body echoes the ticket, or an AI SDK error quoting the provider. None of it reaches a `FieldError`. Tests: Task 1, "reports a jev HTTP error by status, never by body" and "reports a text failure by class and status, never by message"; Task 2, "fails every field in the request when jev errors, without the response body"; Task 3, "fails when generation throws, without the provider's message".
4. **Pick candidates as regexes really return them:**
   - duplicates and empty strings are dropped, keeping first-seen order;
   - a candidate spelled `none` makes the none option get a new label;
   - no candidates at all means "none" without a request;
   - a `candidates` function that throws fails only that pick.

   Tests: Task 2, "keeps candidates in first-seen order…", "renames none when a candidate is spelled none", "answers none without asking when there are no candidates", "fails a pick whose candidates function throws or returns a non-list".
5. **A field named like an input key** (for example a field called `ticket` when the input has `ticket`). One would overwrite the other in jev state and text prompts, so it is rejected by the types and again at run start for untyped callers. Tests: Task 5, "rejects a name used by an input" (type test) and "rejects a field named like an input, for untyped callers".

## Rulings on points the spec leaves open

**Picks and jev state**

- **Pick question:** the pick's `instructions` are sent unchanged as the Choice's instructions. The pilot's wording ("Which of these is …?") therefore stays with the caller: the triage example passes it.
  - The `none` option is labeled `none`, described as "None of these candidates fits", and placed after the candidates. If a candidate is spelled `none`, the label gains leading underscores until it is unique.
  - Candidates are cleaned before asking: repeats and empty strings are dropped, keeping first-seen order. Anything but an array of strings fails the pick with `candidates_error`.
- **A pick with no candidates** is filled with `value: null`, `confidence: 1`, `model: null`, `ms: 0`, and no question is asked. This matches the pilot, where no candidates meant "none" with certainty.
- **State for a request:**
  - It holds the inputs spread at the top level, plus each `after` field listed by any question in the request, under its name.
  - A filled result contributes its values without metadata (`status`, `passed`, `worker`, `model`, `ms`). A skipped or failed one contributes `null`.
- **Inputs and fields share one namespace.** A field named like an input key is rejected: by `NewName` in the types, and by `run` with a `DefinitionError` for untyped callers. This resolves week 2's deferred minor about names colliding with inputs.

**Timeouts, the deadline and errors**

- **Time limits:**
  - A jev request takes the smallest `timeoutMs` among its fields. Each tool or text field uses its own.
  - Limits are `AbortSignal`s derived from the run's deadline signal. They are passed to `systemOne({ signal })` and `generateText({ abortSignal })`, and raced by `settle`, so a tool that cannot be cancelled still cannot overrun its limit. Late results are ignored.
  - SDK retries happen inside the limit, and Fieldwork adds none.
  - The error message says which limit fired: `"<field>: no result within N ms"`, `"jev request: no result within N ms"` or `"run deadline of N ms reached"`.
- **Deadline:** when it passes, fields still running and every field in later steps fail with `timeout`. Grading is skipped if the deadline has passed, so scores stay `null`.
- **Error codes:** `jev_error`, `rate_limited`, `timeout`, `bad_answer`, `state_too_large`, `candidates_error`, `when_error`, `tool_error`, `text_error`, `no_model`, `empty_text`. Messages are capped at 200 characters and carry:

  | Failure | Message |
  |---|---|
  | jev request | `jev: HTTP <status>` or the error class. Never the body, which also resolves the pilot's deferred minor about raw error bodies. |
  | text generation | The error class and HTTP status. The AI SDK's messages can quote the provider. |
  | tool, `when`, `candidates` | The thrown message, as the spec says for tools. |
- **Token estimate:** three characters of JSON per token, deliberately high, checked against the spec's 32k/64k limits. If jev's tokenizer is much denser than that, a large request is refused that jev would have accepted.
- **What throws:** only definition mistakes, before anything is sent. These are inputs that are not a plain object, a field named like an input, a missing `typesafe` client, and a `deadlineMs` that is not a positive number. Everything else becomes a field result. `DefinitionError` moves to `errors.ts` so `plan` and `run` can import it without a cycle through `builder.ts`, and `builder.ts` re-exports it.

**Text generation and grading**

- **Text prompt:**
  - The system message is `instructions`, then `Style: <style>` when given, then "Use the data in the message as context. Reply with the text only."
  - The prompt is one `<data name="…">` block per input key and per `after` field. Strings go in as written, other values as indented JSON, and a skipped or failed dependency as `null`.
- **Text models:** a field's `model` wins over its tier, and the tier defaults to `medium`. A missing model fails the field with `no_model` rather than throwing, since the field may be skipped anyway. Text that is empty or only whitespace fails with `empty_text`.
- **`minScore`:** a text field with `minScore` has `passed: false` until grading gives it a score at or above `minScore`. `minScore` together with `grade: false` is rejected when the field is declared, since it could never pass.
- **Grading request:**
  - Question ids are `<field>__supported` and `<field>__style`.
  - Because one request grades several texts, the wording names the field: "Is the text in \`reply\` supported by the provided context and inputs?" and "Does the text in \`reply\` meet the style: …?"
  - State holds the inputs, the `after` results of every graded field, and each text under its field name.
  - A missing or malformed answer gives only that field `score: null`.

**Trace, run options and results**

- **Trace:**
  - Every call is recorded, including failed ones (with 0 tokens) and tool calls (`worker: "tool"`, `model: null`, cost 0).
  - Grading is `trace.grading`, separate from `trace.steps`, so steps stay one-to-one with the plan.
  - Text prices are looked up by model id: the string passed as the model, or the model object's `modelId`. `trace.estCostUsd` is `null` when any call has no price, rather than a total that silently leaves some calls out.
  - jev is always priced at `JEV_PRICE` unless `prices.jev` overrides it, because through AI Gateway jev reports the unversioned `typesafe-ai/jev`.
- **jev model:** `RunOptions.jevModel` is sent as each request's `model`; omitted, the client's `defaultModel` applies. The spec asks for a pinned, versioned id, but AI Gateway lists no versioned jev id (pilot finding). The option exists so a caller with a direct TypeSafe key can pin one.
- **Results come back in declaration order**, whatever order the fields settled in.

**The triage example and the live test**

- **Where the triage example lives:** `bench/src/triage.ts`, because week 4 benchmarks this schema as System 1. It uses the pilot's wording constants (`INTENT_INSTRUCTIONS`, `ORDER_NUMBER_TARGET`) rather than the spec example's literal strings, because the spec requires the same instruction wording across all systems.
  - `bench` gains a `fieldwork: workspace:*` dependency.
  - The fakes are exported as `fieldwork/testing` (`./test/fakes.ts`). The package is private, so this is revisited when it is published.
  - `orders.lookup` is a stub: every order exists and has shipped.
  - `category`'s `call` checks `f.intent.passed` again, as week 2's ruling said it must.
- **Live contract test:**
  - It goes through Vercel AI Gateway, the only access this project has, with jev `typesafe-ai/jev` and text model `anthropic/claude-haiku-4.5` (the pilot's baseline). Both can be overridden by environment variables.
  - It reads `AI_GATEWAY_API_KEY` from the environment or from `bench/.env`, and it is skipped unless `FIELDWORK_LIVE=1`.
  - It checks shapes, not answer quality. If AI Gateway still answers jev with 429 (see the pilot finding), the run is recorded as blocked and does not block the plan.

**Out of scope here (week 4 and later):** the benchmark runner and report for Fieldwork, the labeling guide and the rest of the written set, latency percentiles, and validating question ids against TypeSafe's rules. Also left for later, from week 2's deferred minors: `FieldView` carrying `reason`/`error`, and readonly `ScoreValue.probabilities`.

---

### Task 1: Runtime foundations: errors, time limits, trace and state

**Files:**
- Create: `packages/fieldwork/src/errors.ts`, `packages/fieldwork/src/time.ts`, `packages/fieldwork/src/trace.ts`, `packages/fieldwork/src/state.ts`
- Modify: `packages/fieldwork/src/builder.ts` (move `DefinitionError` out), `packages/fieldwork/src/plan.ts` (import it from `errors.ts`), `packages/fieldwork/src/types.ts` (add `AnyResult`)
- Test: `packages/fieldwork/test/runtime.test.ts`

**Interfaces:**
- Consumes: `FieldError`, `FieldResult`, `Worker` from `src/types.ts`; `APIError`, `RateLimitError`, `APITimeoutError` from `@typesafe-ai/sdk`.
- Produces:
  - `errors.ts`:
    - `class DefinitionError extends Error` and `class TimeoutReached extends Error`
    - `fieldError(code: string, message: string): FieldError`
    - `jevError(err: unknown): FieldError`, `textError(err: unknown): FieldError`, `thrownError(code: string, err: unknown): FieldError`
  - `time.ts`:
    - `interface Limit { signal: AbortSignal; release(): void }`
    - `limit(parent: AbortSignal | undefined, ms: number | undefined, message: string): Limit`
    - `settle<T>(work: Promise<T>, signal: AbortSignal): Promise<T>`
    - `since(start: number): number`
  - `trace.ts`:
    - `Price`, `Prices { jev?: Price; text?: Record<string, Price> }`, `JEV_PRICE`
    - `CallTrace { worker; model: string | null; fields: string[]; status: "ok" | "failed"; ms; inputTokens; outputTokens; estCostUsd: number | null }`
    - `StepTrace { fields: string[]; calls: CallTrace[] }`
    - `Trace { steps: StepTrace[]; grading: StepTrace | null; totalMs; estCostUsd: number | null }`
    - `callTrace(call: Omit<CallTrace, "estCostUsd">, prices?: Prices): CallTrace`, `totalCost(calls): number | null`
  - `state.ts`:
    - `stateValue(result: AnyResult): Record<string, unknown> | null`
    - `buildState(input: object, results: Readonly<Record<string, AnyResult>>, names: Iterable<string>): Record<string, unknown>`
    - `estimateTokens(value: unknown): number`, `tooLarge(state: unknown, questions: Readonly<Record<string, unknown>>): boolean`, `STATE_LIMIT_TOKENS`, `REQUEST_LIMIT_TOKENS`
  - `types.ts`: `type AnyResult = FieldResult<Record<string, unknown>>`

- [ ] **Step 1: Write the failing tests**

`packages/fieldwork/test/runtime.test.ts`:

```ts
import { APIError, APITimeoutError, RateLimitError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldError, jevError, textError, thrownError, TimeoutReached } from "../src/errors.ts";
import { buildState, estimateTokens, stateValue, tooLarge } from "../src/state.ts";
import { limit, settle } from "../src/time.ts";
import { callTrace, JEV_PRICE, totalCost } from "../src/trace.ts";
import type { AnyResult } from "../src/types.ts";

const call = {
  model: "m",
  fields: ["a"],
  status: "ok" as const,
  ms: 5,
  inputTokens: 1_000_000,
  outputTokens: 2_000_000,
};

function timers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

describe("field errors", () => {
  it("cuts messages to 200 characters", () => {
    expect(fieldError("x", "a".repeat(500)).message).toHaveLength(200);
    expect(fieldError("x", "short")).toEqual({ code: "x", message: "short" });
  });

  it("reports a jev HTTP error by status, never by body", () => {
    const body = { error: { message: "secret customer text" } };
    const err = new APIError(500, body, new Headers());
    expect(jevError(err)).toEqual({ code: "jev_error", message: "jev: HTTP 500" });
    expect(JSON.stringify(jevError(err))).not.toContain("secret");
  });

  it("names rate limits and timeouts", () => {
    expect(jevError(new RateLimitError(429, {}, new Headers())).code).toBe("rate_limited");
    expect(jevError(new APITimeoutError(50))).toEqual({
      code: "timeout",
      message: "jev: no response within 50 ms",
    });
    expect(jevError(new TimeoutReached("run deadline of 10 ms reached"))).toEqual({
      code: "timeout",
      message: "run deadline of 10 ms reached",
    });
  });

  it("reports a text failure by class and status, never by message", () => {
    const err = Object.assign(new Error("provider said: secret"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    expect(textError(err)).toEqual({ code: "text_error", message: "AI_APICallError: HTTP 503" });
  });

  it("keeps a thrown function's message only", () => {
    expect(thrownError("tool_error", new Error("no such order"))).toEqual({
      code: "tool_error",
      message: "no such order",
    });
    expect(thrownError("tool_error", "plain string")).toEqual({
      code: "tool_error",
      message: "plain string",
    });
  });
});

describe("limit and settle", () => {
  it("rejects with a TimeoutReached once the time limit passes", async () => {
    const l = limit(undefined, 10, "slow: no result within 10 ms");
    const never = new Promise<string>(() => {});
    await expect(settle(never, l.signal)).rejects.toThrow("slow: no result within 10 ms");
    l.release();
  });

  it("follows the parent's abort and its reason", async () => {
    const parent = new AbortController();
    const l = limit(parent.signal, undefined, "unused");
    const pending = settle(new Promise(() => {}), l.signal);
    parent.abort(new TimeoutReached("run deadline of 5 ms reached"));
    await expect(pending).rejects.toThrow("run deadline of 5 ms reached");
    l.release();
  });

  it("starts aborted when the parent already is", () => {
    const parent = new AbortController();
    parent.abort(new TimeoutReached("done"));
    expect(limit(parent.signal, 1_000, "x").signal.aborted).toBe(true);
  });

  it("passes work through when it finishes in time", async () => {
    const l = limit(undefined, 1_000, "x");
    await expect(settle(Promise.resolve(7), l.signal)).resolves.toBe(7);
    await expect(settle(Promise.reject(new Error("boom")), l.signal)).rejects.toThrow("boom");
    l.release();
  });

  it("leaves no timer behind after release", () => {
    const before = timers();
    const l = limit(undefined, 60_000, "x");
    expect(timers()).toBe(before + 1);
    l.release();
    expect(timers()).toBe(before);
  });
});

describe("trace costs", () => {
  it("prices jev at TypeSafe's list price unless told otherwise", () => {
    expect(JEV_PRICE).toEqual({ inputPerMTok: 0.042, outputPerMTok: 0 });
    expect(callTrace({ ...call, worker: "jev" }).estCostUsd).toBeCloseTo(0.042);
    const custom = callTrace(
      { ...call, worker: "jev" },
      { jev: { inputPerMTok: 1, outputPerMTok: 1 } },
    );
    expect(custom.estCostUsd).toBeCloseTo(3);
  });

  it("prices text only from the table, by model id", () => {
    const prices = { text: { m: { inputPerMTok: 1, outputPerMTok: 5 } } };
    expect(callTrace({ ...call, worker: "text" }, prices).estCostUsd).toBeCloseTo(11);
    expect(callTrace({ ...call, worker: "text", model: "other" }, prices).estCostUsd).toBeNull();
    expect(callTrace({ ...call, worker: "text", model: "toString" }, prices).estCostUsd).toBeNull();
  });

  it("makes tool calls free", () => {
    expect(callTrace({ ...call, worker: "tool", model: null }).estCostUsd).toBe(0);
  });

  it("totals costs, or null when any call has no price", () => {
    const a = callTrace({ ...call, worker: "jev" });
    const b = callTrace({ ...call, worker: "text" });
    expect(totalCost([a, a])).toBeCloseTo(0.084);
    expect(totalCost([a, b])).toBeNull();
    expect(totalCost([])).toBe(0);
  });
});

describe("state", () => {
  const filled: AnyResult = {
    status: "filled",
    passed: true,
    worker: "jev",
    model: "jev-1.13.0",
    ms: 12,
    choice: "track_order",
    confidence: 0.9,
  };

  it("keeps a filled result's values and drops its metadata", () => {
    expect(stateValue(filled)).toEqual({ choice: "track_order", confidence: 0.9 });
  });

  it("gives null for a skipped or failed result", () => {
    expect(stateValue({ status: "skipped", passed: false, reason: "when returned false" })).toBe(
      null,
    );
    expect(stateValue({ status: "failed", passed: false, error: fieldError("x", "y") })).toBe(null);
  });

  it("adds only the named results to the inputs", () => {
    const skipped: AnyResult = { status: "skipped", passed: false, reason: "r" };
    const state = buildState({ ticket: "hi" }, { intent: filled, other: skipped }, ["intent"]);
    expect(state).toEqual({ ticket: "hi", intent: { choice: "track_order", confidence: 0.9 } });
  });

  it("estimates tokens high, at three characters of JSON each", () => {
    expect(estimateTokens("ab")).toBe(2); // '"ab"' is 4 characters
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("flags state plus the longest question over 32k tokens", () => {
    const big = "x".repeat(3 * 32_000);
    expect(tooLarge({ ticket: big }, { q: "?" })).toBe(true);
    expect(tooLarge({ ticket: "x".repeat(3 * 31_000) }, { q: "?" })).toBe(false);
  });

  it("flags a whole request over 64k tokens even when each question fits", () => {
    const question = "q".repeat(3 * 20_000);
    const questions = { a: question, b: question, c: question, d: question };
    expect(tooLarge({ ticket: "hi" }, questions)).toBe(true);
    expect(tooLarge({ ticket: "hi" }, { a: question })).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter fieldwork exec vitest run test/runtime.test.ts`
Expected: FAIL; the file cannot import `../src/errors.ts`.

- [ ] **Step 3: Add `AnyResult` to `types.ts`**

In `packages/fieldwork/src/types.ts`, directly after the `Results<F>` line:

```ts
export type Results<F> = { [K in keyof F]: FieldResult<F[K]> };

/** Any field's result, as the runtime handles it. */
export type AnyResult = FieldResult<Record<string, unknown>>;
```

- [ ] **Step 4: Write `errors.ts` and move `DefinitionError` into it**

`packages/fieldwork/src/errors.ts`:

```ts
import { APIError, APITimeoutError, RateLimitError } from "@typesafe-ai/sdk";
import type { FieldError } from "./types.ts";

/** A schema mistake found while defining fields, planning them or starting a run. */
export class DefinitionError extends Error {
  override name = "DefinitionError";
}

/** The reason a field's time limit or the run's deadline aborts its work. */
export class TimeoutReached extends Error {
  override name = "TimeoutReached";
}

const MAX_MESSAGE = 200;

/** A field error, its message cut to 200 characters. */
export function fieldError(code: string, message: string): FieldError {
  const short = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
  return { code, message: short };
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A failed jev request: the error class and HTTP status, never the response body. */
export function jevError(err: unknown): FieldError {
  if (err instanceof TimeoutReached) return fieldError("timeout", err.message);
  if (err instanceof RateLimitError) return fieldError("rate_limited", `jev: HTTP ${err.status}`);
  if (err instanceof APIError) return fieldError("jev_error", `jev: HTTP ${err.status}`);
  if (err instanceof APITimeoutError) {
    return fieldError("timeout", `jev: no response within ${err.timeoutMs} ms`);
  }
  return fieldError("jev_error", `jev: ${nameOf(err)}`);
}

/** A failed text generation: the error class and HTTP status, never the provider's body. */
export function textError(err: unknown): FieldError {
  if (err instanceof TimeoutReached) return fieldError("timeout", err.message);
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  const suffix = typeof status === "number" ? `: HTTP ${status}` : "";
  return fieldError("text_error", `${nameOf(err)}${suffix}`);
}

/** A tool, `when` or `candidates` function that threw: its message only. */
export function thrownError(code: string, err: unknown): FieldError {
  if (err instanceof TimeoutReached) return fieldError("timeout", err.message);
  return fieldError(code, messageOf(err));
}
```

In `packages/fieldwork/src/builder.ts`, add the import under the SDK import and replace the class with a re-export, so `import { DefinitionError } from "../src/builder.ts"` keeps working:

```ts
import type { Question } from "@typesafe-ai/sdk";
import { DefinitionError } from "./errors.ts";
```

```ts
// replaces: /** A schema mistake found while defining or planning fields. */ export class DefinitionError …
export { DefinitionError };
```

In `packages/fieldwork/src/plan.ts`, change the first line to:

```ts
import { DefinitionError } from "./errors.ts";
```

- [ ] **Step 5: Write `time.ts`, `trace.ts` and `state.ts`**

`packages/fieldwork/src/time.ts`:

```ts
import { TimeoutReached } from "./errors.ts";

export interface Limit {
  signal: AbortSignal;
  /** Clear the timer and stop following the parent. Call once the work has settled. */
  release(): void;
}

/**
 * A signal that aborts when `parent` aborts, with the parent's reason, or after `ms` with a
 * `TimeoutReached` carrying `message`, whichever comes first. No `ms` means no timer.
 */
export function limit(
  parent: AbortSignal | undefined,
  ms: number | undefined,
  message: string,
): Limit {
  const controller = new AbortController();
  const follow = () => controller.abort(parent?.reason);

  if (parent?.aborted) follow();
  else parent?.addEventListener("abort", follow, { once: true });

  const timer =
    ms === undefined
      ? undefined
      : setTimeout(() => controller.abort(new TimeoutReached(message)), ms);

  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", follow);
    },
  };
}

/**
 * Wait for `work`, but reject with the signal's reason as soon as the signal aborts. Work that
 * finishes later is ignored, so a function that cannot be cancelled still cannot overrun.
 */
export function settle<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {}); // a late rejection is ignored, not unhandled
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Whole milliseconds since `start`, a `performance.now()` reading. */
export function since(start: number): number {
  return Math.round(performance.now() - start);
}
```

`packages/fieldwork/src/trace.ts`:

```ts
import type { Worker } from "./types.ts";

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Prices for cost estimates. jev defaults to TypeSafe's list price; text models have none. */
export interface Prices {
  jev?: Price;
  /** Keyed by model id: the string passed as a model, or the model object's `modelId`. */
  text?: Record<string, Price>;
}

/** TypeSafe's jev price: $0.042 per million input tokens, output free. */
export const JEV_PRICE: Price = { inputPerMTok: 0.042, outputPerMTok: 0 };

export interface CallTrace {
  worker: Worker;
  /** For jev, the model the response names; for text, the model id; `null` for tools. */
  model: string | null;
  /** The fields this call filled or tried to fill. */
  fields: string[];
  status: "ok" | "failed";
  ms: number;
  inputTokens: number;
  outputTokens: number;
  /** `null` when a text model has no price in `prices`. */
  estCostUsd: number | null;
}

export interface StepTrace {
  fields: string[];
  calls: CallTrace[];
}

export interface Trace {
  steps: StepTrace[];
  /** The request that graded generated text, or `null` when nothing was graded. */
  grading: StepTrace | null;
  totalMs: number;
  /** Sum over every call; `null` when any call has no price. */
  estCostUsd: number | null;
}

function priceOf(call: Omit<CallTrace, "estCostUsd">, prices: Prices): Price | undefined {
  if (call.worker === "jev") return prices.jev ?? JEV_PRICE;
  const text = prices.text ?? {};
  return call.model !== null && Object.hasOwn(text, call.model) ? text[call.model] : undefined;
}

/** A call record with its estimated cost. Tool calls cost nothing. */
export function callTrace(call: Omit<CallTrace, "estCostUsd">, prices: Prices = {}): CallTrace {
  if (call.worker === "tool") return { ...call, estCostUsd: 0 };
  const price = priceOf(call, prices);
  const estCostUsd =
    price === undefined
      ? null
      : (call.inputTokens * price.inputPerMTok + call.outputTokens * price.outputPerMTok) / 1e6;
  return { ...call, estCostUsd };
}

/** The total estimated cost, or `null` when any call has no price. */
export function totalCost(calls: readonly CallTrace[]): number | null {
  let total = 0;
  for (const call of calls) {
    if (call.estCostUsd === null) return null;
    total += call.estCostUsd;
  }
  return total;
}
```

`packages/fieldwork/src/state.ts`:

```ts
import type { AnyResult } from "./types.ts";

const META = new Set(["status", "passed", "worker", "model", "ms"]);

/** A dependency as data for jev or a text model: its values when filled, otherwise `null`. */
export function stateValue(result: AnyResult): Record<string, unknown> | null {
  if (result.status !== "filled") return null;
  return Object.fromEntries(Object.entries(result).filter(([key]) => !META.has(key)));
}

/** The inputs plus the named results, as one object. */
export function buildState(
  input: object,
  results: Readonly<Record<string, AnyResult>>,
  names: Iterable<string>,
): Record<string, unknown> {
  const state: Record<string, unknown> = { ...input };
  for (const name of names) state[name] = stateValue(results[name]!);
  return state;
}

/** jev's limits, from its model notes. */
export const STATE_LIMIT_TOKENS = 32_000;
export const REQUEST_LIMIT_TOKENS = 64_000;

/** A deliberately high token estimate: three characters of JSON per token. */
export function estimateTokens(value: unknown): number {
  return Math.ceil((JSON.stringify(value) ?? "").length / 3);
}

/** True when state plus the longest question passes 32k tokens, or the request passes 64k. */
export function tooLarge(state: unknown, questions: Readonly<Record<string, unknown>>): boolean {
  const stateTokens = estimateTokens(state);
  const questionTokens = Object.values(questions).map(estimateTokens);
  const longest = Math.max(0, ...questionTokens);
  const all = questionTokens.reduce((sum, tokens) => sum + tokens, 0);
  return stateTokens + longest > STATE_LIMIT_TOKENS || stateTokens + all > REQUEST_LIMIT_TOKENS;
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter fieldwork exec vitest run test/runtime.test.ts`
Expected: `Tests 20 passed (20)`.

- [ ] **Step 7: Check the whole workspace**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; `fieldwork` has 61 tests (41 from week 2 + 20), bench 92.

- [ ] **Step 8: Commit**

```bash
git add packages/fieldwork/src/errors.ts packages/fieldwork/src/time.ts packages/fieldwork/src/trace.ts packages/fieldwork/src/state.ts packages/fieldwork/src/builder.ts packages/fieldwork/src/plan.ts packages/fieldwork/src/types.ts packages/fieldwork/test/runtime.test.ts
git commit -m "Add runtime foundations: field errors, time limits, trace costs and jev state"
```

---

### Task 2: The judge and pick resolvers

**Files:**
- Create: `packages/fieldwork/src/resolvers/pick.ts`, `packages/fieldwork/src/resolvers/judge.ts`
- Test: `packages/fieldwork/test/judge.test.ts`

**Interfaces:**
- Consumes (Task 1): `fieldError`, `jevError`, `thrownError`; `buildState`, `tooLarge`; `settle`, `since`; `callTrace`, `CallTrace`, `Prices`; `AnyResult`. From week 2: `FieldSpec`, the fakes `fakeTypeSafe`, `answer`, `FAKE_JEV_MODEL`, `JevReply`.
- Produces:
  - `pick.ts`:
    - `interface PickQuestion { question: ChoiceQuestion; candidates: readonly string[]; none: string }`
    - `NONE_DESCRIPTION`
    - `cleanCandidates(found: unknown): string[] | null`
    - `pickQuestion(instructions: string, candidates: readonly string[]): PickQuestion`
  - `judge.ts`:
    - `type JevField = Extract<FieldSpec, { kind: "judge" | "pick" }>`
    - `interface JevContext { client: TypeSafeClient; model?: string; signal: AbortSignal; prices?: Prices }`
    - `type Sent = { ok: true; answers; model; ms; call } | { ok: false; error: FieldError; call }`
    - `failed(error: FieldError): AnyResult`
    - `sendJev(state, questions, fields: string[], ctx: JevContext): Promise<Sent>`
    - `askJev(fields: readonly JevField[], input: object, results, ctx: JevContext): Promise<{ results: Record<string, AnyResult>; call: CallTrace | null }>`
  - Task 4's grading reuses `sendJev`. Task 5's `run` uses `askJev` and `failed`.

- [ ] **Step 1: Write the failing tests**

`packages/fieldwork/test/judge.test.ts`:

```ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldwork } from "../src/builder.ts";
import { askJev, type JevField } from "../src/resolvers/judge.ts";
import { cleanCandidates, NONE_DESCRIPTION, pickQuestion } from "../src/resolvers/pick.ts";
import type { AnyResult } from "../src/types.ts";
import { answer, FAKE_JEV_MODEL, fakeTypeSafe, type JevReply } from "./fakes.ts";

const INTENTS = { track_order: null, get_refund: null } as const;
const LEVELS = ["simple", "judgment", "unusual"] as const;
const findNumbers = (input: { ticket: string }) => input.ticket.match(/#?\d{5,}/g) ?? [];

const schema = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent", INTENTS), { gate: 0.8 })
  .judge("complexity", score("How complex", LEVELS))
  .judge("isRepeat", noul("Has this happened before?"), { yesAbove: 0.8 })
  .pick("orderNumber", { instructions: "The order number", candidates: findNumbers });
const fields = schema.fields as JevField[];
const byName = (name: string) => fields.find((f) => f.name === name)!;

const input = { ticket: "Where is order #12345? Invoice #99999 is fine." };

function ask(reply: JevReply, only: JevField[] = fields, results: Record<string, AnyResult> = {}) {
  const { client, calls } = fakeTypeSafe(reply);
  const signal = new AbortController().signal;
  return { calls, pending: askJev(only, input, results, { client, signal }) };
}

const good = {
  answers: {
    intent: answer.choice({ track_order: 0.9, get_refund: 0.1 }),
    complexity: answer.score([0.1, 0.1, 0.8]),
    isRepeat: answer.noul(0.5),
    orderNumber: answer.choice({ "#12345": 0.7, "#99999": 0.2, none: 0.1 }),
  },
  inputTokens: 250,
};

describe("pick questions", () => {
  it("keeps candidates in first-seen order without repeats or empty strings", () => {
    expect(cleanCandidates(["#2", "", "#1", "#2"])).toEqual(["#2", "#1"]);
  });

  it("rejects anything but an array of strings", () => {
    expect(cleanCandidates("#1")).toBeNull();
    expect(cleanCandidates([1, 2])).toBeNull();
  });

  it("adds a described none option after the candidates", () => {
    const pick = pickQuestion("The order number", ["#1", "#2"]);
    expect(pick.none).toBe("none");
    expect(pick.question).toEqual({
      type: "choice",
      instructions: "The order number",
      criteria: { "#1": null, "#2": null, none: NONE_DESCRIPTION },
    });
  });

  it("renames none when a candidate is spelled none", () => {
    const pick = pickQuestion("x", ["none", "_none"]);
    expect(pick.none).toBe("__none");
    expect(Object.keys(pick.question.criteria)).toEqual(["none", "_none", "__none"]);
  });
});

describe("askJev", () => {
  it("asks every judgment and pick in one request keyed by field name", async () => {
    const { pending, calls } = ask(good);
    await pending;
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.questions)).toEqual([
      "intent",
      "complexity",
      "isRepeat",
      "orderNumber",
    ]);
    expect(calls[0]!.state).toEqual(input);
    expect(calls[0]!.questions.orderNumber).toMatchObject({
      criteria: { "#12345": null, "#99999": null, none: NONE_DESCRIPTION },
    });
  });

  it("maps each answer to a typed, filled result", async () => {
    const { results, call } = await ask(good).pending;
    expect(results.intent).toMatchObject({
      status: "filled",
      passed: true,
      worker: "jev",
      model: FAKE_JEV_MODEL,
      choice: "track_order",
      confidence: 0.9,
      probabilities: { track_order: 0.9, get_refund: 0.1 },
    });
    expect(results.complexity).toMatchObject({
      status: "filled",
      passed: true,
      score: expect.closeTo(1.7),
      confidence: 0.8,
    });
    expect(results.orderNumber).toMatchObject({ value: "#12345", confidence: 0.7, passed: true });
    expect(call).toMatchObject({
      worker: "jev",
      model: FAKE_JEV_MODEL,
      fields: ["intent", "complexity", "isRepeat", "orderNumber"],
      status: "ok",
      inputTokens: 250,
      outputTokens: 0,
    });
    expect(call!.estCostUsd).toBeCloseTo((250 * 0.042) / 1e6);
  });

  it("gates on confidence", async () => {
    const reply = {
      answers: { ...good.answers, intent: answer.choice({ track_order: 0.6, get_refund: 0.4 }) },
    };
    const { results } = await ask(reply).pending;
    expect(results.intent).toMatchObject({ status: "filled", passed: false, confidence: 0.6 });
  });

  it("leaves yes unset and fails the gate when a Noul is between the thresholds", async () => {
    const { results } = await ask(good).pending;
    expect(results.isRepeat).toMatchObject({
      status: "filled",
      passed: false,
      noul: 0.5,
      yes: undefined,
    });
  });

  it("sets yes on either side of yesAbove", async () => {
    for (const [p, yes] of [
      [0.85, true],
      [0.1, false],
    ] as const) {
      const { results } = await ask({ answers: { isRepeat: answer.noul(p) } }, [byName("isRepeat")])
        .pending;
      expect(results.isRepeat).toMatchObject({ passed: true, noul: p, yes });
    }
  });

  it("returns null for a pick when jev chooses none", async () => {
    const reply = {
      answers: { orderNumber: answer.choice({ "#12345": 0.1, "#99999": 0.1, none: 0.8 }) },
    };
    const { results } = await ask(reply, [byName("orderNumber")]).pending;
    expect(results.orderNumber).toMatchObject({ status: "filled", value: null, confidence: 0.8 });
  });

  it("answers none without asking when there are no candidates", async () => {
    const { client, calls } = fakeTypeSafe(good);
    const signal = new AbortController().signal;
    const { results, call } = await askJev(
      [byName("orderNumber")],
      { ticket: "no numbers" },
      {},
      {
        client,
        signal,
      },
    );
    expect(calls).toHaveLength(0);
    expect(call).toBeNull();
    expect(results.orderNumber).toMatchObject({
      status: "filled",
      passed: true,
      value: null,
      confidence: 1,
      model: null,
    });
  });

  it("fails only the field whose answer is missing or outside its options", async () => {
    const reply = {
      answers: {
        intent: { ...answer.choice({ track_order: 0.9 }), choice: "cancel_order" },
        complexity: good.answers.complexity,
        orderNumber: answer.choice({ "#55555": 0.9, none: 0.1 }),
      },
    };
    const { results } = await ask(reply).pending;
    expect(results.intent).toMatchObject({ status: "failed", error: { code: "bad_answer" } });
    expect(results.isRepeat).toMatchObject({ status: "failed", error: { code: "bad_answer" } });
    expect(results.orderNumber).toMatchObject({ status: "failed", error: { code: "bad_answer" } });
    expect(results.complexity).toMatchObject({ status: "filled" });
  });

  it("fails an answer of the wrong type", async () => {
    const reply = { answers: { complexity: answer.noul(0.5) } };
    const { results } = await ask(reply, [byName("complexity")]).pending;
    expect(results.complexity).toMatchObject({
      status: "failed",
      error: { code: "bad_answer", message: "complexity: expected a score answer" },
    });
  });

  it("fails every field in the request when jev errors, without the response body", async () => {
    const reply = { status: 500, body: { error: { message: "secret ticket text" } } };
    const { results, call } = await ask(reply).pending;
    for (const name of ["intent", "complexity", "isRepeat", "orderNumber"]) {
      expect(results[name]).toEqual({
        status: "failed",
        passed: false,
        error: { code: "jev_error", message: "jev: HTTP 500" },
      });
    }
    expect(call).toMatchObject({ status: "failed", inputTokens: 0 });
  });

  it("fails a pick whose candidates function throws or returns a non-list", async () => {
    const schema2 = fieldwork<{ ticket: string }>()
      .pick("a", {
        instructions: "x",
        candidates: () => {
          throw new Error("regex broke");
        },
      })
      .pick("b", { instructions: "x", candidates: () => "#1" as unknown as string[] });
    const { results, call } = await ask(good, schema2.fields as JevField[]).pending;
    expect(results.a).toMatchObject({
      status: "failed",
      error: { code: "candidates_error", message: "regex broke" },
    });
    expect(results.b).toMatchObject({ status: "failed", error: { code: "candidates_error" } });
    expect(call).toBeNull();
  });

  it("adds the after fields the questions list to state, and only those", async () => {
    const later = fieldwork<{ ticket: string }>()
      .judge("intent", choice("The primary intent", INTENTS))
      .judge("complexity", score("How complex", LEVELS))
      .judge("isRepeat", noul("Has this happened before?"), { after: ["intent"] });
    const intent: AnyResult = {
      status: "filled",
      passed: true,
      worker: "jev",
      model: FAKE_JEV_MODEL,
      ms: 3,
      choice: "track_order",
      confidence: 0.9,
      probabilities: { track_order: 0.9, get_refund: 0.1 },
    };
    const complexity: AnyResult = { status: "skipped", passed: false, reason: "r" };
    const { pending, calls } = ask(
      { answers: { isRepeat: answer.noul(0.1) } },
      [later.fields[2] as JevField],
      { intent, complexity },
    );
    await pending;
    expect(calls[0]!.state).toEqual({
      ...input,
      intent: {
        choice: "track_order",
        confidence: 0.9,
        probabilities: { track_order: 0.9, get_refund: 0.1 },
      },
    });
  });

  it("fails the request's fields with state_too_large instead of sending", async () => {
    const { client, calls } = fakeTypeSafe(good);
    const signal = new AbortController().signal;
    const huge = { ticket: "#12345 " + "x".repeat(100_000) };
    const { results, call } = await askJev(fields, huge, {}, { client, signal });
    expect(calls).toHaveLength(0);
    expect(call).toBeNull();
    expect(results.intent).toMatchObject({ status: "failed", error: { code: "state_too_large" } });
    expect(results.orderNumber).toMatchObject({ error: { code: "state_too_large" } });
  });

  it("sends the pinned jev model when one is given", async () => {
    const { client, calls } = fakeTypeSafe(good);
    const signal = new AbortController().signal;
    await askJev(fields, input, {}, { client, signal, model: "jev-1.13.2" });
    expect(calls[0]!.model).toBe("jev-1.13.2");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter fieldwork exec vitest run test/judge.test.ts`
Expected: FAIL; the file cannot import `../src/resolvers/judge.ts`.

- [ ] **Step 3: Write `resolvers/pick.ts`**

`packages/fieldwork/src/resolvers/pick.ts`:

```ts
import { choice, type ChoiceQuestion } from "@typesafe-ai/sdk";

export interface PickQuestion {
  question: ChoiceQuestion;
  candidates: readonly string[];
  /** The label for "none of these": `none`, with underscores added if a candidate is spelled so. */
  none: string;
}

/** The description jev sees for the `none` option. */
export const NONE_DESCRIPTION = "None of these candidates fits";

/**
 * Candidates in first-seen order, without repeats or empty strings. `null` when `found` is not
 * an array of strings.
 */
export function cleanCandidates(found: unknown): string[] | null {
  if (!Array.isArray(found) || !found.every((c) => typeof c === "string")) return null;
  return [...new Set(found.filter((c: string) => c.length > 0))];
}

/** A Choice among the candidates plus `none`, asked with the pick's instructions as written. */
export function pickQuestion(instructions: string, candidates: readonly string[]): PickQuestion {
  let none = "none";
  while (candidates.includes(none)) none = `_${none}`;
  const criteria = Object.fromEntries([
    ...candidates.map((c) => [c, null]),
    [none, NONE_DESCRIPTION],
  ]) as Record<string, string | null>;
  return { question: choice(instructions, criteria), candidates, none };
}
```

- [ ] **Step 4: Write `resolvers/judge.ts`**

`packages/fieldwork/src/resolvers/judge.ts`:

```ts
import type { JsonValue, Question, SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";
import { fieldError, jevError, thrownError } from "../errors.ts";
import { buildState, tooLarge } from "../state.ts";
import { settle, since } from "../time.ts";
import { callTrace, type CallTrace, type Prices } from "../trace.ts";
import type { AnyResult, FieldError, FieldSpec } from "../types.ts";
import { cleanCandidates, pickQuestion, type PickQuestion } from "./pick.ts";

export type JevField = Extract<FieldSpec, { kind: "judge" | "pick" }>;

export interface JevContext {
  client: TypeSafeClient;
  /** Sent as the request's `model`; when omitted, the client's `defaultModel` applies. */
  model?: string;
  signal: AbortSignal;
  prices?: Prices;
}

type Answers = Record<string, unknown>;

/** The result of one systemOne request: its answers, or the error for every question in it. */
export type Sent =
  | { ok: true; answers: Answers; model: string; ms: number; call: CallTrace }
  | { ok: false; error: FieldError; call: CallTrace };

export function failed(error: FieldError): AnyResult {
  return { status: "failed", passed: false, error };
}

/** Send one systemOne request. Never throws: a failure comes back as a field error. */
export async function sendJev(
  state: Record<string, unknown>,
  questions: Record<string, Question>,
  fields: string[],
  ctx: JevContext,
): Promise<Sent> {
  const started = performance.now();
  const request = {
    state: state as Record<string, JsonValue>,
    questions,
    ...(ctx.model === undefined ? {} : { model: ctx.model }),
  };
  try {
    const response: SystemOneResult<Record<string, Question>> = await settle(
      ctx.client.systemOne(request, { signal: ctx.signal }),
      ctx.signal,
    );
    const ms = since(started);
    const call = callTrace(
      {
        worker: "jev",
        model: response.model,
        fields,
        status: "ok",
        ms,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      ctx.prices,
    );
    return { ok: true, answers: response.answers as Answers, model: response.model, ms, call };
  } catch (err) {
    const call = callTrace(
      {
        worker: "jev",
        model: ctx.model ?? null,
        fields,
        status: "failed",
        ms: since(started),
        inputTokens: 0,
        outputTokens: 0,
      },
      ctx.prices,
    );
    return { ok: false, error: jevError(err), call };
  }
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function meetsGate(confidence: number, gate: number | undefined): boolean {
  return gate === undefined || confidence >= gate;
}

/** `true` or `false` only when the Noul is clearly on one side of `yesAbove`. */
function yesOf(noul: number, yesAbove: number | undefined): boolean | undefined {
  if (yesAbove === undefined) return undefined;
  if (noul >= yesAbove) return true;
  if (noul <= 1 - yesAbove) return false;
  return undefined;
}

/** Map one answer to its field's result; a missing or malformed answer fails only that field. */
function readAnswer(
  field: JevField,
  answer: unknown,
  pick: PickQuestion | undefined,
  meta: { model: string; ms: number },
): AnyResult {
  const bad = (what: string) => failed(fieldError("bad_answer", `${field.name}: ${what}`));
  if (!isRecord(answer)) return bad("no answer");

  const filled = { status: "filled", worker: "jev", ...meta } as const;
  const type = field.kind === "pick" ? "choice" : field.question.type;
  if (answer.type !== type) return bad(`expected a ${type} answer`);

  if (type === "noul") {
    if (!isUnit(answer.noul)) return bad("noul is not a probability");
    const yesAbove = field.kind === "judge" ? field.yesAbove : undefined;
    const yes = yesOf(answer.noul, yesAbove);
    return {
      ...filled,
      passed: yesAbove === undefined || yes !== undefined,
      noul: answer.noul,
      yes,
    };
  }

  const { confidence, probabilities } = answer;
  if (!isUnit(confidence) || !isRecord(probabilities)) return bad("malformed answer");

  if (field.kind === "pick") {
    const chosen = answer.choice;
    if (chosen !== pick!.none && !pick!.candidates.includes(chosen as string)) {
      return bad("choice outside the candidates");
    }
    const value = chosen === pick!.none ? null : (chosen as string);
    return { ...filled, passed: meetsGate(confidence, field.gate), value, confidence };
  }

  const passed = meetsGate(confidence, field.gate);
  if (type === "score") {
    if (typeof answer.score !== "number" || !Number.isFinite(answer.score)) {
      return bad("score is not a number");
    }
    return {
      ...filled,
      passed,
      score: answer.score,
      confidence,
      probabilities: { ...probabilities },
    };
  }

  const criteria = (field.question as { criteria: object }).criteria;
  if (typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice)) {
    return bad("choice outside the options");
  }
  return {
    ...filled,
    passed,
    choice: answer.choice,
    confidence,
    probabilities: { ...probabilities },
  };
}

/**
 * Ask every judgment and pick in a step in one systemOne request, and map the answers back to
 * the fields. A pick with no candidates is answered `none` without asking. Never throws.
 */
export async function askJev(
  fields: readonly JevField[],
  input: object,
  results: Readonly<Record<string, AnyResult>>,
  ctx: JevContext,
): Promise<{ results: Record<string, AnyResult>; call: CallTrace | null }> {
  const out: Record<string, AnyResult> = {};
  const questions: Record<string, Question> = {};
  const picks = new Map<string, PickQuestion>();

  for (const field of fields) {
    if (field.kind === "judge") {
      questions[field.name] = field.question;
      continue;
    }

    let found: unknown;
    try {
      found = field.candidates(input);
    } catch (err) {
      out[field.name] = failed(thrownError("candidates_error", err));
      continue;
    }

    const candidates = cleanCandidates(found);
    if (candidates === null) {
      out[field.name] = failed(
        fieldError("candidates_error", `${field.name}: candidates must return an array of strings`),
      );
    } else if (candidates.length === 0) {
      // Nothing to choose from: `none` is certain, and no question is asked.
      out[field.name] = {
        status: "filled",
        passed: true,
        worker: "jev",
        model: null,
        ms: 0,
        value: null,
        confidence: 1,
      };
    } else {
      const pick = pickQuestion(field.instructions, candidates);
      picks.set(field.name, pick);
      questions[field.name] = pick.question;
    }
  }

  const asked = fields.filter((f) => Object.hasOwn(questions, f.name));
  if (asked.length === 0) return { results: out, call: null };
  const names = asked.map((f) => f.name);

  const state = buildState(input, results, new Set(asked.flatMap((f) => f.after)));
  if (tooLarge(state, questions)) {
    const error = fieldError("state_too_large", "state and questions exceed jev's token limits");
    for (const name of names) out[name] = failed(error);
    return { results: out, call: null };
  }

  const sent = await sendJev(state, questions, names, ctx);
  for (const field of asked) {
    out[field.name] = sent.ok
      ? readAnswer(field, sent.answers[field.name], picks.get(field.name), {
          model: sent.model,
          ms: sent.ms,
        })
      : failed(sent.error);
  }
  return { results: out, call: sent.call };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter fieldwork exec vitest run test/judge.test.ts`
Expected: `Tests 18 passed (18)`.

- [ ] **Step 6: Check the whole workspace**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; `fieldwork` has 79 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/fieldwork/src/resolvers/pick.ts packages/fieldwork/src/resolvers/judge.ts packages/fieldwork/test/judge.test.ts
git commit -m "Ask a step's judgments and picks in one systemOne request"
```

---

### Task 3: The tool and text resolvers

**Files:**
- Create: `packages/fieldwork/src/resolvers/tool.ts`, `packages/fieldwork/src/resolvers/text.ts`
- Test: `packages/fieldwork/test/text.test.ts`

**Interfaces:**
- Consumes (Task 1): `fieldError`, `textError`, `thrownError`, `TimeoutReached`; `stateValue`; `settle`, `since`; `callTrace`, `CallTrace`, `Prices`; `AnyResult`, `Reasoning`, `FieldSpec`. From `ai`: `generateText`, `LanguageModel`. The fake `fakeTextModel`.
- Produces:
  - `tool.ts`:
    - `type ToolField = Extract<FieldSpec, { kind: "tool" }>`
    - `runTool(field: ToolField, deps: Record<string, AnyResult>, input: object, signal: AbortSignal): Promise<{ result: AnyResult; call: CallTrace }>`
  - `text.ts`:
    - `type TextField = Extract<FieldSpec, { kind: "text" }>`
    - `interface TextContext { models?: Partial<Record<Reasoning, LanguageModel>>; signal: AbortSignal; prices?: Prices }`
    - `textPrompt(field: TextField, input: object, results): { system: string; prompt: string }`
    - `runText(field: TextField, input: object, results, ctx: TextContext): Promise<{ result: AnyResult; call: CallTrace | null }>`

- [ ] **Step 1: Write the failing tests**

`packages/fieldwork/test/text.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter fieldwork exec vitest run test/text.test.ts`
Expected: FAIL; the file cannot import `../src/resolvers/text.ts`.

- [ ] **Step 3: Write `resolvers/tool.ts`**

`packages/fieldwork/src/resolvers/tool.ts`:

```ts
import { thrownError } from "../errors.ts";
import { settle, since } from "../time.ts";
import { callTrace, type CallTrace } from "../trace.ts";
import type { AnyResult, FieldSpec } from "../types.ts";

export type ToolField = Extract<FieldSpec, { kind: "tool" }>;

/**
 * Call the application's function with its `after` fields and the inputs. A throw or rejection
 * fails the field with the error's message only. Never throws.
 */
export async function runTool(
  field: ToolField,
  deps: Record<string, AnyResult>,
  input: object,
  signal: AbortSignal,
): Promise<{ result: AnyResult; call: CallTrace }> {
  const started = performance.now();
  const record = (status: "ok" | "failed") =>
    callTrace({
      worker: "tool",
      model: null,
      fields: [field.name],
      status,
      ms: since(started),
      inputTokens: 0,
      outputTokens: 0,
    });

  try {
    const value = await settle(
      Promise.resolve().then(() => field.call(deps, input)),
      signal,
    );
    const call = record("ok");
    return {
      result: { status: "filled", passed: true, worker: "tool", model: null, ms: call.ms, value },
      call,
    };
  } catch (err) {
    return {
      result: { status: "failed", passed: false, error: thrownError("tool_error", err) },
      call: record("failed"),
    };
  }
}
```

- [ ] **Step 4: Write `resolvers/text.ts`**

`packages/fieldwork/src/resolvers/text.ts`:

```ts
import { generateText, type LanguageModel } from "ai";
import { fieldError, textError } from "../errors.ts";
import { stateValue } from "../state.ts";
import { settle, since } from "../time.ts";
import { callTrace, type CallTrace, type Prices } from "../trace.ts";
import type { AnyResult, FieldSpec, Reasoning } from "../types.ts";

export type TextField = Extract<FieldSpec, { kind: "text" }>;

export interface TextContext {
  models?: Partial<Record<Reasoning, LanguageModel>>;
  signal: AbortSignal;
  prices?: Prices;
}

/** One labeled data block: strings as written, anything else as indented JSON. */
function block(name: string, value: unknown): string {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `<data name="${name}">\n${body}\n</data>`;
}

/**
 * The instructions and style as the system message; the inputs and `after` results as labeled
 * data blocks. No output format is requested: the model replies with plain text.
 */
export function textPrompt(
  field: TextField,
  input: object,
  results: Readonly<Record<string, AnyResult>>,
): { system: string; prompt: string } {
  const system = [
    field.instructions,
    ...(field.style === undefined ? [] : [`Style: ${field.style}`]),
    "Use the data in the message as context. Reply with the text only.",
  ].join("\n\n");
  const blocks = [
    ...Object.entries(input).map(([name, value]) => block(name, value)),
    ...field.after.map((name) => block(name, stateValue(results[name]!))),
  ];
  return { system, prompt: blocks.join("\n\n") };
}

/** The model a text field uses: its own `model`, else the one for its tier (`medium` by default). */
function modelFor(field: TextField, ctx: TextContext): LanguageModel | undefined {
  return field.model ?? ctx.models?.[field.reasoning ?? "medium"];
}

/** Generate a text field. Never throws; a failure fails only this field. */
export async function runText(
  field: TextField,
  input: object,
  results: Readonly<Record<string, AnyResult>>,
  ctx: TextContext,
): Promise<{ result: AnyResult; call: CallTrace | null }> {
  const model = modelFor(field, ctx);
  if (model === undefined) {
    const tier = field.reasoning ?? "medium";
    const error = fieldError("no_model", `${field.name}: no model for reasoning "${tier}"`);
    return { result: { status: "failed", passed: false, error }, call: null };
  }

  const modelId = typeof model === "string" ? model : model.modelId;
  const { system, prompt } = textPrompt(field, input, results);
  const started = performance.now();

  try {
    const response = await settle(
      generateText({ model, system, prompt, abortSignal: ctx.signal }),
      ctx.signal,
    );
    const ms = since(started);
    const call = callTrace(
      {
        worker: "text",
        model: modelId,
        fields: [field.name],
        status: "ok",
        ms,
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
      },
      ctx.prices,
    );

    if (response.text.trim() === "") {
      const error = fieldError("empty_text", `${field.name}: the model returned no text`);
      return { result: { status: "failed", passed: false, error }, call };
    }

    // Before grading, a field with `minScore` has no score yet, so it has not passed.
    const result: AnyResult = {
      status: "filled",
      passed: field.minScore === undefined,
      worker: "text",
      model: modelId,
      ms,
      value: response.text,
      score: null,
      heuristic: true,
    };
    return { result, call };
  } catch (err) {
    const call = callTrace(
      {
        worker: "text",
        model: modelId,
        fields: [field.name],
        status: "failed",
        ms: since(started),
        inputTokens: 0,
        outputTokens: 0,
      },
      ctx.prices,
    );
    return { result: { status: "failed", passed: false, error: textError(err) }, call };
  }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter fieldwork exec vitest run test/text.test.ts`
Expected: `Tests 14 passed (14)`.

- [ ] **Step 6: Check the whole workspace**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; `fieldwork` has 93 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/fieldwork/src/resolvers/tool.ts packages/fieldwork/src/resolvers/text.ts packages/fieldwork/test/text.test.ts
git commit -m "Run tool functions and generate text with labeled data blocks"
```

---

### Task 4: Grading generated text

**Files:**
- Create: `packages/fieldwork/src/grade.ts`
- Test: `packages/fieldwork/test/grade.test.ts`

**Interfaces:**
- Consumes: `sendJev`, `JevContext` (Task 2); `TextField` (Task 3); `buildState`, `tooLarge`, `CallTrace`, `AnyResult` (Task 1); `noul` from `@typesafe-ai/sdk`.
- Produces:
  - `interface GradeItem { field: TextField; text: string }`
  - `gradeQuestions(field: TextField): Record<string, Question>`
  - `grade(items: readonly GradeItem[], input: object, results, ctx: JevContext): Promise<{ scores: Record<string, number | null>; call: CallTrace | null }>`
  - Task 5's `run` calls `grade` once after the last step.

- [ ] **Step 1: Write the failing tests**

`packages/fieldwork/test/grade.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter fieldwork exec vitest run test/grade.test.ts`
Expected: FAIL; the file cannot import `../src/grade.ts`.

- [ ] **Step 3: Write `grade.ts`**

`packages/fieldwork/src/grade.ts`:

```ts
import { noul, type Question } from "@typesafe-ai/sdk";
import type { TextField } from "./resolvers/text.ts";
import { sendJev, type JevContext } from "./resolvers/judge.ts";
import { buildState, tooLarge } from "./state.ts";
import type { CallTrace } from "./trace.ts";
import type { AnyResult } from "./types.ts";

export interface GradeItem {
  field: TextField;
  text: string;
}

/** The two Nouls for one text field; the style Noul only when the field has a style. */
export function gradeQuestions(field: TextField): Record<string, Question> {
  const questions: Record<string, Question> = {
    [`${field.name}__supported`]: noul(
      `Is the text in \`${field.name}\` supported by the provided context and inputs?`,
    ),
  };
  if (field.style !== undefined) {
    questions[`${field.name}__style`] = noul(
      `Does the text in \`${field.name}\` meet the style: ${field.style}?`,
    );
  }
  return questions;
}

function noulOf(answer: unknown): number | null {
  const a = answer as { type?: unknown; noul?: unknown } | undefined;
  return a?.type === "noul" && typeof a.noul === "number" && a.noul >= 0 && a.noul <= 1
    ? a.noul
    : null;
}

/**
 * Grade every item in one systemOne request. A field's score is the product of its Noul
 * answers, a heuristic rather than a probability; it is `null` when grading fails. Never throws.
 */
export async function grade(
  items: readonly GradeItem[],
  input: object,
  results: Readonly<Record<string, AnyResult>>,
  ctx: JevContext,
): Promise<{ scores: Record<string, number | null>; call: CallTrace | null }> {
  const names = items.map((item) => item.field.name);
  const scores: Record<string, number | null> = Object.fromEntries(names.map((n) => [n, null]));
  if (items.length === 0) return { scores, call: null };

  const questions = Object.assign({}, ...items.map((item) => gradeQuestions(item.field))) as Record<
    string,
    Question
  >;
  const state = buildState(input, results, new Set(items.flatMap((item) => item.field.after)));
  for (const item of items) state[item.field.name] = item.text;
  if (tooLarge(state, questions)) return { scores, call: null };

  const sent = await sendJev(state, questions, names, ctx);
  if (!sent.ok) return { scores, call: sent.call };

  for (const item of items) {
    const name = item.field.name;
    const supported = noulOf(sent.answers[`${name}__supported`]);
    const style = item.field.style === undefined ? 1 : noulOf(sent.answers[`${name}__style`]);
    scores[name] = supported === null || style === null ? null : supported * style;
  }
  return { scores, call: sent.call };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter fieldwork exec vitest run test/grade.test.ts`
Expected: `Tests 6 passed (6)`.

- [ ] **Step 5: Check the whole workspace**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; `fieldwork` has 99 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/fieldwork/src/grade.ts packages/fieldwork/test/grade.test.ts
git commit -m "Grade generated text with two Nouls per field in one request"
```

---

### Task 5: `run`, `Builder.run` and the error table

**Files:**
- Create: `packages/fieldwork/src/run.ts`
- Modify: `packages/fieldwork/src/builder.ts` (`NewName` rejects input keys; `minScore` needs grading; `run` method), `packages/fieldwork/src/index.ts` (export run and trace types)
- Test: `packages/fieldwork/test/run.test.ts` (new); `packages/fieldwork/test/builder.types.test.ts`, `packages/fieldwork/test/builder.test.ts` (add tests)

**Interfaces:**
- Consumes: `plan` (week 2); `askJev`, `failed`, `JevField` (Task 2); `runTool` (Task 3); `runText`, `TextField` (Task 3); `grade`, `GradeItem` (Task 4); `limit`, `since`, `totalCost`, `DefinitionError`, `TimeoutReached`, `fieldError`, `thrownError` and the trace types (Task 1).
- Produces:
  - `interface RunOptions { typesafe: TypeSafeClient; models?: Partial<Record<Reasoning, LanguageModel>>; deadlineMs?: number; jevModel?: string; prices?: Prices }`
  - `interface RunResult<F> { fields: Results<F>; trace: Trace }`
  - `run(fields: readonly FieldSpec[], input: object, options: RunOptions): Promise<{ fields: Record<string, AnyResult>; trace: Trace }>`
  - `Builder<I, F>.run(input: I, options: RunOptions): Promise<RunResult<F>>`
  - Package exports: `RunOptions`, `RunResult`, `JEV_PRICE`, `CallTrace`, `Price`, `Prices`, `StepTrace`, `Trace`.
  - Task 6's triage example and Task 7's live test call `Builder.run`.

- [ ] **Step 1: Write the failing runtime tests**

`packages/fieldwork/test/run.test.ts`, one test per row of the spec's error table plus the step, gate, trace and definition-error behavior:

```ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { Builder, DefinitionError, fieldwork } from "../src/builder.ts";
import type { FieldSpec } from "../src/types.ts";
import { answer, FAKE_JEV_MODEL, fakeTextModel, fakeTypeSafe, type JevCall } from "./fakes.ts";

const INTENTS = { track_order: null, get_refund: null } as const;
const LEVELS = ["simple", "judgment", "unusual"] as const;
const input = { ticket: "Where is order #12345? It happened before." };

/** Answers every question it is asked, by field name, from this table. */
const ANSWERS: Record<string, unknown> = {
  intent: answer.choice({ track_order: 0.9, get_refund: 0.1 }),
  complexity: answer.score([0.8, 0.1, 0.1]),
  isRepeat: answer.noul(0.9),
  orderNumber: answer.choice({ "#12345": 0.95, none: 0.05 }),
  reply__supported: answer.noul(0.9),
  reply__style: answer.noul(0.8),
  note__supported: answer.noul(0.2),
};
function byQuestion(call: JevCall) {
  return {
    answers: Object.fromEntries(Object.keys(call.questions).map((k) => [k, ANSWERS[k]])),
  };
}

const triage = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent", INTENTS), { gate: 0.8 })
  .judge("complexity", score("How complex", LEVELS))
  .pick("orderNumber", {
    instructions: "The order number",
    candidates: (i) => i.ticket.match(/#\d{5,}/g) ?? [],
  })
  .tool("order", {
    after: ["intent", "orderNumber"],
    when: (f) => f.intent.passed && f.orderNumber.value !== null,
    call: (f) => ({ orderNumber: f.orderNumber.value, status: "shipped" }),
  })
  .judge("isRepeat", noul("Has this happened before?"), { after: ["order"], yesAbove: 0.8 })
  .text("reply", {
    after: ["complexity", "order"],
    when: (f) => f.complexity.passed && f.complexity.score < 1.5,
    instructions: "Reply to the customer",
    style: "warm",
    reasoning: "low",
  })
  .text("note", {
    after: ["complexity"],
    when: (f) => !f.complexity.passed || f.complexity.score >= 1.5,
    instructions: "Summarize for the on-call agent",
    reasoning: "high",
  });

const models = { low: fakeTextModel("It shipped today.", "low-model"), high: fakeTextModel("n") };

describe("run", () => {
  it("fills every field step by step and returns them in declaration order", async () => {
    const { client, calls } = fakeTypeSafe(byQuestion);
    const { fields, trace } = await triage.run(input, { typesafe: client, models });

    expect(Object.keys(fields)).toEqual([
      "intent",
      "complexity",
      "orderNumber",
      "order",
      "isRepeat",
      "reply",
      "note",
    ]);
    expect(fields.intent).toMatchObject({ status: "filled", passed: true, choice: "track_order" });
    expect(fields.order).toMatchObject({
      status: "filled",
      value: { orderNumber: "#12345", status: "shipped" },
    });
    expect(fields.isRepeat).toMatchObject({ status: "filled", passed: true, yes: true });
    expect(fields.reply).toMatchObject({ status: "filled", value: "It shipped today." });
    expect(fields.note).toEqual({
      status: "skipped",
      passed: false,
      reason: "when returned false",
    });

    // Step 1 asks intent, complexity and the pick together; step 3 asks isRepeat with the
    // order in state; grading is the last request.
    expect(calls.map((c) => Object.keys(c.questions))).toEqual([
      ["intent", "complexity", "orderNumber"],
      ["isRepeat"],
      ["reply__supported", "reply__style"],
    ]);
    expect(calls[1]!.state).toEqual({
      ...input,
      order: { value: { orderNumber: "#12345", status: "shipped" } },
    });
    expect(trace.steps.map((s) => s.fields)).toEqual([
      ["intent", "complexity", "orderNumber"],
      ["order", "note"],
      ["isRepeat", "reply"],
    ]);
  });

  it("applies grading scores and minScore gates after the last step", async () => {
    const graded = fieldwork<{ ticket: string }>()
      .text("reply", { instructions: "Reply", style: "warm", minScore: 0.5 })
      .text("note", { instructions: "Summarize", minScore: 0.5 })
      .text("raw", { instructions: "Echo", grade: false });
    const { client, calls } = fakeTypeSafe(byQuestion);
    const medium = fakeTextModel("text");
    const { fields, trace } = await graded.run(input, { typesafe: client, models: { medium } });

    expect(fields.reply).toMatchObject({
      status: "filled",
      passed: true,
      score: expect.closeTo(0.72),
      heuristic: true,
    });
    expect(fields.note).toMatchObject({ status: "filled", passed: false, score: 0.2 });
    expect(fields.raw).toMatchObject({ status: "filled", passed: true, score: null });
    expect(Object.keys(calls[0]!.questions)).toEqual([
      "reply__supported",
      "reply__style",
      "note__supported",
    ]);
    expect(trace.grading).toMatchObject({ fields: ["reply", "note"] });
  });

  it("records calls, tokens and costs in the trace", async () => {
    const { client } = fakeTypeSafe((call) => ({ ...byQuestion(call), inputTokens: 1_000_000 }));
    const prices = { text: { "low-model": { inputPerMTok: 0, outputPerMTok: 0 } } };
    const { trace } = await triage.run(input, { typesafe: client, models, prices });

    const jev = trace.steps[0]!.calls[0]!;
    expect(jev).toMatchObject({ worker: "jev", model: FAKE_JEV_MODEL, status: "ok" });
    expect(jev.estCostUsd).toBeCloseTo(0.042);
    expect(trace.steps[1]!.calls).toMatchObject([{ worker: "tool", fields: ["order"] }]);
    expect(trace.grading!.calls).toHaveLength(1);
    // Three jev requests at 1M input tokens each; the priced text model is free.
    expect(trace.estCostUsd).toBeCloseTo(0.126);
    expect(trace.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("reports a null total cost when a text model has no price", async () => {
    const { client } = fakeTypeSafe(byQuestion);
    const { trace } = await triage.run(input, { typesafe: client, models });
    expect(trace.estCostUsd).toBeNull();
  });

  describe("error table", () => {
    it("fails every judgment and pick in a failed request; dependents see passed false", async () => {
      const { client } = fakeTypeSafe({ status: 500, body: "secret ticket text" });
      const { fields } = await triage.run(input, { typesafe: client, models });

      for (const name of ["intent", "complexity", "orderNumber"] as const) {
        expect(fields[name]).toEqual({
          status: "failed",
          passed: false,
          error: { code: "jev_error", message: "jev: HTTP 500" },
        });
      }
      expect(fields.order).toMatchObject({ status: "skipped" });
      expect(fields.reply).toMatchObject({ status: "skipped" });
      // A failed complexity means escalate: the note's when reads passed === false.
      expect(fields.note).toMatchObject({ status: "filled", value: "n" });
    });

    it("fails a request's fields with timeout at the smallest timeoutMs among them", async () => {
      const timed = fieldwork<{ ticket: string }>()
        .judge("intent", choice("The primary intent", INTENTS), { timeoutMs: 30 })
        .judge("complexity", score("How complex", LEVELS), { timeoutMs: 5_000 });
      const { client } = fakeTypeSafe({ hangMs: 2_000 });
      const started = performance.now();
      const { fields } = await timed.run(input, { typesafe: client });

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(fields.intent).toEqual({
        status: "failed",
        passed: false,
        error: { code: "timeout", message: "jev request: no result within 30 ms" },
      });
      expect(fields.complexity).toMatchObject({ status: "failed", error: { code: "timeout" } });
    });

    it("fails only a text field whose generation throws", async () => {
      const { client } = fakeTypeSafe(byQuestion);
      const broken = { low: fakeTextModel(new Error("provider down")), high: models.high };
      const { fields } = await triage.run(input, { typesafe: client, models: broken });
      expect(fields.reply).toMatchObject({ status: "failed", error: { code: "text_error" } });
      expect(fields.isRepeat).toMatchObject({ status: "filled" });
    });

    it("keeps text filled with a null score when grading fails", async () => {
      const { client } = fakeTypeSafe((call, index) =>
        index === 2 ? { status: 503 } : byQuestion(call),
      );
      const { fields, trace } = await triage.run(input, { typesafe: client, models });
      expect(fields.reply).toMatchObject({ status: "filled", passed: true, score: null });
      expect(trace.grading!.calls[0]).toMatchObject({ status: "failed" });
    });

    it("fails a tool that throws with its message only", async () => {
      const schema = fieldwork<{ ticket: string }>()
        .tool("order", {
          call: () => {
            throw new Error("no such order");
          },
        })
        .tool("after", { after: ["order"], call: (f) => f.order.status });
      const { client } = fakeTypeSafe(byQuestion);
      const { fields } = await schema.run(input, { typesafe: client });
      expect(fields.order).toEqual({
        status: "failed",
        passed: false,
        error: { code: "tool_error", message: "no such order" },
      });
      expect(fields.after).toMatchObject({ status: "filled", value: "failed" });
    });

    it("returns what it has when the deadline passes; unsettled and later fields time out", async () => {
      const schema = fieldwork<{ ticket: string }>()
        .tool("fast", { call: () => 1 })
        .tool("slow", { call: () => new Promise(() => {}) })
        .tool("later", { after: ["fast"], call: () => 2 });
      const { client } = fakeTypeSafe(byQuestion);
      const started = performance.now();
      const { fields } = await schema.run(input, { typesafe: client, deadlineMs: 40 });

      expect(performance.now() - started).toBeLessThan(1_000);
      expect(fields.fast).toMatchObject({ status: "filled", value: 1 });
      const timeout = {
        status: "failed",
        passed: false,
        error: { code: "timeout", message: "run deadline of 40 ms reached" },
      };
      expect(fields.slow).toEqual(timeout);
      expect(fields.later).toEqual(timeout);
    });
  });

  it("fails a tool at its own timeoutMs while the rest of the step finishes", async () => {
    const schema = fieldwork<{ ticket: string }>()
      .tool("slow", { call: () => new Promise(() => {}), timeoutMs: 20 })
      .tool("fast", { call: () => "ok" });
    const { client } = fakeTypeSafe(byQuestion);
    const { fields } = await schema.run(input, { typesafe: client });
    expect(fields.slow).toMatchObject({
      status: "failed",
      error: { code: "timeout", message: "slow: no result within 20 ms" },
    });
    expect(fields.fast).toMatchObject({ status: "filled", value: "ok" });
  });

  it("fails only the field whose when throws", async () => {
    const schema = fieldwork<{ ticket: string }>()
      .tool("a", {
        when: () => {
          throw new Error("bad when");
        },
        call: () => 1,
      })
      .tool("b", { call: () => 2 });
    const { client } = fakeTypeSafe(byQuestion);
    const { fields } = await schema.run(input, { typesafe: client });
    expect(fields.a).toEqual({
      status: "failed",
      passed: false,
      error: { code: "when_error", message: "bad when" },
    });
    expect(fields.b).toMatchObject({ status: "filled", value: 2 });
  });

  it("does not ask jev about a field whose when returned false", async () => {
    const schema = fieldwork<{ ticket: string }>()
      .judge("intent", choice("The primary intent", INTENTS))
      .judge("isRepeat", noul("Again?"), { when: () => false });
    const { client, calls } = fakeTypeSafe(byQuestion);
    await schema.run(input, { typesafe: client });
    expect(Object.keys(calls[0]!.questions)).toEqual(["intent"]);
  });

  it("leaves no timers running after it returns", async () => {
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const schema = fieldwork<{ ticket: string }>().tool("a", { call: () => 1, timeoutMs: 60_000 });
    const { client } = fakeTypeSafe(byQuestion);
    const before = timers();
    await schema.run(input, { typesafe: client, deadlineMs: 60_000 });
    expect(timers()).toBe(before);
  });

  describe("definition errors, thrown before anything is sent", () => {
    const { client, calls } = fakeTypeSafe(byQuestion);

    it("rejects a field named like an input, for untyped callers", async () => {
      const spec: FieldSpec = { kind: "tool", name: "ticket", after: [], call: () => 1 };
      await expect(new Builder([spec]).run(input, { typesafe: client })).rejects.toThrow(
        new DefinitionError('Field "ticket" has the same name as an input'),
      );
    });

    it("rejects inputs that are not a plain object", async () => {
      const b = fieldwork<object>();
      await expect(b.run(null as never, { typesafe: client })).rejects.toThrow(DefinitionError);
      await expect(b.run([] as never, { typesafe: client })).rejects.toThrow(DefinitionError);
    });

    it("rejects a missing client and a bad deadline", async () => {
      const b = fieldwork<{ ticket: string }>();
      await expect(b.run(input, {} as never)).rejects.toThrow(
        "run needs a TypeSafeClient as options.typesafe",
      );
      for (const deadlineMs of [0, -1, Number.NaN]) {
        await expect(b.run(input, { typesafe: client, deadlineMs })).rejects.toThrow(
          DefinitionError,
        );
      }
      expect(calls).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Add the failing builder tests**

In `packages/fieldwork/test/builder.types.test.ts`, add the import:

```ts
import type { Trace } from "../src/trace.ts";
```

and these two tests before `it("takes gate for choice and score, yesAbove for noul", …)`:

```ts
  it("rejects a name used by an input", () => {
    fieldwork<{ ticket: string }>()
      // @ts-expect-error: `ticket` is an input; inputs and fields share jev state
      .tool("ticket", { call: () => 1 });
  });

  it("types run's inputs, results and trace from the schema", () => {
    type Run = Awaited<ReturnType<typeof triage.run>>;
    expectTypeOf<Run["fields"]>().toEqualTypeOf<ResultsOf<typeof triage>>();
    expectTypeOf<Run["trace"]>().toEqualTypeOf<Trace>();
    expectTypeOf(triage.run).parameter(0).toEqualTypeOf<{ ticket: string }>();
  });
```

In `packages/fieldwork/test/builder.test.ts`, add before `it("rejects an after that is not a list of names", …)`:

```ts
  it("rejects minScore on a text field that is not graded", () => {
    rejects(
      () =>
        fieldwork<{ ticket: string }>().text("a", {
          instructions: "Write",
          grade: false,
          minScore: 0.5,
        }),
      /a: minScore needs grading, but grade is false/,
    );
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter fieldwork typecheck; pnpm --filter fieldwork exec vitest run test/run.test.ts test/builder.test.ts`
Expected:
- The typecheck fails with `Property 'run' does not exist on type 'Builder<…>'` and an unused `@ts-expect-error` for the `ticket` field name.
- `run.test.ts` fails on `triage.run is not a function`.
- The `minScore` test fails because nothing throws.

- [ ] **Step 4: Write `run.ts`**

`packages/fieldwork/src/run.ts`:

```ts
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { LanguageModel } from "ai";
import { DefinitionError, fieldError, thrownError, TimeoutReached } from "./errors.ts";
import { grade, type GradeItem } from "./grade.ts";
import { plan } from "./plan.ts";
import { askJev, failed, type JevField } from "./resolvers/judge.ts";
import { runText, type TextField } from "./resolvers/text.ts";
import { runTool } from "./resolvers/tool.ts";
import { limit, since } from "./time.ts";
import { totalCost, type CallTrace, type Prices, type StepTrace, type Trace } from "./trace.ts";
import type { AnyResult, FieldSpec, Reasoning, Results } from "./types.ts";

export interface RunOptions {
  typesafe: TypeSafeClient;
  /** AI SDK models for text fields, by reasoning tier. */
  models?: Partial<Record<Reasoning, LanguageModel>>;
  /** Stop waiting after this long; unsettled fields fail with `timeout`. */
  deadlineMs?: number;
  /** The jev model id to send; pin a versioned id. Omitted, the client's `defaultModel` applies. */
  jevModel?: string;
  prices?: Prices;
}

export interface RunResult<F> {
  fields: Results<F>;
  trace: Trace;
}

function checkRun(fields: readonly FieldSpec[], input: unknown, options: RunOptions): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new DefinitionError("run takes the inputs as a plain object");
  }

  // Inputs and field results share one namespace in jev state and text prompts.
  for (const field of fields) {
    if (Object.hasOwn(input, field.name)) {
      throw new DefinitionError(`Field "${field.name}" has the same name as an input`);
    }
  }

  if (typeof options?.typesafe?.systemOne !== "function") {
    throw new DefinitionError("run needs a TypeSafeClient as options.typesafe");
  }

  const d = options.deadlineMs;
  if (d !== undefined && !(Number.isFinite(d) && d > 0)) {
    throw new DefinitionError(`deadlineMs must be a positive number, got ${d}`);
  }
}

function depsOf(field: FieldSpec, results: Readonly<Record<string, AnyResult>>) {
  return Object.fromEntries(field.after.map((name) => [name, results[name]!]));
}

/** `true` to run the field, or the result that settles it without running. */
function checkWhen(field: FieldSpec, input: object, results: Record<string, AnyResult>) {
  if (field.when === undefined) return true;
  try {
    if (field.when(depsOf(field, results), input)) return true;
    return { status: "skipped", passed: false, reason: "when returned false" } as const;
  } catch (err) {
    return failed(thrownError("when_error", err));
  }
}

/** The smallest `timeoutMs` among fields that share one request, if any has one. */
function smallestTimeout(fields: readonly FieldSpec[]): number | undefined {
  const limits = fields.flatMap((f) => (f.timeoutMs === undefined ? [] : [f.timeoutMs]));
  return limits.length === 0 ? undefined : Math.min(...limits);
}

/** Run `work` under a limit derived from the deadline, and release the limit's timer after. */
async function limited<T>(
  deadline: AbortSignal,
  ms: number | undefined,
  message: string,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const l = limit(deadline, ms, message);
  try {
    return await work(l.signal);
  } finally {
    l.release();
  }
}

function isJev(field: FieldSpec): field is JevField {
  return field.kind === "judge" || field.kind === "pick";
}

function timeoutFailure(deadline: AbortSignal): AnyResult {
  const reason: unknown = deadline.reason;
  const message = reason instanceof TimeoutReached ? reason.message : "run deadline reached";
  return failed(fieldError("timeout", message));
}

async function runStep(
  step: readonly FieldSpec[],
  input: object,
  results: Record<string, AnyResult>,
  options: RunOptions,
  deadline: AbortSignal,
): Promise<StepTrace> {
  const trace: StepTrace = { fields: step.map((f) => f.name), calls: [] };
  if (deadline.aborted) {
    for (const field of step) results[field.name] = timeoutFailure(deadline);
    return trace;
  }

  const active: FieldSpec[] = [];
  for (const field of step) {
    const verdict = checkWhen(field, input, results);
    if (verdict === true) active.push(field);
    else results[field.name] = verdict;
  }

  const work: Promise<CallTrace | null>[] = [];
  const jevFields = active.filter(isJev);

  if (jevFields.length > 0) {
    const ms = smallestTimeout(jevFields);
    work.push(
      limited(deadline, ms, `jev request: no result within ${ms} ms`, async (signal) => {
        const ctx = {
          client: options.typesafe,
          model: options.jevModel,
          signal,
          prices: options.prices,
        };
        const outcome = await askJev(jevFields, input, results, ctx);
        Object.assign(results, outcome.results);
        return outcome.call;
      }),
    );
  }

  for (const field of active) {
    if (field.kind !== "tool" && field.kind !== "text") continue;
    const ms = field.timeoutMs;
    work.push(
      limited(deadline, ms, `${field.name}: no result within ${ms} ms`, async (signal) => {
        const outcome =
          field.kind === "tool"
            ? await runTool(field, depsOf(field, results), input, signal)
            : await runText(field, input, results, { ...options, signal });
        results[field.name] = outcome.result;
        return outcome.call;
      }),
    );
  }

  for (const call of await Promise.all(work)) if (call !== null) trace.calls.push(call);
  return trace;
}

/** Grade filled text fields in one request and apply scores and `minScore` gates. */
async function gradeTexts(
  fields: readonly FieldSpec[],
  input: object,
  results: Record<string, AnyResult>,
  options: RunOptions,
  deadline: AbortSignal,
): Promise<StepTrace | null> {
  const items: GradeItem[] = [];
  for (const field of fields) {
    const result = results[field.name]!;
    if (field.kind === "text" && field.grade && result.status === "filled") {
      items.push({ field, text: result.value as string });
    }
  }
  if (items.length === 0 || deadline.aborted) return null;

  const ctx = {
    client: options.typesafe,
    model: options.jevModel,
    signal: deadline,
    prices: options.prices,
  };
  const { scores, call } = await grade(items, input, results, ctx);

  for (const { field } of items) {
    const score = scores[field.name] ?? null;
    const minScore = (field as TextField).minScore;
    const passed = minScore === undefined || (score !== null && score >= minScore);
    results[field.name] = { ...results[field.name]!, score, passed } as AnyResult;
  }
  return { fields: items.map((item) => item.field.name), calls: call === null ? [] : [call] };
}

/**
 * Run fields step by step: evaluate `when`, send each step's judgments and picks as one
 * systemOne request, run tools and text beside it, then grade generated text. Field failures
 * never fail the run; only a definition mistake throws, before anything is sent.
 */
export async function run(
  fields: readonly FieldSpec[],
  input: object,
  options: RunOptions,
): Promise<{ fields: Record<string, AnyResult>; trace: Trace }> {
  checkRun(fields, input, options);
  const steps = plan(fields);
  const started = performance.now();
  const d = options.deadlineMs;
  const deadline = limit(undefined, d, `run deadline of ${d} ms reached`);
  const results: Record<string, AnyResult> = {};
  const trace: Trace = { steps: [], grading: null, totalMs: 0, estCostUsd: null };

  try {
    for (const step of steps) {
      trace.steps.push(await runStep(step, input, results, options, deadline.signal));
    }
    trace.grading = await gradeTexts(fields, input, results, options, deadline.signal);
  } finally {
    deadline.release();
  }

  const stepTraces = trace.grading === null ? trace.steps : [...trace.steps, trace.grading];
  trace.estCostUsd = totalCost(stepTraces.flatMap((s) => s.calls));
  trace.totalMs = since(started);
  // Results in declaration order, whatever order the fields settled in.
  const ordered = Object.fromEntries(fields.map((f) => [f.name, results[f.name]!]));
  return { fields: ordered, trace };
}
```

- [ ] **Step 5: Update the builder**

In `packages/fieldwork/src/builder.ts`:

1. Add the `run` import under the `errors.ts` import:

```ts
import { run as runFields, type RunOptions, type RunResult } from "./run.ts";
```

2. Replace `NewName` and its comment so names that are input keys are rejected:

```ts
/**
 * A single literal name used by neither an earlier field nor an input. A widened `string` or a
 * union is rejected: either would type fields that do not exist at runtime. Inputs and fields
 * share one namespace in jev state and text prompts.
 */
type NewName<N extends string, F, I> = string extends N
  ? never
  : IsUnion<N> extends false
    ? N extends keyof F | keyof I
      ? never
      : N
    : never;
```

3. In each of `judge`, `pick`, `tool` and `text`, change the parameter `name: NewName<N, F>,` to:

```ts
    name: NewName<N, F, I>,
```

4. In `text`, directly after `checkUnit(name, "minScore", options.minScore);`:

```ts
    if (options.grade === false && options.minScore !== undefined) {
      throw new DefinitionError(`${name}: minScore needs grading, but grade is false`);
    }
```

5. Add the method at the end of the `Builder` class, after `text`:

```ts
  /** Fill every field for one set of inputs. Field failures never reject; see `RunResult`. */
  run(input: I, options: RunOptions): Promise<RunResult<F>> {
    return runFields(this.fields, input, options) as Promise<RunResult<F>>;
  }
```

- [ ] **Step 6: Export the run and trace types**

`packages/fieldwork/src/index.ts`:

```ts
export { Builder, DefinitionError, fieldwork, type ResultsOf } from "./builder.ts";
export type { RunOptions, RunResult } from "./run.ts";
export {
  JEV_PRICE,
  type CallTrace,
  type Price,
  type Prices,
  type StepTrace,
  type Trace,
} from "./trace.ts";
export type {
  ChoiceValue,
  Deps,
  Failed,
  FieldError,
  FieldResult,
  FieldView,
  Filled,
  JudgeValue,
  NoulValue,
  PickValue,
  Reasoning,
  Results,
  ScoreValue,
  Skipped,
  TextValue,
  ToolValue,
  Worker,
} from "./types.ts";
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter fieldwork typecheck && pnpm --filter fieldwork test`
Expected: typecheck exits 0 (every `@ts-expect-error` is used); `Tests 119 passed (119)`. `run.test.ts` has 17, `builder.types.test.ts` gains 2 and `builder.test.ts` gains 1.

- [ ] **Step 8: Check the whole workspace**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; bench still 92.

- [ ] **Step 9: Commit**

```bash
git add packages/fieldwork/src/run.ts packages/fieldwork/src/builder.ts packages/fieldwork/src/index.ts packages/fieldwork/test/run.test.ts packages/fieldwork/test/builder.types.test.ts packages/fieldwork/test/builder.test.ts
git commit -m "Run schemas step by step with timeouts, a deadline, grading and a cost trace"
```

---

### Task 6: The triage example, end to end

**Files:**
- Modify: `packages/fieldwork/package.json` (export `./testing`), `bench/package.json` (depend on `fieldwork`), `pnpm-lock.yaml`
- Create: `bench/src/triage.ts`
- Test: `bench/test/triage.test.ts`

**Interfaces:**
- Consumes:
  - `fieldwork`, `ResultsOf` and `Builder.run` (Task 5).
  - `answer`, `fakeTextModel`, `fakeTypeSafe`, `JevCall` from `fieldwork/testing`.
  - From bench: `INTENTS`, `rollUpToCategory` (`bench/src/intents.ts`); `findOrderNumbers` (`bench/src/systems/jev.ts`); `INTENT_INSTRUCTIONS`, `ORDER_NUMBER_TARGET` (`bench/src/wording.ts`).
- Produces: `triage` (the spec's schema), `type TriageResults`, `escalates(fields: TriageResults): boolean`, `stubOrders`, `CATEGORY_GATE = 0.85`, `COMPLEXITY_LIMIT = 1.5`, `COMPLEXITY_LEVELS`. Week 4 runs `triage` as benchmark System 1.

- [ ] **Step 1: Link the package into bench**

In `packages/fieldwork/package.json`, make `exports`:

```json
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./test/fakes.ts"
  },
```

In `bench/package.json`, add to `dependencies` after `csv-parse`:

```json
    "fieldwork": "workspace:*",
```

Run: `pnpm install`
Expected: completes; `pnpm-lock.yaml` gains `fieldwork: specifier: workspace:*, version: link:../packages/fieldwork` under `bench`.

- [ ] **Step 2: Write the failing test**

`bench/test/triage.test.ts`:

```ts
import { answer, fakeTextModel, fakeTypeSafe, type JevCall } from "fieldwork/testing";
import { describe, expect, it } from "vitest";
import { escalates, triage } from "../src/triage.ts";
import { ORDER_NUMBER_TARGET } from "../src/wording.ts";

const ticket = "Where is order #4471902? Invoice #12588 is already paid.";

/** jev's answers by question id; `complexity` levels are simple, judgment, unusual. */
function jev(complexity: readonly number[]) {
  const answers: Record<string, unknown> = {
    intent: answer.choice({ track_order: 0.9, delivery_period: 0.08, get_refund: 0.02 }),
    complexity: answer.score(complexity),
    isRepeat: answer.noul(0.1),
    orderNumber: answer.choice({ "#4471902": 0.93, "#12588": 0.05, none: 0.02 }),
    reply__supported: answer.noul(0.9),
    reply__style: answer.noul(0.9),
    escalationNote__supported: answer.noul(0.8),
    escalationNote__style: answer.noul(0.7),
  };
  return (call: JevCall) => ({
    answers: Object.fromEntries(Object.keys(call.questions).map((id) => [id, answers[id]])),
  });
}

const models = {
  low: fakeTextModel("Your order has shipped and is on its way.", "cheap"),
  high: fakeTextModel("Order #4471902: customer asks where it is.", "big"),
};

describe("triage example", () => {
  it("answers a simple order question automatically", async () => {
    const { client, calls } = fakeTypeSafe(jev([0.9, 0.08, 0.02]));
    const { fields } = await triage.run({ ticket }, { typesafe: client, models });

    expect(fields.category).toMatchObject({ value: { category: "order" } });
    expect(fields.orderNumber).toMatchObject({ value: "#4471902" });
    expect(fields.order).toMatchObject({
      value: { orderNumber: "#4471902", status: "shipped" },
    });
    expect(fields.reply).toMatchObject({ status: "filled", model: "cheap" });
    expect(fields.escalationNote).toMatchObject({ status: "skipped" });
    expect(escalates(fields)).toBe(false);

    // The pick offers every number the regex found, with the pilot's wording.
    expect(calls[0]!.questions.orderNumber).toMatchObject({
      instructions: `Which of these is ${ORDER_NUMBER_TARGET}?`,
      criteria: { "#4471902": null, "#12588": null },
    });
  });

  it("escalates a complex ticket with a note from the high tier", async () => {
    const { client } = fakeTypeSafe(jev([0.05, 0.15, 0.8]));
    const { fields } = await triage.run({ ticket }, { typesafe: client, models });

    expect(fields.reply).toMatchObject({ status: "skipped" });
    expect(fields.escalationNote).toMatchObject({ status: "filled", model: "big" });
    expect(escalates(fields)).toBe(true);
  });

  it("escalates when jev is down, so no ticket is answered blind", async () => {
    const { client } = fakeTypeSafe({ status: 503 });
    const { fields } = await triage.run({ ticket }, { typesafe: client, models });

    expect(fields.intent).toMatchObject({ status: "failed" });
    expect(fields.category).toMatchObject({ status: "skipped" });
    expect(fields.order).toMatchObject({ status: "skipped" });
    expect(fields.reply).toMatchObject({ status: "skipped" });
    expect(escalates(fields)).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter @fieldwork/bench exec vitest run test/triage.test.ts`
Expected: FAIL; the file cannot import `../src/triage.ts`.

- [ ] **Step 4: Write the example**

`bench/src/triage.ts`:

```ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { fieldwork, type ResultsOf } from "fieldwork";
import { INTENTS, rollUpToCategory } from "./intents.ts";
import { findOrderNumbers } from "./systems/jev.ts";
import { INTENT_INSTRUCTIONS, ORDER_NUMBER_TARGET } from "./wording.ts";

/** The benchmark's order system: a stub in which every order exists and has shipped. */
export const stubOrders = {
  async lookup(query: { orderNumber: string }) {
    return { orderNumber: query.orderNumber, status: "shipped" as const };
  },
};

/** Category probability at or above which a ticket is answered without a person. */
export const CATEGORY_GATE = 0.85;

/** Expected complexity at or above which a ticket goes to a person. */
export const COMPLEXITY_LIMIT = 1.5;

export const COMPLEXITY_LEVELS = [
  "Simple lookup or standard procedure",
  "Requires some judgment or multi-step process",
  "Unusual situation, edge case, or escalation needed",
] as const;

/**
 * The spec's support-triage schema: jev picks one of 27 intents, code rolls it up to a category,
 * and a ticket is answered automatically only when the category is sure and the request simple.
 */
export const triage = fieldwork<{ ticket: string }>()
  .judge("intent", choice(INTENT_INSTRUCTIONS, INTENTS))
  .tool("category", {
    after: ["intent"],
    when: (f) => f.intent.passed, // no gate, so this means "filled"
    // `call` cannot see `when`'s narrowing, so it checks again.
    call: (f) => (f.intent.passed ? rollUpToCategory(f.intent.probabilities) : null),
  })
  .judge("complexity", score("How complex is this request to resolve", COMPLEXITY_LEVELS), {
    gate: 0.85,
  })
  .judge("isRepeat", noul("Does the customer say this problem happened before?"))
  .pick("orderNumber", {
    instructions: `Which of these is ${ORDER_NUMBER_TARGET}?`,
    candidates: (input) => findOrderNumbers(input.ticket),
  })
  .tool("order", {
    after: ["category", "orderNumber"],
    when: (f) => f.category.value?.category === "order" && f.orderNumber.value !== null,
    call: (f) => stubOrders.lookup({ orderNumber: f.orderNumber.value! }),
  })
  .text("reply", {
    after: ["category", "complexity", "order"],
    when: (f) =>
      (f.category.value?.probability ?? 0) >= CATEGORY_GATE &&
      f.complexity.passed &&
      f.complexity.score < COMPLEXITY_LIMIT,
    reasoning: "low",
    instructions: "Reply to the customer",
    style: "warm, under 80 words, no promises about dates",
  })
  .text("escalationNote", {
    after: ["category", "complexity", "isRepeat", "order"],
    when: (f) =>
      (f.category.value?.probability ?? 0) < CATEGORY_GATE ||
      !f.complexity.passed ||
      f.complexity.score >= COMPLEXITY_LIMIT,
    reasoning: "high",
    instructions: "Summarize the ticket for the on-call agent",
    style: "one line",
  });

export type TriageResults = ResultsOf<typeof triage>;

/** A run escalates when it wrote a note for the on-call agent. */
export function escalates(fields: TriageResults): boolean {
  return fields.escalationNote.status === "filled";
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm --filter @fieldwork/bench exec vitest run test/triage.test.ts`
Expected: `Tests 3 passed (3)`.

- [ ] **Step 6: Check plain Node can load it through the workspace link**

Week 4's benchmark CLI runs under `node`, not Vitest. Node strips types only outside `node_modules`, and the pnpm link resolves to `packages/fieldwork`.

Run: `cd bench && node --input-type=module -e "const m = await import('./src/triage.ts'); console.log(m.triage.fields.length)"`
Expected: prints `8`.

- [ ] **Step 7: Check the whole workspace**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; bench has 95 tests, fieldwork 119.

- [ ] **Step 8: Commit**

```bash
git add packages/fieldwork/package.json bench/package.json pnpm-lock.yaml bench/src/triage.ts bench/test/triage.test.ts
git commit -m "Add the triage example as a Fieldwork schema, tested end to end"
```

---

### Task 7: Live contract test

**Files:**
- Test: `packages/fieldwork/test/live.test.ts`

**Interfaces:**
- Consumes: `fieldwork`, `Builder.run` (Task 5); `TypeSafeClient`, `choice`, `score`, `noul` from `@typesafe-ai/sdk`; `AI_GATEWAY_API_KEY` from the environment or `bench/.env`.
- Produces: `FIELDWORK_LIVE=1 pnpm --filter fieldwork exec vitest run test/live.test.ts`, a check that real jev and a real text model return the shapes Fieldwork reads. It is skipped in `pnpm test`.

This test has no red step against missing code: everything it calls exists after Task 5. Its failing case is a real service returning a shape Fieldwork does not expect, which only a live run can show.

- [ ] **Step 1: Write the test**

`packages/fieldwork/test/live.test.ts`:

```ts
// Contract test against real jev and one real text model, through Vercel AI Gateway. Runs only
// with FIELDWORK_LIVE=1; it reads AI_GATEWAY_API_KEY from the environment or bench/.env. It
// checks response shapes, not answer quality, and costs well under a cent per run.
import { existsSync } from "node:fs";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldwork } from "../src/builder.ts";

const LIVE = process.env.FIELDWORK_LIVE === "1";
const ENV_FILE = new URL("../../../bench/.env", import.meta.url);
if (LIVE && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const GATEWAY_TYPESAFE_URL = "https://ai-gateway.vercel.sh/typesafe";
const JEV_MODEL = process.env.FIELDWORK_LIVE_JEV_MODEL ?? "typesafe-ai/jev";
const TEXT_MODEL = process.env.FIELDWORK_LIVE_TEXT_MODEL ?? "anthropic/claude-haiku-4.5";

const schema = fieldwork<{ ticket: string }>()
  .judge(
    "intent",
    choice("The primary intent of the customer message in `ticket`", {
      track_order: "Asks where an order is or for its tracking status",
      get_refund: "Asks for money back",
    }),
  )
  .judge("complexity", score("How complex is this request to resolve", ["simple", "some", "hard"]))
  .judge("isRepeat", noul("Does the customer say this problem happened before?"))
  .pick("orderNumber", {
    instructions: "Which of these is the order number the customer is asking about?",
    candidates: (input) => input.ticket.match(/#\d{5,}/g) ?? [],
  })
  .text("reply", {
    after: ["intent"],
    model: TEXT_MODEL,
    instructions: "Reply to the customer",
    style: "one short sentence",
  });

const isUnit = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;

describe.skipIf(!LIVE)("live contract (FIELDWORK_LIVE=1)", () => {
  it("gets typed answers, text, grading and usage from the real services", async () => {
    expect(process.env.AI_GATEWAY_API_KEY, "AI_GATEWAY_API_KEY is not set").toBeTruthy();
    const typesafe = new TypeSafeClient({
      apiKey: process.env.AI_GATEWAY_API_KEY,
      baseURL: GATEWAY_TYPESAFE_URL,
      logLevel: "off",
    });

    const { fields, trace } = await schema.run(
      { ticket: "Where is order #4471902? Invoice #12588 is already paid." },
      { typesafe, jevModel: JEV_MODEL, deadlineMs: 60_000 },
    );

    // Report failures by code before checking shapes, so a gateway error is readable.
    const failures = Object.entries(fields).flatMap(([name, r]) =>
      r.status === "failed" ? [`${name}: ${r.error.code} ${r.error.message}`] : [],
    );
    expect(failures).toEqual([]);

    const { intent, complexity, isRepeat, orderNumber, reply } = fields;
    if (intent.status !== "filled") throw new Error("intent not filled");
    expect(["track_order", "get_refund"]).toContain(intent.choice);
    expect(isUnit(intent.confidence)).toBe(true);
    const total = Object.values(intent.probabilities).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 2);

    if (complexity.status !== "filled") throw new Error("complexity not filled");
    expect(complexity.score).toBeGreaterThanOrEqual(0);
    expect(complexity.score).toBeLessThanOrEqual(2);

    if (isRepeat.status !== "filled") throw new Error("isRepeat not filled");
    expect(isUnit(isRepeat.noul)).toBe(true);

    if (orderNumber.status !== "filled") throw new Error("orderNumber not filled");
    expect(["#4471902", "#12588", null]).toContain(orderNumber.value);

    if (reply.status !== "filled") throw new Error("reply not filled");
    expect(reply.value.trim()).not.toBe("");
    expect(reply.score === null || isUnit(reply.score)).toBe(true);
    expect(reply.score, "grading returned no score").not.toBeNull();

    const jev = trace.steps[0]!.calls.find((c) => c.worker === "jev")!;
    expect(jev.model).toEqual(expect.any(String));
    expect(jev.inputTokens).toBeGreaterThan(0);
    const text = trace.steps[1]!.calls.find((c) => c.worker === "text")!;
    expect(text).toMatchObject({ model: TEXT_MODEL, status: "ok" });
    expect(text.outputTokens).toBeGreaterThan(0);
    expect(trace.grading!.calls[0]).toMatchObject({ worker: "jev", status: "ok" });
  }, 90_000);
});
```

- [ ] **Step 2: Confirm it is skipped by default**

Run: `pnpm --filter fieldwork test`
Expected: `Tests 119 passed | 1 skipped (120)`.

- [ ] **Step 3: Run it live**

This spends well under a cent through AI Gateway. The key file is git-ignored and lives in the main checkout. Copy it into this worktree's `bench/` without printing it (`cp <main checkout>/bench/.env bench/.env`), or export `AI_GATEWAY_API_KEY` in the shell.

Run: `FIELDWORK_LIVE=1 pnpm --filter fieldwork exec vitest run test/live.test.ts`
Expected: `Tests 1 passed (1)`.

If `failures` shows `rate_limited jev: HTTP 429` for the jev fields, that is AI Gateway's known jev access problem recorded in `bench/results/pilot-finding.md`, not a Fieldwork defect.
- Record it in the ledger as `Task 7: Ruling: live run blocked by AI Gateway 429 on typesafe-ai/jev — rerun with the pilot rerun`, and continue.
- Any other failure is a contract mismatch: fix the resolver it points to, with a fake-client test that reproduces the real response first.

- [ ] **Step 4: Check the whole workspace**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/fieldwork/test/live.test.ts
git commit -m "Add a live contract test for jev and a text model, run with FIELDWORK_LIVE=1"
```

---

## After this plan

Week 4 builds the benchmark on `triage` (`bench/src/triage.ts`) and `Trace`:
- the labeling guide;
- the rest of the written set;
- the frontier baseline;
- Fieldwork as System 1 with a response cache around `TypeSafeClient` and the text models;
- the report.

Before week 4 tunes any gate, rerun the full 270-ticket pilot, and this plan's live test if Task 7 was blocked, once AI Gateway serves jev again.
