import { choice, noul, score } from "@typesafe-ai/sdk";
import { fieldwork, type ResultsOf } from "fieldwork";
import { INTENTS, rollUpToCategory } from "./intents.ts";
import { findOrderNumbers } from "./orderNumbers.ts";
import {
  COMPLEXITY_LEVELS,
  COMPLEXITY_QUESTION,
  ESCALATION_NOTE,
  INTENT_INSTRUCTIONS,
  IS_REPEAT_QUESTION,
  ORDER_NUMBER_TARGET,
  REPLY,
} from "./wording.ts";

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

/** Confidence the complexity Score needs before its value is trusted. */
export const COMPLEXITY_GATE = 0.85;

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
  .judge("complexity", score(COMPLEXITY_QUESTION, COMPLEXITY_LEVELS), { gate: COMPLEXITY_GATE })
  .judge("isRepeat", noul(IS_REPEAT_QUESTION))
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
    instructions: REPLY.instructions,
    style: REPLY.style,
  })
  .text("escalationNote", {
    after: ["category", "complexity", "isRepeat", "order"],
    when: (f) =>
      (f.category.value?.probability ?? 0) < CATEGORY_GATE ||
      !f.complexity.passed ||
      f.complexity.score >= COMPLEXITY_LIMIT,
    reasoning: "high",
    instructions: ESCALATION_NOTE.instructions,
    style: ESCALATION_NOTE.style,
  });

export type TriageResults = ResultsOf<typeof triage>;

/**
 * A run escalates unless it answered the customer. A note that failed or timed out still means
 * a person must handle the ticket, so it counts as escalated.
 */
export function escalates(fields: TriageResults): boolean {
  return fields.reply.status !== "filled";
}

/**
 * The schema's escalation rule on plain values, for systems that are not a Fieldwork run. It
 * mirrors the `when` of `reply` and `escalationNote`, and a test checks that they agree.
 */
export function needsPerson(answer: {
  categoryProbability: number;
  complexity: number | null;
  complexityConfidence: number;
}): boolean {
  return (
    answer.categoryProbability < CATEGORY_GATE ||
    answer.complexity === null ||
    answer.complexityConfidence < COMPLEXITY_GATE ||
    answer.complexity >= COMPLEXITY_LIMIT
  );
}
