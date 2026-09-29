# Pilot results

Split: dev (270 tickets), seed 20260928. Intervals are 95% bootstrap intervals. AUROC is the chance a correct answer is more confident than a wrong one.

| Metric | jev | anthropic/claude-haiku-4.5 |
|---|---|---|
| Models | typesafe-ai/jev | anthropic/claude-haiku-4.5 |
| Failed predictions | 0 | 0 |
| Intent accuracy | 95.2% (92.6%–97.4%) | 92.2% (88.9%–95.2%) |
| Category accuracy | 97.0% (94.8%–98.9%) | 96.3% (94.1%–98.5%) |
| Category macro-F1 | 0.971 | 0.963 |
| Intent AUROC | 0.664 (0.494–0.840) | 0.621 (0.466–0.764) |
| Category AUROC | 0.556 (0.398–0.767) | 0.518 (0.307–0.739) |
| Intent ECE | 0.037 | 0.040 |
| Category ECE | 0.024 | 0.064 |
| Category accuracy at 90% coverage | 97.5% | 97.1% |
| Category accuracy at 80% coverage | 97.2% | 96.8% |
| Category accuracy at 70% coverage | 96.8% | 96.8% |
| Order number exact match (tickets with candidates) | 66.7% of 42 | 69.0% of 42 |
| Order number exact match (all) | 94.8% | 95.2% |
| Cost per ticket | $0.000038 | $0.001211 |
| Latency p50 / p95 | 229 / 435 ms | 926 / 1542 ms |

## SDK checks

- One jev model id: typesafe-ai/jev (pass; AI Gateway does not report the jev version)
- Every jev answer served by typesafe-ai: typesafe-ai (pass)
- Token usage on every jev response: pass
