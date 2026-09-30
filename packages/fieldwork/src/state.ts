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
