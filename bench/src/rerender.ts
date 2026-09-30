import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BenchRun } from "./benchRun.ts";
import { paths } from "./config.ts";
import type { JevChecks, SystemSummary } from "./evaluate.ts";
import { writeText } from "./io.ts";
import { renderBenchReport, renderPilotReport } from "./report.ts";

// Re-renders a report from its committed JSON, for report changes. Loads no model client.
// `pnpm report` re-renders the pilot; `pnpm report bench-dev` a benchmark run.
const name = process.argv[2] ?? "pilot";
const run = JSON.parse(await readFile(join(paths.results, `${name}.json`), "utf8")) as unknown;

let report: string;
if (name === "pilot") {
  const pilot = run as {
    split: string;
    seed: number;
    summaries: SystemSummary[];
    checks: JevChecks;
  };
  report = renderPilotReport(pilot.summaries, pilot.checks, {
    split: pilot.split,
    tickets: pilot.summaries[0]!.tickets,
    seed: pilot.seed,
  });
} else {
  report = renderBenchReport(run as BenchRun);
}

await writeText(join(paths.results, `${name}.md`), report);
console.log(report);
