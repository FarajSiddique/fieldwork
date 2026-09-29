import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { BitextTicket } from "./bitext/sample.ts";
import { ResponseCache } from "./cache.ts";
import { mapLimit } from "./concurrency.ts";
import { paths, SEED } from "./config.ts";
import { jevChecks, summarize, type PriceTable } from "./evaluate.ts";
import { readJsonl, writeText } from "./io.ts";
import { renderPilotReport } from "./report.ts";
import { JEV_MODEL, runJev } from "./systems/jev.ts";
import { runStructured } from "./systems/structured.ts";

const CHEAP_MODEL = process.env.BENCH_CHEAP_MODEL ?? "openai/gpt-5.4-mini";
const CONCURRENCY = 8;

// The pilot reads only the dev split. The test split is run once, in M4, after tuning is frozen.
const tickets = await readJsonl<BitextTicket>(paths.dev);
const prices = JSON.parse(await readFile(paths.prices, "utf8")) as PriceTable;
const cache = new ResponseCache(paths.cache);

// "cache-only" lets a fully cached rerun work without keys, as TypeSafe's cookbooks do.
const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? "cache-only",
  defaultModel: JEV_MODEL,
  logLevel: "warn",
});
const cheap = { name: "cheap-structured", model: CHEAP_MODEL, modelId: CHEAP_MODEL };

const jev = await mapLimit(tickets, CONCURRENCY, (t) => runJev(t, client, cache));
const structured = await mapLimit(tickets, CONCURRENCY, (t) => runStructured(t, cheap, cache));

const summaries = [
  summarize("jev", tickets, jev, prices, SEED),
  summarize(cheap.name, tickets, structured, prices, SEED),
];
const checks = jevChecks(jev);
const report = renderPilotReport(summaries, checks, {
  split: "dev",
  tickets: tickets.length,
  seed: SEED,
});

await writeText(
  join(paths.results, "pilot.json"),
  JSON.stringify(
    { split: "dev", seed: SEED, summaries, checks, predictions: [...jev, ...structured] },
    null,
    2,
  ) + "\n",
);
await writeText(join(paths.results, "pilot.md"), report);
console.log(report);
