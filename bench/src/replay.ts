import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import { cacheKey, CacheMiss, type ResponseCache } from "./cache.ts";
import { JEV_PROVIDER } from "./systems/jev.ts";

/** The TypeSafe SDK's `fetch` signature. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** An AI SDK model object; a model id string cannot be wrapped. */
export type Model = Exclude<LanguageModel, string>;

/** How many of one Fieldwork run's calls were served from the cache, and how many went live. */
export interface Tally {
  replayed: number;
  live: number;
}

export interface ReplayOptions {
  /**
   * Wait each cached call's original latency before answering, so a replayed run's trace and
   * deadline behave as the live run's did. A dry run turns it off.
   */
  delay: boolean;
}

/** Resolve after `ms`, or reject with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface CachedHttp {
  status: number;
  body: string;
}

const respond = (value: CachedHttp) =>
  new Response(value.body, {
    status: value.status,
    headers: { "content-type": "application/json" },
  });

/**
 * A `fetch` for `TypeSafeClient` that serves systemOne requests from the response cache. It adds
 * the pilot's routing restriction, so every call reaches TypeSafe's own deployment. Only 2xx
 * responses are cached: a 429 or 5xx goes back to the SDK, which retries it, and the next run
 * sends it again.
 */
export function replayFetch(
  cache: ResponseCache,
  tally: Tally,
  options: ReplayOptions & { fetch?: Fetch },
): Fetch {
  const send = options.fetch ?? fetch;

  return async (input, init) => {
    const body: Record<string, unknown> = {
      ...(JSON.parse(String(init?.body)) as Record<string, unknown>),
      providerOptions: { gateway: { only: [JEV_PROVIDER] } },
    };
    const request = { system: "fieldwork-jev", model: body.model, body };
    const key = cacheKey(request);

    const cached = await cache.get<CachedHttp>(key);
    if (cached) {
      tally.replayed++;
      if (options.delay) await sleep(cached.ms, init?.signal);
      return respond(cached.value);
    }

    // A dry run answers with a status the SDK does not retry, so each miss is counted once.
    if (cache.offline) {
      cache.missed.set(key, request);
      return new Response(JSON.stringify({ error: { message: "not in the cache (dry run)" } }), {
        status: 400,
      });
    }

    tally.live++;
    const started = performance.now();
    const response = await send(input, { ...init, body: JSON.stringify(body) });
    if (!response.ok) return response;

    const value = { status: response.status, body: await response.text() };
    await cache.set(key, { value, ms: Math.round(performance.now() - started) });
    return respond(value);
  };
}

type GenerateResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>>;
type CachedGenerate = Pick<GenerateResult, "content" | "finishReason" | "usage">;

/**
 * Wrap an AI SDK model so its generations are served from the response cache. Only a returned
 * result is cached; a generation that throws is not, so the next run tries it again.
 */
export function replayModel(
  model: Model,
  cache: ResponseCache,
  tally: Tally,
  options: ReplayOptions,
): Model {
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params, model: inner }) => {
      // The signal and headers don't change the answer, and a signal doesn't serialize.
      const request = {
        system: "fieldwork-text",
        model: inner.modelId,
        params: { ...params, abortSignal: undefined, headers: undefined },
      };
      const key = cacheKey(request);

      const cached = await cache.get<CachedGenerate>(key);
      if (cached) {
        tally.replayed++;
        if (options.delay) await sleep(cached.ms, params.abortSignal);
        return { ...cached.value, warnings: [] };
      }

      if (cache.offline) {
        cache.missed.set(key, request);
        throw new CacheMiss("not in the cache (dry run)");
      }

      tally.live++;
      const started = performance.now();
      const result = await doGenerate();
      const value: CachedGenerate = {
        content: result.content,
        finishReason: result.finishReason,
        usage: result.usage,
      };
      await cache.set(key, { value, ms: Math.round(performance.now() - started) });
      return result;
    },
  };

  return wrapLanguageModel({ model, middleware });
}
