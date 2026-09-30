import { thrownError } from "../errors.ts";
import { settle, since } from "../time.ts";
import { callTrace, type CallTrace } from "../trace.ts";
import type { AnyResult, FieldSpec } from "../types.ts";

export type ToolField = Extract<FieldSpec, { kind: "tool" }>;

/**
 * Call the application's function with its `after` fields and the inputs. A throw or rejection
 * fails the field with the error's message only. Never throws.
 */
export async function runTool(
  field: ToolField,
  deps: Record<string, AnyResult>,
  input: object,
  signal: AbortSignal,
): Promise<{ result: AnyResult; call: CallTrace }> {
  const started = performance.now();
  const record = (status: "ok" | "failed") =>
    callTrace({
      worker: "tool",
      model: null,
      fields: [field.name],
      status,
      ms: since(started),
      inputTokens: 0,
      outputTokens: 0,
    });

  try {
    const value = await settle(
      Promise.resolve().then(() => field.call(deps, input)),
      signal,
    );
    const call = record("ok");
    return {
      result: { status: "filled", passed: true, worker: "tool", model: null, ms: call.ms, value },
      call,
    };
  } catch (err) {
    return {
      result: { status: "failed", passed: false, error: thrownError("tool_error", err) },
      call: record("failed"),
    };
  }
}
