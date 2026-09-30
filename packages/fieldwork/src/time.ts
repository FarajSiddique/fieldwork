import { TimeoutReached } from "./errors.ts";

export interface Limit {
  signal: AbortSignal;
  /** Clear the timer and stop following the parent. Call once the work has settled. */
  release(): void;
}

/**
 * A signal that aborts when `parent` aborts, with the parent's reason, or after `ms` with a
 * `TimeoutReached` carrying `message`, whichever comes first. No `ms` means no timer.
 */
export function limit(
  parent: AbortSignal | undefined,
  ms: number | undefined,
  message: string,
): Limit {
  const controller = new AbortController();
  const follow = () => controller.abort(parent?.reason);

  if (parent?.aborted) follow();
  else parent?.addEventListener("abort", follow, { once: true });

  const timer =
    ms === undefined
      ? undefined
      : setTimeout(() => controller.abort(new TimeoutReached(message)), ms);

  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", follow);
    },
  };
}

/**
 * Wait for `work`, but reject with the signal's reason as soon as the signal aborts. Work that
 * finishes later is ignored, so a function that cannot be cancelled still cannot overrun.
 */
export function settle<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {}); // a late rejection is ignored, not unhandled
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Whole milliseconds since `start`, a `performance.now()` reading. */
export function since(start: number): number {
  return Math.round(performance.now() - start);
}
