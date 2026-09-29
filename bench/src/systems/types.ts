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
  ms: number;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

/** A failed prediction counts as wrong with confidence 0, so one bad ticket never stops a run. */
export function failedPrediction(
  system: string,
  ticketId: string,
  model: string,
  err: unknown,
): Prediction {
  const firstLine = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).split("\n")[0]!;
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
    ms: 0,
    inputTokens: 0,
    outputTokens: 0,
    cached: false,
  };
}
