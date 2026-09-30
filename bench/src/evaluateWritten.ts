import { costUsd, interval, type Interval, type PriceTable } from "./evaluate.ts";
import { accuracy, mean, percentile, precision, recall, type Outcome } from "./metrics.ts";
import { normalizeOrderNumber } from "./orderNumbers.ts";
import { createRng } from "./rng.ts";
import type { TriagePrediction } from "./systems/prediction.ts";
import { HARD_CASES, type HardCase, type WrittenTicket } from "./written.ts";

/** One jev weak spot. Too few tickets to resample, so plain rates beside the count. */
export interface HardCaseSummary {
  tag: HardCase;
  tickets: number;
  intentAccuracy: number;
  escalationAccuracy: number;
  orderNumberExactMatch: number;
}

export interface WrittenSummary {
  system: string;
  tickets: number;
  failed: number;
  /** Ok predictions with at least one failed field (a reply, a note, the pick). */
  partialFailures: number;
  escalationRecall: Interval;
  escalationPrecision: Interval;
  intentAccuracy: Interval;
  complexityAccuracy: Interval;
  isRepeatAccuracy: Interval;
  orderNumberExactMatch: Interval;
  costPerTicketUsd: number | null;
  latencyMs: { p50: number; p95: number };
  hardCases: HardCaseSummary[];
}

interface Row {
  ticket: WrittenTicket;
  prediction: TriagePrediction;
  escalation: Outcome;
  intent: boolean;
  complexity: boolean;
  isRepeat: boolean;
  orderNumber: boolean;
}

function score(ticket: WrittenTicket, p: TriagePrediction): Row {
  const ok = p.status === "ok";

  return {
    ticket,
    prediction: p,
    // A failed prediction escalates, so it counts toward recall and against precision.
    escalation: { gold: ticket.needsEscalation, predicted: p.escalates },
    intent: ok && p.intent === ticket.intent,
    // The expected score can fall between levels; the nearest level is the answer.
    complexity: ok && p.complexity !== null && Math.round(p.complexity) === ticket.complexity,
    isRepeat: ok && p.isRepeat === ticket.isRepeat,
    orderNumber:
      ok && normalizeOrderNumber(p.orderNumber) === normalizeOrderNumber(ticket.orderNumber),
  };
}

export function summarizeWritten(
  system: string,
  tickets: readonly WrittenTicket[],
  predictions: readonly TriagePrediction[],
  prices: PriceTable,
  seed: number,
): WrittenSummary {
  const byId = new Map(predictions.map((p) => [p.ticketId, p]));
  const rows = tickets.map((t) => {
    const p = byId.get(t.id);
    if (!p) throw new Error(`No ${system} prediction for ${t.id}`);
    return score(t, p);
  });

  const rng = createRng(seed);
  const rate = (correct: (r: Row) => boolean) =>
    interval(rows, (rs) => accuracy(rs.map(correct)), rng);
  const costs = rows.map((r) => costUsd(r.prediction, prices));
  const okMs = rows.filter((r) => r.prediction.status === "ok").map((r) => r.prediction.ms);

  return {
    system,
    tickets: rows.length,
    failed: rows.filter((r) => r.prediction.status === "failed").length,
    partialFailures: rows.filter(
      (r) => r.prediction.status === "ok" && r.prediction.fieldErrors.length > 0,
    ).length,
    escalationRecall: interval(rows, (rs) => recall(rs.map((r) => r.escalation)), rng),
    escalationPrecision: interval(rows, (rs) => precision(rs.map((r) => r.escalation)), rng),
    intentAccuracy: rate((r) => r.intent),
    complexityAccuracy: rate((r) => r.complexity),
    isRepeatAccuracy: rate((r) => r.isRepeat),
    orderNumberExactMatch: rate((r) => r.orderNumber),
    costPerTicketUsd: costs.some((c) => c === null) ? null : mean(costs as number[]),
    latencyMs: { p50: percentile(okMs, 50), p95: percentile(okMs, 95) },
    hardCases: HARD_CASES.map((tag) => {
      const tagged = rows.filter((r) => r.ticket.hardCases.includes(tag));
      return {
        tag,
        tickets: tagged.length,
        intentAccuracy: accuracy(tagged.map((r) => r.intent)),
        escalationAccuracy: accuracy(
          tagged.map((r) => r.escalation.gold === r.escalation.predicted),
        ),
        orderNumberExactMatch: accuracy(tagged.map((r) => r.orderNumber)),
      };
    }),
  };
}
