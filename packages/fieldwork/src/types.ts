import type {
  ChoiceCriteria,
  ChoiceQuestion,
  NoulQuestion,
  Question,
  ScoreCriteria,
  ScoreQuestion,
  ScoreResponse,
} from "@typesafe-ai/sdk";
import type { LanguageModel } from "ai";

/** Who filled a field: jev, the application's function, or a text model. */
export type Worker = "jev" | "tool" | "text";
export type Reasoning = "low" | "medium" | "high";

/** A short code and message; never a raw provider or tool payload. */
export interface FieldError {
  code: string;
  message: string;
}

export interface ChoiceValue<C extends ChoiceCriteria> {
  choice: keyof C & string;
  confidence: number;
  probabilities: { -readonly [K in keyof C]: number };
}
export interface ScoreValue<S extends ScoreCriteria> {
  /** Expected score over levels counted from zero; may fall between levels. */
  score: number;
  confidence: number;
  probabilities: ScoreResponse<S>["probabilities"];
}
export interface NoulValue {
  noul: number;
  /** Set only when `yesAbove` is given and `noul` is clearly on one side of it. */
  yes: boolean | undefined;
}
export interface PickValue {
  /** The chosen candidate, or `null` when jev chose none. */
  value: string | null;
  confidence: number;
}
export interface ToolValue<T> {
  value: T;
}
export interface TextValue {
  value: string;
  score: number | null;
  heuristic: true;
}

export type JudgeValue<Q extends Question> = Q extends NoulQuestion
  ? NoulValue
  : Q extends ScoreQuestion<infer S>
    ? ScoreValue<S>
    : Q extends ChoiceQuestion<infer C>
      ? ChoiceValue<C>
      : never;

interface Meta {
  worker: Worker;
  /** For jev, the versioned id from the response; `null` for tools. */
  model: string | null;
  ms: number;
}

export type Filled<V> = { status: "filled"; passed: boolean } & Meta & V;
export interface Skipped {
  status: "skipped";
  passed: false;
  reason: string;
}
export interface Failed {
  status: "failed";
  passed: false;
  error: FieldError;
}
export type FieldResult<V> = Filled<V> | Skipped | Failed;

type Absent<V> = { [K in keyof V]?: undefined };

/**
 * A dependency as `when` and `call` see it: discriminated on `passed`, with value properties
 * `undefined` when the field was skipped or failed.
 */
export type FieldView<V> =
  | ({ status: "filled"; passed: true } & Meta & V)
  | ({ status: "filled"; passed: false } & Meta & V)
  | ({ status: "skipped" | "failed"; passed: false } & Absent<V>);

/** The fields named in `after`, as views. */
export type Deps<F, A extends keyof F> = { [K in A]: FieldView<F[K]> };

export type Results<F> = { [K in keyof F]: FieldResult<F[K]> };

interface Common<I, F, A extends keyof F> {
  /** Earlier fields this one reads. */
  after?: readonly A[];
  /** Run the field only when this returns true; otherwise it is skipped. */
  when?: (f: Deps<F, A>, input: I) => boolean;
  timeoutMs?: number;
}

export type JudgeOptions<I, F, A extends keyof F, Q extends Question> = Common<I, F, A> &
  (Q extends NoulQuestion ? { yesAbove?: number } : { gate?: number });

export interface PickOptions<I, F, A extends keyof F> extends Common<I, F, A> {
  instructions: string;
  /** Candidate strings found by code; Fieldwork adds a `none` option. */
  candidates: (input: I) => readonly string[];
  gate?: number;
}

export interface ToolOptions<I, F, A extends keyof F, T> extends Common<I, F, A> {
  call: (f: Deps<F, A>, input: I) => T;
}

export interface TextOptions<I, F, A extends keyof F> extends Common<I, F, A> {
  instructions: string;
  style?: string;
  reasoning?: Reasoning;
  /** Overrides `reasoning`. */
  model?: LanguageModel;
  /** Grade with two Nouls after the last step. Default: true. */
  grade?: boolean;
  minScore?: number;
}

/** Untyped view of a field, used by `plan` and the runtime. */
type AnyWhen = (f: Record<string, unknown>, input: unknown) => boolean;
interface SpecCommon {
  name: string;
  after: readonly string[];
  when?: AnyWhen;
  timeoutMs?: number;
}
export type FieldSpec =
  | (SpecCommon & { kind: "judge"; question: Question; gate?: number; yesAbove?: number })
  | (SpecCommon & {
      kind: "pick";
      instructions: string;
      candidates: (input: unknown) => readonly string[];
      gate?: number;
    })
  | (SpecCommon & { kind: "tool"; call: (f: Record<string, unknown>, input: unknown) => unknown })
  | (SpecCommon & {
      kind: "text";
      instructions: string;
      style?: string;
      reasoning?: Reasoning;
      model?: LanguageModel;
      grade: boolean;
      minScore?: number;
    });
