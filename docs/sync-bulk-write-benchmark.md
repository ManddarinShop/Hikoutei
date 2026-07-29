# Sync bulk-write benchmark

> Historical benchmark record. The measurements below are branch- and
> deployment-specific and are not the current public API contract. The current
> runtime treats SQLite as authoritative, sends durable outbox effects through
> a separate worker, and calls the signed operation-based Apps Script gateway.
> Older entries may mention retired HTTP routes, benchmark-only scripts, or
> earlier snapshot/metadata strategies; keep those details as historical
> evidence rather than implementation instructions. See
> [`architecture.md`](architecture.md) and
> [`write-and-synchronization-flow.md`](write-and-synchronization-flow.md) for
> the current design.

## 2026-07-24 — raw Apps Script write

- Branch: `benchmark/apps-script-bulk-write`
- Script: `apps-script/gateway/BulkWriteBenchmark.gs`
- Entry point: `runBulkWriteBenchmark100()`
- Backend: Apps Script `SpreadsheetApp`
- Target: `__typed_sheets_bulk_write_benchmark`
- Dataset: 100 rows × 6 columns = 600 cells
- Write mode: one contiguous `setValues()` followed by one `flush()`
- Setup: the benchmark appended at row 22; one-time sheet setup was excluded
  from the measured write interval

| Measurement | Setup | `setValues()` | `flush()` | Steady-state total |
| --- | ---: | ---: | ---: | ---: |
| 100 rows / 600 cells | 713 ms | 96 ms | 278 ms | 374 ms |

Throughput was 267.38 rows/second and 1,604.28 cells/second.

## Comparison: full sync request

The previous clean-DB test sent 20 customer effects through the complete
Gateway path with `POST /sync/once?maxEffects=20`. It took 75,409 ms and all 20
effects were applied. That path included snapshot reads, row metadata, CAS
checks, postcondition reads, receipts, and request tracing.

The raw write benchmark is therefore roughly 1,000 times faster per row than
the complete 20-effect sync request. This is not a correctness comparison: the
benchmark intentionally bypasses concurrency checks, user-edit detection,
receipts, and postcondition verification.

## 2026-07-24 — isolated stage benchmark

- Branch: `benchmark/apps-script-bulk-write`
- Script: `apps-script/gateway/BulkWriteBenchmark.gs`
- Entry point: `runBulkWriteStageBenchmark20()`
- Backend: Apps Script `SpreadsheetApp`
- Dataset: 20 rows × 6 columns
- Setup time is excluded from each stage measurement.

| Stage | Setup | Operation | Flush | Measured total |
| --- | ---: | ---: | ---: | ---: |
| `metadata_read` | 35,117 ms | 3,609 ms | — | 3,609 ms |
| `metadata_write` | 33,273 ms | 31,637 ms | 59 ms | 31,696 ms |
| `snapshot_read` | 19,540 ms | 4,303 ms | — | 4,303 ms |
| `cas_compare` | 0 ms | 2 ms | — | 2 ms |
| `postcondition_read` | 18,280 ms | 2,646 ms | — | 2,646 ms |
| `receipt_read` | 1,200 ms | 119 ms | — | 119 ms |
| `receipt_write` | 1,597 ms | 430 ms | 352 ms | 782 ms |

The dominant measured stage is `metadata_write`: rewriting three row metadata
entries for 20 rows took about 31.7 seconds, while the `flush()` itself took
only 59 ms. This identifies the per-row Developer Metadata API calls as the
primary bottleneck. The in-memory CAS comparison and receipt operations are
not significant for this test size.

## 2026-07-24 — visible-state metadata migration

The Gateway batch path now treats SQLite as the authority for
`visibleRevision` (가시적 버전) and `visibleHash` (가시적 상태 해시):

- Sheet Developer Metadata keeps only the projection-local row anchor.
- Batch CAS compares the bulk-read cell hash with the effect's
  `expectedVisibleHash` from SQLite; it no longer reads or rewrites a
  revision/hash metadata pair for every changed row.
- Successful results and receipts derive the next revision as
  `expectedVisibleRevision + 1`.
- Batch postconditions verify the raw cell hash in one range read.
- The receipt sheet remains because it is durable response-loss evidence, not
  per-row Developer Metadata.
- Existing visible revision/hash metadata is not deleted; it is left inert so
  this migration does not perform a destructive cleanup of user sheets.

This change is source-level and requires deploying the updated
`apps-script/gateway/Code.gs` before a live benchmark. The next comparison
should rerun `runBulkWriteStageBenchmark20()` and a 20-effect sync against a
fresh test sheet, then verify that `metadata_write` no longer appears in the
production batch path and that SQLite confirmations still advance normally.

## 2026-07-24 — new Gateway progressive load test

- Branch: `benchmark/apps-script-bulk-write`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: MikroORM + SQLite locally, deployed Apps Script Gateway remotely
- Database: fresh `typed-sheets-load-test-new-gateway.sqlite`
- Setup: provisioned five projection tabs and seeded 20 customers plus 20
  products; the 40-effect seed sync took 46.7 seconds and applied all effects
  with no failures. Setup is excluded from the stage comparison below.
- Gateway behavior: visible revision/hash row metadata disabled; anchor
  metadata and receipt sheet retained.
- Stage runner: the local Node fetch runner created orders in groups of
  `1/5/10/20` and called `/sync/once?maxEffects=1/5/10/20` once after each
  group. Each order produced four effects in this scenario.

| Orders added | `maxEffects` | Order writes | Sync request | Applied | Failed | Pending after stage |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 6.03 s | 5.97 s | 1 | 0 | 3 |
| 5 | 5 | 11.07 s | 11.03 s | 5 | 0 | 18 |
| 10 | 10 | 16.22 s | 16.15 s | 10 | 0 | 48 |
| 20 | 20 | 23.24 s | 23.10 s | 20 | 0 | 108 |

The stage sync cost was approximately 1.15 seconds per effect at the 20-effect
batch, compared with 5.97 seconds per effect at the single-effect batch. The
cost is still substantial, but the 20-effect request is about 3.3× faster than
the earlier 75.4-second 20-effect run that rewrote visible row metadata.

The accumulated 108-effect backlog was then drained with
`/sync/once?maxEffects=100`:

| Drain pass | Duration | Selected | Applied | Deferred | Failed | Pending after pass |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 59.85 s | 92 | 60 | 32 | 0 | 48 |
| 2 | 69.49 s | 48 | 48 | 0 | 0 | 0 |

Final SQLite counts were 36 orders, 36 order items, and 36 payments. The final
outbox contained 184 applied effects and no failed effects. This confirms that
the new Gateway path can drain this clean backlog, but it does not yet prove
that arbitrary response loss or a manually edited Sheet will always converge.

## 2026-07-24 — write-batch read reduction

- Branch: `benchmark/apps-script-bulk-write`
- Source: `apps-script/gateway/Code.gs`
- Scope: the `applyEffects` write path only; the standalone `readSnapshot` path
  remains unchanged

The write path no longer uses the reader-oriented full snapshot at both sides
of a batch:

- `createSyncBatchContext_` now reads one raw-value range and row anchors using
  `readSyncBatchState_`; it does not read formulas, display values, or merged
  ranges, and it does not repeat the raw-value range read.
- The postcondition check now reads only the changed rows, grouped into
  contiguous ranges, instead of reading every registered row from row 2 to the
  sheet's last row.
- The final full snapshot read was removed from the write response. SQLite is
  authoritative for visible revision/hash state, while each changed effect is
  still verified from raw Sheet cells before its receipt is written. Apply
  responses now contain only per-effect results and bounded-batch state.
- Stable row anchors and the receipt sheet remain unchanged because they are
  still required for row identity and response-loss recovery.

Static verification passed with `node --check`, the focused Apps Script source
and sync-client tests (9 tests), `npm run typecheck`, and `npm run build`. A live
comparison requires deploying this `Code.gs` first. The next benchmark should
compare the `prepare_batch_context`, `batch_flush`, and postcondition phase
durations against the progressive run above, especially on a sheet with many
existing rows.

## 2026-07-24 — fresh-sheet progressive load test after a new deployment

- Branch: `benchmark/apps-script-bulk-write`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: MikroORM + SQLite locally, newly deployed Apps Script Gateway
- Database: fresh `data/typed-sheets-load-test-progressive-20260724.sqlite`
- Dataset: 20 customers and 20 products seeded into a new spreadsheet; seed
  synchronization was 40 effects and is excluded from the progressive stage
  comparison
- Setup commands: `POST /sync/provision`, `POST /load-test/seed` with
  `customers=20`, `products=20`, then `POST /sync/once?maxEffects=100`
- Progressive script: create order groups of `1/5/10/20`; after each group,
  call `POST /sync/once?maxEffects=<group size>` and record `/metrics` before
  and after the call
- Background worker: disabled; synchronization was explicitly invoked by the
  test runner

The 40-effect seed took 49.87 seconds and applied all effects without failure.

| Orders added | `maxEffects` | Order writes | Sync request | Applied | Failed | Pending after stage |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 21.98 ms | 6.40 s | 1 | 0 | 3 |
| 5 | 5 | 42.29 ms | 9.13 s | 5 | 0 | 18 |
| 10 | 10 | 77.42 ms | 14.72 s | 10 | 0 | 48 |
| 20 | 20 | 139.47 ms | 27.39 s | 20 | 0 | 108 |

The first drain pass selected 92 effects, applied 60, deferred 32 because of
the Gateway prefix limit, and took 56.62 seconds. The following 16-effect
`load-payments-state` request exceeded the 120-second client timeout. Its
response-loss recovery then issued one full `readSnapshot` request per unknown
effect, with individual reads taking roughly 7–16 seconds. The observed state
after that recovery was 162 applied, 16 failed, and 6 pending; every failed
effect had `postcondition_unavailable`.

A follow-up drain selected 21 effects (the 16 failed effects were eligible for
retry plus 5 pending effects), took 184.39 seconds, applied only the 5 pending
effects, and left the same 16 failures. Final metrics were:

| SQLite table | Count |
| --- | ---: |
| customers | 20 |
| products | 20 |
| orders | 36 |
| orderItems | 36 |
| payments | 36 |

The final outbox contained 167 applied, 16 failed, and 1 pending effect. This
test confirms the dominant failure path is not raw `setValues()` throughput:
an oversized or slow payment batch reaches the 120-second transport timeout,
then failed-effect retry multiplies the cost by performing full snapshot reads
per effect. The next fix should make postcondition recovery batch-aware and
avoid retrying all failed effects in the normal drain pass without a bounded
backoff or explicit recovery mode.

## 2026-07-24 — fresh-sheet progressive load test with batch postcondition recovery

- Branch: `benchmark/apps-script-bulk-write`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: MikroORM + SQLite locally, newly deployed Apps Script Gateway
- Database: fresh `data/typed-sheets-load-test-progressive-20260724-new-sheet.sqlite`
- Dataset: 20 customers and 20 products seeded into a fresh spreadsheet; seed
  synchronization applied 40 effects without failure and is excluded from the
  progressive stage comparison
- Background worker: disabled; synchronization was explicitly invoked with
  `POST /sync/once`
- Recovery path: `readEffectPostconditions` batch API; no per-effect full
  `readSnapshot` recovery call

| Orders added | `maxEffects` | Order writes | Sync request | Selected | Applied | Requeued | Failed | Pending after stage |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 57.16 ms | 5.96 s | 1 | 1 | 0 | 0 | 3 |
| 5 | 5 | 44.42 ms | 125.51 s | 5 | 0 | 5 | 0 | 23 |
| 10 | 10 | 77.86 ms | 15.38 s | 10 | 10 | 0 | 0 | 53 |
| 20 | 20 | 558.76 ms | 18.54 s | 20 | 20 | 0 | 0 | 113 |

The five-effect stage exceeded the 120-second client timeout, but the new
batch postcondition recovery classified all five effects as `unapplied` and
returned them to `pending`; it did not create `postcondition_unavailable`
failures or issue one full snapshot read per effect. The other stages applied
normally.

The backlog was drained in multiple passes because the Apps Script Gateway
still limits each apply prefix to 20 effects, and product stock effects for the
same target must respect predecessor ordering:

| Drain pass | Selected | Applied | Deferred | Pending after pass |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 78 | 46 | 32 | 67 |
| 2 | 33 | 33 | 0 | 34 |
| 3 | 1 | 1 | 0 | 33 |
| Ordered-chain passes | 25 | 25 | 0 | 0 |

Final metrics were 184 applied effects, zero failed effects, and zero pending
effects. SQLite contained 36 orders, 36 order items, and 36 payments. This
reproduces the variable Gateway latency, but confirms that batch postcondition
recovery prevents the previous per-effect snapshot amplification and allows
the backlog to converge to zero.

## 2026-07-25 — published beta progressive API load test

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Package: published `typed-sheets@0.2.0-beta-1` (not a local workspace link)
- Backend: MikroORM + SQLite locally, deployed Apps Script Gateway remotely
- Gateway configuration: the new untracked `.env` values supplied for this
  test; the secret is intentionally not recorded here
- Background worker: disabled; the load runner invoked `/sync/once` itself
- Existing state: the test DB already contained one customer, one product, and
  two applied seed effects; the spreadsheet was also reused, so this is not a
  clean-sheet comparison
- Commands used:

```sh
LOAD_TEST_DURATION_MS=5000 LOAD_TEST_CONCURRENCY=1 \
LOAD_TEST_WRITE_RATIO=0.7 LOAD_TEST_SEED_CUSTOMERS=5 \
LOAD_TEST_SEED_PRODUCTS=5 LOAD_TEST_SYNC=1 LOAD_TEST_DRAIN=0 \
node --env-file-if-exists=.env load-test.mjs

LOAD_TEST_DURATION_MS=10000 LOAD_TEST_CONCURRENCY=2 \
LOAD_TEST_WRITE_RATIO=0.7 LOAD_TEST_SEED_CUSTOMERS=5 \
LOAD_TEST_SEED_PRODUCTS=5 LOAD_TEST_SYNC=1 LOAD_TEST_DRAIN=0 \
node --env-file-if-exists=.env load-test.mjs
```

| Stage | Duration | Concurrency | Generated orders | Total requests | Requests/s | Sync calls recorded | Applied | Pending | Processing | Failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Low | 5 s | 1 | 643 | 918 | 181.30 | 0 | 2 | 3,558 | 10 | 0 |
| Medium | 10 s | 2 | 876 | 1,283 | 127.24 | 0 | 18 | 8,429 | 45 | 0 |

The `/orders` route combines order writes and order-list reads, so its latency
is not a write-only measurement. The low-stage mixed route latency was p50
6.18 ms / p95 9.74 ms / p99 13.93 ms; the medium-stage latency was p50
14.67 ms / p95 28.77 ms / p99 39.45 ms. All HTTP requests succeeded.

The load runner did not receive a completed `maxEffects=50` sync response before
each short stage ended, so those calls were aborted from the runner's point of
view. A standalone `maxEffects=1` request after the low stage selected and
applied one effect successfully in roughly 3.3 seconds. This gives a direct
steady-state reference for the consumer path, excluding the load runner's
health and seed setup.

The medium stage already saturated the projection path: local SQLite produced
orders much faster than the Gateway consumed effects, growing the backlog from
3,558 to 8,429 pending effects while failed effects remained at zero. The high
stage was intentionally not run because it would add backlog and external
Gateway traffic without changing this conclusion. A clean-sheet drain test is
still required separately.

## 2026-07-25 — new Gateway fast-append and management-loop smoke test

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: MikroORM + SQLite locally, newly deployed Apps Script Gateway
- Database: fresh `data/typed-sheets-load-test-20260725-new-gateway.sqlite`
- Gateway configuration: new untracked `.env` values supplied for this test;
  the secret is intentionally not recorded here
- Background worker: enabled; reconciliation(불일치 보정) management loop was
  enabled with its default 60-second interval
- Command:

```sh
env LOAD_TEST_PROVISION=1 LOAD_TEST_DURATION_MS=3000 \
  LOAD_TEST_CONCURRENCY=1 LOAD_TEST_WRITE_RATIO=1 \
  LOAD_TEST_SEED_CUSTOMERS=20 LOAD_TEST_SEED_PRODUCTS=20 \
  LOAD_TEST_DRAIN=1 LOAD_TEST_SYNC_DRAIN_TIMEOUT_MS=120000 \
  npm run load-test
```

| Stage | Setup / provision | Traffic duration | Generated orders | HTTP errors | Applied | Pending | Processing | Failed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20/20 seed | 13.24 s | 3 s | 435 | 0 | 300 | 2,178 | 100 | 0 |

The local API successfully created 435 orders, 834 order items, and 435
payments; all 562 HTTP requests succeeded. The Gateway accepted
`fastAppendRows` batches of 20, 80, and 100 rows, and each returned `applied`,
but the remote requests still took approximately 16–37 seconds each. The
SQLite producer therefore outpaced the Gateway consumer and the drain did not
reach zero within 120 seconds.

The management loop exposed a compatibility defect after provisioning:
`readSnapshot` returned a protocol version that the Node client rejected as
unsupported. Consequently reconciliation did not run, so this result validated
fast append only and did not validate automatic drift repair. The protocol was
aligned in the follow-up run below.

## 2026-07-26 — protocol-aligned Gateway load test

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: MikroORM + SQLite locally, deployed Apps Script Gateway remotely
- Database: fresh `/private/tmp/typed-sheets-protocol-fixed-20260726.sqlite`
- Gateway configuration: current untracked `.env` values supplied for this
  test; the secret is intentionally not recorded here
- Background worker: enabled; reconciliation(불일치 보정) management loop was
  enabled
- The SQLite database was fresh, but the remote spreadsheet was reused and was
  not an empty-sheet comparison. The first reconciliation scan observed
  existing remote rows.
- Server command:

```sh
TYPED_SHEETS_DB_PATH=/private/tmp/typed-sheets-protocol-fixed-20260726.sqlite \
  TYPED_SHEETS_API_PORT=3200 TYPED_SHEETS_BACKGROUND_WORKER=1 npm start
```

- Load command:

```sh
LOAD_TEST_PROVISION=1 LOAD_TEST_DURATION_MS=3000 \
  LOAD_TEST_CONCURRENCY=1 LOAD_TEST_WRITE_RATIO=1 \
  LOAD_TEST_SEED_CUSTOMERS=20 LOAD_TEST_SEED_PRODUCTS=20 \
  LOAD_TEST_DRAIN=1 LOAD_TEST_SYNC_DRAIN_TIMEOUT_MS=120000 \
  npm run load-test
```

| Metric | Result |
| --- | ---: |
| Provision setup | 7.49 s |
| Traffic duration | 3 s |
| Generated orders | 465 |
| Total HTTP requests | 591 |
| HTTP errors | 0 |
| Steady-state `/orders` requests | 465 successful; p50 6.21 ms / p95 8.93 ms / p99 12.53 ms |
| Total elapsed including drain wait | 130.99 s |
| Final applied effects | 20 |
| Final pending effects | 3,605 |
| Final failed effects | 0 |

The protocol error disappeared: every observed `readSnapshot` request returned
`ok: true`, including reconciliation reads. However, the first reconciliation
scan on the reused sheet found 1,350 desired rows and 500 scanned remote rows,
then enqueued 885 correction effects. Those corrections competed with the
load-test writes. The Gateway applied the first 20-row `fastAppendRows` batch,
but returned `operation_failed` for later 80-row and 100-row batches; the
worker requeued those effects and no final `failed` rows remained. This run
therefore confirms protocol compatibility, but not successful convergence.

The result also shows that starting reconciliation immediately against a
non-empty reused sheet contaminates a producer-throughput test. The next
benchmark should use a clean spreadsheet, disable reconciliation for the raw
fast-append measurement, then run reconciliation separately with a controlled
drift case.

## 2026-07-26 — clean Sheet protocol-aligned load test

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: MikroORM + SQLite locally, newly deployed Apps Script Gateway
- Database: fresh `/private/tmp/typed-sheets-new-sheet-20260726.sqlite`
- Gateway configuration: new untracked `.env` values supplied for this test;
  the secret is intentionally not recorded here
- Background worker: enabled; reconciliation(불일치 보정) management loop was
  enabled
- The remote Sheet was new and passed provisioning successfully.
- Command:

```sh
LOAD_TEST_PROVISION=1 LOAD_TEST_DURATION_MS=3000 \
  LOAD_TEST_CONCURRENCY=1 LOAD_TEST_WRITE_RATIO=1 \
  LOAD_TEST_SEED_CUSTOMERS=20 LOAD_TEST_SEED_PRODUCTS=20 \
  LOAD_TEST_DRAIN=1 LOAD_TEST_SYNC_DRAIN_TIMEOUT_MS=120000 \
  npm run load-test
```

| Metric | Result |
| --- | ---: |
| Provision setup | 16.89 s |
| Traffic duration | 3 s |
| Generated orders | 393 |
| Generated order items | 759 |
| Generated payments | 393 |
| Total HTTP requests | 519 |
| HTTP errors | 0 |
| Steady-state `/orders` requests | 393 successful; p50 7.29 ms / p95 11.26 ms / p99 15.95 ms |
| Total elapsed including drain wait | 140.32 s |
| Final applied effects | 100 |
| Final pending effects | 2,164 |
| Final processing effects | 100 |
| Final failed effects | 0 |

The clean Sheet removed the previous reused-data problem for the initial
fast-append calls: 20-row and 80-row `fastAppendRows` batches were both
applied successfully, and no protocol or `operation_failed` error was observed
during those batches. However, the management loop later saw the canonical
SQLite state growing faster than the Sheet snapshot and enqueued additional
reconciliation work. The worker could not drain the resulting queue within
120 seconds; 2,164 effects remained pending and 100 remained processing when
the load runner stopped. A separate 20-effect correction request observed an
`operation_failed` response while the server was being shut down, so that
late response should not be treated as a clean fast-append result.

This isolates the current conclusion more clearly: a clean Sheet can accept
the tested 20- and 80-row fast-append batches, but the combined producer plus
reconciliation workload still exceeds the worker/Gateway drain rate. A raw
fast-append benchmark with reconciliation disabled is still needed to measure
the Gateway ceiling without management-loop work competing for the same worker.

## 2026-07-26 — new Gateway progressive load test

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: MikroORM + SQLite locally, newly deployed Apps Script Gateway
- Database: fresh `/private/tmp/typed-sheets-progressive-20260726-01.sqlite`
- Gateway configuration: new untracked values supplied for this test; the
  secret is intentionally not recorded here
- Provisioning: five projection sheets created and initialized successfully
- Background worker: enabled; reconciliation management loop enabled
- Traffic: write-only order workload (`LOAD_TEST_WRITE_RATIO=1`), 5 seconds per
  stage, 20 customers and 20 products seeded at each stage, no drain wait

The server was started with the Gateway environment variables supplied for this
run and `TYPED_SHEETS_WORKER_MAX_EFFECTS=100`. Each stage reused the same local
database and newly provisioned spreadsheet so the table and outbox totals show
the cumulative effect of the stages.

| Stage | Concurrency | Orders | `/orders` req/s | p50 / p95 / p99 (ms) | Final outbox |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 1 | 683 | 135.11 | 6.97 / 11.33 / 15.80 | applied 340, pending 4,084 |
| 2 | 2 | 582 | 112.71 | 15.53 / 27.20 / 36.95 | applied 340, failed 100, pending 8,431 |
| 3 | 4 | 481 | 93.66 | 42.46 / 67.13 / 141.94 | applied 340, failed 66, pending 12,462, processing 80 |

All API requests succeeded with zero HTTP errors. The SQLite totals after the
third stage were 1,746 orders, 3,385 order items, and 1,746 payments. The
write path therefore accepted traffic, but the projection path did not keep up:
the backlog increased by roughly 4,000 effects per stage while the applied
count remained at 340.

The server logs identified two concrete causes:

1. The reconciliation scan observed 340 Sheet rows but 4,434 desired SQLite
   rows and enqueued 1,197 correction effects while the original outbox was
   still being drained. Reconciliation is therefore amplifying the backlog
   when it runs before the initial append queue has caught up.
2. The correction effects include the `_deleted` tombstone field, but the
   registered ranges for the test sheets do not declare `_deleted`. Gateway
   postcondition recovery repeatedly failed with:

```text
postcondition_read_failed: Effect field is not a registered header: _deleted
```

There was also a direct Gateway cost signal: a `readSnapshot` for a 320-row
sheet took 65.553 seconds. This is outside the fast append write itself, but it
shows that running full reconciliation snapshots during a high-write backlog
can monopolize the same worker and make convergence worse.

This run is not a successful convergence test. It demonstrates that the raw
SQLite API path remains responsive, while the current combination of pending
effect drain, immediate reconciliation, and an invalid tombstone field cannot
reach outbox zero.

## 2026-07-26 — pure fast-append Gateway throughput

- Branch: `refactor/thin-sync-gateway`
- Harness: temporary `.local/fast-append-load-test.mjs`
- Backend: direct `AppsScriptOperationClient` + `createFastAppendRowsOperation`
  calls; no SQLite
  outbox, effect worker, reconciliation, snapshot, postcondition, receipt, or
  delete operation was involved
- Database: `/private/tmp/typed-sheets-fast-append-20260726-01.sqlite` was used
  only to provision the five projection registry entries; it was not part of
  the measured write path
- Spreadsheet: newly provisioned `LoadTest_Customers` projection
- Gateway mode: the newly deployed fast-append-only Code.gs; a verification
  `readSnapshot` request was rejected with `Fast append benchmark accepts only
  fastAppendRows.`
- Request limit: 100 rows per Gateway call; the 200-row stage used two calls

| Batch rows | Gateway calls | Applied rows | Elapsed | Rows/s | Cells/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 1 | 20 | 3,309.04 ms | 6.04 | 36.26 |
| 50 | 1 | 50 | 2,766.91 ms | 18.07 | 108.42 |
| 100 | 1 | 100 | 2,506.87 ms | 39.89 | 239.34 |
| 200 | 2 | 200 | 5,459.14 ms | 36.64 | 219.82 |

All 370 requested rows were acknowledged as `applied`; no row was left for a
worker or reconciliation pass. This is the first clean measurement of the
Gateway's current fast-append path. It confirms that the pure path can process
the complete tested load, but its steady-state ceiling is approximately 36–40
rows/s for six-column rows, with roughly 2.5–2.8 seconds of latency per 50–100
row request. The earlier backlog and `_deleted` failures were therefore not
part of this measurement.

## 2026-07-26 — continuous drain follow-up

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/lib-test-beta-0.2.0-beta1`
- Backend: the same local SQLite database and new Sheet from the preceding
  clean-Sheet test
- Server command:

```sh
TYPED_SHEETS_DB_PATH=/private/tmp/typed-sheets-new-sheet-20260726.sqlite \
  TYPED_SHEETS_API_PORT=3200 TYPED_SHEETS_BACKGROUND_WORKER=1 npm start
```

- The server was restarted with the previous outbox intact. A local metrics
  poll ran every 15 seconds for 180 seconds; no new application traffic was
  generated.

| Metric | Result |
| --- | ---: |
| Initial recovered state | applied 180 / pending 2,084 / processing 80 / failed 20 |
| Applied during observation | +240 |
| Final applied effects | 420 |
| Final pending effects | 2,337 |
| Final processing effects | 0 |
| Final failed effects | 20 |
| Observation duration | 180 s |

The worker did continue consuming effects after the load runner had stopped;
this disproves the idea that the 120-second test timeout closes the Gateway or
stops synchronization. However, the queue did not converge. Reconciliation
continued to enqueue correction effects while the worker was consuming the
existing queue, so pending temporarily increased from 2,104 to 2,417 before
ending at 2,337.

The 20 failed effects were repeatedly rejected during batched postcondition
recovery with:

```text
postcondition_read_failed: Effect field is not a registered header: _deleted
```

Those effects reached four attempts and remained failed. This is a concrete
blocking defect independent of the 120-second drain window: the worker can
consume some work indefinitely, but these effects cannot complete until the
registered Sheet headers and the postcondition payload agree. The continuous
test therefore confirms ongoing consumption, but not eventual convergence.

## 2026-07-27 — lib-test-beta thin-interface fast-append benchmark

- Branch: `refactor/thin-sync-gateway`
- Historical harness: `.local/lib-test-beta-0.2.0-beta1/fast-append-load-test.mjs`
  (removed after this benchmark)
- Server: `.local/lib-test-beta-0.2.0-beta1/server.mjs`, using the current
  `AppsScriptOperationClient` and `createFastAppendRowsOperation` library APIs
- Database: fresh `/private/tmp/typed-sheets-lib-test-fast-append-20260727.sqlite`
  used only to initialize the lib-test runtime; SQLite outbox/effect processing
  was not part of the measured path
- Gateway: newly supplied deployment; URL, shared secret, and spreadsheet ID
  are intentionally not recorded
- Background effect worker: disabled
- Reconciliation: disabled
- Setup: one unmeasured operation created/initialized `LoadTest_Customers` and
  wrote its six-column header
- Measured scenario: three sequential requests, one contiguous `setValues()`
  operation per stage; no metadata, snapshot, CAS, receipt, postcondition, or
  delete work

Command used for the measured runner:

```sh
LOAD_TEST_BASE_URL=http://127.0.0.1:3205 \
  node .local/lib-test-beta-0.2.0-beta1/fast-append-load-test.mjs
```

| Batch rows | Gateway calls | Applied rows | Elapsed | Rows/s | Cells/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 1 | 20 | 2,275 ms | 8.79 | 52.75 |
| 100 | 1 | 100 | 2,729 ms | 36.64 | 219.86 |
| 370 | 1 | 370 | 3,792 ms | 97.57 | 585.44 |

All 490 rows across the three stages returned `applied`, with HTTP 200 and no
client or remote error. The 20-row stage includes the fixed HTTP/Apps Script
startup cost; larger contiguous writes amortized that cost substantially. The
370-row one-request result is materially faster than the earlier 200-row
two-request measurement (36.64 rows/s), but it is not a complete production
sync test because it bypasses SQLite outbox consumption and reconciliation.

## 2026-07-27 — operational User/Order/OrderItem end-to-end test

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/typed-sheets-e2e.mjs`
- Command: `npm run build`, then `node .local/typed-sheets-e2e.mjs` with the
  supplied Gateway environment variables; secret and Sheet ID are intentionally
  not recorded
- Package boundary: the server imported the built package entry
  (`dist/index.js`), `typed-sheets/orm`, and `typed-sheets/mikro-orm`; the test
  runner rejected a `src` import and did not call the Gateway directly
- Domain tables: `User`, `Order`, and `OrderItem`; the library's internal
  registry and outbox tables were also created by the MikroORM SQLite adapter
- Gateway: the supplied thin `Code.gs` deployment; provisioning and all remote
  writes went through `AppsScriptOperationClient` and
  `AppsScriptOperationSyncGateway`
- Spreadsheet setup: each run used three unique tabs derived from its run ID,
  so existing Sheet data was neither deleted nor reused
- Worker: started automatically by the server after successful provisioning;
  maximum 100 effects per pass
- Reconciliation: disabled for this isolated SQLite-to-Sheets create path
- API concurrency: 4 HTTP clients

The functional smoke flow created one User, one Order, and two OrderItems, then
read the User-Order-OrderItem graph through the HTTP API. Each load stage used
the same API and EntityManager path, generated durable SQLite outbox effects,
and waited for the server-owned worker to drain them. The stage measurements
exclude one-time package build, SQLite migration, Sheet provisioning, and the
functional smoke setup; they are the no-setup/steady-state measurements.

| Stage | New Orders | New OrderItems | Setup excluded | Stage time | SQLite rows = Sheet rows | Failed effects |
| ---: | ---: | ---: | :---: | ---: | --- | ---: |
| Smoke | 1 | 2 | — | functional check | 1 User / 1 Order / 2 Items | 0 |
| 20 | 20 | 40 | yes | 12,673 ms | 1 / 21 / 42 | 0 |
| 100 | 100 | 200 | yes | 16,918 ms | 1 / 121 / 242 | 0 |
| 370 | 370 | 740 | yes | 40,196 ms | 1 / 491 / 982 | 0 |

The final cumulative worker count was 1,474 applied effects, with zero failed
effects and zero ready outbox effects. Every dedicated Sheet tab matched the
SQLite domain count. The server was stopped and restarted against the same
SQLite file; the original Order and its two OrderItems were read successfully
after restart.

## 2026-07-27 — operational test with idle-gated reconciliation

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/typed-sheets-e2e.mjs`
- Backend: built `typed-sheets` package, MikroORM, and local SQLite
- Gateway: the previously supplied Apps Script deployment; credentials and
  spreadsheet ID are intentionally not recorded
- Scenario command (Gateway environment variables were supplied separately):

```sh
TYPED_SHEETS_OPERATIONAL_LOAD_STAGES=1 \
TYPED_SHEETS_OPERATIONAL_RECONCILIATION_INTERVAL_MS=1000 \
TYPED_SHEETS_OPERATIONAL_DRAIN_TIMEOUT_MS=120000 \
node .local/typed-sheets-e2e.mjs
```

- Reconciliation policy: run only after the worker pass is idle and SQLite has
  no `pending` or `processing` outbox effects
- Dataset: one functional smoke flow, followed by one additional Order and two
  OrderItems through the HTTP API
- Setup: package build, SQLite migration, Sheet provisioning, and functional
  smoke setup are excluded from the stage timing

| Stage | New Orders | New OrderItems | Stage time | SQLite rows = Sheet rows | Failed effects |
| ---: | ---: | ---: | ---: | --- | ---: |
| 1 | 1 | 2 | 38,724 ms | 1 User / 2 Orders / 4 Items | 0 |

The operational E2E completed successfully. It imported the built package,
created all three domain tables through the library, wrote through the SQLite
outbox and server-owned worker, read the entity graph through the HTTP API, and
verified the same row counts in Sheets. The server restart check also passed.
The final outbox contained 21 applied effects and zero pending or processing
effects.

The test also exposed a remaining system-level issue. Even after the worker
became idle, reconciliation observed a stale or incomplete Sheet snapshot and
created correction effects:

| Reconciliation observation | Desired rows | Drifted rows | Missing rows | Correction effects |
| --- | ---: | ---: | ---: | ---: |
| First scan | 4 | 0 | 4 | 4 |
| Later scan | 7 | 4 | 3 | 7 |

Fourteen reconciliation effects were eventually applied, which is why the
final row counts converged. This means the idle gate prevents reconciliation
from competing with an actively pending outbox, but it does not yet prove that
an `applied` worker result and the subsequent Sheet snapshot are immediately
consistent. The normal write result, Gateway snapshot behavior, and
reconciliation identity matching need separate investigation before claiming
that the correction path is only a rare safety net.

Compared with the earlier pure fast-append benchmark (370 synthetic rows in
3,792 ms), this run is not a raw `setValues()` comparison: it includes 1,110
entity effects, SQLite flush/outbox work, worker leasing, multiple Gateway
requests, and Sheet row-count verification. It confirms that the current
library-to-worker-to-thin-Gateway create path converges for this workload, not
that update/delete or reconciliation paths are complete.

## 2026-07-27 — batched anchor lookup polling benchmark

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/typed-sheets-e2e.mjs`
- Backend: built `typed-sheets` package, MikroORM, and local SQLite
- Gateway: an operational `Code.gs` deployment; URL, secret, and spreadsheet ID
  are intentionally not recorded
- Reconciliation: disabled so it could not add correction effects during the
  polling measurement
- Scenario: create one smoke User plus 20 Orders and 40 OrderItems through the
  HTTP API, wait for the server-owned effect worker to drain, then run the
  polling path twice
- Command shape (Gateway environment variables were supplied separately):

```sh
npm run build
TYPED_SHEETS_OPERATIONAL_RECONCILIATION=0 \
TYPED_SHEETS_OPERATIONAL_POLLING_BENCHMARK=1 \
TYPED_SHEETS_OPERATIONAL_POLLING_RUNS=2 \
TYPED_SHEETS_OPERATIONAL_LOAD_STAGES=20 \
node .local/typed-sheets-e2e.mjs
```

The observation operation was changed from one `getDeveloperMetadata()` call
per row to one Sheet-scoped `DeveloperMetadataFinder` search per operation.
The returned row locations are indexed in memory and reused by both anchor
assignment and snapshot construction. Existing duplicate-anchor and
unanchored-row behavior remains unchanged.

| Poll run | Rows scanned | Anchors assigned | Users | Orders | OrderItems | Poll time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First (includes anchor setup) | 64 | 64 | 1 | 21 | 42 | 56,159 ms |
| Second (steady state) | 64 | 0 | 1 | 21 | 42 | 55,401 ms |

The load stage itself took 12,483 ms and produced matching SQLite/Sheet row
counts with zero failed effects. The first poll assigned one anchor per row;
this write remains intentionally per-row because `fastAppend` does not create
Developer Metadata. The second poll had no anchor writes, but its duration was
almost unchanged. Therefore the batch lookup removes the explicit row-by-row
metadata-read pattern, but it is not yet a material end-to-end polling speedup.

The remaining polling cost is now likely distributed across the full range
reads (`values`, formulas, display values, and merged ranges), per-cell
normalization and SHA-256 hashing, and conversion of the returned metadata
locations. A phase-level benchmark is required before claiming that any one of
those is the next dominant stage. This result also means the earlier estimate
of a few minutes for 10,000 rows cannot be accepted as a measured expectation;
the current steady-state result is still too slow to extrapolate safely.

## 2026-07-27 — operational timing run on the newly deployed Gateway

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/typed-sheets-e2e.mjs`
- Backend: built `typed-sheets` package, MikroORM, and local SQLite
- Package boundary: the server imported `dist/index.js`; the runner did not
  import `src/**` or call SQLite/Gateway operations directly
- Gateway: the newly supplied Apps Script deployment; URL, secret, and
  spreadsheet ID are intentionally not recorded
- Reconciliation: disabled for this isolated write-path measurement
- API concurrency: 4; load stage: 20 new Orders with 40 new OrderItems
- Sheet setup: three unique projection tabs were provisioned for this run;
  setup and provisioning are excluded from the stage timer
- Command shape (Gateway environment variables were supplied separately):

```sh
TYPED_SHEETS_OPERATIONAL_RECONCILIATION=0 \
TYPED_SHEETS_OPERATIONAL_LOAD_STAGES=20 \
TYPED_SHEETS_OPERATIONAL_DRAIN_TIMEOUT_MS=240000 \
node .local/typed-sheets-e2e.mjs
```

The functional smoke path created a User, an Order, and two OrderItems,
read the entity graph through the HTTP API, updated an Order through the
EntityManager, and removed the Order and its two related test items. Delete is
represented in the System_State projection by the library's
`__typed_sheets_deleted` tombstone, so the verification compares active rows,
not physical Sheet row count.

| Stage | New Orders | New OrderItems | Stage time | SQLite active rows = Sheet active rows | Failed effects |
| ---: | ---: | ---: | ---: | --- | ---: |
| Smoke | 1 | 2 | functional check | 1 User / 1 Order / 2 Items | 0 |
| 20 | 20 | 40 | 28,182 ms | 1 / 21 / 42 | 0 |

The stage finished with 69 applied effects, zero failed effects, and no ready
or active effects. The server was stopped and restarted against the same
SQLite file; the original Order and its two OrderItems were readable after
restart. All remote requests returned HTTP 200.

The timing sink separated local ORM work, worker orchestration, and the remote
Gateway. The largest steady-state totals were:

| Scope | Operation | Phase | Calls | Total | Max |
| --- | --- | --- | ---: | ---: | ---: |
| Worker | append | `append_gateway_dispatch` | 9 | 21,698 ms | 4,301 ms |
| Worker | update-like | `regular_gateway_dispatch` | 3 | 12,512 ms | 5,217 ms |
| Gateway | update-like | `dispatcher_eval` | 3 | 6,553 ms | 2,920 ms |
| Gateway | update-like | `script_lock` | 3 | 6,318 ms | 2,830 ms |
| Gateway | append | `dispatcher_flush` | 9 | 2,091 ms | 293 ms |
| Gateway | append | `append_range_lookup` | 9 | 896 ms | 248 ms |
| Gateway | append | `set_values` | 9 | 92 ms | 17 ms |
| ORM flush | append | `flush_total` | 23 | 55 ms | 4 ms |
| ORM flush | delete | `flush_total` | 1 | 2 ms | 2 ms |

This run confirms that local SQLite persistence and outbox creation are not the
current bottleneck: ORM flushes were measured in milliseconds. The dominant
cost is the Gateway round trip and Apps Script dispatcher/lock overhead. The
raw append `setValues()` work itself was only 92 ms across nine requests; the
remaining append time is request dispatch, range lookup, and remote execution
overhead. At the ORM layer `em.remove()` is correctly classified as `delete`,
but its System_State materialization is a tombstone write and therefore appears
in the Gateway's regular update-like timing path rather than as a physical row
delete.

This is a successful functional and timing run for the 20-order operational
scenario. It does not establish the sustained 100/370-order drain ceiling, nor
does it test reconciliation or user-edit conflict handling; those require
separate runs so their reads and corrective effects do not contaminate this
write-path measurement.

## 2026-07-27 — progressive operational throughput run

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/typed-sheets-e2e.mjs`
- Backend: built `typed-sheets` package, MikroORM, and local SQLite
- Package boundary: the server imported `dist/index.js`; the runner did not
  import `src/**` or call SQLite/Gateway operations directly
- Gateway: the newly supplied Apps Script deployment; credentials are not
  recorded
- Reconciliation: disabled for this isolated throughput measurement
- Stage Sheet verification: disabled so the result measures API ingestion plus
  worker drain, without an additional full snapshot read after every stage
- Load stages: 20, 100, and 370 new Orders; each Order created two OrderItems
- API concurrency: 4; Gateway timeout: 120 seconds; drain timeout: 240 seconds
- Command shape (Gateway environment variables were supplied separately):

```sh
TYPED_SHEETS_OPERATIONAL_RECONCILIATION=0 \
TYPED_SHEETS_OPERATIONAL_LOAD_STAGES='20,100,370' \
TYPED_SHEETS_OPERATIONAL_VERIFY_STAGE_SHEETS=0 \
TYPED_SHEETS_OPERATIONAL_DRAIN_TIMEOUT_MS=240000 \
node .local/typed-sheets-e2e.mjs
```

| Stage | New Orders | New OrderItems | Materialized rows | Stage time | Approx. rows/s | Cumulative applied | Failed |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 20 | 40 | 60 | 11,987 ms | 5.0 | 69 | 0 |
| 100 | 100 | 200 | 300 | 14,960 ms | 20.1 | 369 | 0 |
| 370 | 370 | 740 | 1,110 | 36,865 ms | 30.1 | 1,479 | 0 |

All three stages completed through the real HTTP server and the deployed
Gateway. The worker reached the expected applied count at every stage, no
effect failed, the server restarted successfully against the same SQLite file,
and the persisted Order/OrderItem graph remained readable after restart.

The dominant measured cost was still the remote worker-to-Gateway path:

| Scope | Phase | Calls | Total | Max |
| --- | --- | ---: | ---: | ---: |
| Worker | `append_gateway_dispatch` | 27 | 67,825 ms | 3,964 ms |
| Worker | `worker_total` (append) | 20 | 71,592 ms | 6,068 ms |
| Gateway | `append_range_lookup` | 27 | 3,941 ms | 938 ms |
| Gateway | `set_values` | 27 | 370 ms | 52 ms |
| ORM flush | `flush_total` (append) | 493 | 1,118 ms | 7 ms |

This separates the bottleneck more clearly: local SQLite/ORM flush work is
roughly millisecond-scale, and the raw Gateway `setValues()` work is small.
Most elapsed time is HTTP/Apps Script dispatch and Gateway range lookup. The
stage timer includes API entity creation and worker drain, so it is an
end-to-end operational throughput result, not a raw `setValues()` benchmark.

The polling probe returned zero rows and zero tables on both steady-state runs.
That is **not** a measured user-input polling speed: this operational fixture
registers only `system_state` projections, so there is no `user_input`
projection for the optimized polling path to scan. User-input polling needs a
separate fixture with a valid user-input registration and data.

## 2026-07-27 — corrected full-table polling run

The previous section's polling probe was invalid for this operational scenario:
it filtered by the projection label `user_input`, even though the test's User,
Order, and OrderItem tabs are all domain tables represented by `system_state`.
The polling helper now batches all registered projections; `user_input` remains
an ownership/edit-mode classification, not a domain table name.

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/typed-sheets-e2e.mjs`
- Backend and package boundary: same as the progressive throughput run above
- Reconciliation: disabled
- Load stage: 20 Orders and 40 OrderItems, plus the functional smoke rows
- Polling: one combined Gateway observation request for User, Order, and
  OrderItem, followed by two polling passes
- Command shape (Gateway environment variables were supplied separately):

```sh
TYPED_SHEETS_OPERATIONAL_RECONCILIATION=0 \
TYPED_SHEETS_OPERATIONAL_LOAD_STAGES=20 \
TYPED_SHEETS_OPERATIONAL_POLLING_BENCHMARK=1 \
TYPED_SHEETS_OPERATIONAL_POLLING_RUNS=2 \
TYPED_SHEETS_OPERATIONAL_VERIFY_STAGE_SHEETS=0 \
node .local/typed-sheets-e2e.mjs
```

| Poll pass | Rows scanned | Anchors assigned | User rows | Order rows | OrderItem rows | Elapsed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First (anchor setup) | 66 | 60 | 1 | 22 | 43 | 34,919 ms |
| Second (steady state) | 66 | 0 | 1 | 22 | 43 | 75,150 ms |

Both passes completed without failed effects. The first pass assigned anchors
to rows created by fast-append; the second pass reused all 66 anchors. The
steady-state pass was slower than the first despite doing no metadata writes,
so the dominant polling cost is not only anchor assignment. The full snapshot
read, Apps Script lock/dispatch latency, range reads, normalization, hashing,
and SQLite observation persistence all remain in the path.

A separate 20/100/370 run reached the 370 stage but could not start its full
table polling pass: the Gateway rejected the Order observation while adding
row Developer Metadata because the test Spreadsheet exceeded its allowed
metadata storage. This is an independent scalability limit in the current
anchor-based polling design; it prevents claiming a 370-row polling result.

## 2026-07-27 — polling phase trace

The observation Gateway and local ingestion path were instrumented to separate
remote Apps Script work from SQLite comparison and observation persistence. The
same 20-Order/40-OrderItem operational fixture scanned 66 rows across the three
domain tabs.

| Poll pass | User Gateway | Order Gateway | OrderItem Gateway | Local SQLite/observation | Total polling |
| --- | ---: | ---: | ---: | ---: | ---: |
| First, 60 anchors assigned | 994 ms | 8,917 ms | 18,464 ms | 8 ms | 31,371 ms |
| Second, steady state | 635 ms | 6,748 ms | 17,661 ms | 6 ms | 27,652 ms |

The first pass spent 14,544 ms assigning 60 row anchors: 4,808 ms for Order
and 9,735 ms for OrderItem. The second pass assigned no anchors, but still
spent 10,402 ms reading Developer Metadata, so removing anchor writes alone is
not enough.

The largest steady-state remote phases were:

| Phase | User | Order | OrderItem | Combined |
| --- | ---: | ---: | ---: | ---: |
| `anchor_metadata_read` | 228 ms | 2,794 ms | 7,380 ms | 10,402 ms |
| `row_normalization` | 30 ms | 786 ms | 5,705 ms | 6,521 ms |
| `snapshot_hash` | 111 ms | 2,502 ms | 4,204 ms | 6,817 ms |

These phases are nested inside `snapshot_build`, so their combined values must
not be added again to the per-table Gateway totals. The raw `values_read`
phase was only 12 ms in steady state, and local SQLite shadow comparison plus
observation persistence took 6 ms. Therefore the current polling bottleneck is
not SQLite and not the basic Sheet range read; it is the Developer Metadata
finder plus repeated Apps Script hashing/normalization work. OrderItem alone
accounted for 17,661 ms of the 27,652 ms steady-state pass.

This confirms that the current full-snapshot polling path is not suitable as a
frequent normal synchronization mechanism at this size. It is currently more
appropriate as an infrequent safety scan, while `onEdit` or a redesigned
lightweight identity/change path handles the normal user-edit signal. The
370-row polling pass remains unmeasured because the current anchor metadata
quota is reached before the scan completes.

## 2026-07-27 — lightweight values-only polling

- Branch: `refactor/thin-sync-gateway`
- Harness: `.local/typed-sheets-e2e.mjs`
- Backend: built `typed-sheets` package, MikroORM, and local SQLite
- Package boundary: the server imported `dist/index.js`; the runner did not
  import `src/**` or call SQLite/Gateway operations directly
- Gateway: the supplied Apps Script deployment; URL, secret, and spreadsheet
  ID are intentionally not recorded
- Reconciliation: disabled
- Dataset: one smoke User plus 20 Orders and 40 OrderItems (66 Sheet rows)
- Scenario: the server-owned worker drained the outbox, then `/poll` issued one
  batched values-only read for User, Order, and OrderItem twice
- Command shape (Gateway environment variables were supplied separately):

```sh
npm run build
TYPED_SHEETS_OPERATIONAL_RECONCILIATION=0 \
TYPED_SHEETS_OPERATIONAL_LOAD_STAGES=20 \
TYPED_SHEETS_OPERATIONAL_POLLING_BENCHMARK=1 \
TYPED_SHEETS_OPERATIONAL_POLLING_RUNS=2 \
TYPED_SHEETS_OPERATIONAL_VERIFY_STAGE_SHEETS=0 \
TYPED_SHEETS_OPERATIONAL_SKIP_TIMING_SUMMARY=1 \
node .local/typed-sheets-e2e.mjs
```

| Poll pass | Rows scanned | Unchanged | Changed | Unknown/invalid | Elapsed | Remote read total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| First | 66 | 66 | 0 | 0 / 0 | 2,109 ms | 573 ms |
| Second, steady state | 66 | 66 | 0 | 0 / 0 | 2,240 ms | 530 ms |

Each pass used one signed Apps Script request containing three independent
`getValues()` operations. No `LockService`, Developer Metadata, snapshot hash,
receipt, or observation persistence was used. The remote phases per table were
approximately 210–220 ms for User, 155–210 ms for Order, and 156–163 ms for
OrderItem; the remainder was HTTP dispatch and local canonical comparison.

The test passed through the real HTTP server, package boundary, SQLite outbox,
background worker, and deployed Gateway. The final rows were classified as
unchanged, including active and tombstoned System_State rows, and the server
restart check passed. Compared with the previous steady-state full-snapshot
poll (27,652 ms for the same 66-row shape), the lightweight path was roughly
12 times faster. This is a read/compare benchmark: changed rows are returned
to the caller, but this pass does not yet turn them into evaluated user-edit
events or canonical writes.

## 2026-07-29 — live User_Input polling benchmark blocked by Web App access

- Branch: `feature/inbound-polling`
- Harness: `.local/user-input-polling-live.mjs`
- Command: `npm run build`, then `node --env-file=.env .local/user-input-polling-live.mjs`
- Backend: MikroORM with an in-memory SQLite database
- Intended dataset: one entity row across System_State and User_Input
- Intended scenario: provision temporary tabs, insert and deliver one row, run
  initial polling, edit User_Input remotely, run changed polling, repeat steady
  polling, then update and delete the entity
- Gateway credentials: supplied through ignored `.env`; URL, shared secret, and
  spreadsheet ID are intentionally not recorded

The benchmark did not reach provisioning. The `/exec` request redirected to a
Google `ServiceLogin` page and the followed POST ended with HTTP 401 and a
non-JSON response. A metadata-only probe confirmed the redirect target was
`accounts.google.com/ServiceLogin`, so this is a Web App deployment access-policy
failure rather than a polling or signature result. No temporary tabs were
created by the harness; its scoped cleanup request also failed before it could
find any tab.

No operation timings are reported for this attempt. Re-run after the deployed
Apps Script Web App allows the Node process to call the `/exec` endpoint without
interactive Google login and after confirming the deployment uses the current
`apps-script/gateway/Code.gs`.

## 2026-07-29 — Gateway access restored; User_Input materialization exposed a guard defect

- Branch: `feature/inbound-polling`
- Harness: `.local/user-input-polling-live.mjs`
- Command: `npm run build`, then `node --env-file=.env .local/user-input-polling-live.mjs`
- Backend: MikroORM with an in-memory SQLite database
- Gateway: the newly supplied deployment; credentials and spreadsheet ID are
  intentionally not recorded
- Dataset: one entity row and two projection tabs created with unique temporary
  names; cleanup removed the temporary tabs after each attempt

The new deployment was reachable and provisioning completed, but the first
entity insert did not materialize the User_Input row:

| Phase | Result |
| --- | ---: |
| Provisioning | 3,769.52 ms |
| SQLite insert flush | 8.59 ms |
| Outbound worker pass | 5,847.94 ms |
| Initial User_Input poll | 2,118.24 ms |

The worker selected two effects. The System_State effect was applied, while
the User_Input `candidate_reconcile` effect became `blocked_candidate` with
`candidate_guard_mismatch / visible_guard_mismatch`. The remote User_Input tab
contained headers but zero data rows; the System_State tab contained the one
expected row. Consequently, remote edit polling, update, and delete timings
were not measured in this run.

This is a real thin-Gateway integration defect, not a Web App access or secret
problem. The candidate effect has `createIfMissing: true` and an empty visible
baseline. The current `EFFECT_OPERATION_SOURCE` creates a blank row and then
applies the existing-row visible-hash guard to that newly created row, so the
blank row cannot pass the guard and the effect is rejected. Existing unit tests
use the fake Sheet gateway and therefore did not exercise this Apps Script
operation path.

The next fix should special-case a newly created row in the thin Gateway effect
operation: after `createIfMissing` succeeds, it should write the requested
fields without comparing the blank row against the empty existing-row hash,
then verify the target postcondition. The benchmark should be rerun only after
that fix; this result must not be presented as a completed CRUD/polling
benchmark.

## 2026-07-29 — structural effect planning fixed append materialization

- Branch: `feature/inbound-polling`
- Source change: separate `append`, `update`, and `delete` plans in the thin
  Gateway effect operation; an append is populated before its first physical
  write and is not passed through an existing-row visible guard
- Verification: `npm test`, `npm run typecheck`, `npm run build`, plus the
  serialized Apps Script source regression test in
  `test/apps-script-effect-operation.test.ts`
- Backend: MikroORM with an in-memory SQLite database
- Gateway: the supplied deployment; credentials and spreadsheet ID are not
  recorded
- Dataset: one temporary entity row across System_State and User_Input

The live CRUD-only run completed successfully. Provisioning is shown separately
because it is one-time setup rather than an operation throughput result:

| Scenario | Setup / provision (excluded) | SQLite flush | Gateway worker / polling | Result |
| --- | ---: | ---: | ---: | --- |
| Insert | 4,421.71 ms | 6.94 ms | 14,374.88 ms | 2 effects applied |
| Update | — | 6.30 ms | 6,676.13 ms | 2 effects applied |
| Delete | — | 3.44 ms | 6,557.05 ms | 2 effects applied |

The independent polling run also completed successfully:

| Step | Elapsed | Result |
| --- | ---: | --- |
| Provisioning (setup, excluded) | 3,940.01 ms | completed |
| Insert delivery | 10,987.65 ms | 2 effects applied |
| Initial poll | 3,413 ms | 1 row scanned, unchanged |
| Remote User_Input edit | 4,607.52 ms | completed |
| Changed poll | 4,373 ms | 1 row changed and applied, 0 conflicts |

The live polling check read the entity through a fresh EntityManager after the
poll and confirmed the SQLite value was `approved`. The harness had to use a
fresh EntityManager because MikroORM's identity map otherwise returns the
pre-poll `pending` object; that was a test-harness issue, not a storage write
failure.

The combined sequence “remote User_Input edit → polling → local update/delete
of the same entity” remains a separate design issue and is not included in the
CRUD result above. After polling accepts `approved`, a later local update to
`completed` creates a User_Input `candidate_reconcile` effect that is blocked by
`visible_guard_mismatch`; a subsequent delete is refused because the latest
User_Input effect is `blocked_candidate`. The current evidence is that polling
updates `last_observed_hash`, while `projectionBaselineFromConfirmedState()`
continues to use the older `confirmed_snapshot_hash` (`pending`) for the next
outbound compare-and-set. This should be discussed and fixed separately from
the append-plan defect.

## 2026-07-29 — progressive append regression check

- Branch: `feature/inbound-polling`
- Command: `node --env-file=.env .local/append-regression-load-test.mjs`
- Harness: direct `AppsScriptOperationClient` calls to the supplied Gateway;
  SQLite, the outbox, the worker, and reconciliation were not included
- Dataset: six columns (`id`, `name`, `status`, `email`, `age`, `active`),
  fresh temporary tab per stage, setup/provisioning excluded
- The regular-effect run used `createApplyEffectsOperation` with a
  User_Input `candidate_reconcile` append. The fast-append run used
  `createFastAppendRowsOperation` and is the comparable path to the earlier
  raw append benchmark.

The regular effect path is materially more expensive as the batch grows. It
performs layout/context and receipt work, metadata writes, locking, guarded
materialization, postcondition checks, and receipt writes; it is not equivalent
to a raw `setValues()` append.

| Regular effect rows | Gateway elapsed | Applied effects |
| ---: | ---: | ---: |
| 1 | 5,048.44 ms | 1 |
| 2 | 4,197.58 ms | 2 |
| 5 | 6,031.67 ms | 5 |
| 10 | 8,932.31 ms | 10 |
| 20 | 14,961.42 ms | 20 |

The comparable fast-append path did not regress against the previous raw
Gateway benchmark:

| Rows | Previous (2026-07-26) | Current | Delta |
| ---: | ---: | ---: | ---: |
| 20 | 3,309.04 ms | 2,042.12 ms | -38.3% |
| 50 | 2,766.91 ms | 2,969.11 ms | +7.3% |
| 100 | 2,506.87 ms | 1,881.14 ms | -25.0% |
| 200 | 5,459.14 ms | 4,764.00 ms | -12.7% |

Therefore the cleanup did not make the old fast-append path slower. The
earlier live two-effect insert total of 14,374.88 ms is a worker-level mixed
measurement containing one fast System_State effect and one regular User_Input
effect, plus per-request and worker overhead. A direct current two-row regular
request completed in 4,197.58 ms, so the 14-second observation was not
reproduced as the intrinsic cost of a two-row Gateway append. It should be
treated as request/Apps Script latency variance until the worker's individual
Gateway request timings are compared across repeated runs.

The raw fast-append source timing still shows `setValues()` in the millisecond
range. The dominant cost is Gateway invocation, Apps Script dispatch/flush,
locking, and—on the regular path—the additional guarded effect protocol. This
benchmark is a regression diagnosis, not a claim that the regular effect path
is already suitable for high-throughput bulk writes.

## 2026-07-29 — ID-based 1,000-row User_Input polling attempt

- Branch: `feature/inbound-polling`
- Command: `npm run build && node --env-file=.env .local/polling-load-test.mjs`
- Dataset: 1,000 User_Input rows; the harness seeds visible `id` and `status`
  cells with `setValues()` and does not create Developer Metadata anchors
- Intended scenarios: unchanged poll by default, with `POLL_SCENARIO=changed-1`,
  `changed-100`, or `changed-1000` available for changed-row measurements

| Phase | Setup/provisioning | Steady-state poll | Result |
| --- | ---: | ---: | --- |
| Live Gateway attempt | HTTP 404 | not reached | blocked before polling |

The external Apps Script deployment returned HTTP 404 during provisioning, so
this run did not measure ID-based polling. No setup-excluded or steady-state
performance value is inferred from this attempt. The code and local tests do
exercise the values-only, no-metadata path; a valid deployment URL is required
for the live 1,000-row benchmark.

## 2026-07-29 — ID-based 1,000-row User_Input polling succeeded

- Branch: `feature/inbound-polling`
- Harness: `.local/polling-load-test.mjs`
- Command: `npm run build`, then `node --env-file=.env .local/polling-load-test.mjs`
  or `POLL_SCENARIO=changed-1 node --env-file=.env .local/polling-load-test.mjs`
  or `POLL_SCENARIO=changed-100 node --env-file=.env .local/polling-load-test.mjs`
- Backend: deployed Apps Script Gateway, MikroORM, and in-memory SQLite
- Dataset: 1,000 User_Input rows; visible `id` and `status` values only, no
  Developer Metadata anchors
- Setup: temporary tabs, provisioning, local entity seed, SQLite baseline, and
  remote cell seed are excluded from the poll column

| Scenario | Rows scanned | Changed | Applied | Invalid | Poll elapsed | Gateway request |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Unchanged | 1,000 | 0 | 0 | 0 | 2,269.46 ms | 2,172 ms |
| One remote edit | 1,000 | 1 | 1 | 0 | 11,248.09 ms | 11,143 ms |
| 100 remote edits | 1,000 | 100 | 100 | 0 | 3,480.54 ms | 3,257 ms |

All three runs completed successfully with zero unknown or duplicate business keys.
The unchanged pass demonstrates the values-only ID scan at roughly 2.3 seconds
for 1,000 rows. The one-edit pass was substantially slower because the remote
Apps Script request itself took roughly 11.1 seconds; it is a single live
measurement and should be repeated before treating that latency as a stable
polling cost. The 100-edit pass scanned the same 1,000 rows and applied all 100
changes in roughly 3.5 seconds, so the result is not monotonically proportional
to the number of changed rows; the remote Gateway request/Apps Script latency
is the dominant variable in these live runs. The earlier 404 was transient at
the deployment endpoint: the same URL later returned HTTP 302/200 and all
scenarios completed.

## Caveats

- The raw benchmark measures a throughput upper bound, not production sync
  behavior.
- The benchmark uses an isolated sheet and synthetic string values.
- Network, HTTP, lock acquisition, retry, and response-loss behavior are not
  included.
- The result strongly indicates that the current Gateway validation and
  metadata path, rather than raw `setValues()` throughput, is the dominant
  bottleneck.
