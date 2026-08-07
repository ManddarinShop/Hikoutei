---
title: Benchmarks
description: Dated live and synthetic measurements for Hikoutei sync — throughput, latency, quota behavior, and their limitations.
---

# Benchmarks

All measurements are dated, environment-specific observations recorded in the
repository's
[`docs/sync-bulk-write-benchmark.md`](https://github.com/ManddarinShop/Hikoutei/blob/develop/docs/sync-bulk-write-benchmark.md).
They are not guarantees for other environments.

## Key findings (historical)

| Observation | Result | Caveat |
| --- | --- | --- |
| Raw Apps Script `setValues()` (100 rows × 6 cols) | ~374 ms steady-state (~267 rows/s) | isolated write, no safety machinery |
| Progressive operational run | 1,110 rows in ~36.9 s (~30.1 rows/s) | remote worker→Gateway path dominated |
| Redeployed signed no-op Gateway baseline | p50 1.956 s / p95 4.511 s over 100 requests | transport-only probe |
| Local SQLite CRUD (clean mixed workload) | ms-scale, zero failures | Gateway p95 was ~33 s in the same run |

The evidence shows the bottleneck is **not raw cell writes** — it is
dispatch/runtime overhead, locks, metadata lookups, receipts, postconditions,
and recovery. The 2026-08-03 clean smoke also showed the outbox not converging
while the local API stayed healthy, which is why the
[internal consistency model](/guide/internal-consistency) and the
[architecture](/guide/architecture) treat local serving and remote convergence
as separate concerns.

## Benchmark recording rule

Any new benchmark must be recorded durably before it is considered complete:
date and branch, exact command, dataset size and scenario, environment, a
result table with a separate no-setup/steady-state column, comparison with the
previous relevant benchmark, and known caveats. See
[`CONTRIBUTING.md`](https://github.com/ManddarinShop/Hikoutei/blob/develop/CONTRIBUTING.md)
for the rule.
