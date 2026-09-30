import { Timed } from "./cache.ts";
import { sleep } from "./replay.ts";

export interface BackoffOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseMs: number;
  maxMs: number;
  /** Injected for tests; default Math.random. */
  random?: () => number;
  /** Injected for tests; default `sleep` from replay.ts. */
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  signal?: AbortSignal | null;
}

/** What the real run uses; `BENCH_RETRIES` overrides the retry count. */
export const DEFAULT_BACKOFF = { retries: 6, baseMs: 1000, maxMs: 30_000 } as const;

/** `BENCH_RETRIES` as a retry count: unset gives the default, anything but a non-negative integer throws. */
export function retriesFromEnv(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_BACKOFF.retries;
  if (!/^\d+$/.test(value)) {
    throw new Error(`BENCH_RETRIES must be a non-negative integer, got "${value}"`);
  }

  return Number(value);
}

/**
 * Full-jitter delay before retry number `attempt` (0 for the first retry): `random()` times
 * `min(maxMs, baseMs * 2^attempt)`, raised to `retryAfterMs` when the server asked for longer.
 * A Retry-After is honoured but never past twice the cap.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  retryAfterMs?: number,
): number {
  const random = options.random ?? Math.random;
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** attempt);

  return Math.min(Math.max(random() * ceiling, retryAfterMs ?? 0), options.maxMs * 2);
}

export type Attempt<T> = { done: T } | { retry: unknown; retryAfterMs?: number };

/**
 * Call `attempt` until it returns `{ done }`, waiting a jittered, exponentially growing delay
 * between tries. A throw is final and is not retried. After `options.retries` retries, the last
 * `{ retry }` reason goes to `onGiveUp`, whose return value (or throw) is the result.
 */
export async function withBackoff<T>(
  attempt: () => Promise<Attempt<T>>,
  options: BackoffOptions,
  onGiveUp: (reason: unknown) => T,
): Promise<T> {
  const wait = options.sleep ?? sleep;

  for (let n = 0; ; n++) {
    const result = await attempt();
    if ("done" in result) return result.done;
    if (n >= options.retries) return onGiveUp(result.retry);

    await wait(backoffDelay(n, options, result.retryAfterMs), options.signal);
  }
}

/** No retries: what a caller without backoff options gets, so it behaves as before. */
export const NO_RETRIES: BackoffOptions = { retries: 0, baseMs: 0, maxMs: 0 };

/**
 * Run `fn`, retrying it with backoff when it throws a retryable error; any other error, or the
 * last retryable one, is thrown. Only the successful attempt is timed.
 */
export async function retryTimed<T>(
  options: BackoffOptions,
  fn: () => PromiseLike<T>,
): Promise<Timed<T>> {
  return withBackoff<Timed<T>>(
    async () => {
      const started = performance.now();
      try {
        const value = await fn();
        return { done: new Timed(value, Math.round(performance.now() - started)) };
      } catch (err) {
        if (!isRetryableError(err)) throw err;
        return { retry: err, retryAfterMs: retryAfterMs(err) };
      }
    },
    options,
    (err) => {
      throw err;
    },
  );
}

/** True for an HTTP status worth retrying: a timeout, a rate limit or a server error. */
export const isRetryableStatus = (status: unknown): boolean =>
  typeof status === "number" && (status === 408 || status === 429 || status >= 500);

const RATE_LIMIT_TEXT = /GatewayRateLimitError|rate limit|No access to this model at this time/i;

/**
 * Whether a thrown error is a transient gateway or provider failure: an AI SDK error that says
 * it is retryable, a retryable status, or a gateway rate limit. The AI SDK's own retry wrapper
 * (`AI_RetryError`) is looked through to its last error.
 */
export function isRetryableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    name?: unknown;
    message?: unknown;
    isRetryable?: unknown;
    statusCode?: unknown;
    lastError?: unknown;
  };

  if (e.isRetryable === true || isRetryableStatus(e.statusCode)) return true;
  if (RATE_LIMIT_TEXT.test(`${String(e.name)} ${String(e.message)}`)) return true;

  return e.lastError !== undefined && isRetryableError(e.lastError);
}

/** Parse a Retry-After header, in seconds or as an HTTP date, into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The wait a thrown error asks for through its `retry-after` response header, if any. */
export function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { responseHeaders?: Record<string, string>; lastError?: unknown };

  const header = e.responseHeaders?.["retry-after"] ?? e.responseHeaders?.["Retry-After"];
  return parseRetryAfter(header) ?? retryAfterMs(e.lastError);
}
