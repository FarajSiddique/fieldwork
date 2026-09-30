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
