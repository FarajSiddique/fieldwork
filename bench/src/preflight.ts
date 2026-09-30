import { cacheKey, stableStringify, type ResponseCache } from "./cache.ts";
import type { PriceTable } from "./evaluate.ts";

export interface Tokens {
  input: number;
  output: number;
}

export interface SystemPreflight {
  system: string;
  model: string;
  calls: number;
  cached: number;
  live: number;
  /** Estimated spend for the live calls; null when the model has no price. */
  estLiveCostUsd: number | null;
  /** How the estimate was made: from cached calls' usage, or roughly from request size. */
  basis: "cached usage" | "request size" | "none";
}

/** Rough tokens for a call never made: about 3 characters per input token, a fixed output allowance. */
export function guessTokens(request: unknown, outputTokens: number): Tokens {
  return { input: Math.ceil(stableStringify(request).length / 3), output: outputTokens };
}

/**
 * Count the requests a run would serve from the cache and the ones it would send live, and
 * estimate what the live ones cost. Makes no network calls.
 */
export async function preflightSystem(options: {
  system: string;
  model: string;
  requests: readonly unknown[];
  cache: ResponseCache;
  prices: PriceTable;
  tokensOf: (value: unknown) => Tokens;
  /** Output tokens assumed per live call when no call is cached to learn from. */
  guessOutputTokens: number;
}): Promise<SystemPreflight> {
  const { system, model, requests, cache, prices, tokensOf, guessOutputTokens } = options;
  const cachedTokens: Tokens[] = [];
  const live: unknown[] = [];
  for (const request of requests) {
    const entry = await cache.get(cacheKey(request));
    if (entry) cachedTokens.push(tokensOf(entry.value));
    else live.push(request);
  }

  const price = prices[model];
  const cost = (t: Tokens) =>
    price ? (t.input * price.inputPerMTok + t.output * price.outputPerMTok) / 1e6 : 0;
  let estLiveCostUsd: number | null = null;
  let basis: SystemPreflight["basis"] = "none";
  if (live.length === 0) {
    estLiveCostUsd = 0;
  } else if (price && cachedTokens.length > 0) {
    const meanCost = cachedTokens.reduce((sum, t) => sum + cost(t), 0) / cachedTokens.length;
    estLiveCostUsd = meanCost * live.length;
    basis = "cached usage";
  } else if (price) {
    estLiveCostUsd = live.reduce<number>(
      (sum, r) => sum + cost(guessTokens(r, guessOutputTokens)),
      0,
    );
    basis = "request size";
  }

  return {
    system,
    model,
    calls: requests.length,
    cached: cachedTokens.length,
    live: live.length,
    estLiveCostUsd,
    basis,
  };
}

export function renderPreflight(split: string, rows: readonly SystemPreflight[]): string {
  const usd = (v: number | null) => (v === null ? "no price" : `$${v.toFixed(4)}`);
  const lines = [
    `Preflight: ${split} split. No calls were made.`,
    "",
    "| System | Model | Calls | Cached | Live | Est. live cost | Basis |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.system} | ${r.model} | ${r.calls} | ${r.cached} | ${r.live} | ${usd(r.estLiveCostUsd)} | ${r.basis} |`,
    ),
  ];
  const known = rows.map((r) => r.estLiveCostUsd);
  const total = known.includes(null) ? null : known.reduce<number>((s, v) => s + (v ?? 0), 0);
  lines.push(
    "",
    `Live calls: ${rows.reduce((s, r) => s + r.live, 0)}. Estimated spend: ${usd(total)}.`,
  );
  return lines.join("\n") + "\n";
}

/** Output tokens assumed per missed call, by the cache request's `system`. */
const GUESS_OUTPUT: Record<string, number> = {
  "fieldwork-jev": 0,
  "fieldwork-text": 150,
  "triage-structured": 450,
  "reply-judge": 10,
};

/**
 * What a dry run could not serve from the cache, per system and model, with a cost guessed from
 * request size. Calls that depend on a missed call are never reached, so these are lower bounds.
 */
export function renderDryRun(
  split: string,
  missed: ReadonlyMap<string, unknown>,
  prices: PriceTable,
): string {
  const rows = new Map<
    string,
    { system: string; model: string; live: number; cost: number | null }
  >();
  for (const request of missed.values()) {
    const { system, model, modelId } = request as {
      system: string;
      model?: string;
      modelId?: string;
    };
    const id = model ?? modelId ?? "unknown";
    const row = rows.get(`${system} ${id}`) ?? { system, model: id, live: 0, cost: 0 };
    const price = prices[id];
    const tokens = guessTokens(request, GUESS_OUTPUT[system] ?? 200);

    row.live++;
    row.cost =
      row.cost === null || !price
        ? null
        : row.cost +
          (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1e6;
    rows.set(`${system} ${id}`, row);
  }

  const usd = (v: number | null) => (v === null ? "no price" : `$${v.toFixed(4)}`);
  const all = [...rows.values()];
  const total = all.some((r) => r.cost === null)
    ? null
    : all.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const spend = total === null ? "unknown, a model has no price" : `at least ${usd(total)}`;

  return [
    `Dry run: ${split} split. No calls were made and no results were written.`,
    "",
    "| System | Model | Live calls | Est. cost |",
    "|---|---|---|---|",
    ...all.map((r) => `| ${r.system} | ${r.model} | ${r.live} | ${usd(r.cost)} |`),
    "",
    `Live calls: at least ${missed.size}. Estimated spend: ${spend}.`,
    "Calls that depend on a missed call (Fieldwork's later steps and grading, and the reply judge) are not reached, so the true numbers are higher.",
    "",
  ].join("\n");
}
