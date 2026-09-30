import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { gateway } from "ai";
import type { Prices } from "fieldwork";
import type { BitextTicket } from "./bitext/sample.ts";
import { runBench } from "./benchRun.ts";
import { DEFAULT_BACKOFF, retriesFromEnv, type BackoffOptions } from "./backoff.ts";
import { ResponseCache } from "./cache.ts";
import {
  benchModels,
  benchSplit,
  GATEWAY_TYPESAFE_URL,
  missingPrices,
  paths,
  SEED,
  type Split,
} from "./config.ts";
import type { PriceTable } from "./evaluate.ts";
import { readJsonl, writeText } from "./io.ts";
import { renderDryRun } from "./preflight.ts";
import { replayFetch, replayModel } from "./replay.ts";
import { renderBenchReport } from "./report.ts";
import type { FieldworkFactory } from "./systems/fieldwork.ts";
import { renderSpotCheck } from "./systems/replyJudge.ts";
import { labeledSplit, loadWrittenSet } from "./written.ts";

// Usage: pnpm bench [dev|test] [--dry-run]. Every model is called through Vercel AI Gateway.
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
let split: Split;
try {
  split = benchSplit(args.find((a) => !a.startsWith("--")));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

const models = benchModels();
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 8);
// The spec's example uses 10 s; notes come from the mid model through a gateway, and a rate-limited
// call may wait out several backoff delays (up to 30 s each), so allow much more.
const DEADLINE_MS = 180_000;

let backoff: BackoffOptions;
try {
  backoff = { ...DEFAULT_BACKOFF, retries: retriesFromEnv(process.env.BENCH_RETRIES) };
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

const prices = JSON.parse(await readFile(paths.prices, "utf8")) as PriceTable;
const unpriced = missingPrices(models, prices);
if (unpriced.length > 0) {
  console.error(`No price for ${unpriced.join(", ")}: add them to bench/prices.json`);
  process.exit(2);
}

const cache = new ResponseCache(paths.cache, { offline: dryRun });
const bitext = await readJsonl<BitextTicket>(paths[split]);
const written = labeledSplit(await loadWrittenSet(paths.written), split);

// "cache-only" lets a fully cached rerun work without a key, as in the pilot.
const apiKey = process.env.AI_GATEWAY_API_KEY ?? "cache-only";
const fieldworkPrices: Prices = { jev: prices[models.jev], text: prices };
const replay = { delay: !dryRun, backoff };
const fieldwork: FieldworkFactory = (tally) => ({
  typesafe: new TypeSafeClient({
    apiKey,
    baseURL: GATEWAY_TYPESAFE_URL,
    defaultModel: models.jev,
    logLevel: "warn",
    // replayFetch retries with backoff; the SDK's own retries would multiply it.
    retry: { maxRetries: 0 },
    // The SDK's default 10 s timeout would cover replayFetch's whole retry loop; each attempt
    // has its own timeout there, so this one only needs to fit the backoff.
    timeout: DEADLINE_MS,
    fetch: replayFetch(cache, tally, replay),
  }),
  models: {
    low: replayModel(gateway(models.textLow), cache, tally, replay),
    high: replayModel(gateway(models.textHigh), cache, tally, replay),
  },
  prices: fieldworkPrices,
  jevModel: models.jev,
  deadlineMs: DEADLINE_MS,
});

const run = await runBench(bitext, written, {
  split,
  seed: SEED,
  models,
  cache,
  prices,
  concurrency: CONCURRENCY,
  backoff,
  fieldwork,
  frontier: { name: "frontier", model: models.frontier, modelId: models.frontier },
  cheap: { name: "cheap", model: models.cheap, modelId: models.cheap },
  judge: { model: models.judge, modelId: models.judge },
});

if (dryRun) {
  console.log(renderDryRun(split, cache.missed, prices));
  if (cache.missed.size > 0 && !process.env.AI_GATEWAY_API_KEY) {
    console.log("Warning: live calls needed but AI_GATEWAY_API_KEY is not set; they would fail.");
  }
} else {
  const report = renderBenchReport(run);
  await writeText(join(paths.results, `${run.run}.json`), JSON.stringify(run, null, 2) + "\n");
  await writeText(join(paths.results, `${run.run}.md`), report);
  await writeText(
    join(paths.results, `${run.run}-spotcheck.md`),
    renderSpotCheck(written, run.predictions, SEED),
  );
  console.log(report);
}
