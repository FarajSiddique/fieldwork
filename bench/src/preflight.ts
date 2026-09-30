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
function guessTokens(request: unknown, outputTokens: number): Tokens {
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
