# M1 Week 2: Builder, Plan, Fakes and the Written Set — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `fieldwork` package with its typed chained builder and step planner, the fake TypeSafe and text-model clients that week 3's runtime tests need, and the first draft tickets of the hand-written benchmark set.

**Architecture:** A new pnpm workspace package at `packages/fieldwork`, source-only TypeScript run by Node's type stripping like `bench/`. `types.ts` holds the field-kind value types and the result/view unions; `builder.ts` is an immutable chained builder whose type parameter `F` maps each declared field to its value type, so `after` is limited to earlier names and `when`/`call` see only those fields; `plan.ts` groups the builder's untyped `FieldSpec` list into dependency steps. Test fakes wrap the real `TypeSafeClient` (scripted `fetch`) and the AI SDK's `MockLanguageModelV4`. The written set lives in `bench/` as validated JSONL.

**Tech Stack:** Node 24 type stripping, pnpm 10 workspace, TypeScript 6 strict, Vitest 5 (`expectTypeOf` checked by `tsc`), `@typesafe-ai/sdk` 0.6, `ai` 7 (`ai/test`), zod 4 (bench only), ESLint 10, Prettier 3.

**Spec:** `docs/superpowers/specs/2026-09-27-fieldwork-mvp-design.md` (week 2 of "Build order"). The M0 pilot finding (`bench/results/pilot-finding.md`) recorded a provisional GO; parts of later weeks that depend on jev's confidence stay provisional until the full rerun.

## Global Constraints

- Node 24, pnpm, strict TypeScript. Runtime dependencies: `@typesafe-ai/sdk` and `ai` (AI SDK), both as peer dependencies.
- Judgment questions are TypeSafe's own `choice()`, `score()` and `noul()` helpers from `@typesafe-ai/sdk`, passed through unchanged.
- Dependencies: each field lists the earlier fields it reads (`after`). A field can only depend on fields declared before it, so cycles are impossible.
- `f` inside `when` and `call` contains only the fields named in `after`, so reading any other field is a compile error. Result types come from the question.
- Field results: `{ status: "filled", passed, worker, model, ms, ...kind-specific values }`, `{ status: "skipped", passed: false, reason }`, `{ status: "failed", passed: false, error }`, where `error` is a short code and message.
- Inside `when`, a skipped or failed dependency has `passed: false` and its value properties are `undefined`; the field types are unions discriminated on `passed`.
- `plan` puts each field in the step after the latest step of anything in its `after` list. Fields with no `after` go in step 1. `plan` repeats the builder's check at runtime for untyped callers.
- Written set: hand-written multi-sentence e-commerce tickets, all labeled as synthetic; labels `intent`, `complexity` (three levels), `needs_escalation`, `isRepeat`, `orderNumber` (or `none`); tickets with an order number also mention other numbers; tagged hard cases: mixed intents, relative dates, injected instructions; split 20 dev / 40 test.
- Testing: type tests (`expectTypeOf`) for the builder; unit tests for `plan`; fakes are a fake `fetch` passed to `TypeSafeClient` and the AI SDK's mock language model. Vitest, strict TypeScript, ESLint and Prettier.

## Review Focus

The inputs below come mostly from untyped (JavaScript) callers or from reuse patterns the spec implies but does not name. Each has a test in the task that owns the code.

1. A `when`, `call` or `candidates` that is not a function (a JS caller passes `true` or a string): rejected with a `DefinitionError` naming the field when the field is declared, not a `TypeError` mid-run. Task 1, "rejects when, call and candidates that are not functions".
2. A field named `__proto__`: rejected, because it would silently vanish from the plain-object `state` sent to jev. Task 1, "rejects empty and __proto__ names".
3. Two schemas branched from one shared base builder: each keeps only its own fields; the base is unchanged. Task 1, "never changes a builder".
4. A threshold of `NaN` or outside its range (`gate`, `minScore` in 0–1; `yesAbove` in 0.5–1), while the bounds themselves are accepted. Task 1, "rejects thresholds outside their range, including NaN" and "accepts thresholds at their bounds".
5. An `after` that lists the same field twice: planned once, in the right step. Task 2, "plans a field that lists the same dependency twice once".

## Rulings on points the spec leaves open

- **Package name and place:** workspace package `packages/fieldwork`, `"name": "fieldwork"`, `"private": true`, so imports match the spec's `from "fieldwork"`. The published name stays the spec's open question.
- **`call` does not see `when`'s narrowing.** TypeScript cannot carry a `when` check into `call`, so `f.intent.probabilities` in `call` is `… | undefined`. The spec's example passes it straight to `rollUpToCategory`; the type tests use a `rollUpToCategory` that accepts `undefined`. Week 3's triage example must do the same or guard.
- **`yes` on a Noul is `boolean | undefined`** whether or not `yesAbove` is set; typing it by the presence of `yesAbove` adds a type parameter for little gain.
- **`worker` is `"jev" | "tool" | "text"`, and `model` is `string | null`** (`null` for tools, which have no model).
- **`ChoiceValue.probabilities` is mutable** (`-readonly`), even though `as const` criteria are readonly, so callers can pass it to ordinary functions.
- **Where checks live:** the builder checks each field's own options (name, thresholds, function types) when it is declared; `plan` checks names across fields (unknown, later, self, duplicate). `plan` is internal and not exported from the package.
- **Type tests run under `pnpm typecheck`** (`tsc`), which checks every `expectTypeOf` and `@ts-expect-error`; Vitest also runs those files, where the assertions are no-ops.
- **Written set:** tickets start as `"status": "draft"` because the labeling guide is week 4. Injected-instruction tickets wait for the license check on `TrustAIRLab/in-the-wild-jailbreak-prompts` (spec) and are not in this plan. This plan adds the format, its validator and eight dev drafts; the remaining tickets are written by hand in weeks 2–4.
- **Out of scope here (week 3):** the `none` option and candidate collisions in picks, request-size checks, the pinned jev version, timeouts and the deadline, `run`, `trace`.

---

### Task 1: The `fieldwork` package, field types and the builder

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `packages/fieldwork/package.json`, `packages/fieldwork/tsconfig.json`
- Create: `packages/fieldwork/src/types.ts`, `packages/fieldwork/src/builder.ts`, `packages/fieldwork/src/index.ts`
- Test: `packages/fieldwork/test/builder.types.test.ts`, `packages/fieldwork/test/builder.test.ts`

**Interfaces:**
- Consumes: `Question`, `ChoiceQuestion`, `ScoreQuestion`, `NoulQuestion`, `ChoiceCriteria`, `ScoreCriteria`, `ScoreResponse` from `@typesafe-ai/sdk`; `LanguageModel` from `ai`.
- Produces:
  - `fieldwork<I extends object>(): Builder<I>`
  - `class Builder<I, F>` with `readonly fields: readonly FieldSpec[]` and `judge(name, question, options?)`, `pick(name, options)`, `tool(name, options)`, `text(name, options)`, each returning a new `Builder`
  - `class DefinitionError extends Error`
  - `type FieldSpec` (untyped field: `kind`, `name`, `after: readonly string[]`, `when?`, `timeoutMs?`, plus kind options; text fields always have `grade: boolean`)
  - `type FieldResult<V>`, `FieldView<V>`, `Deps<F, A>`, `Results<F>`, `ResultsOf<B>`, value types `ChoiceValue`, `ScoreValue`, `NoulValue`, `PickValue`, `ToolValue`, `TextValue`, `Worker`, `Reasoning`, `FieldError`

- [ ] **Step 1: Add the package to the workspace**

`pnpm-workspace.yaml`:

```yaml
packages:
  - bench
  - packages/*
```

`packages/fieldwork/package.json`:

```json
{
  "name": "fieldwork",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "peerDependencies": {
    "@typesafe-ai/sdk": "^0.6.0",
    "ai": "^7.0.122"
  },
  "devDependencies": {
    "@types/node": "^24.19.0",
    "@typesafe-ai/sdk": "^0.6.0",
    "ai": "^7.0.122",
    "typescript": "~6.0.3",
    "vitest": "^5.0.2"
  }
}
```

`packages/fieldwork/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `pnpm install`
Expected: completes; `packages/fieldwork/node_modules/@typesafe-ai/sdk` and `packages/fieldwork/node_modules/ai` exist.

- [ ] **Step 2: Write the type tests**

`packages/fieldwork/test/builder.types.test.ts`:

```ts
// Type tests: `pnpm typecheck` checks every assertion and @ts-expect-error below. Vitest runs the
// `it` blocks too, where expectTypeOf is a no-op, so the runtime checks here stay minimal.
import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, expectTypeOf, it } from "vitest";
import { fieldwork, type ResultsOf } from "../src/builder.ts";
import type { FieldView, NoulValue } from "../src/types.ts";

const INTENTS = { track_order: "Where an order is", get_refund: "Wants money back" } as const;

/** Stand-in for the app's roll-up; it takes `undefined` because `call` cannot see `when`. */
declare function rollUpToCategory(
  probabilities: { track_order: number; get_refund: number } | undefined,
): { category: "order" | "refund"; probability: number };
declare const orders: { lookup(q: { orderNumber: string }): Promise<{ status: string }> };

/** The spec's triage example, reduced to two intents. */
const triage = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent of this customer message", INTENTS))
  .tool("category", {
    after: ["intent"],
    when: (f) => f.intent.passed,
    call: (f) => rollUpToCategory(f.intent.probabilities),
  })
  .judge(
    "complexity",
    score("How complex is this request to resolve", ["simple", "judgment", "unusual"]),
    { gate: 0.85 },
  )
  .judge("isRepeat", noul("Does the customer say this problem happened before?"))
  .pick("orderNumber", {
    instructions: "The order number the customer is asking about",
    candidates: (input) => input.ticket.match(/#\d{5,}/g) ?? [],
  })
  .tool("order", {
    after: ["category", "orderNumber"],
    when: (f) => f.category.value?.category === "order" && f.orderNumber.value !== null,
    call: (f) => orders.lookup({ orderNumber: f.orderNumber.value! }),
  })
  .text("reply", {
    after: ["category", "complexity", "order"],
    when: (f) =>
      (f.category.value?.probability ?? 0) >= 0.85 &&
      f.complexity.passed &&
      f.complexity.score < 1.5,
    reasoning: "low",
    instructions: "Reply to the customer",
    style: "warm, under 80 words, no promises about dates",
  })
  .text("escalationNote", {
    after: ["category", "complexity", "isRepeat", "order"],
    when: (f) =>
      (f.category.value?.probability ?? 0) < 0.85 ||
      !f.complexity.passed ||
      f.complexity.score >= 1.5,
    reasoning: "high",
    instructions: "Summarize the ticket for the on-call agent",
    style: "one line",
  });

type Results = ResultsOf<typeof triage>;
type FilledOf<K extends keyof Results> = Extract<Results[K], { status: "filled" }>;

describe("builder types", () => {
  it("builds the triage example", () => {
    expect(triage.fields).toHaveLength(8);
  });

  it("infers each field's result from its question or function", () => {
    expectTypeOf<FilledOf<"intent">["choice"]>().toEqualTypeOf<"track_order" | "get_refund">();
    expectTypeOf<FilledOf<"intent">["probabilities"]>().toEqualTypeOf<{
      track_order: number;
      get_refund: number;
    }>();
    expectTypeOf<FilledOf<"complexity">["score"]>().toEqualTypeOf<number>();
    expectTypeOf<FilledOf<"isRepeat">["noul"]>().toEqualTypeOf<number>();
    expectTypeOf<FilledOf<"isRepeat">["yes"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<FilledOf<"orderNumber">["value"]>().toEqualTypeOf<string | null>();
    expectTypeOf<FilledOf<"category">["value"]>().toEqualTypeOf<{
      category: "order" | "refund";
      probability: number;
    }>();
    // A tool that returns a promise yields the resolved value.
    expectTypeOf<FilledOf<"order">["value"]>().toEqualTypeOf<{ status: string }>();
    expectTypeOf<FilledOf<"reply">["value"]>().toEqualTypeOf<string>();
    expectTypeOf<FilledOf<"reply">["score"]>().toEqualTypeOf<number | null>();
  });

  it("makes every result filled, skipped or failed", () => {
    expectTypeOf<Results["intent"]["status"]>().toEqualTypeOf<"filled" | "skipped" | "failed">();
    expectTypeOf<Extract<Results["intent"], { status: "skipped" }>>().toEqualTypeOf<{
      status: "skipped";
      passed: false;
      reason: string;
    }>();
    expectTypeOf<Extract<Results["intent"], { status: "failed" }>["error"]>().toEqualTypeOf<{
      code: string;
      message: string;
    }>();
  });

  it("narrows a dependency's values to defined when passed is checked", () => {
    const view = {} as FieldView<{ score: number }>;
    expectTypeOf(view.score).toEqualTypeOf<number | undefined>();
    if (view.passed) expectTypeOf(view.score).toEqualTypeOf<number>();
  });

  it("gives when and call only the fields named in after, plus the inputs", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      .judge("b", noul("B?"))
      .tool("c", {
        after: ["a"],
        when: (f, input) => {
          expectTypeOf(input).toEqualTypeOf<{ ticket: string }>();
          expectTypeOf(f).toEqualTypeOf<{ a: FieldView<NoulValue> }>();
          return true;
        },
        // @ts-expect-error: b is not in after
        call: (f) => f.b,
      });
  });

  it("gives a field with no after an empty f", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      .tool("b", {
        call: (f) => {
          expectTypeOf(f).toEqualTypeOf<Record<never, never>>();
          return 1;
        },
      });
  });

  it("rejects after names that are not earlier fields", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      // @ts-expect-error: unknown name
      .tool("b", { after: ["nope"], call: () => 1 });
    fieldwork<{ ticket: string }>()
      // @ts-expect-error: a field cannot read itself
      .tool("a", { after: ["a"], call: () => 1 });
  });

  it("rejects a name used twice", () => {
    fieldwork<{ ticket: string }>()
      .judge("a", noul("A?"))
      // @ts-expect-error: duplicate name
      .text("a", { instructions: "Write" });
  });

  it("takes gate for choice and score, yesAbove for noul", () => {
    fieldwork<{ ticket: string }>()
      // @ts-expect-error: noul has no gate
      .judge("a", noul("A?"), { gate: 0.5 })
      // @ts-expect-error: choice has no yesAbove
      .judge("b", choice("B?", { x: null, y: null }), { yesAbove: 0.9 });
  });
});
```

- [ ] **Step 3: Run the typecheck to see it fail**

Run: `pnpm --filter fieldwork typecheck`
Expected: FAIL with `Cannot find module '../src/builder.ts'` (and `../src/types.ts`).

- [ ] **Step 4: Write the runtime tests**

`packages/fieldwork/test/builder.test.ts`:

```ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { Builder, DefinitionError, fieldwork } from "../src/builder.ts";

const ticketSchema = () => fieldwork<{ ticket: string }>();

describe("fieldwork builder", () => {
  it("starts empty", () => {
    const empty = ticketSchema();
    expect(empty).toBeInstanceOf(Builder);
    expect(empty.fields).toEqual([]);
  });

  it("records every field kind in declaration order, with defaults filled in", () => {
    const intent = choice("The primary intent", { track_order: null, get_refund: null });
    const candidates = (input: { ticket: string }) => input.ticket.match(/#\d{5,}/g) ?? [];
    const call = () => 1;
    const schema = ticketSchema()
      .judge("intent", intent, { gate: 0.8 })
      .judge("isRepeat", noul("Has this happened before?"), { yesAbove: 0.9 })
      .pick("orderNumber", { instructions: "The order number", candidates })
      .tool("lookup", { after: ["orderNumber"], call })
      .text("reply", { after: ["intent"], instructions: "Reply to the customer" });

    expect(schema.fields.map((f) => [f.kind, f.name])).toEqual([
      ["judge", "intent"],
      ["judge", "isRepeat"],
      ["pick", "orderNumber"],
      ["tool", "lookup"],
      ["text", "reply"],
    ]);
    expect(schema.fields[0]).toMatchObject({ question: intent, gate: 0.8, after: [] });
    expect(schema.fields[1]).toMatchObject({ yesAbove: 0.9 });
    expect(schema.fields[2]).toMatchObject({ instructions: "The order number", candidates });
    expect(schema.fields[3]).toMatchObject({ call, after: ["orderNumber"] });
    expect(schema.fields[4]).toMatchObject({ grade: true, after: ["intent"] });
  });

  it("keeps a text field's grade: false", () => {
    const schema = ticketSchema().text("note", { instructions: "Summarize", grade: false });
    expect(schema.fields[0]).toMatchObject({ grade: false });
  });

  it("never changes a builder: branches from a shared base stay independent", () => {
    const base = ticketSchema().judge("a", noul("A?"));
    const left = base.judge("b", noul("B?"));
    const right = base.judge("c", noul("C?"));
    expect(base.fields.map((f) => f.name)).toEqual(["a"]);
    expect(left.fields.map((f) => f.name)).toEqual(["a", "b"]);
    expect(right.fields.map((f) => f.name)).toEqual(["a", "c"]);
  });

  it("accepts thresholds at their bounds", () => {
    expect(() =>
      ticketSchema()
        .judge("a", score("How complex", ["low", "high"]), { gate: 0 })
        .judge("b", choice("Which", { x: null, y: null }), { gate: 1 })
        .judge("c", noul("Yes?"), { yesAbove: 0.5 })
        .judge("d", noul("Yes?"), { yesAbove: 1 })
        .text("e", { instructions: "Write", minScore: 0 }),
    ).not.toThrow();
  });

  // The cases below come from untyped (JavaScript) callers; the types reject them at compile time.
  const untyped = () =>
    ticketSchema() as unknown as Record<string, (...args: unknown[]) => unknown>;
  const rejects = (fn: () => unknown, message: RegExp) => {
    expect(fn).toThrow(DefinitionError);
    expect(fn).toThrow(message);
  };

  it("rejects thresholds outside their range, including NaN", () => {
    rejects(
      () => ticketSchema().judge("a", noul("?"), { yesAbove: 0.4 }),
      /a: yesAbove must be between 0.5 and 1/,
    );
    rejects(
      () => ticketSchema().judge("a", choice("?", { x: null, y: null }), { gate: 1.2 }),
      /a: gate must be between 0 and 1, got 1.2/,
    );
    rejects(
      () => ticketSchema().judge("a", choice("?", { x: null, y: null }), { gate: Number.NaN }),
      /a: gate must be between 0 and 1, got NaN/,
    );
    rejects(
      () => ticketSchema().pick("a", { instructions: "?", candidates: () => [], gate: -0.1 }),
      /a: gate must be between 0 and 1/,
    );
    rejects(
      () => ticketSchema().text("a", { instructions: "?", minScore: 2 }),
      /a: minScore must be between 0 and 1/,
    );
  });

  it("rejects a timeout that is not a positive number", () => {
    rejects(
      () => ticketSchema().judge("a", noul("?"), { timeoutMs: 0 }),
      /a: timeoutMs must be a positive number/,
    );
    rejects(
      () => ticketSchema().tool("a", { call: () => 1, timeoutMs: Number.POSITIVE_INFINITY }),
      /a: timeoutMs must be a positive number/,
    );
  });

  it("rejects empty and __proto__ names", () => {
    rejects(() => untyped().judge!("", noul("?")), /non-empty strings/);
    rejects(() => untyped().judge!("__proto__", noul("?")), /"__proto__" cannot be a field name/);
  });

  it("rejects a judge whose question is not a TypeSafe question", () => {
    rejects(
      () => untyped().judge!("a", { type: "free_text" }),
      /a: judge takes a choice\(\), score\(\) or noul\(\)/,
    );
    rejects(() => untyped().judge!("a", "Is this urgent?"), /a: judge takes/);
  });

  it("rejects when, call and candidates that are not functions", () => {
    rejects(() => untyped().judge!("a", noul("?"), { when: true }), /a: when must be a function/);
    rejects(() => untyped().tool!("a", { call: "lookup" }), /a: call must be a function/);
    rejects(() => untyped().pick!("a", { instructions: "?" }), /a: candidates must be a function/);
  });

  it("rejects an after that is not a list of names", () => {
    rejects(
      () => untyped().tool!("a", { after: "intent", call: () => 1 }),
      /a: after must be an array of field names/,
    );
    rejects(() => untyped().tool!("a", { after: [1], call: () => 1 }), /a: after must be an array/);
  });
});
```

- [ ] **Step 5: Run the tests to see them fail**

Run: `pnpm --filter fieldwork test`
Expected: FAIL; both files fail to import `../src/builder.ts`.

- [ ] **Step 6: Write the field types**

`packages/fieldwork/src/types.ts`:

```ts
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
```

- [ ] **Step 7: Write the builder**

`packages/fieldwork/src/builder.ts`:

```ts
import type { Question } from "@typesafe-ai/sdk";
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

/** A schema mistake found while defining or planning fields. */
export class DefinitionError extends Error {
  override name = "DefinitionError";
}

/** Rejects a name already used by an earlier field. */
type NewName<N extends string, F> = N extends keyof F ? never : N;
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
  if (value !== undefined && !(value >= min && value <= 1)) {
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
```

- [ ] **Step 8: Write the package entry point**

`packages/fieldwork/src/index.ts`:

```ts
export { Builder, DefinitionError, fieldwork, type ResultsOf } from "./builder.ts";
export type {
  ChoiceValue,
  Deps,
  Failed,
  FieldError,
  FieldResult,
  FieldView,
  Filled,
  JudgeValue,
  NoulValue,
  PickValue,
  Reasoning,
  Results,
  ScoreValue,
  Skipped,
  TextValue,
  ToolValue,
  Worker,
} from "./types.ts";
```

- [ ] **Step 9: Run the typecheck and tests to see them pass**

Run: `pnpm --filter fieldwork typecheck && pnpm --filter fieldwork test`
Expected: typecheck exits 0 (every `@ts-expect-error` is used); `Tests 20 passed (20)` across `builder.types.test.ts` (9) and `builder.test.ts` (11).

- [ ] **Step 10: Check that the type tests bite**

Temporarily change `"track_order" | "get_refund"` in the first `toEqualTypeOf` of `builder.types.test.ts` to `"track_order"`.
Run: `pnpm --filter fieldwork typecheck`
Expected: FAIL with `TS2344` on that line. Revert the change and rerun: exits 0.

- [ ] **Step 11: Lint, format and commit**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; bench's tests still pass.

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/fieldwork
git commit -m "Add the fieldwork package with its typed field builder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `plan`: group fields into steps

**Files:**
- Create: `packages/fieldwork/src/plan.ts`
- Test: `packages/fieldwork/test/plan.test.ts`

**Interfaces:**
- Consumes: `FieldSpec` from `src/types.ts`; `DefinitionError`, `fieldwork` from `src/builder.ts` (Task 1).
- Produces: `plan(fields: readonly FieldSpec[]): FieldSpec[][]`. Index 0 is step 1; steps are contiguous; within a step, fields keep declaration order. Throws `DefinitionError` with these messages: `Field "a" reads unknown field "x"`, `Field "a" reads "b", which is declared after it`, `Field "a" reads itself`, `Field "a" is declared more than once`.

- [ ] **Step 1: Write the failing tests**

`packages/fieldwork/test/plan.test.ts`:

```ts
import { choice, noul, score } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { DefinitionError, fieldwork } from "../src/builder.ts";
import { plan } from "../src/plan.ts";
import type { FieldSpec } from "../src/types.ts";

const names = (steps: FieldSpec[][]) => steps.map((step) => step.map((f) => f.name));

/** A field as an untyped caller would build it. */
const field = (name: string, after: string[] = []): FieldSpec => ({
  kind: "tool",
  name,
  after,
  call: () => null,
});

describe("plan", () => {
  it("returns no steps for no fields", () => {
    expect(plan([])).toEqual([]);
  });

  it("puts fields with no after in the first step, in declaration order", () => {
    expect(names(plan([field("a"), field("b"), field("c")]))).toEqual([["a", "b", "c"]]);
  });

  it("puts each field in the step after the latest step it reads", () => {
    const steps = plan([
      field("a"),
      field("b", ["a"]),
      field("c"),
      field("d", ["b", "c"]),
      field("e", ["a"]),
    ]);
    expect(names(steps)).toEqual([["a", "c"], ["b", "e"], ["d"]]);
  });

  it("plans a field that lists the same dependency twice once", () => {
    expect(names(plan([field("a"), field("b", ["a", "a"])]))).toEqual([["a"], ["b"]]);
  });

  it("plans the triage example in four steps", () => {
    const triage = fieldwork<{ ticket: string }>()
      .judge("intent", choice("The primary intent", { track_order: null, get_refund: null }))
      .tool("category", { after: ["intent"], call: () => ({ category: "order", probability: 1 }) })
      .judge("complexity", score("How complex", ["simple", "judgment", "unusual"]), { gate: 0.85 })
      .judge("isRepeat", noul("Happened before?"))
      .pick("orderNumber", { instructions: "The order number", candidates: () => [] })
      .tool("order", { after: ["category", "orderNumber"], call: () => null })
      .text("reply", { after: ["category", "complexity", "order"], instructions: "Reply" })
      .text("escalationNote", {
        after: ["category", "complexity", "isRepeat", "order"],
        instructions: "Summarize",
      });

    expect(names(plan(triage.fields))).toEqual([
      ["intent", "complexity", "isRepeat", "orderNumber"],
      ["category"],
      ["order"],
      ["reply", "escalationNote"],
    ]);
  });

  it("rejects an after naming an unknown field", () => {
    expect(() => plan([field("a", ["nope"])])).toThrow(DefinitionError);
    expect(() => plan([field("a", ["nope"])])).toThrow('Field "a" reads unknown field "nope"');
  });

  it("rejects an after naming a field declared later", () => {
    expect(() => plan([field("a", ["b"]), field("b")])).toThrow(
      'Field "a" reads "b", which is declared after it',
    );
  });

  it("rejects a field that reads itself", () => {
    expect(() => plan([field("a", ["a"])])).toThrow('Field "a" reads itself');
  });

  it("rejects a name declared twice", () => {
    expect(() => plan([field("a"), field("a")])).toThrow('Field "a" is declared more than once');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter fieldwork exec vitest run test/plan.test.ts`
Expected: FAIL; cannot import `../src/plan.ts`.

- [ ] **Step 3: Write `plan`**

`packages/fieldwork/src/plan.ts`:

```ts
import { DefinitionError } from "./builder.ts";
import type { FieldSpec } from "./types.ts";

/**
 * Group fields into steps: each field goes in the step after the latest step of anything in its
 * `after` list, and fields with no `after` go in the first step. Within a step, fields keep
 * their declaration order. Repeats the builder's type checks at runtime for untyped callers.
 */
export function plan(fields: readonly FieldSpec[]): FieldSpec[][] {
  const stepOf = new Map<string, number>();
  const steps: FieldSpec[][] = [];
  for (const field of fields) {
    if (stepOf.has(field.name)) {
      throw new DefinitionError(`Field "${field.name}" is declared more than once`);
    }
    let step = 0;
    for (const dep of field.after) {
      const depStep = stepOf.get(dep);
      if (depStep === undefined) {
        const problem =
          dep === field.name
            ? "reads itself"
            : fields.some((f) => f.name === dep)
              ? `reads "${dep}", which is declared after it`
              : `reads unknown field "${dep}"`;
        throw new DefinitionError(`Field "${field.name}" ${problem}`);
      }
      step = Math.max(step, depStep + 1);
    }
    stepOf.set(field.name, step);
    (steps[step] ??= []).push(field);
  }
  return steps;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter fieldwork exec vitest run test/plan.test.ts`
Expected: `Tests 9 passed (9)`.

- [ ] **Step 5: Check and commit**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0.

```bash
git add packages/fieldwork/src/plan.ts packages/fieldwork/test/plan.test.ts
git commit -m "Group fields into dependency steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Fake TypeSafe and text-model clients

Week 3's runtime tests need one test per row of the spec's error table. These fakes produce each row's trigger through the real SDKs, so the tests exercise the SDKs' own parsing, error classes and timeouts rather than hand-made stand-ins.

**Files:**
- Create: `packages/fieldwork/test/fakes.ts`
- Test: `packages/fieldwork/test/fakes.test.ts`

**Interfaces:**
- Consumes: `TypeSafeClient`, `Question` and error classes from `@typesafe-ai/sdk`; `MockLanguageModelV4` from `ai/test`; `generateText` from `ai`.
- Produces (for week 3 tests):
  - `FAKE_JEV_MODEL = "jev-1.13.0"`
  - `fakeTypeSafe(reply: JevReply | ((call: JevCall, index: number) => JevReply), options?: { timeoutMs?: number }): { client: TypeSafeClient; calls: JevCall[] }`
  - `type JevReply = { answers; model?; inputTokens? } | { status; body? } | { hangMs }`, `interface JevCall { model; state; questions }`
  - `answer.choice(probabilities)`, `answer.score(probabilities, confidence?)`, `answer.noul(probability)`
  - `fakeTextModel(reply: string | Error | ((prompt: string) => string), modelId?: string): MockLanguageModelV4`

- [ ] **Step 1: Write the failing tests**

`packages/fieldwork/test/fakes.test.ts`:

```ts
import {
  APITimeoutError,
  choice,
  InternalServerError,
  noul,
  RateLimitError,
  score,
} from "@typesafe-ai/sdk";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { answer, FAKE_JEV_MODEL, fakeTextModel, fakeTypeSafe } from "./fakes.ts";

const questions = {
  intent: choice("The primary intent", { track_order: null, get_refund: null }),
  complexity: score("How complex", ["simple", "judgment", "unusual"]),
  isRepeat: noul("Has this happened before?"),
};

describe("answer builders", () => {
  it("makes the most probable label the choice", () => {
    expect(answer.choice({ track_order: 0.2, get_refund: 0.8 })).toEqual({
      type: "choice",
      choice: "get_refund",
      confidence: 0.8,
      probabilities: { track_order: 0.2, get_refund: 0.8 },
    });
  });

  it("makes the score the expected level, which can fall between levels", () => {
    const a = answer.score([0.1, 0.1, 0.8]);
    expect(a.score).toBeCloseTo(1.7);
    expect(a).toMatchObject({ confidence: 0.8, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } });
    expect(answer.score([0.5, 0.5], 0.3).confidence).toBe(0.3);
  });
});

describe("fakeTypeSafe", () => {
  it("answers through the real SDK and records what was sent", async () => {
    const { client, calls } = fakeTypeSafe({
      answers: {
        intent: answer.choice({ track_order: 0.9, get_refund: 0.1 }),
        complexity: answer.score([0.7, 0.2, 0.1]),
        isRepeat: answer.noul(0.05),
      },
      inputTokens: 321,
    });

    const result = await client.systemOne({ state: { ticket: "where is #12345" }, questions });

    expect(result.model).toBe(FAKE_JEV_MODEL);
    expect(result.usage).toEqual({ input_tokens: 321, output_tokens: 0 });
    expect(result.answers.intent.choice).toBe("track_order");
    expect(result.answers.isRepeat.noul).toBe(0.05);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: FAKE_JEV_MODEL, state: { ticket: "where is #12345" } });
    expect(Object.keys(calls[0]!.questions)).toEqual(["intent", "complexity", "isRepeat"]);
  });

  it("reports the model a reply names", async () => {
    const { client } = fakeTypeSafe({ answers: { isRepeat: answer.noul(1) }, model: "jev-1.14.0" });
    const result = await client.systemOne({
      state: "x",
      questions: { isRepeat: questions.isRepeat },
    });
    expect(result.model).toBe("jev-1.14.0");
  });

  it("scripts a reply per call from the request and its index", async () => {
    const { client } = fakeTypeSafe((call, index) => ({
      answers: { isRepeat: answer.noul(index / 10) },
      model: `jev-${String(call.state)}`,
    }));
    const ask = (state: string) =>
      client.systemOne({ state, questions: { isRepeat: questions.isRepeat } });
    expect((await ask("a")).answers.isRepeat.noul).toBe(0);
    const second = await ask("b");
    expect(second.answers.isRepeat.noul).toBe(0.1);
    expect(second.model).toBe("jev-b");
  });

  it("surfaces an error status as the SDK's error class", async () => {
    const failing = (status: number) =>
      fakeTypeSafe({ status }).client.systemOne({ state: "x", questions });
    await expect(failing(500)).rejects.toBeInstanceOf(InternalServerError);
    await expect(failing(429)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("times out a hung request with the SDK's timeout error", async () => {
    const { client } = fakeTypeSafe({ hangMs: 5_000 }, { timeoutMs: 20 });
    await expect(client.systemOne({ state: "x", questions })).rejects.toBeInstanceOf(
      APITimeoutError,
    );
  });
});

describe("fakeTextModel", () => {
  it("returns its text through generateText", async () => {
    const model = fakeTextModel("Your order ships tomorrow.");
    const { text } = await generateText({ model, prompt: "Reply to the customer" });
    expect(text).toBe("Your order ships tomorrow.");
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("passes the prompt text to a reply function", async () => {
    const model = fakeTextModel((prompt) => `echo: ${prompt}`);
    const { text } = await generateText({ model, prompt: "hello" });
    expect(text).toBe("echo: hello");
  });

  it("rejects with the reply's error", async () => {
    const model = fakeTextModel(new Error("provider down"));
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow(
      "provider down",
    );
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter fieldwork exec vitest run test/fakes.test.ts`
Expected: FAIL; cannot import `./fakes.ts`.

- [ ] **Step 3: Write the fakes**

`packages/fieldwork/test/fakes.ts`:

```ts
import { TypeSafeClient, type Question } from "@typesafe-ai/sdk";
import { MockLanguageModelV4 } from "ai/test";

/** The versioned jev id the fake reports unless a reply overrides it. */
export const FAKE_JEV_MODEL = "jev-1.13.0";

/** One request as the fake TypeSafe server received it. */
export interface JevCall {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}

/** What the fake server does with a request: answer it, fail with a status, or hang. */
export type JevReply =
  | { answers: Record<string, unknown>; model?: string; inputTokens?: number }
  | { status: number; body?: unknown }
  | { hangMs: number };

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A real `TypeSafeClient` whose `fetch` is scripted, so tests exercise the SDK's own parsing,
 * error classes and timeouts. Retries are off; `timeoutMs` is the SDK's per-attempt timeout.
 */
export function fakeTypeSafe(
  reply: JevReply | ((call: JevCall, index: number) => JevReply),
  options: { timeoutMs?: number } = {},
) {
  const calls: JevCall[] = [];
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const call = JSON.parse(String(init?.body)) as JevCall;
    calls.push(call);
    const r = typeof reply === "function" ? reply(call, calls.length - 1) : reply;
    if ("hangMs" in r) {
      await sleep(r.hangMs, init?.signal);
      return json({});
    }
    if ("status" in r) return json(r.body ?? { error: { message: "fake failure" } }, r.status);
    return json({
      model: r.model ?? FAKE_JEV_MODEL,
      answers: r.answers,
      usage: { input_tokens: r.inputTokens ?? 100, output_tokens: 0 },
    });
  };
  const client = new TypeSafeClient({
    apiKey: "test",
    fetch,
    defaultModel: FAKE_JEV_MODEL,
    retry: { maxRetries: 0 },
    timeout: options.timeoutMs ?? 1_000,
    logLevel: "off",
  });
  return { client, calls };
}

/** Answer builders in the shape jev returns. */
export const answer = {
  /** The most probable label is the choice, and its probability is the confidence. */
  choice(probabilities: Record<string, number>) {
    const [choice, confidence] = Object.entries(probabilities).reduce((best, entry) =>
      entry[1] > best[1] ? entry : best,
    );
    return { type: "choice", choice, confidence, probabilities };
  },
  /** `probabilities[i]` is the probability of level `i`; the score is the expected level. */
  score(probabilities: readonly number[], confidence = Math.max(...probabilities)) {
    return {
      type: "score",
      score: probabilities.reduce((sum, p, level) => sum + p * level, 0),
      confidence,
      probabilities: Object.fromEntries(probabilities.map((p, level) => [String(level), p])),
    };
  },
  noul(probability: number) {
    return { type: "noul", noul: probability };
  },
};

/** What the fake text model does: reply with text, compute it from the prompt, or throw. */
export type TextReply = string | Error | ((prompt: string) => string);

/**
 * An AI SDK mock model. The function form receives the prompt's text parts joined with newlines.
 * `doGenerateCalls` on the returned model records every call.
 */
export function fakeTextModel(reply: TextReply, modelId = "fake-text") {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async (options) => {
      if (reply instanceof Error) throw reply;
      const prompt = options.prompt
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        .join("\n");
      const text = typeof reply === "function" ? reply(prompt) : reply;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: {
            total: prompt.length,
            noCache: prompt.length,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: text.length, text: text.length, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter fieldwork exec vitest run test/fakes.test.ts`
Expected: `Tests 10 passed (10)`.

- [ ] **Step 5: Check and commit**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0; `fieldwork` has 39 tests.

```bash
git add packages/fieldwork/test/fakes.ts packages/fieldwork/test/fakes.test.ts
git commit -m "Add fake TypeSafe and text-model clients for runtime tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The written set: format, validator and first drafts

**Files:**
- Modify: `bench/src/config.ts` (add `paths.written`)
- Create: `bench/src/written.ts`, `bench/data/written.jsonl`
- Test: `bench/test/written.test.ts`

**Interfaces:**
- Consumes: `INTENT_NAMES` from `bench/src/intents.ts`; `readJsonl` from `bench/src/io.ts`; `findOrderNumbers` from `bench/src/systems/jev.ts`; `paths` from `bench/src/config.ts`.
- Produces: `HARD_CASES`, `writtenTicketSchema`, `type WrittenTicket`, `validateWrittenSet(records: readonly unknown[]): WrittenTicket[]`, `loadWrittenSet(path: string): Promise<WrittenTicket[]>`, `paths.written`. Week 4 uses these for labeling and the benchmark.

Record format, one JSON object per line: `id` (`wr-NNN`), `split` (`dev`/`test`), `status` (`draft`/`final`), `synthetic: true`, `text`, `intent` (one of Bitext's 27), `complexity` (0 simple, 1 needs judgment, 2 unusual or needs a person), `needsEscalation`, `isRepeat`, `orderNumber` (exactly as written in the ticket, or `null`), `hardCases` (subset of `mixed_intents`, `relative_dates`, `injected_instructions`). The validator also requires the order number to be one of the candidates `findOrderNumbers` finds in the text, since the pick can only choose a candidate.

- [ ] **Step 1: Write the failing tests**

`bench/test/written.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { paths } from "../src/config.ts";
import { loadWrittenSet, validateWrittenSet, type WrittenTicket } from "../src/written.ts";

const ticket = (overrides: Partial<WrittenTicket> = {}): WrittenTicket => ({
  id: "wr-001",
  split: "dev",
  status: "draft",
  synthetic: true,
  text: "Where is order #582041? Invoice #20417 says it shipped.",
  intent: "track_order",
  complexity: 1,
  needsEscalation: false,
  isRepeat: false,
  orderNumber: "#582041",
  hardCases: [],
  ...overrides,
});

describe("validateWrittenSet", () => {
  it("accepts well-formed tickets, with or without an order number", () => {
    const tickets = [ticket(), ticket({ id: "wr-002", orderNumber: null })];
    expect(validateWrittenSet(tickets)).toEqual(tickets);
  });

  it("rejects an order number the candidate regex would not find", () => {
    expect(() => validateWrittenSet([ticket({ orderNumber: "#999999" })])).toThrow(
      "wr-001: orderNumber #999999 is not a candidate found in the text",
    );
    // Written without the "#" that the ticket uses: the pick returns the span as written.
    expect(() => validateWrittenSet([ticket({ orderNumber: "582041" })])).toThrow(
      "orderNumber 582041 is not a candidate",
    );
  });

  it("rejects duplicate ids", () => {
    expect(() => validateWrittenSet([ticket(), ticket()])).toThrow("wr-001: duplicate id");
  });

  it("rejects unknown intents, complexity levels outside 0–2 and unknown hard cases", () => {
    const bad = [
      { ...ticket(), intent: "where_is_my_stuff" },
      { ...ticket({ id: "wr-002" }), complexity: 3 },
      { ...ticket({ id: "wr-003" }), hardCases: ["sarcasm"] },
    ];
    expect(() => validateWrittenSet(bad)).toThrow(
      /wr-001: intent: .*\nwr-002: complexity: .*\nwr-003: hardCases\.0: /,
    );
  });

  it("rejects a ticket not marked synthetic, and unexpected fields", () => {
    expect(() => validateWrittenSet([{ ...ticket(), synthetic: false }])).toThrow(
      "wr-001: synthetic:",
    );
    expect(() => validateWrittenSet([{ ...ticket(), escalate: true }])).toThrow("wr-001: record:");
  });

  it("names the line when the id is unreadable", () => {
    expect(() => validateWrittenSet([ticket(), { text: "hello" }])).toThrow("line 2: id:");
  });
});

describe("the committed written set", () => {
  it("is valid", async () => {
    const tickets = await loadWrittenSet(paths.written);
    expect(tickets.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @fieldwork/bench exec vitest run test/written.test.ts`
Expected: FAIL; cannot import `../src/written.ts`.

- [ ] **Step 3: Add the path**

In `bench/src/config.ts`, add to `paths` after `test`:

```ts
  written: join(root, "data", "written.jsonl"),
```

- [ ] **Step 4: Write the validator**

`bench/src/written.ts`:

```ts
import { z } from "zod";
import { INTENT_NAMES } from "./intents.ts";
import { readJsonl } from "./io.ts";
import { findOrderNumbers } from "./systems/jev.ts";

/** The jev weak spots the written set tags, from TypeSafe's jev notes. */
export const HARD_CASES = ["mixed_intents", "relative_dates", "injected_instructions"] as const;

export const writtenTicketSchema = z.strictObject({
  id: z.string().regex(/^wr-\d{3}$/),
  split: z.enum(["dev", "test"]),
  /** `draft` until labeled against the labeling guide (week 4). */
  status: z.enum(["draft", "final"]),
  synthetic: z.literal(true),
  text: z.string().trim().min(1),
  intent: z.enum(INTENT_NAMES),
  /** The complexity Score's level: 0 simple, 1 needs judgment, 2 unusual or needs a person. */
  complexity: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  needsEscalation: z.boolean(),
  isRepeat: z.boolean(),
  /** Exactly as written in the ticket, or `null` when the ticket has none. */
  orderNumber: z.string().nullable(),
  hardCases: z.array(z.enum(HARD_CASES)),
});

export type WrittenTicket = z.infer<typeof writtenTicketSchema>;

/**
 * Parse and cross-check the written set. Throws one error listing every problem, each prefixed
 * with the ticket id (or line number when the id is unreadable).
 */
export function validateWrittenSet(records: readonly unknown[]): WrittenTicket[] {
  const problems: string[] = [];
  const tickets: WrittenTicket[] = [];
  const seen = new Set<string>();
  records.forEach((record, i) => {
    const parsed = writtenTicketSchema.safeParse(record);
    if (!parsed.success) {
      const id = (record as { id?: unknown } | null)?.id;
      const where = typeof id === "string" ? id : `line ${i + 1}`;
      for (const issue of parsed.error.issues) {
        problems.push(`${where}: ${issue.path.join(".") || "record"}: ${issue.message}`);
      }
      return;
    }
    const t = parsed.data;
    if (seen.has(t.id)) problems.push(`${t.id}: duplicate id`);
    seen.add(t.id);
    // The pick can only choose a candidate the regex finds, so the label must be one.
    if (t.orderNumber !== null && !findOrderNumbers(t.text).includes(t.orderNumber)) {
      problems.push(`${t.id}: orderNumber ${t.orderNumber} is not a candidate found in the text`);
    }
    tickets.push(t);
  });
  if (problems.length > 0) throw new Error(`Invalid written set:\n${problems.join("\n")}`);
  return tickets;
}

export async function loadWrittenSet(path: string): Promise<WrittenTicket[]> {
  return validateWrittenSet(await readJsonl<unknown>(path));
}
```

- [ ] **Step 5: Add the first eight dev drafts**

`bench/data/written.jsonl` (one ticket per line, exactly as below):

```jsonl
{"id":"wr-001","split":"dev","status":"draft","synthetic":true,"text":"Hi, I ordered a standing desk on March 3rd, order #582041, and the tracking page hasn't moved in nine days. Invoice #20417 says it shipped. Can you tell me where it actually is?","intent":"track_order","complexity":1,"needsEscalation":false,"isRepeat":false,"orderNumber":"#582041","hardCases":[]}
{"id":"wr-002","split":"dev","status":"draft","synthetic":true,"text":"This is the third time I'm writing about order #771930. The blender arrived cracked, you sent a replacement, and that one is cracked too. I want my $89.99 back, not another blender.","intent":"get_refund","complexity":2,"needsEscalation":true,"isRepeat":true,"orderNumber":"#771930","hardCases":[]}
{"id":"wr-003","split":"dev","status":"draft","synthetic":true,"text":"Can I change the delivery address on my order? I moved last week. It's order 640218 and the app says it hasn't shipped yet.","intent":"change_shipping_address","complexity":0,"needsEscalation":false,"isRepeat":false,"orderNumber":"640218","hardCases":[]}
{"id":"wr-004","split":"dev","status":"draft","synthetic":true,"text":"I was charged twice for the same purchase yesterday, two payments of $142.50 on my card ending 4421. I only placed one order. Please fix this before my rent comes out on Friday.","intent":"payment_issue","complexity":2,"needsEscalation":true,"isRepeat":false,"orderNumber":null,"hardCases":["relative_dates"]}
{"id":"wr-005","split":"dev","status":"draft","synthetic":true,"text":"Two things. First, please cancel order #390112, I found it cheaper elsewhere. Second, how do I update the email on my account? I don't use the old one any more.","intent":"cancel_order","complexity":1,"needsEscalation":false,"isRepeat":false,"orderNumber":"#390112","hardCases":["mixed_intents"]}
{"id":"wr-006","split":"dev","status":"draft","synthetic":true,"text":"I'd like to close my account entirely. I've asked twice already by email and nobody replied. Please also delete the cards I saved.","intent":"delete_account","complexity":1,"needsEscalation":true,"isRepeat":true,"orderNumber":null,"hardCases":[]}
{"id":"wr-007","split":"dev","status":"draft","synthetic":true,"text":"Where can I download the invoice for my last purchase? I need it for an expense report. The order was #458873 and the invoice number in the email was #90331.","intent":"get_invoice","complexity":0,"needsEscalation":false,"isRepeat":false,"orderNumber":"#458873","hardCases":[]}
{"id":"wr-008","split":"dev","status":"draft","synthetic":true,"text":"My parcel was marked delivered two days ago but it isn't here, and my neighbour doesn't have it either. Order #502776. The medication inside has to reach me by Monday.","intent":"track_order","complexity":2,"needsEscalation":true,"isRepeat":false,"orderNumber":"#502776","hardCases":["relative_dates"]}
```

They cover escalation both ways (4 of 8), repeats, order numbers with and without `#`, invoice-number distractors (`wr-001`, `wr-007`), a ticket with no order number, mixed intents and relative dates. All are `draft` until week 4's labeling guide.

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm --filter @fieldwork/bench exec vitest run test/written.test.ts`
Expected: `Tests 7 passed (7)`.

- [ ] **Step 7: Check and commit**

Run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
Expected: all exit 0.

```bash
git add bench/src/config.ts bench/src/written.ts bench/test/written.test.ts bench/data/written.jsonl
git commit -m "Add the written set format, its validator and eight draft dev tickets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After this plan

Week 3 (`resolvers`, `grade`, `run`, `trace`, the live contract test and the triage example) builds on `Builder.fields`, `plan` and the fakes. Before week 4's benchmark work, rerun the full pilot once AI Gateway serves jev again and confirm the confidence gate on all 270 dev tickets.
