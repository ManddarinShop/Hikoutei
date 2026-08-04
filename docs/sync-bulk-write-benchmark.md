# Sync bulk-write benchmark

## Black-box server and Locust workload

The test-only server harness treats Hikoutei as a server-side library rather
than calling the sync worker directly from a benchmark script:

```sh
node --env-file=.env .local/hikoutei-load-server.mjs
```

It binds to `127.0.0.1:8787` by default and reports a run-specific persistent
SQLite path, System_State/User_Input tab names, and JSONL log path from
`GET /health`. It does not delete the database or Sheet data on shutdown.

Run the mixed workload from another terminal:

```sh
locust -f .local/locustfile.py \
  --host http://127.0.0.1:8787 \
  --users 20 \
  --spawn-rate 5 \
  --run-time 5m \
  --headless
```

The Locust user weights are read 40%, create 20%, application update 25%, and
User_Input simulation 15%. The User_Input task calls the test-only
`/__test/user-input` endpoint, which changes the real Sheet and leaves the
normal polling service to apply the value to SQLite. The server records HTTP,
flush, Gateway, polling, error, and over-30-second events in the JSONL log;
the over-30-second observer never stops the server or workload. Inspect
`GET /metrics` after Locust stops, then stop the server with `Ctrl-C`; the
persistent run data remains for inspection.

## 2026-08-03 — black-box Locust run and configuration diagnosis

- Server run: `load-1785732937019-23536468`
- Log: `.local/hikoutei-load-load-1785732937019-23536468.jsonl`
- Workload: `.local/locustfile.py` mixed CRUD/User_Input tasks
- Final HTTP log: **1,508** requests; 1,201 successful responses and 307
  failures, including 264 creates, 582 reads, 375 updates, and 209 User_Input
  requests
- Gateway log: **444** requests; 246 successes, 190 operation failures, and 8
  timeouts; 4 requests exceeded 30 seconds
- Final local state snapshot: **264** SQLite entity rows, 332 applied effects,
  7 blocked candidates, 601 pending effects, and 234 processing effects

The test did create visible tabs, but the server read a different
`TYPED_SHEETS_GATEWAY_SHEET_ID` from the local `.env` than the spreadsheet ID
provided for the intended target. On the spreadsheet actually used by the
server, the following tabs were visible: `TS_Load_load-1785732937019-23536468_System`
(265 rows including the header) and `TS_Load_load-1785732937019-23536468_Input`
(26 rows including the header). The apparent missing table was therefore a
configuration-target mismatch, not a provisioning omission. The intended sheet
ID must be placed in `.env` before the next run; the shared secret must also be
valid for that deployed gateway/sheet configuration.

The run was not a clean functional pass. Concurrent User_Input simulation and
polling contended on the Apps Script observation lock, producing repeated
`Could not acquire the sync observation gateway lock` errors; the resulting
failed effects then blocked later ORM writes with `user_input projection is
blocked: latest effect is failed`. The persistent SQLite file and actual test
Sheet data were retained for diagnosis.

## 2026-08-03 — lock-refactor Locust run

- Branch: `perf/adaptive-sync-performance`
- Server run: `load-1785737483461-793bddd2`
- Exact server command: `node --env-file=.env .local/hikoutei-load-server.mjs`
- Exact Locust command: `/usr/local/bin/locust -f .local/locustfile.py --host http://127.0.0.1:8787`
  (user count and duration were controlled from the Locust UI)
- Log: `.local/hikoutei-load-load-1785737483461-793bddd2.jsonl`
- Database: `.local/hikoutei-load-load-1785737483461-793bddd2.sqlite`
- Backend: local Node `v24.3.0`, persistent SQLite/MikroORM, deployed Apps Script
  gateway, and the real target Sheet
- Scenario: mixed read/create/update/User_Input workload; HTTP activity ran from
  `2026-08-03T06:12:25Z` through `2026-08-03T06:17:44Z` (about 5m 19s)
- Setup: one provisioning Gateway call, 4,013 ms, excluded from steady-state
  counts below

| Metric | No-setup / steady-state result | Full recorded run |
| --- | ---: | ---: |
| HTTP requests | 4,883 workload requests | 4,907 through workload stop, including 21 health, 2 metrics, and 1 unknown request |
| HTTP success/failure | 3,119 / 1,764 workload responses | 3,142 / 1,765 responses |
| Gateway requests | 763 sync calls; 718 success / 45 failure | 764 including setup |
| HTTP latency | p50 5.16 ms; p95 2,820.89 ms | max 60,004.28 ms |
| Gateway latency | p50 2,312 ms; p95 30,314 ms | max 60,004 ms; 35 over 30 s |

Workload response breakdown: create 505 successful and 522 failed; read 1,957
successful; update 582 successful and 603 failed; User_Input 75 returned 202,
598 returned 404 before the row was projected, and 41 returned 500. Gateway
failures during the workload were 22 invalid responses, 15 `method_not_allowed`
responses, 6 timeouts, and 2 remote operation failures. No
`Could not acquire the sync observation gateway lock` message occurred during
the workload window. One such lock error appeared later while background
polling continued after Locust stopped.

The dominant workload failure was projection poisoning: 1,124 HTTP operation
errors reported `user_input projection is blocked: latest effect is
blocked_candidate`. The workload also recorded 7 polling errors for invalid
observed projection evidence. A post-load metrics snapshot showed 505 entity
rows, 656 applied outbox effects, 25 blocked candidates, 61 failed effects,
1,264 pending effects, and 177 processing effects; this snapshot includes
background synchronization after the Locust workload stopped. The Locust UI
process remained open without new workload requests, and the server remained
alive for diagnosis. All Sheet, SQLite, and JSONL data were retained.

## 2026-08-03 — pending User_Input retry Locust run

- Branch: `perf/adaptive-sync-performance`
- Server run: `load-1785738645774-79e64130`
- Exact server command: `node --env-file=.env .local/hikoutei-load-server.mjs`
- Exact Locust command: `/usr/local/bin/locust -f .local/locustfile.py --host http://127.0.0.1:8787`
  (user count and duration were controlled from the Locust UI)
- Log: `.local/hikoutei-load-load-1785738645774-79e64130.jsonl`
- Database: `.local/hikoutei-load-load-1785738645774-79e64130.sqlite`
- Backend: local Node `v24.3.0`, persistent SQLite/MikroORM, deployed Apps Script
  gateway, and the real target Sheet
- Scenario: mixed read/create/update/User_Input workload with bounded User_Input
  retry/backoff; workload ran from `2026-08-03T06:31:37Z` through
  `2026-08-03T06:36:58Z` (about 5m 21s)
- Setup: one provisioning call and pre-load worker warm-up excluded from the
  steady-state Gateway counts

| Metric | No-setup / steady-state result | Locust result |
| --- | ---: | ---: |
| Requests | 7,754 CRUD/User_Input requests | 7,774 total requests |
| Success/failure | 4,519 / 3,235 workload responses | fail ratio **41.61%** |
| Gateway | 1,173 calls; 1,165 success / 8 failure | p50 2,132 ms; p95 6,624 ms |
| HTTP latency | aggregate median 10 ms; p95 2,300 ms | max 52,409 ms |
| Slow Gateway calls | 12 over 30 seconds | max 52,407 ms |

Locust's stopped report had 3,116 successful reads, 1,590 creates with 1,386
failures, 1,924 updates with 1,698 failures, and 1,124 User_Input attempts
with 151 failures. Of the User_Input failures, 148 reached the bounded retry
deadline and 3 were HTTP 500 responses. The harness therefore stopped counting
most projection-lag 404 responses as immediate Locust failures, but those rows
still did not become successful Sheet edits: the server log recorded 943 404s
and 188 successful 202 edits.

The main failure remained projection poisoning. The server recorded 3,084
`user_input projection is blocked: latest effect is blocked_candidate` errors,
matching the create/update failures. During the workload, the Gateway had 3
remote operation failures, 4 invalid responses, and 1 `method_not_allowed`
response; polling also recorded 2 observation-lock acquisition failures and 7
invalid observed-evidence errors. The retry queue improved classification of
asynchronous row lag, but it cannot repair a projection whose effect is already
blocked. A post-load metrics snapshot showed 204 entity rows, 360 applied
outbox effects, 25 blocked candidates, 2 failed effects, 397 pending effects,
and 93 processing effects. The Locust state was stopped with zero users; the
server and all generated data remain available for diagnosis.

Compared with the previous lock-refactor run, the retry queue reduced User_Input
failures reported by Locust from immediate row-not-found failures to 148
retry-deadline failures, but the underlying blocked-candidate cascade remains
the next bottleneck. The two observation-lock failures also confirm that the
remaining contention is in the retained full-observation path, not the
lock-free values-only read.

## 2026-08-03 — Sync_Conflicts and automatic system-wins Locust run

- Branch: `perf/adaptive-sync-performance`
- Server command: `node --env-file=.env .local/hikoutei-load-server.mjs`
- Locust command: `/usr/local/bin/locust -f .local/locustfile.py --host http://127.0.0.1:8787` (user count and duration were controlled from the Locust UI)
- Server run: `load-1785748381328-41f5654c`
- Log: `.local/hikoutei-load-load-1785748381328-41f5654c.jsonl`
- Database: `.local/hikoutei-load-load-1785748381328-41f5654c.sqlite`
- Backend: local Node `v24.3.0`, persistent SQLite/MikroORM, deployed Apps Script gateway, and the real target Sheet
- Scenario: mixed read/create/update/User_Input workload with mandatory
  `System_State`, `User_Input`, and `Sync_Conflicts` projections
- Workload window: `2026-08-03T09:13:59.580Z`–`2026-08-03T09:19:17.434Z`
  (about 5m 18s); setup provisioning took 5,436 ms and is excluded below
- Dataset/result: 456 SQLite entity rows and 127 captured conflicts

| Metric | No-setup / steady-state result | Full server record |
| --- | ---: | ---: |
| Application HTTP requests | 2,648 workload requests | 2,669 including 21 health requests before the workload endpoint closed |
| HTTP outcome | 2,068 2xx / 246 projection-lag 404 / 334 500 | 2,089 2xx / 246 404 / 334 500 |
| Locust-effective failure ratio | **334 / 2,648 = 12.61%** | 404 responses were marked success by the bounded retry queue |
| Gateway requests | 428 sync calls; 308 success / 120 failure | 429 including setup |
| Gateway latency | p50 4,344 ms; p95 34,246 ms | max 60,011 ms; 92 over 30 s; 4 over 60 s |

Application breakdown was 456 successful creates and 93 failed creates, 1,044
successful reads, 526 successful updates and 130 failed updates, and 42
successful User_Input changes, 246 projection-lag 404s, and 111 failed
User_Input requests. The main errors were 223 requests blocked by a previously
failed `user_input` effect, 90 invalid Gateway JSON responses, 17
`Use a signed POST request` responses, and 4 Gateway timeouts. During the
workload window there were 2 polling evidence errors and 1 effect-worker
postcondition/claim mismatch. The 404s are not counted as Locust failures by
`locustfile.py`; they remain bounded pending projection retries.

The new conflict path itself behaved correctly in SQLite: all **127/127**
`sync_conflict` rows ended `RESOLVED`, all **127/127**
`acknowledge_system` commands ended `applied` with role `sync_operator`, and
there were **0** active candidate pointers. No `latest effect is
blocked_candidate` cascade appeared in the server errors; the remaining
application failures were caused by failed Gateway/materialization effects.
The durable outbox retained the remote work for recovery. At the post-load
metrics snapshot (after background synchronization continued), the outbox was
`applied=390`, `pending=1,267`, `processing=60`, `failed=375`,
`blocked_candidate=4`, and `superseded=127` at the
`2026-08-03T09:26:09Z` metrics snapshot. The 127 conflict-audit effects
were `30 applied`, `77 pending`, and `20 failed`, so SQLite resolution was
committed even though the remote `Sync_Conflicts` projection had not fully
converged.

This is a functional improvement over the preceding retry-queue run: the
unresolved conflict/candidate cascade was eliminated and the observed failure
ratio was lower, but it is **not a clean remote-delivery benchmark**. The
remaining bottleneck is Apps Script instability/latency (`invalid JSON`,
`method_not_allowed`, operation failures, and timeouts), which poisoned
System_State/User_Input effects and left a large durable backlog. The server
and all Sheet, SQLite, and JSONL artifacts were retained; the server continued
running after Locust stopped, so later background metrics are explicitly not
part of the steady-state workload numbers.

A later background-only inspection at `2026-08-03T09:50:42Z` found that the
server was still alive but the remote projection had not converged: SQLite now
contained **333** resolved conflicts (up from 127 at the workload snapshot),
with zero active candidate pointers. This increase represents the same
User_Input edits being observed again while their canonical reconcile effects
remain failed/pending; it is not evidence that SQLite left conflicts open, but
it does show that a continuously running worker cannot drain a permanently
unavailable remote projection. The outbox then stood at `applied=794`,
`pending=887`, `processing=64`, `failed=553`, `blocked_candidate=4`, and
`superseded=333`; the server was still handling a long Gateway append when the
20-second before/after check was taken. This follow-up is diagnostic and is not
part of the steady-state workload result above.

## 2026-08-02 — performance branch baseline

- Branch: `perf/adaptive-sync-performance`
- Base: `origin/develop` at `63ebddc`, including the merged contract PRs #155 and #156
- Environment: macOS arm64, Node `v24.3.0`, npm `11.4.2`

### Local implementation verification (synthetic, no live Sheets)

These commands exercise the in-process SQLite authority plus fake/in-memory
Apps Script gateways. They are correctness and contract checks, not latency
measurements: no real spreadsheet, credentials, or Apps Script quota is
involved, so timings are not comparable to the live baselines below.

- `npm test` — 30 files, 197 tests passed
- `npm run typecheck` — passed
- `npm run typecheck:test` — passed
- `npm run build` — passed
- `npm pack --dry-run` — passed
- `git diff --check` — passed

The regression suite now covers the adaptive/outbound work directly with
synthetic fixtures: the values-only preflight escalation rules, formula/merged/
error deferral to the periodic safety full scan, safety-scan scheduling and
coalescing, backlog convergence across worker passes, no full read on unchanged
adaptive passes, response-loss backoff, and the new internal polling timing
phases emitted through the diagnostics sink (canonical state read, values-only
read, fast comparison, full metadata observation, persistence, overall, and safety-scan lag).

### 2026-08-02 — local synthetic latency sample

- Branch: `perf/adaptive-sync-performance`
- Exact command: `./node_modules/.bin/vite-node scripts/bench-local-sync-performance.ts`
- Backend: in-process SQLite/MikroORM plus `FakeSyncSheetGateway`; no network or Apps Script quota
- Dataset: 66 unchanged User_Input rows; 7 steady-state samples per mode
- Setup: entity seeding, effect delivery, and first warm-up pass excluded

| Scenario | No-setup / steady-state result | Gateway calls during run |
| --- | ---: | --- |
| Adaptive values-only polling | mean **1.604 ms** (min 1.271 / max 2.582) | 7 values-only reads, 0 full snapshots |
| Full metadata polling | mean **5.642 ms** (min 5.228 / max 6.656) | 0 values-only reads, 7 full snapshots |
| 66-row outbound update | SQLite flush **68.988 ms**; delivery **216.973 ms**; 66 applied | 8 `applyEffects` calls |

The local adaptive sample is about **3.5× faster** than the local full path in
this no-network fixture, but it is not comparable to the historical live
27.7-second versus 2.2-second measurements below. The useful correctness signal
is that unchanged adaptive samples used no full metadata reads. The live
measurement below confirms the same behavior through the deployed gateway.

### 2026-08-02 — live Apps Script polling smoke benchmark

- Branch: `perf/adaptive-sync-performance`
- Exact command: `LIVE_POLL_ONLY=1 node --env-file=.env .local/user-input-polling-live.mjs`
- Slow-request guard: synchronization Gateway requests with `durationMs > 30,000` fail the benchmark; provisioning and cleanup requests are recorded but excluded from this failure gate
- Backend: deployed Apps Script gateway and real Google Sheet
- Dataset: 1 entity row, System_State + User_Input projections
- Setup: temporary-tab provisioning and first safety scan are reported separately;
  steady-state polling excludes provisioning

| Scenario | No-setup / steady-state result | Evidence |
| --- | ---: | --- |
| Initial unchanged adaptive poll | **2,504 ms** | `mode=adaptive`, `fullMetadataTables=0`, 1 values-only read, 0 full snapshots |
| Remote edit request | **1,663.4 ms** | Apps Script `setValue()` + `flush()` |
| Changed adaptive poll | **3,859 ms** | 1,580 ms values-only read + 2,262 ms full metadata read; SQLite status became `approved` |
| First ORM insert flush | **12.39 ms** | SQLite/outbox commit |
| Insert remote delivery | **5,185.8 ms** | 2 effects applied |

The service's automatic initial safety scan took **2,567 ms** and used one full
metadata request. The latency guard inspected **8 synchronization Gateway
requests** and found **0** over the 30-second threshold. Temporary Sheet tabs
were cleaned up after the run. This live run proves the current harness reaches
the deployed gateway and that unchanged polling avoids the full metadata request
while changed polling escalates and persists correctly. The JSON result includes
`gatewayLatencyGuard` with the threshold and guarded-request summary. A
functional failure (for example, the SQLite value is not `approved`) is reported
separately from a `slow_sync_gateway_operation` latency failure.

#### Post-guard verification rerun

- Commands:
  - `LIVE_POLL_ONLY=1 node --env-file=.env .local/user-input-polling-live.mjs`
  - `LIVE_CRUD_ONLY=1 node --env-file=.env .local/user-input-polling-live.mjs`
  - `node --env-file=.env .local/user-input-polling-live.mjs`
- Dataset: 1 row per isolated run; provisioning excluded from steady-state values
- Functional result: all runs completed; User_Input status became `approved`; all
  CRUD deliveries applied 2 effects per operation; no conflicts

| Run | No-setup / steady-state result | Guard result |
| --- | --- | --- |
| `LIVE_POLL_ONLY=1` | Initial poll **2,304 ms**; changed poll **5,345 ms**; insert delivery **6,194.66 ms** | 8 guarded requests, 0 slow |
| `LIVE_CRUD_ONLY=1` | Initial poll **2,153 ms**; update delivery **8,515.16 ms**; delete delivery **6,372.73 ms** | 9 guarded requests, 0 slow |
| Full harness | Initial poll **2,728 ms**; steady polls **3,141.38 / 2,489.48 / 2,227.51 ms**; update delivery **7,593.92 ms**; delete delivery **7,249.12 ms** | 15 guarded requests, 0 slow |

#### Quota observation for this verification batch

The three live runs above made **38 external Apps Script Web App POSTs** in total:
32 synchronization requests, 3 provisioning requests, and 3 cleanup requests. Every observed gateway request returned HTTP 200; no 403/429,
`RESOURCE_EXHAUSTED`, or quota-related gateway error occurred. The 30-second
gateway guard also found 0 slow synchronization requests.

This is an observed sample, not a remaining-quota counter. The current gateway
uses Apps Script `SpreadsheetApp`, not the Google Sheets REST API, so the Sheets
REST request quota cannot be inferred from these POST counts. Apps Script
service/runtime quotas are account- and project-dependent, and Google does not
return their remaining amount through this harness. The exact remaining quota
must be checked in the linked Google Cloud/API or Apps Script execution/usage
console.

### 2026-08-02 — progressive live bidirectional verification

- Branch: `perf/adaptive-sync-performance`
- Exact command: `node --env-file=.env .local/progressive-bidirectional-live.mjs`
- Backend: deployed Apps Script gateway and real Google Sheet
- Matrix: cumulative **1 → 10 → 25 → 66 → 100 rows** in one isolated service
- Each stage performed both directions: app flush/effect delivery, bulk User_Input
  edit, changed polling, SQLite verification, and one unchanged polling pass
- Policy: 30-second Gateway requests were recorded but never stopped the matrix;
  all stages completed before the final result was reported

| Rows | Added | App flush | Outbound delivery | Changed poll | Unchanged poll | Max Gateway request | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 1 | 12.25 ms | 6,304.94 ms | 4,003.09 ms | 1,768.76 ms | 3,510 ms | passed |
| 10 | 9 | 13.18 ms | 13,100.62 ms | 10,130.85 ms | 2,356.88 ms | 8,121 ms | passed |
| 25 | 15 | 16.71 ms | 16,375.68 ms | 7,866.09 ms | 2,037.32 ms | 8,462 ms | passed |
| 66 | 41 | 34.96 ms | 78,406.70 ms | 16,210.92 ms | 1,845.36 ms | 19,087 ms | passed |
| 100 | 34 | 23.89 ms | 120,235.71 ms | 27,529.99 ms | 1,881.89 ms | 26,694 ms | passed |

All stages persisted the expected row count, changed polling applied every
expected row with one full-metadata escalation and zero conflicts, and unchanged
polling stayed on the values-only path. The matrix made **47 synchronization
Gateway requests** (49 including one provisioning and one cleanup request),
found **0** over 30 seconds, and had no functional or cleanup failure. The 66- and 100-row worker/stage totals exceeded 30 seconds because they
contained multiple Gateway requests; no individual synchronization Gateway
request exceeded the threshold.

This is a one-row smoke benchmark, not a 66-row throughput result. Network
latency, Apps Script execution variance, Sheet lock contention, and quota remain
caveats. The progressive result above is still a single 100-row cumulative run,
not a repeated production-load benchmark. Historical live comparison baselines
from earlier branches remain:

| Scenario | Setup | No-setup / steady-state result | Source |
| --- | ---: | ---: | --- |
| Full snapshot polling, 66 rows | excluded | 27,652 ms steady state | 2026-07-27 phase trace below |
| Values-only polling, 66 rows | excluded | 2,240 ms steady state | 2026-07-27 lightweight polling below |
| Outbound 20-order stage | excluded | 28,182 ms / 5.0 rows/s | 2026-07-27 timing run below |
| Outbound 370-order stage | excluded | 36,865 ms / 30.1 rows/s | 2026-07-27 progressive run below |

SQLite remains the application authority and Sheets the asynchronous projection:
full metadata fidelity, response-loss recovery, and the periodic safety full scan
stay required while the values-only fast path avoids remote full reads on
unchanged passes.

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
  still verified from raw Sheet cells before its receipt is written. The
  optional `snapshotHash` in an apply response is therefore `null`.
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

## Caveats

- The raw benchmark measures a throughput upper bound, not production sync
  behavior.
- The benchmark uses an isolated sheet and synthetic string values.
- Network, HTTP, lock acquisition, retry, and response-loss behavior are not
  included.
- The result strongly indicates that the current Gateway validation and
  metadata path, rather than raw `setValues()` throughput, is the dominant
  bottleneck.

## 2026-08-03 — clean Locust smoke after adaptive-sync implementation

- Branch: `perf/adaptive-sync-performance`
- Command:
  `locust -f .local/locustfile.py --host http://127.0.0.1:8787 --headless
  --users 10 --spawn-rate 2 --run-time 60s --csv
  .local/locust-20260803-231300-clean2 --html
  .local/locust-20260803-231300-clean2.html --only-summary`
- Server: `.local/hikoutei-load-server.mjs`, Node.js 24.3, local SQLite,
  deployed Apps Script Gateway, fresh run ID `load-20260803-231003-clean2`
- Dataset/scenario: fresh SQLite and fresh `System_State`, `User_Input`, and
  `Sync_Conflicts` projection tabs; 10 mixed Locust users; 2 users/second
  ramp; 60-second workload window.
- No-setup/steady-state scope: server provisioning and startup were excluded;
  the table below starts after `/health` became ready and includes only the
  Locust workload window. The separate drain snapshot includes background
  worker/polling traffic after Locust stopped.

| Workload | Requests | Failures | p50 | p95 | Maximum | Throughput |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /users/:id` | 134 | 0 (0%) | 2 ms | 4 ms | 6 ms | 2.29/s |
| `POST /users` | 81 | 0 (0%) | 5 ms | 6 ms | 19 ms | 1.38/s |
| `PATCH /users/:id` | 76 | 0 (0%) | 5 ms | 8 ms | 22 ms | 1.30/s |
| `POST /__test/user-input` | 38 | 8 (21.05%) | 2.2 s | 31.0 s | 31.9 s | 0.65/s |
| **Aggregated** | **339** | **8 (2.36%)** | **4 ms** | **2.3 s** | **31.9 s** | **5.78/s** |

The server-side Gateway snapshot after the workload and approximately two
minutes of background drain contained 100 Gateway requests, 34 failures, p50
3.71 s, p95 33.47 s, and maximum 60.00 s. The failures were dominated by
intermittent non-JSON/timeout Gateway responses. The SQLite outbox had 306
`pending`, 8 `processing`, 2 `applied`, and 2 `superseded` effects at the
snapshot; it had not converged, so this is not a successful drain benchmark.

Compared with the earlier 2,648-request run (12.61% HTTP failures, Gateway
p50 4.34 s, p95 34.25 s, maximum 60.01 s), the clean smoke had a lower HTTP
failure rate for entity create/read/update traffic, but its User_Input path
still failed and the outbox did not drain. The runs are not a production
performance comparison until the Gateway deployment is stable and the
background outbox converges under the same workload.

Artifacts:

- `.local/locust-20260803-231300-clean2_stats.csv`
- `.local/locust-20260803-231300-clean2_failures.csv`
- `.local/locust-20260803-231300-clean2.html`
- `.local/hikoutei-load-load-20260803-231003-clean2.jsonl`

Caveats: the Gateway returned intermittent HTTP 404/non-JSON responses and
60-second client timeouts during the run; Python 3.9 emitted Locust's
end-of-life warning; and the remote deployment was not independently
re-deployed during this measurement.

## 2026-08-03 — Gateway baseline transport gate (stopped)

- Branch: `perf/adaptive-sync-performance`
- Command:
  `node --env-file=.env --input-type=module <gateway-baseline-probe>`
- Exact probe: 100 sequential (`concurrency=1`) signed `applyOperations` calls
  using a read-only function that returned the bound spreadsheet ID and an
  integer nonce; no Sheet rows or tabs were created or changed.
- Environment: current built `dist/`, configured Apps Script Gateway URL,
  configured shared secret, configured spreadsheet ID; secrets and IDs are not
  recorded here.
- No-setup/steady-state scope: every request was measured after the client was
  constructed; there was no application or Sheet setup work in the request
  loop.

| Requests | Success | Failure | Failure rate | p50/p95/maximum | Duration |
| ---: | ---: | ---: | ---: | --- | ---: |
| 100 | 0 | 100 | **100%** | not applicable (all HTTP 405) | 425,373 ms |

Every failure decoded as `invalid_sync_gateway_response` with HTTP 405 and the
message `Code.gs response was not valid JSON`. This exceeds the 1% stop
criterion, so no further live sync/load refactor or User_Input migration should
be accepted until the deployed Gateway URL, redirect/method preservation,
permissions, deployment version, and quota/runtime path are isolated. This
probe is diagnostic only and does not establish Sheet convergence.

Artifact: `.local/gateway-baseline-100-20260804.json`.

## 2026-08-04 — Gateway baseline transport gate (redeployed, passed)

- Branch: `perf/adaptive-sync-performance`
- Command: ephemeral signed no-op probe using the built
  `AppsScriptOperationClient`; Gateway credentials were supplied only through
  process environment and are not recorded.
- Exact probe: 100 sequential (`concurrency=1`) signed `applyOperations` calls
  using the same read-only function as the stopped baseline. No Sheet rows or
  tabs were created or changed.
- Environment: redeployed Apps Script Web App `/exec`, current built `dist/`,
  60-second client timeout. Setup was excluded from the measured loop.

| Requests | Success | Failure | Failure rate | p50 | p95 | Maximum | Duration |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 100 | 0 | **0%** | 1,956 ms | 4,511 ms | 20,994 ms | 254,786 ms |

All responses were valid HTTP 200 JSON envelopes. Every request followed the
expected `POST /exec` 302 redirect to the Apps Script `macros/echo` endpoint,
which returned HTTP 200. Compared with the previous 100% failure baseline, the
redeployment fixed the transport gate. This probe proves transport and signed
no-op execution only; it does not establish Sheet write convergence or remove
the need for the subsequent single-append, replay, and concurrency checks.

Artifact: `.local/gateway-baseline-100-20260804-fixed.json`.

## 2026-08-04 — Code.gs-only write correctness gate (passed)

- Branch: `perf/adaptive-sync-performance`
- Command: `node .local/gateway-write-verification-live.mjs` with Gateway
  credentials supplied only through ephemeral process environment; credentials
  are not recorded.
- Backend: redeployed Apps Script Web App `/exec`, built `dist/`, no Advanced
  Sheets Service or manifest activation.
- Scenario: create a uniquely named temporary tab, append one row, replay the
  same effect, submit a same-effect payload mismatch, submit a duplicate
  identity, simulate response loss after the remote append response, replay the
  uncertain effect, inspect row/receipt counts, and delete the temporary tab and
  newly created receipt tab. Setup and cleanup were outside the correctness
  assertions; no existing user tab was retained or modified.

| Check | Result |
| --- | --- |
| Single append | `applied`, receipt-backed visible hash/revision |
| Exact replay | `applied`, target rows 2 including header, one receipt per effect |
| Payload mismatch | rejected with `operation_failed` |
| Duplicate identity | rejected with `operation_failed` |
| Simulated response loss | classified as network uncertainty |
| Response-loss replay | `applied`, no duplicate target/receipt row |
| Cleanup | temporary target and receipt tabs deleted |

This is the first live write-path verification of the built-in
`SpreadsheetApp` implementation. It proves the default single-`Code.gs` path can
append, replay, reject unsafe reuse, and recover a lost response without the
Advanced Sheets Service. It does not yet establish multi-user throughput or
eliminate the documented two-flush crash window between target and receipt
writes.

Artifact: `.local/gateway-write-verification-20260804.json`.
