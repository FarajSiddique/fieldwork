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
