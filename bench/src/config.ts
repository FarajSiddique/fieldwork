import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SEED = 20260928;

const root = fileURLToPath(new URL("..", import.meta.url));

export const paths = {
  raw: join(root, ".data", "bitext.csv"),
  dev: join(root, "data", "bitext-dev.jsonl"),
  test: join(root, "data", "bitext-test.jsonl"),
  written: join(root, "data", "written.jsonl"),
  cache: join(root, "cache"),
  results: join(root, "results"),
  prices: join(root, "prices.json"),
};

/** Every model is called through Vercel AI Gateway, authenticated by AI_GATEWAY_API_KEY. */
export const GATEWAY_TYPESAFE_URL = "https://ai-gateway.vercel.sh/typesafe";

export type Split = "dev" | "test";

/** The benchmark's models, as AI Gateway ids. */
export interface BenchModels {
  jev: string;
  /** Fieldwork's `low` tier, which writes replies. */
  textLow: string;
  /** Fieldwork's `high` tier, which writes escalation notes. */
  textHigh: string;
  /** The frontier single-call baseline. */
  frontier: string;
  /** The cheap single-call baseline. */
  cheap: string;
  /** Judges reply quality; its provider must not be one any system generates with. */
  judge: string;
}

export const DEFAULT_MODELS: BenchModels = {
  jev: "typesafe-ai/jev",
  textLow: "anthropic/claude-haiku-4.5",
  textHigh: "anthropic/claude-sonnet-5.5",
  frontier: "anthropic/claude-opus-5.5",
  cheap: "anthropic/claude-haiku-4.5",
  judge: "openai/gpt-5.5",
};

const providerOf = (id: string) => id.split("/")[0]!;

type Env = Record<string, string | undefined>;

/** The bench's models: BENCH_* variables over the defaults. */
export function benchModels(env: Env = process.env): BenchModels {
  const models: BenchModels = {
    jev: env.BENCH_JEV_MODEL ?? DEFAULT_MODELS.jev,
    textLow: env.BENCH_TEXT_LOW_MODEL ?? DEFAULT_MODELS.textLow,
    textHigh: env.BENCH_TEXT_HIGH_MODEL ?? DEFAULT_MODELS.textHigh,
    frontier: env.BENCH_FRONTIER_MODEL ?? DEFAULT_MODELS.frontier,
    cheap: env.BENCH_CHEAP_MODEL ?? DEFAULT_MODELS.cheap,
    judge: env.BENCH_JUDGE_MODEL ?? DEFAULT_MODELS.judge,
  };

  // The spec asks for a judge from a model family not used for generation.
  const generating = [models.textLow, models.textHigh, models.frontier, models.cheap];
  if (generating.map(providerOf).includes(providerOf(models.judge))) {
    throw new Error(
      `The reply judge ${models.judge} shares a provider with a generating model; choose another family`,
    );
  }
  return models;
}

/**
 * The split a bench command runs on. The test split is run once, after tuning is frozen, so it
 * needs BENCH_ALLOW_TEST=1, which only the owner's decision sets (see the bench-runbook skill).
 */
export function benchSplit(arg: string | undefined, env: Env = process.env): Split {
  const split = arg ?? "dev";
  if (split !== "dev" && split !== "test") {
    throw new Error(`Unknown split "${split}"; use dev or test.`);
  }
  if (split === "test" && env.BENCH_ALLOW_TEST !== "1") {
    throw new Error(
      "The test split is run once, after tuning is frozen. Set BENCH_ALLOW_TEST=1 only after the owner has decided to spend it.",
    );
  }
  return split;
}
