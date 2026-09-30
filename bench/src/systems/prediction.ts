import type { Category, Intent } from "../intents.ts";

export interface Prediction {
  system: string;
  ticketId: string;
  status: "ok" | "failed";
  /** Short error name and message, at most 200 characters; null when ok. */
  error: string | null;
  intent: Intent | null;
  intentConfidence: number;
  category: Category | null;
  categoryConfidence: number;
  orderNumber: string | null;
  orderNumberConfidence: number;
  model: string;
  /** The provider AI Gateway routed the call to, when the response reports it; otherwise null. */
  provider: string | null;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Set by systems that price their own calls (Fieldwork, from its trace; the triage baselines).
   * When absent, the report prices `model`'s tokens.
   */
  estCostUsd?: number | null;
  cached: boolean;
}

/** A failed prediction counts as wrong with confidence 0, so one bad ticket never stops a run. */
export function failedPrediction(
  system: string,
  ticketId: string,
  model: string,
  err: unknown,
): Prediction {
  const firstLine = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).split(
    "\n",
  )[0]!;
  return {
    system,
    ticketId,
    status: "failed",
    error: firstLine.slice(0, 200),
    intent: null,
    intentConfidence: 0,
    category: null,
    categoryConfidence: 0,
    orderNumber: null,
    orderNumberConfidence: 0,
    model,
    provider: null,
    ms: 0,
    inputTokens: 0,
    outputTokens: 0,
    cached: false,
  };
}

/** A prediction on the full triage schema: the Bitext fields plus the written set's. */
export interface TriagePrediction extends Prediction {
  estCostUsd: number | null;
  /** Expected complexity level, 0 to 2, or null when not answered. */
  complexity: number | null;
  complexityConfidence: number;
  isRepeat: boolean | null;
  /** Whether the system hands the ticket to a person. */
  escalates: boolean;
  /** The text sent to the customer, when the system answered. */
  reply: string | null;
  /** The note for the on-call agent, when the system escalated. */
  escalationNote: string | null;
  /** `<field>: <code>` for each field that failed, including when the prediction is ok. */
  fieldErrors: string[];
}

/**
 * A triage prediction for a call that failed: wrong everywhere, and escalated, because a person
 * handles any ticket the system could not. A failed call is not priced.
 */
export function failedTriage(
  system: string,
  ticketId: string,
  model: string,
  err: unknown,
): TriagePrediction {
  return {
    ...failedPrediction(system, ticketId, model, err),
    estCostUsd: 0,
    complexity: null,
    complexityConfidence: 0,
    isRepeat: null,
    escalates: true,
    reply: null,
    escalationNote: null,
    fieldErrors: [],
  };
}
