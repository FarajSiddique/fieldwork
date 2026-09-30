# Benchmark dev run

Date: 2026-09-29 · Split: dev (270 Bitext + 20 written tickets) · Status: **incomplete — no results committed**

## What happened

`pnpm bench dev` was run twice (the second run retries only the uncached calls, as the bench-runbook allows once). Both runs finished, but AI Gateway refused almost every call to two of the models with `No access to this model at this time` — the same account-side error that blocked the pilot rerun:

| System | Model | Answered | Failed |
|---|---|---|---|
| fieldwork (jev) | `typesafe-ai/jev` | 2 of 290 | 288 (`rate_limited: jev: HTTP 429`) |
| frontier | `anthropic/claude-opus-5.5` | 2 of 290 | 288 (`GatewayRateLimitError: No access to this model at this time`, after 3 attempts) |
| cheap | `anthropic/claude-haiku-4.5` | 290 of 290 | 0 |

576 of 870 predictions failed against a limit of 8, so the run is incomplete. A report from it would score the two refused systems as wrong with confidence 0, so none is committed or quoted. The incomplete `bench-dev.{json,md}` were kept outside git in `bench/.data/incomplete-bench-dev/`.

## Spend

About $0.85 in estimated cost: cheap baseline $0.59, Fieldwork $0.23 (mostly escalation notes written after jev failed, whose prompts will not recur once jev answers), frontier $0.02. Every successful response is in `bench/cache/`, so the next run re-sends only the refused calls: at least 578 jev and 289 Opus calls, about $4.20 by the dry run's estimate.

## Still owed

- AI Gateway access to `typesafe-ai/jev` and `anthropic/claude-opus-5.5` for this account. One call each succeeded, so the refusal may be rate- or tier-based rather than total.
- Then: `pnpm bench dev --dry-run`, `pnpm bench dev`, and this note rewritten with the report's numbers (see the week 4 plan, Task 11, Step 5).
- The pilot's full rerun (`bench/results/pilot-finding.md`) is owed for the same reason.

## Update (2026-09-30): tabled

A third run added retries with exponential backoff and jitter (`bench/src/backoff.ts`) at `BENCH_CONCURRENCY=4`. After about 2.5 minutes, only 2 new jev responses had been cached, so the owner stopped it. A single sequential call to each model succeeds, but the gateway still refuses sustained load. The dev run is tabled until the account can sustain it. The 2 new responses are committed and will be reused.
