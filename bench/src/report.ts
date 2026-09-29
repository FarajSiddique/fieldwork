import type { Interval, JevChecks, SystemSummary } from "./evaluate.ts";

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");
const num = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");
const ms = (x: number) => (Number.isFinite(x) ? String(x) : "n/a");
const withCi = (i: Interval, f: (x: number) => string) =>
  `${f(i.value)} (${f(i.ci[0])}–${f(i.ci[1])})`;
const usd = (x: number | null) => (x === null ? "n/a (price missing)" : `$${x.toFixed(6)}`);
const pass = (ok: boolean) => (ok ? "pass" : "FAIL");

export function renderPilotReport(
  summaries: readonly SystemSummary[],
  checks: JevChecks,
  meta: { split: string; tickets: number; seed: number },
): string {
  const row = (label: string, cell: (s: SystemSummary) => string) =>
    `| ${label} | ${summaries.map(cell).join(" | ")} |`;
  const atCoverage = (s: SystemSummary, c: number) =>
    pct(s.categoryAccuracyAtCoverage.find((x) => x.coverage === c)?.accuracy ?? Number.NaN);

  return [
    "# Pilot results",
    "",
    `Split: ${meta.split} (${meta.tickets} tickets), seed ${meta.seed}. Intervals are 95% bootstrap intervals. AUROC is the chance a correct answer is more confident than a wrong one.`,
    "",
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
    "",
    "## SDK checks",
    "",
    `- One jev model id: ${checks.modelIds.join(", ") || "none"} (${pass(checks.oneModel)}; AI Gateway does not report the jev version)`,
    `- Every jev answer served by typesafe-ai: ${checks.providers.join(", ") || "none"} (${pass(checks.onlyTypeSafe)})`,
    `- Token usage on every jev response: ${pass(checks.usageReported)}`,
    "",
  ].join("\n");
}
