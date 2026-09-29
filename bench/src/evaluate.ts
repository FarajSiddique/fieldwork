import type { BitextTicket } from "./bitext/sample.ts";
import {
  accuracy,
  accuracyAtCoverage,
  auroc,
  bootstrapCi,
  expectedCalibrationError,
  macroF1,
  mean,
  percentile,
  type Scored,
} from "./metrics.ts";
import { createRng } from "./rng.ts";
import { findOrderNumbers } from "./systems/jev.ts";
import type { Prediction } from "./systems/types.ts";

export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
}

export type PriceTable = Record<string, Price>;

export function costUsd(p: Prediction, prices: PriceTable): number | null {
  const price = prices[p.model];
  if (!price) return null;
  return (p.inputTokens * price.inputPerMTok + p.outputTokens * price.outputPerMTok) / 1e6;
}

/** Baselines may drop the "#"; the comparison ignores it and surrounding space. */
export function normalizeOrderNumber(value: string | null): string | null {
  return value === null ? null : value.trim().replace(/^#/, "");
}

export interface Interval {
  value: number;
  ci: [number, number];
}

export interface SystemSummary {
  system: string;
  models: string[];
  tickets: number;
  failed: number;
  intentAccuracy: Interval;
  categoryAccuracy: Interval;
  categoryMacroF1: number;
  intentAuroc: Interval;
  categoryAuroc: Interval;
  intentEce: number;
  categoryEce: number;
  categoryAccuracyAtCoverage: { coverage: number; accuracy: number }[];
  orderNumber: { withCandidates: number; exactMatchWithCandidates: number; exactMatchAll: number };
  costPerTicketUsd: number | null;
  latencyMs: { p50: number; p95: number };
}

export function summarize(
  system: string,
  tickets: readonly BitextTicket[],
  predictions: readonly Prediction[],
  prices: PriceTable,
  seed: number,
): SystemSummary {
  const byId = new Map(predictions.map((p) => [p.ticketId, p]));
  const rows = tickets.map((t) => {
    const p = byId.get(t.id);
    if (!p) throw new Error(`No ${system} prediction for ${t.id}`);
    return { t, p, ok: p.status === "ok" };
  });

  const intentScored: Scored[] = rows.map(({ t, p, ok }) => ({
    confidence: p.intentConfidence,
    correct: ok && p.intent === t.intent,
  }));
  const categoryScored: Scored[] = rows.map(({ t, p, ok }) => ({
    confidence: p.categoryConfidence,
    correct: ok && p.category === t.category,
  }));

  const rng = createRng(seed);
  const withCi = (scored: Scored[], stat: (s: readonly Scored[]) => number): Interval => ({
    value: stat(scored),
    ci: bootstrapCi(scored.length, (idx) => stat(idx.map((i) => scored[i]!)), rng),
  });
  const acc = (s: readonly Scored[]) => accuracy(s.map((x) => x.correct));

  const orderCorrect = rows.map(
    ({ t, p, ok }) =>
      ok && normalizeOrderNumber(p.orderNumber) === normalizeOrderNumber(t.orderNumber),
  );
  const hasCandidates = rows.map(({ t }) => findOrderNumbers(t.text).length > 0);
  const costs = rows.map(({ p }) => costUsd(p, prices));
  const okMs = rows.filter((r) => r.ok).map((r) => r.p.ms);

  return {
    system,
    models: [...new Set(rows.filter((r) => r.ok).map((r) => r.p.model))].sort(),
    tickets: rows.length,
    failed: rows.filter((r) => !r.ok).length,
    intentAccuracy: withCi(intentScored, acc),
    categoryAccuracy: withCi(categoryScored, acc),
    categoryMacroF1: macroF1(
      rows.map(({ t, p, ok }) => ({ gold: t.category, predicted: ok ? p.category : null })),
    ),
    intentAuroc: withCi(intentScored, auroc),
    categoryAuroc: withCi(categoryScored, auroc),
    intentEce: expectedCalibrationError(intentScored),
    categoryEce: expectedCalibrationError(categoryScored),
    categoryAccuracyAtCoverage: [1, 0.9, 0.8, 0.7].map((coverage) => ({
      coverage,
      accuracy: accuracyAtCoverage(categoryScored, coverage),
    })),
    orderNumber: {
      withCandidates: hasCandidates.filter(Boolean).length,
      exactMatchWithCandidates: accuracy(orderCorrect.filter((_, i) => hasCandidates[i])),
      exactMatchAll: accuracy(orderCorrect),
    },
    costPerTicketUsd: costs.some((c) => c === null) ? null : mean(costs as number[]),
    latencyMs: { p50: percentile(okMs, 50), p95: percentile(okMs, 95) },
  };
}

export interface JevChecks {
  versionedModelIds: string[];
  allVersioned: boolean;
  usageReported: boolean;
}

/** The SDK behavior the design relies on: a versioned model id and token usage on every response. */
export function jevChecks(predictions: readonly Prediction[]): JevChecks {
  const ok = predictions.filter((p) => p.status === "ok");
  const ids = [...new Set(ok.map((p) => p.model))].sort();
  return {
    versionedModelIds: ids,
    allVersioned:
      ids.length > 0 && ids.every((id) => /^(typesafe-ai\/)?jev-\d+\.\d+\.\d+$/.test(id)),
    usageReported: ok.length > 0 && ok.every((p) => p.inputTokens > 0),
  };
}
