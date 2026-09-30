import { noul, type Question } from "@typesafe-ai/sdk";
import type { TextField } from "./resolvers/text.ts";
import { sendJev, type JevContext } from "./resolvers/judge.ts";
import { buildState, stateProblem } from "./state.ts";
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
  if (stateProblem(state, questions) !== null) return { scores, call: null };

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
