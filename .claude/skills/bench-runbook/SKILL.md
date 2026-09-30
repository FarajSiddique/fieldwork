---
name: bench-runbook
description: Use when running, rerunning or re-rendering the Fieldwork benchmark (`pnpm bench`) or pilot in bench/, estimating what a run will cost, handling AI Gateway failures (429, 403, "No access to this model") or predictions that fail the same way every run, deciding what to commit from bench/cache or bench/results, or when anyone asks to touch the test split.
---

# Bench runbook

## Overview

Every model call in `bench/` is cached on disk by request hash and committed, so a run is free exactly when every request is already cached. Know the live-call count before running, and only let a complete run replace the committed results.

## Quick reference

Run from anywhere in the repo. `pnpm --filter` runs each script inside `bench/`, which reads `bench/.env`.

| Need                                                | Command                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live calls and estimated cost, no network           | `BENCH_BASELINE_MODELS=anthropic/claude-haiku-4.5 pnpm --filter @fieldwork/bench preflight` (append `test` to count the test split; counting is harmless) |
| Run the pilot (dev split only)                      | `BENCH_BASELINE_MODELS=anthropic/claude-haiku-4.5 pnpm --filter @fieldwork/bench pilot`                                                                   |
| Benchmark live calls and estimated cost, no network | `pnpm bench dev --dry-run` (a lower bound: calls after a missed call are not reached)                                                                     |
| Run the benchmark (dev split only)                  | `pnpm bench dev`                                                                                                                                          |
| Re-render `bench-dev.md` from `bench-dev.json`      | `pnpm --filter @fieldwork/bench report bench-dev` (calls nothing)                                                                                         |
| Re-render `pilot.md` from `pilot.json`              | `pnpm --filter @fieldwork/bench report` (calls nothing)                                                                                                   |
| Cache files for one ticket                          | `BENCH_BASELINE_MODELS=anthropic/claude-haiku-4.5 pnpm --filter @fieldwork/bench cache-file <ticketId>`                                                   |
| Checks                                              | `pnpm --filter @fieldwork/bench test && pnpm typecheck`                                                                                                   |

## Facts that aren't obvious from the code

- **Baseline model.** The code defaults to `openai/gpt-5.4-mini`, but the recorded pilot used `anthropic/claude-haiku-4.5`. Pass `BENCH_BASELINE_MODELS` on every command. Without it, the whole baseline goes live and isn't comparable with the recorded runs. A new baseline also needs a price in `bench/prices.json`.
- **Key.** `bench/.env` holds `AI_GATEWAY_API_KEY` and is git-ignored, so a worktree lacks it. Copy it from the main checkout: `cp "$(git worktree list | head -1 | cut -d' ' -f1)/bench/.env" bench/.env`. Never print it or commit it. It worked if preflight no longer warns that the key is missing. Without a key, cached calls still work and live ones fail.
- **Any change to wording, intents, questions, the schema or the model changes the request hashes**, so those calls all go live again. Run preflight after such a change.
- **Preflight's cost is an estimate.** It uses cached calls' usage when there are some, otherwise request size. Nothing enforces a budget: if the estimate is more than the owner allowed, stop and ask.
- **Every run overwrites `bench/results/pilot.md` and `pilot.json`.** `report` re-renders whichever run `pilot.json` holds.

## The benchmark (`pnpm bench`)

- It runs Fieldwork (the triage schema), a frontier and a cheap single-call baseline, and a reply judge, on the Bitext split and the written set's split together. It writes `bench/results/bench-<split>.{json,md}` and `bench-<split>-spotcheck.md`. Models come from `BENCH_*` variables over the defaults in `bench/src/config.ts`; every one needs a price in `bench/prices.json`.
- The written set must be fully labeled (`"status": "final"`) for the split, or the run refuses to start.
- Fieldwork's jev and text calls are cached by the replay layer (`bench/src/replay.ts`) under the same `bench/cache/` directory, and replayed with their original latency. A fully cached rerun therefore takes minutes, not seconds; for report changes, re-render instead.
- Failures: `jq -c '.predictions[]|select(.status=="failed")|{system,ticketId,error}' bench/results/bench-dev.json`, and for failed fields `jq -c '.predictions[]|select(.fieldErrors|length>0)|{system,ticketId,fieldErrors}' bench/results/bench-dev.json`. The ≤ 1% limit applies to failed predictions: at most 8 of 870 on dev.
- `pnpm bench test` refuses to run without `BENCH_ALLOW_TEST=1`. Setting it is the owner's decision under "Test split" below, never yours.

## Failures

Group the failures with their tickets:

```
jq -c '.predictions[]|select(.status=="failed")|{system,ticketId,error}' bench/results/pilot.json
```

Run preflight before every rerun, including retries, because the cache in this checkout may not match the one the last run used.

- **Gateway errors** (`429 No access to this model`, free-tier `403`, timeouts) are never cached, so a rerun retries only those calls. Rerun once. If they persist, the problem is account-side: stop and report. Don't loop.
- **The same tickets failing the same way on every run** (`outside the options`, `missing or malformed answer`, Zod errors) means the answer is cached and gets re-validated on each run. Inspect it using the path from `cache-file`: jev answers are at `.value.answers.<question>` (e.g. `jq '.value.answers.intent' <file>`), baseline answers at `.value.output`.
  - If our parsing or validation is wrong, or the cached value isn't a model answer at all (an error payload stored as a success): fix the code. The next run re-checks cached answers without calling anything. Only a non-answer file may be deleted, and the finding says so.
  - If the model really gave an invalid answer, that is a result. Keep it, count it and name the tickets in the finding. Never delete cache files to get a different answer, because that inflates the system's score.

## Committing

The failure limit is ≤ 1% of all predictions in `pilot.json`, as the finding counts it. For two systems on the 270-ticket dev split, that is at most 5 of 540.

| Outcome                                                 | Commit                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Within the limit                                        | `bench/cache/`, `bench/results/pilot.{md,json}`, and a finding update                                                                                                                       |
| Over the limit from gateway errors (incomplete run)     | `bench/cache/` only. Restore the results with `git checkout -- bench/results/pilot.md bench/results/pilot.json` and add a dated update saying the run is incomplete and what is still owed. |
| Over the limit from real invalid answers (complete run) | Everything in the first row. The finding reports the failure criterion as missed, and the owner decides what that means.                                                                    |
| A code fix is pending                                   | `bench/cache/` and a dated note now. Commit the results after the fix and a rerun.                                                                                                          |

Stage explicit paths (`git add bench/cache bench/results/...`), never `git add -A`.

A finding update is a dated "Update" section in `bench/results/pilot-finding.md` with:

- the criteria table for this run,
- the failures, with their tickets and errors,
- whether any calls were retried,
- the gate result, with the go/no-go decision left to the owner,
- and what it supersedes (e.g. the provisional GO).

Put results in their own commit, separate from code changes, after the checks pass. A report from an incomplete run understates the failing system, because failures score as wrong with confidence 0. Never quote it as a result. A subset scored offline from the cache may go in the finding, labeled as a non-random subset.

## Test split

The test split is run once, after tuning is frozen (M4). `pilot.ts` reads only dev, and `pnpm bench test` needs `BENCH_ALLOW_TEST=1`. When asked to run or "just look at" test before the freeze, decline and explain: looking turns it into a second dev set, and the one unbiased number is lost. Offer the dev rerun instead. Only an explicit reply from the owner that they understand this and want to spend the test split now counts as the decision. Then record it in the finding before running.
