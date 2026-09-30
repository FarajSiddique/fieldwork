/** Instruction wording shared by every system, so they are compared on the same question. */
export const INTENT_INSTRUCTIONS = "The primary intent of the customer message in `ticket`";

export const ORDER_NUMBER_TARGET =
  "the order number the customer in `ticket` is asking about (an invoice or bill number is not an order number)";

export const COMPLEXITY_QUESTION = "How complex is this request to resolve";

/** The complexity Score's levels, counted from zero. */
export const COMPLEXITY_LEVELS = [
  "Simple lookup or standard procedure",
  "Requires some judgment or multi-step process",
  "Unusual situation, edge case, or escalation needed",
] as const;

export const IS_REPEAT_QUESTION = "Does the customer say this problem happened before?";

export const REPLY = {
  instructions: "Reply to the customer",
  style: "warm, under 80 words, no promises about dates",
} as const;

export const ESCALATION_NOTE = {
  instructions: "Summarize the ticket for the on-call agent",
  style: "one line",
} as const;
