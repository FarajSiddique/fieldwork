import { expect, it } from "vitest";
import type { SystemSummary } from "../src/evaluate.ts";
import { renderPilotReport } from "../src/report.ts";

const summary: SystemSummary = {
  system: "jev",
  models: ["jev-1.13.0"],
  tickets: 270,
  failed: 0,
  intentAccuracy: { value: 0.9, ci: [0.86, 0.93] },
  categoryAccuracy: { value: 0.95, ci: [0.92, 0.97] },
  categoryMacroF1: 0.94,
  intentAuroc: { value: 0.81, ci: [0.74, 0.88] },
  categoryAuroc: { value: Number.NaN, ci: [Number.NaN, Number.NaN] },
  intentEce: 0.04,
  categoryEce: 0.03,
  categoryAccuracyAtCoverage: [
    { coverage: 1, accuracy: 0.95 },
    { coverage: 0.9, accuracy: 0.98 },
    { coverage: 0.8, accuracy: 0.99 },
    { coverage: 0.7, accuracy: 1 },
  ],
  orderNumber: { withCandidates: 60, exactMatchWithCandidates: 0.97, exactMatchAll: 0.99 },
  costPerTicketUsd: null,
  latencyMs: { p50: 180, p95: 320 },
};

it("renders a table with one column per system and the SDK checks", () => {
  const md = renderPilotReport(
    [summary, { ...summary, system: "cheap-structured" }],
    { versionedModelIds: ["jev-1.13.0"], allVersioned: true, usageReported: true },
    { split: "dev", tickets: 270, seed: 20260928 },
  );
  expect(md).toContain("| Metric | jev | cheap-structured |");
  expect(md).toContain("90.0% (86.0%–93.0%)");
  expect(md).toContain("n/a (n/a–n/a)");
  expect(md).toContain("n/a (price missing)");
  expect(md).toContain("97.0% of 60");
  expect(md).toContain("180 / 320 ms");
  expect(md).toContain("- Versioned jev model ids: jev-1.13.0 (pass)");
});
