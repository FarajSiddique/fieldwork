import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "./config.ts";
import type { JevChecks, SystemSummary } from "./evaluate.ts";
import { writeText } from "./io.ts";
import { renderPilotReport } from "./report.ts";

// Re-renders pilot.md from the committed pilot.json, for report changes. Loads no model client.
const run = JSON.parse(await readFile(join(paths.results, "pilot.json"), "utf8")) as {
  split: string;
  seed: number;
  summaries: SystemSummary[];
  checks: JevChecks;
};
const report = renderPilotReport(run.summaries, run.checks, {
  split: run.split,
  tickets: run.summaries[0]!.tickets,
  seed: run.seed,
});
await writeText(join(paths.results, "pilot.md"), report);
console.log(report);
