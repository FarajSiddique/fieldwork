import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** JSON with object keys sorted at every level, so equal requests hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function cacheKey(request: unknown): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

export interface CacheEntry<T> {
  value: T;
  /** Latency of the original call, kept so reruns report it. */
  ms: number;
}

export class ResponseCache {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
    try {
      return JSON.parse(await readFile(this.#path(key), "utf8")) as CacheEntry<T>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async set<T>(key: string, entry: CacheEntry<T>): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    // Write, then rename into place, so an interrupted run never leaves a half-written entry
    // that every later run would fail to parse.
    const path = this.#path(key);
    const partial = `${path}.${process.pid}.partial`;
    await writeFile(partial, JSON.stringify(entry, null, 2) + "\n");
    await rename(partial, path);
  }

  #path(key: string): string {
    return join(this.#dir, `${key}.json`);
  }
}

/**
 * Serve `request` from the cache, or call `fn`, time it and cache the result. A call that throws
 * is never cached; a response that returns normally is, even if the caller later rejects it.
 */
export async function cachedCall<T>(
  cache: ResponseCache,
  request: unknown,
  fn: () => Promise<T>,
): Promise<CacheEntry<T> & { hit: boolean }> {
  const key = cacheKey(request);
  const cached = await cache.get<T>(key);
  if (cached) return { ...cached, hit: true };
  const started = performance.now();
  const value = await fn();
  const entry = { value, ms: Math.round(performance.now() - started) };
  await cache.set(key, entry);
  return { ...entry, hit: false };
}
