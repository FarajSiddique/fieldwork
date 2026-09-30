import type { BenchRun } from "./benchRun.ts";
import type { Interval, JevChecks, SystemSummary } from "./evaluate.ts";
import type { WrittenSummary } from "./evaluateWritten.ts";
import type { TriagePrediction } from "./systems/prediction.ts";
import { HARD_CASES } from "./written.ts";

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");
const num = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");
const ms = (x: number) => (Number.isFinite(x) ? String(x) : "n/a");
const withCi = (i: Interval, f: (x: number) => string) =>
  `${f(i.value)} (${f(i.ci[0])}–${f(i.ci[1])})`;
const usd = (x: number | null) =>
  x === null ? "n/a (price missing)" : Number.isFinite(x) ? `$${x.toFixed(6)}` : "n/a";
const pass = (ok: boolean) => (ok ? "pass" : "FAIL");

/** The Bitext metrics, one column per system; shared by the pilot and the benchmark. */
export function renderBitextTable(summaries: readonly SystemSummary[]): string[] {
  const row = (label: string, cell: (s: SystemSummary) => string) =>
    `| ${label} | ${summaries.map(cell).join(" | ")} |`;
  const atCoverage = (s: SystemSummary, c: number) =>
    pct(s.categoryAccuracyAtCoverage.find((x) => x.coverage === c)?.accuracy ?? Number.NaN);

  return [
    `| Metric | ${summaries.map((s) => s.system).join(" | ")} |`,
    `|---|${summaries.map(() => "---").join("|")}|`,
    row("Models", (s) => s.models.join(", ") || "n/a"),
    row("Failed predictions", (s) => String(s.failed)),
    row("Intent accuracy", (s) => withCi(s.intentAccuracy, pct)),
    row("Category accuracy", (s) => withCi(s.categoryAccuracy, pct)),
    row("Category macro-F1", (s) => num(s.categoryMacroF1)),
    row("Intent AUROC", (s) => withCi(s.intentAuroc, num)),
    row("Category AUROC", (s) => withCi(s.categoryAuroc, num)),
    row("Intent ECE", (s) => num(s.intentEce)),
    row("Category ECE", (s) => num(s.categoryEce)),
    ...[0.9, 0.8, 0.7].map((c) =>
      row(`Category accuracy at ${c * 100}% coverage`, (s) => atCoverage(s, c)),
    ),
    row(
      "Order number exact match (tickets with candidates)",
      (s) => `${pct(s.orderNumber.exactMatchWithCandidates)} of ${s.orderNumber.withCandidates}`,
    ),
    row("Order number exact match (all)", (s) => pct(s.orderNumber.exactMatchAll)),
    row("Cost per ticket", (s) => usd(s.costPerTicketUsd)),
    row("Latency p50 / p95", (s) => `${ms(s.latencyMs.p50)} / ${ms(s.latencyMs.p95)} ms`),
  ];
}

export function renderPilotReport(
  summaries: readonly SystemSummary[],
  checks: JevChecks,
  meta: { split: string; tickets: number; seed: number },
): string {
  return [
    "# Pilot results",
    "",
    `Split: ${meta.split} (${meta.tickets} tickets), seed ${meta.seed}. Intervals are 95% bootstrap intervals. AUROC is the chance a correct answer is more confident than a wrong one.`,
    "",
    ...renderBitextTable(summaries),
    "",
    "## SDK checks",
    "",
    `- One jev model id: ${checks.modelIds.join(", ") || "none"} (${pass(checks.oneModel)}; AI Gateway does not report the jev version)`,
    `- Every jev answer served by typesafe-ai: ${checks.providers.join(", ") || "none"} (${pass(checks.onlyTypeSafe)})`,
    `- Token usage on every jev response: ${pass(checks.usageReported)}`,
    "",
  ].join("\n");
}

function writtenTable(summaries: readonly WrittenSummary[]): string[] {
  const row = (label: string, cell: (s: WrittenSummary) => string) =>
    `| ${label} | ${summaries.map(cell).join(" | ")} |`;

  return [
    `| Metric | ${summaries.map((s) => s.system).join(" | ")} |`,
    `|---|${summaries.map(() => "---").join("|")}|`,
    row("Failed predictions", (s) => String(s.failed)),
    row("Predictions with a failed field", (s) => String(s.partialFailures)),
    row("Escalation recall", (s) => withCi(s.escalationRecall, pct)),
    row("Escalation precision", (s) => withCi(s.escalationPrecision, pct)),
    row("Intent accuracy", (s) => withCi(s.intentAccuracy, pct)),
    row("Complexity accuracy", (s) => withCi(s.complexityAccuracy, pct)),
    row("isRepeat accuracy", (s) => withCi(s.isRepeatAccuracy, pct)),
    row("Order number exact match", (s) => withCi(s.orderNumberExactMatch, pct)),
    row("Cost per ticket", (s) => usd(s.costPerTicketUsd)),
    row("Latency p50 / p95", (s) => `${ms(s.latencyMs.p50)} / ${ms(s.latencyMs.p95)} ms`),
  ];
}

function hardCaseTable(summaries: readonly WrittenSummary[]): string[] {
  return [
    `| Weak spot | Tickets | ${summaries.map((s) => s.system).join(" | ")} |`,
    `|---|---|${summaries.map(() => "---").join("|")}|`,
    ...HARD_CASES.map((tag) => {
      const tickets = summaries[0]?.hardCases.find((h) => h.tag === tag)?.tickets ?? 0;
      const cells = summaries.map((s) => {
        const h = s.hardCases.find((x) => x.tag === tag);
        return h
          ? `${pct(h.intentAccuracy)} / ${pct(h.escalationAccuracy)} / ${pct(h.orderNumberExactMatch)}`
          : "n/a";
      });
      return `| ${tag} | ${tickets} | ${cells.join(" | ")} |`;
    }),
  ];
}

function replyTable(run: BenchRun): string[] {
  return [
    "| Fieldwork vs | Pairs | Fieldwork wins | Ties | Baseline wins | Failed | Fieldwork win rate |",
    "|---|---|---|---|---|---|---|",
    ...run.replies.map(
      (r) =>
        `| ${r.baseline} | ${r.pairs} | ${r.fieldworkWins} | ${r.ties} | ${r.baselineWins} | ${r.failed} | ${withCi(r.winRate, pct)} |`,
    ),
  ];
}

/** Every failed prediction and failed field, counted by system and error. */
function failureLines(predictions: readonly TriagePrediction[]): string[] {
  const counts = new Map<string, number>();
  for (const p of predictions) {
    const errors = p.status === "failed" ? [p.error ?? "unknown error"] : p.fieldErrors;
    for (const error of errors) {
      const key = `${p.system}: ${error}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return ["None."];
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `- ${key} (${n})`);
}

export function renderBenchReport(run: BenchRun): string {
  const { models } = run;

  return [
    `# Benchmark results: ${run.split} split`,
    "",
    `Seed ${run.seed}. Intervals are 95% bootstrap intervals. n/a means undefined, for example recall when no ticket needs escalation, or a cost with a price missing.`,
    "",
    "## Systems",
    "",
    `- **fieldwork**: the triage schema. jev \`${models.jev}\`; replies by \`${models.textLow}\`; escalation notes by \`${models.textHigh}\`.`,
    `- **frontier**: one structured-output call to \`${models.frontier}\` for every field.`,
    `- **cheap**: the same call to \`${models.cheap}\`.`,
    `- Reply judge: \`${models.judge}\`, from a provider no system generates with.`,
    "",
    `## Bitext set (${run.bitext[0]?.tickets ?? 0} tickets)`,
    "",
    "Intent, category, confidence and the pick. AUROC is the chance a correct answer is more confident than a wrong one.",
    "",
    ...renderBitextTable(run.bitext),
    "",
    `## Written set (${run.written[0]?.tickets ?? 0} synthetic tickets)`,
    "",
    "Hand-written and hand-labeled by bench/data/LABELING.md. A ticket escalates when the system does not answer the customer.",
    "",
    ...writtenTable(run.written),
    "",
    "## Hard cases",
    "",
    "Too few tickets per weak spot to resample. Each cell is intent / escalation / order-number accuracy.",
    "",
    ...hardCaseTable(run.written),
    "",
    "## Reply quality",
    "",
    `Blind pairwise judgment by \`${models.judge}\` on written tickets where both systems answered the customer. The order of the two replies is fixed per ticket and hidden from the judge. A tie counts as half a win.`,
    "",
    ...replyTable(run),
    "",
    "## Failures",
    "",
    ...failureLines(run.predictions),
    "",
    "## Notes",
    "",
    "- A failed prediction counts as wrong and as escalated: a person handles any ticket a system could not.",
    "- The baselines escalate by the same rule as Fieldwork's schema, applied to their own answers. Their category confidence is their intent confidence, a lower bound, since they give no per-intent probabilities.",
    "- The baselines write both the reply and the escalation note in their one call; the extra output is in their cost.",
    "- Cached calls are replayed with their original latency, so latency is the live run's.",
    "",
  ].join("\n");
}
