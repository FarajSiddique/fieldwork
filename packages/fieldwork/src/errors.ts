import { APIError, APITimeoutError, RateLimitError } from "@typesafe-ai/sdk";
import type { FieldError } from "./types.ts";

/** A schema mistake found while defining fields, planning them or starting a run. */
export class DefinitionError extends Error {
  override name = "DefinitionError";
}

/** The reason a field's time limit or the run's deadline aborts its work. */
export class TimeoutReached extends Error {
  override name = "TimeoutReached";
}

const MAX_MESSAGE = 200;

/** A field error, its message cut to 200 characters. */
export function fieldError(code: string, message: string): FieldError {
  const short = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
  return { code, message: short };
}

function nameOf(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A failed jev request: the error class and HTTP status, never the response body. */
export function jevError(err: unknown): FieldError {
  if (err instanceof TimeoutReached) return fieldError("timeout", err.message);
  if (err instanceof RateLimitError) return fieldError("rate_limited", `jev: HTTP ${err.status}`);
  if (err instanceof APIError) return fieldError("jev_error", `jev: HTTP ${err.status}`);
  if (err instanceof APITimeoutError) {
    return fieldError("timeout", `jev: no response within ${err.timeoutMs} ms`);
  }
  return fieldError("jev_error", `jev: ${nameOf(err)}`);
}

/** A failed text generation: the error class and HTTP status, never the provider's body. */
export function textError(err: unknown): FieldError {
  if (err instanceof TimeoutReached) return fieldError("timeout", err.message);
  const status = (err as { statusCode?: unknown } | null)?.statusCode;
  const suffix = typeof status === "number" ? `: HTTP ${status}` : "";
  return fieldError("text_error", `${nameOf(err)}${suffix}`);
}

/** A tool, `when` or `candidates` function that threw: its message only. */
export function thrownError(code: string, err: unknown): FieldError {
  if (err instanceof TimeoutReached) return fieldError("timeout", err.message);
  return fieldError(code, messageOf(err));
}
