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
