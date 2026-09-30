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
