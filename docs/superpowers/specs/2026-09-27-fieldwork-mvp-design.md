# Fieldwork MVP design

Date: 2026-09-27 · Revised: 2026-09-28 · Status: awaiting review

The first version of this spec defined a YAML document format with its own `when` expression language. This revision replaces it with a TypeScript library built directly on TypeSafe's SDK. The YAML version is in git history.

A later revision on 2026-09-28 changed the example and benchmark schema from fintech to e-commerce support, because the benchmark dataset (Bitext) is e-commerce: the fintech categories, the `amount` pick and the ledger tool had nothing in the data to measure against.

A third revision the same day split the benchmark into two sets after profiling Bitext. Its tickets are one-line requests whose need for escalation follows from intent alone, so Bitext is used at scale for intent, category, confidence and the pick. A hand-written set carries escalation, complexity and hard cases. jev now chooses among 27 intents rolled up to 8 categories. The `complexity` conditions compare the Score's expected value against a threshold, because it can fall between levels.

## Purpose

Fieldwork lets an application declare the output it needs instead of prompting a model to "return JSON like this." Each field is filled by the right worker: jev (TypeSafe's System One model) for judgments, a reasoning model for text, or the application's own function for facts. Every field comes back typed, with its confidence or score, the worker that produced it, and its timing.

Fieldwork is a thin layer over TypeSafe's primitives, not a replacement for them. It uses `@typesafe-ai/sdk` question objects as they are, follows TypeSafe's documented patterns (intent routing, confidence gating, select instead of generate), and leaves the workflow in code.

Thesis: https://claude.ai/artifact/Gn7mDtAuxba6QA55m3pe2A
Walkthrough of the finished MVP: https://claude.ai/artifact/CKS4uZDcRpkahrdBn7wZY1

### MVP goal

An open-source TypeScript library, a reproducible published benchmark, and a support-triage cookbook contributed to TypeSafe's docs. The MVP succeeds if the benchmark shows that Fieldwork:

1. matches a frontier single structured-output call on category accuracy (Bitext set) and escalation recall (written set),
2. costs close to a cheap single structured-output call per ticket,
3. gives confidence values that hold up on held-out data, so "act automatically above the gate" is safe at a stated coverage, and
4. reports its failures plainly, mapped to TypeSafe's published list of jev weak spots.

### Decisions made

| Decision | Choice |
|---|---|
| Schema format | A typed TypeScript builder. No YAML, no document format, no expression language. |
| Judgment questions | TypeSafe's own `choice()`, `score()` and `noul()` helpers from `@typesafe-ai/sdk`, passed through unchanged |
| Judgment worker | `TypeSafeClient.systemOne()`, one call per step, with the jev version pinned in config |
| Text worker | AI SDK `generateText` with a `LanguageModel` per reasoning tier, so any provider works (including Vercel AI Gateway) |
| Gating | On `confidence` for Choice and Score, as TypeSafe recommends; on the `noul` probability for Noul, since Noul has no confidence |
| Tool arguments | `pick` fields: code finds candidate values, a jev Choice selects one. No model generates arguments. |
| Dependencies | Each field lists the earlier fields it reads (`after`). A field can only depend on fields declared before it, so cycles are impossible. |
| Scheduling | Step by step: dependency levels, one `systemOne` call per level for all its judgments and picks |
| Example and benchmark schema | E-commerce support triage, matching the benchmark data and TypeSafe's intent-routing example |
| Benchmark data | Two sets. Bitext (CDLA-Sharing-1.0) at scale with its own labels, for intent, category, confidence and the pick. About 60 hand-written multi-sentence tickets, reported as synthetic, for escalation, complexity and hard cases. |
| Intent granularity | jev chooses among Bitext's 27 intents; code rolls up to 8 categories and gates on category probability |
| Baselines | One structured-output call to a frontier model, and one to a cheap model |

### Out of scope for the MVP

A portable spec document, hosted runtime, dashboard, streaming results, a Python version, prompt-injection defenses beyond confidence gating, and calibrated scores for generated text.

## Components

One package plus a separate `bench/` workspace. Node 24, pnpm, strict TypeScript. Runtime dependencies: `@typesafe-ai/sdk` and `ai` (AI SDK), both as peer dependencies.

| Unit | Responsibility | Depends on |
|---|---|---|
| `builder` | The chained `fieldwork()` builder, field kinds, and the type machinery that infers each field's result type | — |
| `plan` | Group fields into steps by their `after` lists; runtime check that `after` names only earlier fields | `builder` |
| `resolvers/judge` | Put every judgment and pick in a step into one `systemOne` request; map answers back to fields | `@typesafe-ai/sdk` |
| `resolvers/pick` | Run a pick's `candidates` function, add a `none` option, build its Choice question | `resolvers/judge` |
| `resolvers/text` | Build the prompt and call `generateText` with the tier's model | `ai` |
| `resolvers/tool` | Call the registered function with the typed dependency results and inputs | — |
| `grade` | One `systemOne` request with two Nouls per generated text field | `resolvers/judge` |
| `run` | Execute steps, evaluate `when`, enforce timeouts and the deadline, assemble results and trace | all of the above |
| `trace` | Per-call records and cost estimates | — |
| `bench/` | Dataset preparation, systems under test, metrics, report. Uses only the public API. | the package |

### Public API

The example is an e-commerce support triage. It follows the customer service example on TypeSafe's intent-routing pattern page (an intent Choice plus a complexity Score, with low confidence or a complex request going to a person), and it matches the benchmark data.

jev chooses among the 27 fine-grained intents; code rolls the probabilities up to 8 categories and gates on the category's total probability. This is the pattern in TypeSafe's "Classification using confidence" and "Hierarchical classification" cookbooks: when the model is unsure between two intents in the same category, the category can still be acted on. It also gives the benchmark enough errors to measure confidence against.

```ts
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { fieldwork } from "fieldwork";
import { INTENTS, rollUpToCategory } from "./intents"; // 27 intents with descriptions; intent → category map

const triage = fieldwork<{ ticket: string }>()
  .judge("intent", choice("The primary intent of this customer message", INTENTS))
  .tool("category", {
    after: ["intent"],
    when: (f) => f.intent.passed, // no gate, so this means "filled"
    call: (f) => rollUpToCategory(f.intent.probabilities), // { category, probability }
  })
  .judge("complexity", score("How complex is this request to resolve", [
    "Simple lookup or standard procedure",
    "Requires some judgment or multi-step process",
    "Unusual situation, edge case, or escalation needed",
  ]), { gate: 0.85 })
  .judge("isRepeat", noul("Does the customer say this problem happened before?"))
  .pick("orderNumber", {
    instructions: "The order number the customer is asking about",
    candidates: (input) => findOrderNumbers(input.ticket), // regex in app code
  })
  .tool("order", {
    after: ["category", "orderNumber"],
    when: (f) => f.category.value?.category === "order" && f.orderNumber.value !== null,
    call: (f) => orders.lookup({ orderNumber: f.orderNumber.value! }),
  })
  .text("reply", {
    after: ["category", "complexity", "order"],
    when: (f) => (f.category.value?.probability ?? 0) >= 0.85
      && f.complexity.passed && f.complexity.score < 1.5,
    reasoning: "low",
    instructions: "Reply to the customer",
    style: "warm, under 80 words, no promises about dates",
  })
  .text("escalationNote", {
    after: ["category", "complexity", "isRepeat", "order"],
    when: (f) => (f.category.value?.probability ?? 0) < 0.85
      || !f.complexity.passed || f.complexity.score >= 1.5,
    reasoning: "high",
    instructions: "Summarize the ticket for the on-call agent",
    style: "one line",
  });

const result = await triage.run({ ticket }, {
  typesafe: new TypeSafeClient(),       // jev model pinned via defaultModel
  models: { low: cheapModel, medium: midModel, high: bigModel }, // AI SDK LanguageModels
  deadlineMs: 10_000,
});

result.fields.intent;
// { status: "filled", choice: "track_refund", confidence: 0.94, probabilities: {...}, passed: true, worker: "jev", model: "jev-1.13.0", ms: 190 }
result.fields.reply;
// { status: "skipped", passed: false, reason: "when returned false" }
result.trace;
// { steps: [{ fields, calls: [{ worker, model, ms, inputTokens, outputTokens, estCostUsd }] }], totalMs, estCostUsd }
```

`f` inside `when` and `call` contains only the fields named in `after`, so reading any other field is a compile error. Result types come from the question: `f.intent.choice` is the union of the declared labels. `f.complexity.score` is TypeSafe's expected score over levels counted from zero, so it can fall between levels (1.7, say); `when` functions compare it against thresholds such as `1.5`, never test it for equality with a level.

## Field kinds

| Method | Worker | Takes | Result when filled | Gate |
|---|---|---|---|---|
| `judge(name, choice(...))` | jev | A TypeSafe Choice question, `gate?` | `choice`, `confidence`, `probabilities` | `confidence >= gate` |
| `judge(name, score(...))` | jev | A TypeSafe Score question, `gate?` | `score`, `confidence`, `probabilities` | `confidence >= gate` |
| `judge(name, noul(...))` | jev | A TypeSafe Noul question, `yesAbove?` | `noul`, and `yes` if `yesAbove` is set | `yes` is set only when `noul >= yesAbove` or `noul <= 1 - yesAbove`; otherwise `passed` is false |
| `pick(name, ...)` | jev | `instructions`, `candidates(input)`, `gate?` | `value` (a candidate string, or `null` for none), `confidence` | `confidence >= gate` |
| `tool(name, ...)` | Your function | `call(f, input)` | `value` (JSON-serializable) | always `passed: true` |
| `text(name, ...)` | AI SDK model | `instructions`, `style?`, `reasoning` or `model`, `grade?` (default `true`), `minScore?` | `value` (string), `score` or `null`, `heuristic: true` | `score >= minScore` when set |

A Choice, Score or pick with no `gate` has `passed: true` whenever it is filled.

Every field also takes `after` (earlier fields it reads), `when` (a function of those fields and the inputs), and `timeoutMs`. `judge` and `pick` fields may also list `after` fields; their results are added to that request's state as named data.

A pick's `candidates` function returns strings found by code (amounts, dates, account numbers). Fieldwork adds a `none` option so jev can report that no candidate fits. Parsing and comparing the chosen value stays in app code, because TypeSafe documents jev as unreliable at date and number arithmetic.

`reasoning` is `low`, `medium` or `high` and selects a model from `models`. `model` passes an AI SDK model directly and overrides the tier. A text field with neither uses `medium`.

### Field results

- `{ status: "filled", passed, worker, model, ms, ...kind-specific values }`
- `{ status: "skipped", passed: false, reason }`
- `{ status: "failed", passed: false, error }`, where `error` is a short code and message, never a raw provider or tool payload

Inside `when`, a skipped or failed dependency has `passed: false` and its value properties are `undefined`. So `f.complexity.score >= 1.5` is false when `complexity` failed, and `!f.complexity.passed` is true. The field types are unions discriminated on `passed`, so checking `f.complexity.passed` narrows `score` to a number before a comparison such as `score < 1.5`. A failed field never fails the run. A `when` or `call` function that throws marks only its own field `failed`.

## Execution

### Planning

`plan` puts each field in the step after the latest step of anything in its `after` list. Fields with no `after` go in step 1. The builder's types reject names that are not earlier fields; `plan` repeats that check at runtime for untyped callers.

### Running a step

1. Evaluate `when` for each field in the step. False → `skipped`.
2. All remaining `judge` and `pick` fields go into **one** `systemOne` request. `state` holds the inputs plus the results of every `after` field those questions list, as named JSON fields. Question ids are the field names.
3. Text and tool fields run in parallel with that request.
4. The step finishes when all its fields have settled.

A pick whose candidates depend only on the inputs lands in step 1. It is asked on every run, even when the tool that uses it ends up skipped. That is TypeSafe's speculative fan-out pattern; extra questions cost only input tokens.

A missing answer, or a choice outside the question's options, marks only that field `failed`.

### Text generation

The prompt is built from `instructions` and `style`, with the inputs and `after` results given as clearly labeled data blocks. The model returns plain text. No JSON format instructions are ever sent to a text worker.

### Grading

After the last step, one `systemOne` request covers every filled text field with `grade: true`: two Nouls per field, "Is this text supported by the provided context and inputs?" and "Does this text meet the style: <style>?" (the second is omitted when there is no `style`). The score is the product of the two `noul` values. It is always returned with `heuristic: true`. TypeSafe notes that separate Nouls don't obey arithmetic identities, so this product is useful for ranking and alerts but is not a calibrated probability. When grading fails, the field stays filled with `score: null`.

### Error handling

| Failure | Result |
|---|---|
| `systemOne` request errors or times out (after the SDK's own retries) | Every judgment and pick in that request → `failed`; dependents see `passed: false` |
| Text generation fails | That field → `failed`; others in the step continue |
| Grading fails | Text fields stay `filled`, `score: null` |
| Tool throws | `failed` with the error message only |
| `deadlineMs` reached | Unsettled fields → `failed` with `timeout`; the run returns what it has |

Fieldwork does not add its own retries on top of the TypeSafe SDK's retry policy or the AI SDK's `maxRetries`. Logs never include inputs, generated text, or provider response bodies.

### Trace

Each step records its fields and calls. Each call records worker, model (for jev, the versioned id from the response's `model` field), latency, and input and output tokens from the response's usage. Cost is an estimate from a price table in config: jev defaults to $0.042 per million input tokens with free output, per TypeSafe's models page, and text-model prices must be supplied by the user. The benchmark reads cost and latency from the trace.

### jev constraints the design respects

From TypeSafe's jev 1.13 notes:

- Pin a versioned model id, not `jev-latest`, because gate thresholds are tuned against one version.
- Keep date, number and counting logic in code. Picks select a raw span; code parses and compares it.
- Keep state small and relevant. Only inputs and listed `after` results go into a request.
- Text inside a ticket can steer an answer. Fieldwork does not claim to prevent this. Gates limit the damage, and the benchmark measures it.
- `state` plus the longest question must fit in 32k tokens, and each request in 64k. Fieldwork checks request size before sending and fails the step's judgments with `state_too_large` rather than sending.

## Benchmark

### Pilot (week 1)

Before building the library: run the Bitext dev split through a plain `systemOne` call (the 27-intent Choice and the order-number pick) and through one cheap structured-output call, then write one page of findings. This checks that jev's confidence separates right from wrong answers on this data before the library is built around it. It needs no hand labels, because Bitext's own labels are the answers. The pilot also confirms the SDK behavior the design assumes (several questions per request keyed by id, `usage` and a versioned `model` in the response, a custom `fetch`).

### Data

There are two sets, reported separately.

**Bitext set.** Real customer phrasing, labels from the dataset, used for intent, category, confidence and the pick.

- Source: `bitext/Bitext-customer-support-llm-chatbot-training-dataset` on Hugging Face, CDLA-Sharing-1.0, pinned to revision `430d1a89bd93bd1fa23c16f29dd53e73f0087443` (file `Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv`, 26,872 rows, 27 intents in 11 dataset categories). The published sample is shared under the same license; benchmark results are not restricted.
- Tickets are single requests, a median of 48 characters, with typos and slang. They carry no escalation signal: whether a ticket needs a person follows from its intent alone. So the Bitext set is not used for escalation, complexity or `isRepeat`.
- The 27 intents map to the 8 benchmark categories. The mapping is stored in the repo.
- Placeholders such as `{{Order Number}}`, `{{Person Name}}` and `{{Refund Amount}}` are replaced with values generated from a fixed seed. The value put in for `{{Order Number}}` is the `orderNumber` label; tickets without one are labeled `none`. Only `cancel_order`, `track_order` and `change_order` tickets contain an order number, each at most once, and invoice tickets contain invoice numbers such as `#12588` that the pick must reject.
- Sample stratified by intent, fixed seed: 10 per intent for dev (270) and 40 per intent for test (1,080). Balanced intents make macro metrics direct, and the test size gives enough errors to measure calibration.

**Written set.** About 60 multi-sentence tickets written by hand in the same e-commerce domain, all labeled as synthetic. They carry the judgments one-line Bitext requests cannot.

- Hand labels: `intent`, `complexity` (the Score's three levels), `needs_escalation`, `isRepeat`, and `orderNumber` (or `none`).
- About half need escalation, so recall rests on enough positives. Tickets with an order number also mention other numbers (invoice numbers, amounts, dates) so the pick has real distractors.
- Tagged hard cases: mixed intents, relative dates, and injected instructions. Injected instructions are drawn from `TrustAIRLab/in-the-wild-jailbreak-prompts` (the set TypeSafe's guardrails cookbook uses) and embedded in ordinary tickets, subject to a license check before redistribution.
- A written labeling guide defines each complexity level and when a ticket needs escalation.
- Split 20 dev / 40 test.

Questions, criteria and gates are tuned only on the dev splits. Each test split is run once, after tuning is frozen.

### Systems

1. Fieldwork with the triage schema above (`intent` rolled up to `category`, `complexity`, `isRepeat`, `orderNumber`, `reply` when not escalating, `escalationNote` when escalating; `orders.lookup` is stubbed). A run escalates when `escalationNote` is filled.
2. Frontier single call: one structured-output request returning all fields plus a self-reported confidence per judgment.
3. Cheap single call: the same request to a cheap model.

All three use the same instruction wording.

### Metrics

| Metric | Set | Purpose |
|---|---|---|
| Category accuracy and macro-F1; intent accuracy | Bitext | Core correctness |
| Accuracy at a given coverage, expected calibration error, for category probability and intent confidence | Bitext | The confidence claim, compared against self-reported confidence |
| Order number exact match, including correct `none` | Both | The pick |
| Estimated cost per ticket; p50 and p95 latency | Both | The cost claim, and its latency price |
| Escalation recall and precision | Written | Missing a ticket that needs a person is the costly error |
| Complexity accuracy (expected score rounded to the nearest level); `isRepeat` accuracy | Written | The other judgments |
| Hard-case results by jev weak spot | Written | The failure report |
| Reply quality: blind pairwise judgment by a model family not used for generation, plus a 30-reply human spot check | Written | Secondary |

Every metric is reported with a 95% bootstrap confidence interval, since the written set is small.

### Reproducibility

`pnpm bench` runs all systems on a chosen split and writes `results/<run>.json` and `results/<run>.md`. Every model response is cached by request hash, so reruns and report changes cost nothing. The results, the labeled sample and the response cache for the published runs are committed, so readers reproduce the numbers without API spend, as TypeSafe's cookbooks do with their shipped `json_cache.json`.

## Testing

- Type tests (`expectTypeOf`) for the builder: inferred result types, `after` restricting `f`, unknown names rejected.
- Unit tests for `plan`: step grouping and the runtime `after` check.
- Runtime tests with a fake `fetch` passed to `TypeSafeClient` and the AI SDK's mock language model, one per row of the error table plus the triage example end to end.
- A contract test against real jev and one real text model, run only when `FIELDWORK_LIVE=1`, checking response shapes.
- Vitest, strict TypeScript, ESLint and Prettier.

## Build order

About six weeks at 10 to 15 hours a week.

| Week | Work |
|---|---|
| 1 | Pilot on the Bitext dev split: data preparation, plain `systemOne` against one cheap structured-output call, one-page finding |
| 2 | `builder` and its types, `plan`, fake-client tests. Start writing the written set. |
| 3 | `resolvers`, `grade`, `run`, `trace`; live contract test; the triage example |
| 4 | `bench/`: labeling guide, finish and label the written set, hard cases, frontier baseline, metrics and report |
| 5 | Tune on dev, freeze, run test once |
| 6 | Publish results, write-up, cookbook pull request to TypeSafe's docs |

## Open questions

- Package name. The unscoped npm name `fieldwork` was unpublished in June 2026; publishing under a scope avoids depending on it.
- Whether the cookbook should use Fieldwork or plain `@typesafe-ai/sdk` code. Plain SDK code is more likely to be accepted; the write-up can then show the Fieldwork version beside it.
