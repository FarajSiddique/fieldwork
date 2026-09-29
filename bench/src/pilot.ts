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
import type { Prediction } from "./systems/types.ts";

// Every model goes through Vercel AI Gateway, authenticated by AI_GATEWAY_API_KEY.
const GATEWAY_TYPESAFE_URL = "https://ai-gateway.vercel.sh/typesafe";
const JEV = process.env.BENCH_JEV_MODEL ?? JEV_MODEL;
// Comma-separated AI Gateway model ids; each becomes one structured-output baseline.
const BASELINE_MODELS = (process.env.BENCH_BASELINE_MODELS ?? "openai/gpt-5.4-mini")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id !== "");
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 8);

// The pilot reads only the dev split. The test split is run once, in M4, after tuning is frozen.
const tickets = await readJsonl<BitextTicket>(paths.dev);
const prices = JSON.parse(await readFile(paths.prices, "utf8")) as PriceTable;
const cache = new ResponseCache(paths.cache);

// "cache-only" lets a fully cached rerun work without keys, as TypeSafe's cookbooks do.
const client = new TypeSafeClient({
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "cache-only",
  baseURL: GATEWAY_TYPESAFE_URL,
  defaultModel: JEV,
  logLevel: "warn",
});

const jev = await mapLimit(tickets, CONCURRENCY, (t) => runJev(t, client, cache, JEV));
const structured: Prediction[][] = [];
for (const modelId of BASELINE_MODELS) {
  const system = { name: modelId, model: modelId, modelId };
  structured.push(await mapLimit(tickets, CONCURRENCY, (t) => runStructured(t, system, cache)));
}

const summaries = [
  summarize("jev", tickets, jev, prices, SEED),
  ...BASELINE_MODELS.map((id, i) => summarize(id, tickets, structured[i]!, prices, SEED)),
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
    { split: "dev", seed: SEED, summaries, checks, predictions: [...jev, ...structured.flat()] },
    null,
    2,
  ) + "\n",
);
await writeText(join(paths.results, "pilot.md"), report);
console.log(report);
