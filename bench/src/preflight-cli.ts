import { readFile } from "node:fs/promises";
import type { BitextTicket } from "./bitext/sample.ts";
import { ResponseCache } from "./cache.ts";
import { paths } from "./config.ts";
import type { PriceTable } from "./evaluate.ts";
import { readJsonl } from "./io.ts";
import { preflightSystem, renderPreflight, type SystemPreflight } from "./preflight.ts";
import { JEV_MODEL, jevCacheRequest } from "./systems/jev.ts";
import { structuredCacheRequest } from "./systems/structured.ts";

// Reads the same environment as the pilot, so it predicts exactly what the pilot would call.
const JEV = process.env.BENCH_JEV_MODEL ?? JEV_MODEL;
const BASELINE_MODELS = (process.env.BENCH_BASELINE_MODELS ?? "openai/gpt-5.4-mini")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id !== "");

const split = process.argv[2] ?? "dev";
if (split !== "dev" && split !== "test") {
  console.error(`Unknown split "${split}"; use dev or test.`);
  process.exit(2);
}

const tickets = await readJsonl<BitextTicket>(paths[split]);
const prices = JSON.parse(await readFile(paths.prices, "utf8")) as PriceTable;
const cache = new ResponseCache(paths.cache);

const rows: SystemPreflight[] = [
  await preflightSystem({
    system: "jev",
    model: JEV,
    requests: tickets.map((t) => jevCacheRequest(t.text, JEV)),
    cache,
    prices,
    tokensOf: (v) => {
      const usage = (v as { usage: { input_tokens: number; output_tokens: number } }).usage;
      return { input: usage.input_tokens, output: usage.output_tokens };
    },
    guessOutputTokens: 0,
  }),
];
for (const modelId of BASELINE_MODELS) {
  rows.push(
    await preflightSystem({
      system: "structured",
      model: modelId,
      requests: tickets.map((t) => structuredCacheRequest(t.text, modelId)),
      cache,
      prices,
      tokensOf: (v) => {
        const call = v as { inputTokens: number; outputTokens: number };
        return { input: call.inputTokens, output: call.outputTokens };
      },
      guessOutputTokens: 200,
    }),
  );
}

console.log(renderPreflight(split, rows));
if (rows.some((r) => r.live > 0) && !process.env.AI_GATEWAY_API_KEY) {
  console.log("Warning: live calls needed but AI_GATEWAY_API_KEY is not set; they would fail.");
}
if (split === "test") {
  console.log("Warning: the test split is run once, after tuning is frozen.");
}
