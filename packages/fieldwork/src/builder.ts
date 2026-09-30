import type { Question } from "@typesafe-ai/sdk";
import { DefinitionError } from "./errors.ts";
import type {
  FieldSpec,
  JudgeOptions,
  JudgeValue,
  PickOptions,
  PickValue,
  Results,
  TextOptions,
  TextValue,
  ToolOptions,
  ToolValue,
} from "./types.ts";

export { DefinitionError };

/** True when `T` is a union of more than one member. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * A single literal name not used by an earlier field. A widened `string` or a union is rejected:
 * either would type fields that do not exist at runtime.
 */
type NewName<N extends string, F> = string extends N
  ? never
  : IsUnion<N> extends false
    ? N extends keyof F
      ? never
      : N
    : never;
type Empty = Record<never, never>;
type AnyWhen = NonNullable<FieldSpec["when"]>;

interface CommonInput {
  after?: readonly unknown[];
  when?: unknown;
  timeoutMs?: number;
}

function checkFunction(field: string, option: string, value: unknown, required: boolean): void {
  if ((required || value !== undefined) && typeof value !== "function") {
    throw new DefinitionError(`${field}: ${option} must be a function`);
  }
}

function checkUnit(field: string, option: string, value: number | undefined, min = 0): void {
  // The typeof check matters: `null >= 0` and `"0.5" >= 0` are true in JavaScript.
  if (value !== undefined && !(typeof value === "number" && value >= min && value <= 1)) {
    throw new DefinitionError(`${field}: ${option} must be between ${min} and 1, got ${value}`);
  }
}

/** Checks shared by every field; the types already enforce these for typed callers. */
function checkCommon(name: string, options: CommonInput): readonly string[] {
  if (typeof name !== "string" || name.length === 0) {
    throw new DefinitionError("Field names must be non-empty strings");
  }
  // A "__proto__" key vanishes from the plain objects sent as jev state.
  if (name === "__proto__") throw new DefinitionError(`"__proto__" cannot be a field name`);
  const after = options.after ?? [];
  if (!Array.isArray(after) || !after.every((a) => typeof a === "string")) {
    throw new DefinitionError(`${name}: after must be an array of field names`);
  }
  checkFunction(name, "when", options.when, false);
  const t = options.timeoutMs;
  if (t !== undefined && !(Number.isFinite(t) && t > 0)) {
    throw new DefinitionError(`${name}: timeoutMs must be a positive number, got ${t}`);
  }
  return after as readonly string[];
}

/**
 * An immutable, chained schema. Each method returns a new builder with one more field; `F` maps
 * every field declared so far to the value its result carries.
 */
export class Builder<I extends object, F extends object = Empty> {
  readonly fields: readonly FieldSpec[];

  constructor(fields: readonly FieldSpec[] = []) {
    this.fields = fields;
  }

  #add<G extends object>(spec: FieldSpec): Builder<I, G> {
    return new Builder<I, G>([...this.fields, spec]);
  }

  /** A jev judgment: a TypeSafe `choice()`, `score()` or `noul()` question, passed through. */
  judge<const N extends string, const Q extends Question, const A extends keyof F & string = never>(
    name: NewName<N, F>,
    question: Q,
    options: JudgeOptions<I, F, A, Q> = {} as JudgeOptions<I, F, A, Q>,
  ): Builder<I, F & { [K in N]: JudgeValue<Q> }> {
    const after = checkCommon(name, options);
    const type = (question as { type?: unknown } | null)?.type;
    if (type !== "choice" && type !== "score" && type !== "noul") {
      throw new DefinitionError(`${name}: judge takes a choice(), score() or noul() question`);
    }
    const { gate, yesAbove } = options as { gate?: number; yesAbove?: number };
    checkUnit(name, "gate", gate);
    checkUnit(name, "yesAbove", yesAbove, 0.5);
    return this.#add({
      kind: "judge",
      name,
      question,
      gate,
      yesAbove,
      after,
      when: options.when as AnyWhen | undefined,
      timeoutMs: options.timeoutMs,
    });
  }

  /** A jev selection among candidate strings found by code, plus a `none` option. */
  pick<const N extends string, const A extends keyof F & string = never>(
    name: NewName<N, F>,
    options: PickOptions<I, F, A>,
  ): Builder<I, F & { [K in N]: PickValue }> {
    const after = checkCommon(name, options);
    checkFunction(name, "candidates", options.candidates, true);
    checkUnit(name, "gate", options.gate);
    return this.#add({
      kind: "pick",
      name,
      instructions: options.instructions,
      candidates: options.candidates as (input: unknown) => readonly string[],
      gate: options.gate,
      after,
      when: options.when as AnyWhen | undefined,
      timeoutMs: options.timeoutMs,
    });
  }

  /** The application's own function, called with the `after` fields and the inputs. */
  tool<const N extends string, T, const A extends keyof F & string = never>(
    name: NewName<N, F>,
    options: ToolOptions<I, F, A, T>,
  ): Builder<I, F & { [K in N]: ToolValue<Awaited<T>> }> {
    const after = checkCommon(name, options);
    checkFunction(name, "call", options.call, true);
    return this.#add({
      kind: "tool",
      name,
      call: options.call as (f: Record<string, unknown>, input: unknown) => unknown,
      after,
      when: options.when as AnyWhen | undefined,
      timeoutMs: options.timeoutMs,
    });
  }

  /** Text from an AI SDK model, chosen by `reasoning` tier or passed as `model`. */
  text<const N extends string, const A extends keyof F & string = never>(
    name: NewName<N, F>,
    options: TextOptions<I, F, A>,
  ): Builder<I, F & { [K in N]: TextValue }> {
    const after = checkCommon(name, options);
    checkUnit(name, "minScore", options.minScore);
    return this.#add({
      kind: "text",
      name,
      instructions: options.instructions,
      style: options.style,
      reasoning: options.reasoning,
      model: options.model,
      grade: options.grade ?? true,
      minScore: options.minScore,
      after,
      when: options.when as AnyWhen | undefined,
      timeoutMs: options.timeoutMs,
    });
  }
}

/** Start a schema for inputs of type `I`. */
export function fieldwork<I extends object>(): Builder<I> {
  return new Builder<I>();
}

/** The result type of every field in a schema. */
export type ResultsOf<B> = B extends Builder<object, infer F> ? Results<F> : never;
