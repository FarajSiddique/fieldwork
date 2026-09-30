import type { Worker } from "./types.ts";

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Prices for cost estimates. jev defaults to TypeSafe's list price; text models have none. */
export interface Prices {
  jev?: Price;
  /** Keyed by model id: the string passed as a model, or the model object's `modelId`. */
  text?: Record<string, Price>;
}

/** TypeSafe's jev price: $0.042 per million input tokens, output free. */
export const JEV_PRICE: Price = { inputPerMTok: 0.042, outputPerMTok: 0 };

export interface CallTrace {
  worker: Worker;
  /** For jev, the model the response names; for text, the model id; `null` for tools. */
  model: string | null;
  /** The fields this call filled or tried to fill. */
  fields: string[];
  status: "ok" | "failed";
  ms: number;
  inputTokens: number;
  outputTokens: number;
  /** `null` when a text model has no price in `prices`. */
  estCostUsd: number | null;
}

export interface StepTrace {
  fields: string[];
  calls: CallTrace[];
}

export interface Trace {
  steps: StepTrace[];
  /** The request that graded generated text, or `null` when nothing was graded. */
  grading: StepTrace | null;
  totalMs: number;
  /** Sum over every call; `null` when any call has no price. */
  estCostUsd: number | null;
}

function priceOf(call: Omit<CallTrace, "estCostUsd">, prices: Prices): Price | undefined {
  if (call.worker === "jev") return prices.jev ?? JEV_PRICE;
  const text = prices.text ?? {};
  return call.model !== null && Object.hasOwn(text, call.model) ? text[call.model] : undefined;
}

/** A call record with its estimated cost. Tool calls cost nothing. */
export function callTrace(call: Omit<CallTrace, "estCostUsd">, prices: Prices = {}): CallTrace {
  if (call.worker === "tool") return { ...call, estCostUsd: 0 };
  const price = priceOf(call, prices);
  const estCostUsd =
    price === undefined
      ? null
      : (call.inputTokens * price.inputPerMTok + call.outputTokens * price.outputPerMTok) / 1e6;
  return { ...call, estCostUsd };
}

/** The total estimated cost, or `null` when any call has no price. */
export function totalCost(calls: readonly CallTrace[]): number | null {
  let total = 0;
  for (const call of calls) {
    if (call.estCostUsd === null) return null;
    total += call.estCostUsd;
  }
  return total;
}
