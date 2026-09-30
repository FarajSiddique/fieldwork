import type { BitextTicket } from "./bitext/sample.ts";
import type { BackoffOptions } from "./backoff.ts";
import type { ResponseCache } from "./cache.ts";
import { mapLimit } from "./concurrency.ts";
import type { BenchModels, Split } from "./config.ts";
import { summarize, type PriceTable, type SystemSummary } from "./evaluate.ts";
import { summarizeWritten, type WrittenSummary } from "./evaluateWritten.ts";
import { FIELDWORK, runFieldwork, type FieldworkFactory } from "./systems/fieldwork.ts";
import type { TriagePrediction } from "./systems/prediction.ts";
import {
  compareReplies,
  type JudgeSystem,
  type ReplyComparison,
  type Verdict,
} from "./systems/replyJudge.ts";
import type { StructuredSystem } from "./systems/structured.ts";
import { runTriageStructured } from "./systems/triageStructured.ts";
import type { WrittenTicket } from "./written.ts";

/** Everything one benchmark run produced; `results/<run>.json` holds it. */
export interface BenchRun {
  /** `bench-<split>`, the results files' name. */
  run: string;
  split: Split;
  seed: number;
  models: BenchModels;
  bitext: SystemSummary[];
  written: WrittenSummary[];
  replies: ReplyComparison[];
  /** The judge's verdict per ticket, by baseline. */
  verdicts: Record<string, Verdict[]>;
  predictions: TriagePrediction[];
}

export interface BenchContext {
  split: Split;
  seed: number;
  models: BenchModels;
  cache: ResponseCache;
  prices: PriceTable;
  concurrency: number;
  /** Retries for the baselines and the judge; absent means none. */
  backoff?: BackoffOptions;
  fieldwork: FieldworkFactory;
  frontier: StructuredSystem;
  cheap: StructuredSystem;
  judge: JudgeSystem;
}

/** Run every system on both sets, score each set separately, and judge the replies. */
export async function runBench(
  bitext: readonly BitextTicket[],
  written: readonly WrittenTicket[],
  ctx: BenchContext,
): Promise<BenchRun> {
  const tickets = [...bitext, ...written];
  if (new Set(tickets.map((t) => t.id)).size !== tickets.length) {
    throw new Error("Ticket ids repeat across the sets");
  }

  const systems = [
    {
      name: FIELDWORK,
      predictions: await mapLimit(tickets, ctx.concurrency, (t) => runFieldwork(t, ctx.fieldwork)),
    },
  ];
  for (const baseline of [ctx.frontier, ctx.cheap]) {
    const predictions = await mapLimit(tickets, ctx.concurrency, (t) =>
      runTriageStructured(t, baseline, ctx.cache, ctx.prices, ctx.backoff),
    );
    systems.push({ name: baseline.name, predictions });
  }

  const bitextIds = new Set(bitext.map((t) => t.id));
  const onBitext = (ps: readonly TriagePrediction[]) => ps.filter((p) => bitextIds.has(p.ticketId));
  const onWritten = (ps: readonly TriagePrediction[]) =>
    ps.filter((p) => !bitextIds.has(p.ticketId));

  const replies: ReplyComparison[] = [];
  const verdicts: Record<string, Verdict[]> = {};
  const [fieldwork, ...baselines] = systems;
  for (const baseline of baselines) {
    const result = await compareReplies(
      written,
      onWritten(fieldwork!.predictions),
      onWritten(baseline.predictions),
      {
        baseline: baseline.name,
        judge: ctx.judge,
        cache: ctx.cache,
        seed: ctx.seed,
        concurrency: ctx.concurrency,
        backoff: ctx.backoff,
      },
    );
    replies.push(result.comparison);
    verdicts[baseline.name] = result.verdicts;
  }

  return {
    run: `bench-${ctx.split}`,
    split: ctx.split,
    seed: ctx.seed,
    models: ctx.models,
    bitext: systems.map((s) =>
      summarize(s.name, bitext, onBitext(s.predictions), ctx.prices, ctx.seed),
    ),
    written: systems.map((s) =>
      summarizeWritten(s.name, written, onWritten(s.predictions), ctx.prices, ctx.seed),
    ),
    replies,
    verdicts,
    predictions: systems.flatMap((s) => s.predictions),
  };
}
