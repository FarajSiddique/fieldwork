import type { TypeSafeClient } from "@typesafe-ai/sdk";
import type { LanguageModel } from "ai";
import type { Prices, Trace } from "fieldwork";
import type { Tally } from "../replay.ts";
import { escalates, triage, type TriageResults } from "../triage.ts";
import type { TriagePrediction } from "./prediction.ts";

export const FIELDWORK = "fieldwork";

export interface FieldworkSystem {
  typesafe: TypeSafeClient;
  /** `low` writes replies, `high` writes escalation notes. */
  models: { low: LanguageModel; high: LanguageModel };
  prices: Prices;
  jevModel: string;
  deadlineMs: number;
}

/** Builds one ticket's clients; `tally` counts that ticket's replayed and live calls. */
export type FieldworkFactory = (tally: Tally) => FieldworkSystem;

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

function toPrediction(
  ticketId: string,
  fields: TriageResults,
  trace: Trace,
  tally: Tally,
  jevModel: string,
): TriagePrediction {
  const calls = [...trace.steps.flatMap((s) => s.calls), ...(trace.grading?.calls ?? [])];
  const jev = calls.find((c) => c.worker === "jev" && c.status === "ok");
  const { intent, category, complexity, isRepeat, orderNumber, reply, escalationNote } = fields;

  const common = {
    system: FIELDWORK,
    ticketId,
    model: jev?.model ?? jevModel,
    provider: null,
    ms: trace.totalMs,
    inputTokens: sum(calls.map((c) => c.inputTokens)),
    outputTokens: sum(calls.map((c) => c.outputTokens)),
    cached: tally.live === 0,
    estCostUsd: trace.estCostUsd,
    complexity: complexity.status === "filled" ? complexity.score : null,
    complexityConfidence: complexity.status === "filled" ? complexity.confidence : 0,
    isRepeat: isRepeat.status === "filled" ? isRepeat.noul >= 0.5 : null,
    escalates: escalates(fields),
    reply: reply.status === "filled" ? reply.value : null,
    escalationNote: escalationNote.status === "filled" ? escalationNote.value : null,
    fieldErrors: Object.entries(fields).flatMap(([name, r]) =>
      r.status === "failed" ? [`${name}: ${r.error.code}`] : [],
    ),
  };

  // Without an intent there is nothing to score; the ticket goes to a person.
  if (intent.status !== "filled") {
    return {
      ...common,
      status: "failed",
      error:
        intent.status === "failed"
          ? `${intent.error.code}: ${intent.error.message}`.slice(0, 200)
          : `intent ${intent.status}`,
      intent: null,
      intentConfidence: 0,
      category: null,
      categoryConfidence: 0,
      orderNumber: null,
      orderNumberConfidence: 0,
    };
  }

  const rolledUp = category.status === "filled" ? category.value : null;
  return {
    ...common,
    status: "ok",
    error: null,
    intent: intent.choice,
    intentConfidence: intent.confidence,
    category: rolledUp?.category ?? null,
    categoryConfidence: rolledUp?.probability ?? 0,
    orderNumber: orderNumber.status === "filled" ? orderNumber.value : null,
    orderNumberConfidence: orderNumber.status === "filled" ? orderNumber.confidence : 0,
  };
}

/** Run the triage schema on one ticket. Only a definition mistake throws; failures are fields. */
export async function runFieldwork(
  ticket: { id: string; text: string },
  factory: FieldworkFactory,
): Promise<TriagePrediction> {
  const tally: Tally = { replayed: 0, live: 0 };
  const system = factory(tally);

  const { fields, trace } = await triage.run(
    { ticket: ticket.text },
    {
      typesafe: system.typesafe,
      models: system.models,
      prices: system.prices,
      jevModel: system.jevModel,
      deadlineMs: system.deadlineMs,
    },
  );

  return toPrediction(ticket.id, fields, trace, tally, system.jevModel);
}
