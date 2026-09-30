import { join } from "node:path";
import type { BitextTicket } from "./bitext/sample.ts";
import { cacheKey } from "./cache.ts";
import { paths } from "./config.ts";
import { readJsonl } from "./io.ts";
import { JEV_MODEL, jevCacheRequest } from "./systems/jev.ts";
import { structuredCacheRequest } from "./systems/structured.ts";

// Prints the cache file of each system's call for one ticket, to inspect what a model answered.
const JEV = process.env.BENCH_JEV_MODEL ?? JEV_MODEL;
const BASELINE_MODELS = (process.env.BENCH_BASELINE_MODELS ?? "openai/gpt-5.4-mini")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id !== "");

const id = process.argv[2];
const tickets = [
  ...(await readJsonl<BitextTicket>(paths.dev)),
  ...(await readJsonl<BitextTicket>(paths.test)),
];
const ticket = tickets.find((t) => t.id === id);
if (!ticket) {
  console.error(`No Bitext ticket with id "${id}".`);
  process.exit(2);
}

const file = (request: unknown) => join(paths.cache, `${cacheKey(request)}.json`);
console.log(`jev ${JEV}: ${file(jevCacheRequest(ticket.text, JEV))}`);
for (const modelId of BASELINE_MODELS) {
  console.log(`structured ${modelId}: ${file(structuredCacheRequest(ticket.text, modelId))}`);
}
