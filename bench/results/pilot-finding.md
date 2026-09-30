# Pilot finding

Date: 2026-09-29 · jev `typesafe-ai/jev` via AI Gateway (version not reported) · baseline `anthropic/claude-haiku-4.5` · Bitext dev split, 270 tickets

## Decision: NO-GO as run (the confidence gate missed); recommended next step is one rerun after fixing an intent description

The confidence criterion failed, so by the plan's rule this run is NO-GO. The cause is traced below to our own intent wording, not to jev's confidence, and it is cheap to fix and rerun on the dev split. The go/no-go call is the project owner's.

### Update 2026-09-29: provisional GO

The intent descriptions and order-number question were fixed (commit 74d27ea) and the pilot rerun. The rerun is incomplete: AI Gateway refused 203 of 270 jev calls with `429 No access to this model at this time`, apparently a gateway-side issue on accounts that moved from the free to the paid tier (the refused calls never reached TypeSafe). On the 67 tickets jev did answer, computed offline from the cache:

| Same 67 tickets | Intent accuracy | Errors | Intent AUROC (95% interval) |
|---|---|---|---|
| jev, old wording | 91.0% | 6 | 0.567 (0.349–0.850) |
| jev, new wording | 92.5% | 5 | 0.905 (0.808–0.985) |
| Haiku 4.5, new wording | 92.5% | 5 | 0.937 (0.849–1.000) |

The four confidence-1.00 errors on these tickets are gone; every new-wording error has confidence 0.91 or lower. The subset is small and not random, so this is a signal rather than the gate. The project owner decided to proceed to M1 provisionally. The full 270-ticket rerun, with the same gate, is still owed once the gateway issue clears, and parts of M1 that depend on jev's confidence stay provisional until then.

### Update 2026-09-29: full rerun still blocked

The full dev rerun was tried once more. Preflight counted 203 live jev calls (67 cached, estimated $0.0079); the run made them and AI Gateway refused 202 of the 270 jev calls with `RateLimitError: 429 No access to this model at this time` (one call succeeded and was cached). The Haiku 4.5 baseline was fully cached and had no failures. That is 202 of 540 predictions failed, against a limit of 5, so the run is incomplete and its report is not a result: failures score as wrong with confidence 0, which is why the discarded report showed jev at 23.3% intent accuracy. `pilot.md` and `pilot.json` were restored to the previous committed run. No calls were retried after this run; the failure is account-side, and the rerun stays owed. The provisional GO above is not superseded, and the confidence gate (jev intent AUROC ≥ 0.70 with the interval's lower bound above 0.5) has not been applied to the full split.

## Criteria

| Criterion | Threshold | Result | Met |
|---|---|---|---|
| Confidence separates right from wrong | jev intent AUROC ≥ 0.70, CI lower bound > 0.5 | 0.664 (0.494–0.840) | No |
| SDK assumptions | one jev model id, every answer served by `typesafe-ai`, usage on every response (jev version is not verifiable through AI Gateway) | `typesafe-ai/jev` only; all served by `typesafe-ai`; usage on all | Yes |
| Failures | ≤ 1% of predictions | 0 of 540 in the final results (2 jev calls failed with a free-tier 403 on the first run, right after credits were added, and succeeded on retry) | Yes |

Informational, not part of the decision:

| Measure | jev | Cheap baseline (Haiku 4.5) |
|---|---|---|
| Intent accuracy | 95.2% (92.6%–97.4%) | 92.2% (88.9%–95.2%) |
| Category accuracy | 97.0% (94.8%–98.9%) | 96.3% (94.1%–98.5%) |
| Intent AUROC | 0.664 (0.494–0.840) | 0.621 (0.466–0.764) |
| Category ECE (baseline: self-reported confidence) | 0.024 | 0.064 |
| Cost per ticket | $0.000038 | $0.001211 |
| Latency p50 / p95 | 229 / 435 ms | 926 / 1542 ms |

## What the numbers say

jev is slightly more accurate than Haiku 4.5 on intent (13 errors against 21) and level on category (8 against 10), at about 1/32 of the cost and a quarter of the latency. With only 13 intent errors and 8 category errors, both AUROC intervals are wide; the category interval is too wide to read, so the gate rests on intent AUROC, which missed at 0.664. Six of jev's 13 intent errors carry confidence 1.00, and all six are the same pair: tickets like "when will my package arrive", labelled `delivery_period`, answered `track_order`. Our description of `track_order` in `bench/src/intents.ts` is "Asks where an order is or when it will arrive", so jev followed the option text we gave it; Haiku made the same seven confusions. jev's other seven errors all have confidence 0.86 or lower (median 0.62), which is the separation the gate is looking for. Category accuracy barely moves as coverage falls (97.0% at full coverage, 96.8% at 70%) because the confident `delivery_period`/`track_order` errors cross categories (shipping vs order) and sit at the top of the confidence ranking.

## Surprises

- The overlapping `track_order` description, described above. It is a defect in the benchmark's wording, not in either system.
- Order numbers: both systems found all 28 real order numbers. Every miss (14 for jev, 13 for Haiku) is an invoice number ("check invoice #85632") on a ticket with no order number, which both systems returned as the order number. The candidate regex matches invoice numbers, and the question does not say that invoice numbers are not order numbers. The exact-match rate on tickets with candidates (66.7% jev, 69.0% Haiku) is therefore measuring this wording gap, not extraction.
- jev is very sure of itself: 73% of its answers have confidence ≥ 0.99. Haiku reports at most 0.99 and puts 11 of its 21 errors at ≥ 0.90.
- Two jev calls got a free-tier 403 on the first run after the account was upgraded, presumably while the upgrade propagated. Failures are not cached, and the retry succeeded.

## Consequences for M1

Before any go decision:

1. Make the `track_order` and `delivery_period` descriptions disjoint (for example, `track_order`: "Asks where an order is or for its tracking status"; `delivery_period`: "Asks how long delivery takes or when an order will arrive"), and state in the order-number question that invoice and bill numbers are not order numbers.
2. Rerun the pilot on the dev split (about $0.35; the test split stays untouched) and apply the same gate. If intent AUROC still misses, the design's reliance on jev's confidence for gating needs revisiting.

Both changes touch only wording on the dev split, which is what the pilot is for. The wording change also changes every request hash, so the rerun calls the gateway afresh rather than reading this run's cache.
