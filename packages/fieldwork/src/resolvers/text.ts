import { generateText, type LanguageModel } from "ai";
import { fieldError, textError } from "../errors.ts";
import { stateValue } from "../state.ts";
import { settle, since } from "../time.ts";
import { callTrace, type CallTrace, type Prices } from "../trace.ts";
import type { AnyResult, FieldSpec, Reasoning } from "../types.ts";

export type TextField = Extract<FieldSpec, { kind: "text" }>;

export interface TextContext {
  models?: Partial<Record<Reasoning, LanguageModel>>;
  signal: AbortSignal;
  prices?: Prices;
}

/** One labeled data block: strings as written, anything else as indented JSON. */
function block(name: string, value: unknown): string {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `<data name="${name}">\n${body}\n</data>`;
}

/**
 * The instructions and style as the system message; the inputs and `after` results as labeled
 * data blocks. No output format is requested: the model replies with plain text.
 */
export function textPrompt(
  field: TextField,
  input: object,
  results: Readonly<Record<string, AnyResult>>,
): { system: string; prompt: string } {
  const system = [
    field.instructions,
    ...(field.style === undefined ? [] : [`Style: ${field.style}`]),
    "Use the data in the message as context. Reply with the text only.",
  ].join("\n\n");
  const blocks = [
    ...Object.entries(input).map(([name, value]) => block(name, value)),
    ...field.after.map((name) => block(name, stateValue(results[name]!))),
  ];
  return { system, prompt: blocks.join("\n\n") };
}

/** The model a text field uses: its own `model`, else the one for its tier (`medium` by default). */
function modelFor(field: TextField, ctx: TextContext): LanguageModel | undefined {
  return field.model ?? ctx.models?.[field.reasoning ?? "medium"];
}

/** Generate a text field. Never throws; a failure fails only this field. */
export async function runText(
  field: TextField,
  input: object,
  results: Readonly<Record<string, AnyResult>>,
  ctx: TextContext,
): Promise<{ result: AnyResult; call: CallTrace | null }> {
  const model = modelFor(field, ctx);
  if (model === undefined) {
    const tier = field.reasoning ?? "medium";
    const error = fieldError("no_model", `${field.name}: no model for reasoning "${tier}"`);
    return { result: { status: "failed", passed: false, error }, call: null };
  }

  const modelId = typeof model === "string" ? model : model.modelId;
  let system: string;
  let prompt: string;
  try {
    ({ system, prompt } = textPrompt(field, input, results));
  } catch {
    const error = fieldError("bad_state", `${field.name}: data is not JSON-serializable`);
    return { result: { status: "failed", passed: false, error }, call: null };
  }

  const started = performance.now();

  try {
    const response = await settle(
      generateText({ model, system, prompt, abortSignal: ctx.signal }),
      ctx.signal,
    );
    const ms = since(started);
    const call = callTrace(
      {
        worker: "text",
        model: modelId,
        fields: [field.name],
        status: "ok",
        ms,
        inputTokens: response.usage.inputTokens ?? 0,
        outputTokens: response.usage.outputTokens ?? 0,
      },
      ctx.prices,
    );

    if (response.text.trim() === "") {
      const error = fieldError("empty_text", `${field.name}: the model returned no text`);
      return { result: { status: "failed", passed: false, error }, call };
    }

    // Before grading, a field with `minScore` has no score yet, so it has not passed.
    const result: AnyResult = {
      status: "filled",
      passed: field.minScore === undefined,
      worker: "text",
      model: modelId,
      ms,
      value: response.text,
      score: null,
      heuristic: true,
    };
    return { result, call };
  } catch (err) {
    const call = callTrace(
      {
        worker: "text",
        model: modelId,
        fields: [field.name],
        status: "failed",
        ms: since(started),
        inputTokens: 0,
        outputTokens: 0,
      },
      ctx.prices,
    );
    return { result: { status: "failed", passed: false, error: textError(err) }, call };
  }
}
