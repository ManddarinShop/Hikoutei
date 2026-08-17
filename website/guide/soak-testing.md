---
title: Soak testing
description: Long-duration soak runner for the local SQLite authority — source build, six scalar tables, 6h preflight and 24h direct-live runs, log envs, redaction contract, resume/cleanup, acceptance criteria, and the later always-on execution.
---

# Soak testing

The local multi-table soak is the long-duration stability exercise for the
SQLite-authoritative entity lifecycle. It drives the **current local build**
of Hikoutei exclusively through the public `createTypedSheets()` /
EntityManager surface — no internal provider, worker, or SQL API — for hours
at a time, across six independent scalar tables, with deterministic seeded
workloads and an in-memory oracle that mirrors the public query semantics.

The runner lives in `scripts/ci/run-local-multitable-soak.mjs` with the
workload helpers in `scripts/ci/local-soak/`, and its short-budget behavior
is pinned by focused Vitest suites (`test/soak-args.test.ts`,
`test/soak-prng.test.ts`, `test/soak-oracle.test.ts`,
`test/soak-executor.test.ts`, the split `test/soak-artifacts.{records,writer,collection}.test.ts`, and
`test/soak-runner-unit.test.ts`, the feature-independent soak suite whose
focused unit convergence/tombstone/batching/readiness/security asserts run
in the default suite. The feature-dependent `test/soak-runner.test.ts` — a
short end-to-end run that crosses the cycle-60 reopen and the resume path,
with opt-in long soak/recovery groups — is excluded from the non-feature
soak stack, so `npm run test:soak` targets the available non-feature file
through a portable Node launcher (`scripts/run-soak-long.mjs`) that sets the
long-run gate in-process and works in POSIX and Windows npm shells alike
(the same gate is available manually as `SOAK_RUNNER_LONG=1 vitest run
test/soak-runner-unit.test.ts`). The default `npm test` stays bounded while
the focused unit asserts run in it. This page is the tracked home of
the soak documentation; the gitignored `docs/` notes are working notes only.

## Source build only — never `hikoutei@latest`

The runner never installs or imports the npm release. It imports `hikoutei`
through the package self-reference, which resolves to `./dist`, so the local
build must be current before every run:

```sh
npm run build
node scripts/ci/run-local-multitable-soak.mjs --duration-hours 6
```

Progress goes to stderr; the redacted summary JSON goes to stdout; the exit
code is `0` on `passed` and `1` on `failed`.

## Workload shape

Six independent scalar entities with string primary keys — no relations,
joins, `populate()`, or raw SQL:

| Entity | Table |
| --- | --- |
| `SoakCustomer` | `soak_customers` |
| `SoakOrder` | `soak_orders` |
| `SoakInventoryItem` | `soak_inventory_items` |
| `SoakTask` | `soak_tasks` |
| `SoakAuditEvent` | `soak_audit_events` |
| `SoakFeatureFlag` | `soak_feature_flags` |

The documented execution profile is **4 forked actors × 20 operations per
actor** with a **5-minute interval between cycles** (the defaults). Each
cycle is deterministic from the run seed and repeats the same shape:

1. **Prologue** — for every active table: create a long-lived main row,
   create and delete a churn row, and update the main row.
2. **Concurrent actors** — each forked actor runs its seeded mixed operation
   stream: create/update/delete/batchPersist, filtered and paged queries,
   `transactional()` commit and rollback, fork-isolation, and the
   `expected_*` validation-error assertions. Actor-scoped ids are disjoint,
   so the final state is independent of scheduling; every oracle-touching
   operation is serialized through one mutex.
3. **Verification** — sampled per-table queries and full id-set scans
   against the oracle.
4. **Human-edit probe** (live only, every 10th cycle) — overwrites one
   editable field through the `User_Input` tab and waits for the polling
   pipeline to accept the value into SQLite.
5. **Convergence check** (live only, every cycle) — the `_System`
   projections must eventually contain exactly the oracle ids, with no
   duplicates, no lost rows, and no silent overwrite of an accepted human
   edit.
6. **Reopen** (every 60th cycle) — the runtime closes and reopens as a
   safe handoff: the old runtime's leases are released by closing it
   BEFORE the replacement opens (live-mode sync auto-start claims writer
   leases under a fresh random writer id, so opening the replacement first
   would fail with `WRITER_LEASE_UNAVAILABLE`). A failed reopen may be
   evidenced by EITHER post-reopen table counts differing from the oracle
   OR `scan: "failed"` identity/content evidence — the full-scan compare
   verifies row identity and content in addition to counts, so a
   same-count scan failure (a row id lost/extra or a content mismatch
   while every count still matches) fails the reopen too, and the runner
   records both `status` and `scan` fields. If the replacement cannot
   open after the old close, the run records a stable
   `reopen-cleanup-failed` abort and stops with `reopen-failed` — it
   never continues against a closed runtime and never reports success.

A failed operation is retried up to three times before it counts as a
failure; every extra attempt counts as a retry. The run stops when the
duration budget is reached or when consecutive failures cross
`--max-consecutive-failures`.

## Modes

- **Local preflight (default)** — no credentials, no Sheets contact. The
  SQLite authority is exercised end to end; probes and convergence are
  recorded as `skipped`. This is the 6h source-built preflight.
- **Direct live** — set `HIKOUTEI_SYNC_SPREADSHEET_URL` (a
  `.../spreadsheets/d/<ID>/...` URL) and `GOOGLE_APPLICATION_CREDENTIALS`
  (ADC service-account key). The internal sync service starts with the
  runtime and every cycle additionally verifies eventual Sheets convergence.
  This is the 24h direct-live run. Never point live runs at a production
  spreadsheet; the sandbox is dedicated and cleanup is scoped to it.

## Deadline and request gating

The run budget is enforced on the EPOCH clock (`Date.now()`), so live
probe/convergence waits and Sheets requests can never disagree with the run
duration (durations themselves stay on `performance.now()`):

- The runtime open is deadline-gated: a startup (or the cycle-60 reopen)
  that returns AFTER the budget expired is closed best-effort and the run
  fails with the stable `deadline_expired` class instead of claiming a
  within-budget run.
- Every live observation/probe request timeouts at `min(default timeout,
  remaining budget)` and never starts after the deadline: the expiry check
  and the timeout computation share ONE clock read, so the deadline can
  never cross between two checks and produce a 0ms (no-abort) timeout.
- Each convergence/probe phase additionally carries its OWN operation
  deadline — `min(run deadline, now + phase timeout)` — and every direct
  Sheets request of the phase (tab reads, the human-edit write, cleanup)
  is asserted against it before it starts, so a slow request can never
  outlive the phase timeout just because the run budget is larger.
- Waits between cycles are bounded by the deadline: when the remaining
  budget is smaller than the poll interval, the sleep ends at the deadline,
  never after it.

## Request pacing and quota headroom

Google Sheets quota is enforced per 100-second windows, so Hikoutei's direct
provider serializes ALL request starts — reads and writes together — through
ONE shared limiter: at most one Sheets API request can start per interval
regardless of class. The safe default interval is **2,500 ms** (about 40
starts per 100-second window), leaving headroom inside the default
per-user/per-project 100-second quotas for the observation and provisioning
reads that run beside the worker; the exact quota stays provider and
environment dependent. Admission is BOUNDED: a request whose predicted slot
lies more than ONE interval out is refused before any SDK call with the
stable delivery-uncertain `google_sheets_api_request_start_refused` error,
so a burst of concurrent lock-free polling reads can never push a later
write's start past its effect lease — the durable worker requeues the effect
and the limiter horizon is untouched, so the next pass is admitted again
once the queue drains. The interval is also bounded by the effect lease: a
worst-case dispatch (two preflight/postcondition reads plus one write, each
paced and timed out, with up to one full interval of first-slot wait because
the shared limiter may hold a prior reservation) must finish inside the
120-second default lease with the 30-second provider headroom —
`120 s > 60 s + I + 2 x max(10 s, I) + 30 s` — so an unsafe override is
rejected at startup instead of risking lease expiry and duplicate remote
delivery. Under the default lease/timeouts the strict bound caps the
interval below 10 s (env ceiling 9,999 ms); longer intervals stay possible
only with an explicitly longer active effect lease. The
library never retries mutating HTTP calls in
`gaxios` (`retry: false`); the durable outbox worker owns retries, and the
limiter is fail-open for telemetry.

| Env var | Default | Contract |
| --- | --- | --- |
| `HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS` | `2500` | internal override for the shared read+write request-start interval of the REAL Google Sheets provider; plain decimal integer in `1000..9999` ms (the largest default-safe interval under the default 120 s lease, 60 s write timeout, 10 s read timeout, and 30 s headroom, including the up-to-one-interval first-slot wait: `120 s > 60 s + I + 2 x max(10 s, I) + 30 s`); malformed or out-of-bounds values fail sync startup closed. The same value is the admission bound: a request whose slot is more than one interval out is refused before transport (delivery-uncertain, requeued). Injected fake transports and local-only mode are never affected by this key. Not part of the root public API. |

The soak harness itself is paced too: the direct observation client used for
convergence reads, probe edits, and cleanup spaces every request start of
one client through its own shared read+write gate, defaulting to the same
2,500 ms as the library. Soak-only direct requests can therefore never fire
an unpaced burst on top of the library's worker traffic and invalidate the
quota behavior the live run is observing. The soak workload (cycles,
operations, probes) is unchanged; only request START times are spaced.
(Test clients may pass `requestStartIntervalMs: 0` to disable the gate.)

Convergence observation is batched: each round reads every active System
tab in ONE `spreadsheets.get` request (one range per tab) under a single
pacing slot, so a six-entity round is one request start instead of six
per-entity reads. This reduces the harness observation request count
only — the workload, poll cadence, and the convergence checks themselves
are unchanged.

## Options

| Option | Default | Contract |
| --- | --- | --- |
| `--duration-hours` | `24` | `0 < hours <= 24`; 6 and 24 are the documented execution values |
| `--interval-seconds` | `300` | non-negative; `0` disables the between-cycle wait |
| `--actors` | `4` | `1..64` |
| `--operations-per-actor` | `20` | `1..1000` |
| `--tables` | all six | comma-separated subset of the soak tables |
| `--seed` | `0x50414b53` | integer in `[0, 2^32-1]`, decimal or `0x` hex |
| `--max-consecutive-failures` | `5` | `1..1000` |
| `--log-file` | artifact dir | library log path (`.txt` enforced); never echoed |
| `--output-dir` | `.local/soak/run-<ts>` | artifact directory |
| `--resume` | off | continue from `state.json`; requires `--output-dir`; the stored seed wins |
| `--cleanup-only` | off | delete the sandbox projection tabs (live only) |

## Planned execution

1. **6h local preflight** from the source build (no credentials) — the
   baseline soak that validates the workload and oracle over a meaningful
   duration:

   ```sh
   npm run build
   node scripts/ci/run-local-multitable-soak.mjs --duration-hours 6
   ```

2. **24h direct-live run** against the dedicated sandbox spreadsheet with
   the service account, verifying the async Sheets projection under
   sustained churn:

   ```sh
   HIKOUTEI_SYNC_SPREADSHEET_URL='https://docs.google.com/spreadsheets/d/<ID>/edit' \
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
   node scripts/ci/run-local-multitable-soak.mjs --duration-hours 24
   ```

3. **Later long-running execution** on an always-on host (Oracle Cloud VM is
   the planned target) to extend coverage past 24h. The `--resume` /
   `--cleanup-only` options exist for that phase: a run interrupted by host
   maintenance resumes from its artifact directory, and `--cleanup-only`
   removes the sandbox tabs when a spreadsheet is retired.

## Library log envs and the redaction contract

The library's structured log is opt-in (`src/shared/observability/`): the
runner pins `HIKOUTEI_LOG_FILE` into the artifact directory and
`HIKOUTEI_LOG_LEVEL` to `info` unless the operator supplied
`--log-file`/env values. The pin is scoped to ONE run: the pre-run env
values are restored and the library's cached process logger reset when the
run ends (success or failure), so repeated `runLocalMultiTableSoak()` calls
in one Node process never retain the first run's `HIKOUTEI_LOG_FILE` or a
logger bound to its file — each run's current/rotated/collected log
contains only its own events, and caller-set env values are honored during
the run and left untouched after it (normal application env behavior is
unchanged). The rotation contract is enforced by the library,
not the runner:

| Env var | Default | Contract |
| --- | --- | --- |
| `HIKOUTEI_LOG_FILE` | — | log path; when absent OR blank/whitespace-only the logger is a no-op (blank never normalizes to a bare `.txt`) |
| `HIKOUTEI_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `HIKOUTEI_LOG_MAX_BYTES` | `10 MiB` | rotation threshold (minimum 4 KiB) |
| `HIKOUTEI_LOG_BACKUPS` | `5` | rotated backup files kept (0 = truncate) |

The log is redacted and allowlisted by construction: only stable event,
component, class, and code constants are emitted — entity values, ids,
spreadsheet URLs, and credentials never are. The runner additionally
concatenates the log and its retained rotated backups into
`collected-log.txt` inside the artifact directory. Rotation keeps only the
current file plus the five most recent rotated backups (10 MiB each); older
log content is deleted by rotation and is not recoverable, so collection
preserves exactly the retained window — it never recovers logs older than
the retention. Every collected line must validate against the logger's
JSONL shape (known fields, allowlisted event/component/code/class, finite
counts) and is re-serialized in the canonical shape; non-JSON or
secret-bearing lines — including arbitrary pre-existing files that merely
share the log name — are dropped, never byte-copied. Extensionless custom
`--log-file` paths are normalized to `.txt` (the logger's contract),
whitespace-padded values are trimmed exactly as the logger trims them,
before collection, and the logger queue is drained before the final
collection so the last events (including the runtime close) are always
present. A blank/whitespace `HIKOUTEI_LOG_FILE` means logging was disabled
and the collection is empty — it never resolves to a bare `.txt`.
Backup matching is exact-case and canonical: only the logger-created base
filename plus `<base>.<N>.txt` backups with N the canonical positive
decimal in [1, retention] are ever collected or cleared — `.0.txt`,
leading-zero, beyond-retention numeric files, and files that differ only
by base-name or suffix case (`HIKOUTEI-INTERNAL-LOG.1.txt`,
`hikoutei-internal-log.1.TXT`) are operator files and stay untouched.
The reserved `collected-log.txt` is written atomically (temp file +
rename), so a pre-existing symlink at that name is replaced, never
followed — an external operator target can never be overwritten. The
same no-follow guarantee holds for every artifact writer: JSONL streams
are appended through `O_NOFOLLOW` (after any pre-existing symlink at
the stream name is removed), JSON/checkpoint documents claim a UNIQUE
staging name per write (`<name>.tmp-<pid>-<seq>`) created with an
exclusive no-follow open (`O_CREAT|O_EXCL`, plus `O_NOFOLLOW` where the
platform provides it), fsync the staged content, and rename over any
pre-existing symlink at the target name — so there is no
rm-then-write window a planted symlink could race, and a link planted at
any artifact, staging, or summary path that points outside the output
dir is either replaced by a real file inside it or fails the write
closed, while the external target stays byte-identical. Stale staging
files from a crash between the temp write and its rename — the retired
fixed `<name>.tmp` names and the unique `<name>.tmp-<pid>-<seq>` shape —
are removed by a fresh run's reset.
Logger-owned files (the effective log plus its rotated backups) are only
read or cleared under containment: a log path inside the output dir must
ALSO resolve by real path inside the real output dir, so a symlinked log
directory or log file that escapes the output dir is never read or
cleared; lexically external custom `--log-file` paths remain
operator-owned (collected, never deleted).

A runtime close failure at the end of the run is never swallowed: the
runner retries the close once, and the retry GENUINELY re-invokes the
provider cleanup (Hikoutei close is retryable), so a real first-attempt
failure can recover. A persistent close failure increments the failure
counters, fails the summary with a stable
`cleanup: { status: "failed", reason: "runtime-close-failed", ... }`
section, and every artifact still lands. A replacement runtime that opened
during a failed reopen handoff is tracked and closed with the same final
retry; a persistent failure adds a stable `replacementCleanup:
{ status: "failed", reason: "replacement-close-failed", ... }` section.
The same applies to a final artifact write/collection failure: the summary
is forced to `failed` with a stable `finalization` section, and the failed
marker is persisted in `state.json` so a later `--resume` rejects the
state instead of silently continuing a failed run.

All artifacts are redacted by construction: entity ids, field values,
spreadsheet IDs/URLs, credentials, and raw error messages never enter them.
Operation failures carry a stable reason category (for example
`rollback-verification`, `query-mismatch`, `unexpected-throw`) plus the
stable HikouteiError code when one exists. `soak.sqlite` (the local SQLite
authority) is never collected or uploaded.

Artifacts in `--output-dir`:

| File | Content |
| --- | --- |
| `cycles.jsonl` | per-cycle counters, durations, probe/convergence/reopen summaries |
| `operations.jsonl` | per-operation kind, table, status, stable code/reason, counts |
| `resources.jsonl` | RSS/heap/external memory, db size, uptime |
| `state.json` | resume state (runId, seed, params, cumulative counters, optional recovery/cleanup/finalization markers); atomic temp-file + rename write |
| `checkpoint.json` | atomic per-cycle recovery marker (`in-flight` before a cycle's SQLite work, `completed` after its record + state + resource landed); validated against the state's runId |
| `summary.json` / `summary.md` | redacted final summary |
| `hikoutei-internal-log.txt` | the library's opt-in redacted JSONL log |
| `collected-log.txt` | concatenation of the log plus its retained rotated backups (rotation window only) |
| `soak.sqlite` (+ `-wal`/`-journal`/`-shm` sidecars) | the local SQLite authority (never collected or uploaded) |

Do not paste raw artifacts into issues; reproduce from `--seed` and the
artifact directory instead.

## Acceptance criteria

A run is accepted when all of the following hold:

- `summary.status` is `passed` and the process exit code is `0`.
- `summary.stopReason` is `duration-budget-reached` (not
  `max-consecutive-failures` or an artifact-write failure).
- `summary.operations.failures` is `0`, and
  `total = ok + expectedErrors + failures` holds.
- `summary.tableRows` covers every active table, and the per-cycle
  `tablesTouched` matches the deterministic plan-derived union: the
  prologue table names plus the entity names the stored actor stream
  actually selects (a low-workload config such as `--actors 1
  --operations-per-actor 1` touches only the one planned entity per
  cycle, never every active entity).
- All artifact files listed above exist and contain no raw ids, values,
  spreadsheet URLs, or messages.
- The 60th-cycle reopen records exist with `status: "ok"` (which requires
  BOTH ok full-scan identity/content evidence — `scan: "ok"` — and
  post-reopen counts matching the oracle); a failed reopen is evidenced
  by either differing table counts or `scan: "failed"`.
- In live mode, probes and convergence checks are `ok` (no missing,
  duplicate, or extra projection rows). Durable System_State tombstone
  rows (`__typed_sheets_deleted` displayed `TRUE` on a non-blank-id row)
  are retained deleted-entity history and are excluded from the active id
  set; a tombstone display on a blank-id row is malformed and still counts
  as an extra row.
- Determinism holds: the same `--seed`, duration, and options reproduce the
  same operation stream and outcomes.

For the 6h → 24h pair specifically: the 6h local preflight must pass before
the 24h direct-live run is scheduled, and the 24h run must pass before the
longer always-on execution is considered.

## Resume and cleanup

- `--resume` re-derives the oracle from SQLite (the authority) before
  continuing and keeps the stored seed, so the continued stream stays on the
  original determinism. It fails loudly when `state.json` is missing,
  unparseable, or of an unsupported version — never silently starts fresh.
  The complete schema is validated before any runtime opens: version, runId,
  seed, mode, params (positive numerics, exact known tables), cumulative
  operation/probe/convergence counters, `tableRows`, and
  `lastCompletedCycle`; malformed, missing, or unknown fields fail with a
  stable local reason and never partially run. A zero-cycle state
  (`lastCompletedCycle 0` — a run interrupted during its FIRST cycle)
  legitimately carries the initial empty `tableRows` set and is recovered
  deterministically, exactly like any other interrupted cycle.
  `checkpoint.json` is validated the same way (version, runId matching the
  state, cycle, status); a corrupt or foreign marker rejects the resume
  before any runtime opens.
- **Run identity grammar.** Every run gets a generated `runId` in the
  `soak-<base36>` grammar (`^soak-[0-9a-z]{4,32}$`). Resume validates BOTH
  `state.runId` and `checkpoint.runId` against that grammar and requires
  them to be identical: a secret-like, corrupt, uppercase, too-short, or
  URL-shaped id is rejected with a stable reason, and a marker that belongs
  to a different run fails the resume before anything opens.
- **SQLite authority validation before resume.** The database file must
  already exist, be a regular file, and be non-empty BEFORE the runtime
  opens — a missing or empty `soak.sqlite` is never silently recreated (a
  fresh run without `--resume` is the only path that builds a new
  authority). The checks use `lstat`, so a symlinked `soak.sqlite` or a
  symlinked `-wal`/`-journal`/`-shm` sidecar rejects the resume with a
  stable reason BEFORE any inspection or open — the runner can never
  inspect or mutate an external database through a link. The EXISTING
  schema is then inspected READ-ONLY before the
  runtime opens: a dropped entity table or column fails the resume with a
  stable reason instead of being silently recreated by the runtime's
  non-destructive migration and accepted with zero expected rows. After the
  runtime opens, every active entity table is read through the public
  runtime surface before any workload mutation, and the observed row set is
  verified against an EXACT deterministic replay of the stored seed/params
  (sequential prologue + up-front actor planning + deterministic final row
  sets):
  - every row of every checkpointed cycle must be present by ID and by
    content (a missing row, a foreign id, or a same-count in-place field
    mutation is a stable pre-mutation failure),
  - an interrupted cycle (in-flight marker for `lastCompletedCycle + 1`
    WITHOUT a recorded cycle record) may only contain rows from its own
    deterministic planned set — prologue main/churn rows in one of their
    committed stages plus a subset of the planned actor rows, each with
    exact content — with the sequential per-table prologue stage rules
    enforced,
  - an in-flight cycle WITH a recorded non-aborted record (the
    completed-cycle-checkpoint recovery) is verified as a COMPLETED
    cycle: its full deterministic row set (prologue rows plus every
    planned actor row) must be present with exact content, so a missing,
    tampered, or partial row fails CLOSED instead of passing as a
    plausible interrupted prefix,
  - the human-edit override row content (live probes) is accepted only
    when the corresponding recorded probe is successful and names the
    deterministic target/field AND the authority contains the
    deterministic human-edit value for that exact cycle/table/field — a
    failed, missing, or altered probe makes changed content fail closed,
    and an ok probe without the authority evidence (forged record with
    adjusted counters, unchanged DB) fails closed as tampered history
    instead of mutating the replay oracle or passing the exact proof,
  - `state.tableRows` must equal the replayed counts at the last
    checkpointed cycle exactly (implicitly zero for a zero-cycle state),
  - a completed cycle whose abort record cannot prove its committed
    extent (anything but the full-cycle reopen/deadline aborts) fails
    CLOSED instead of accepting an unprovable superset.
  A drifted schema, a foreign or mutated row, or an unprovable
  interrupted cycle is a stable pre-mutation failure — SQLite is the
  authority and is never silently reconciled, recreated, or trusted with
  a schema or row set that contradicts the deterministic state.
- **Strict JSONL history validation.** No parseable JSONL line is trusted
  as completion proof: resume validates the exact cycle/operation/resource
  record schemas, cycle identity, gaps, duplicates, resource samples for
  every checkpointed cycle, and the cumulative counters against the
  recorded history — all BEFORE any runtime opens or mutates. Every
  operation record is additionally bound to the deterministic stream the
  stored seed generates: its `(cycle, actor, index)` identity must be
  within `actors x operationsPerActor`, its kind/table must equal the
  seed's own plan for that identity, a non-aborted cycle must hold the
  EXACT full actor grid, a PROVABLE abort (reopen cleanup / deadline
  expired) must hold the EXACT full actor grid too — those aborts only
  fire in the reopen phase after every actor record landed, so a
  truncated suffix is forged history — and only an ambiguous abort or a
  recordless interrupted cycle may hold a contiguous actor prefix. The
  recorded sections are bound to the same determinism: a convergence
  section's cycle must equal its record's cycle with the exact
  ok/failed shape, a live probe's table must equal the deterministic
  round-robin target for its cycle (with the mode's exact status/reason
  shape; local probes are exactly `skipped`/`local-mode`), and a reopen
  section must carry exactly one count per active table bound to the
  replay: `status: "ok"` requires every count to match the replayed
  post-cycle counts exactly AND `scan: "ok"`, while `status: "failed"`
  requires EITHER at least one count to differ OR `scan: "failed"`
  identity/content evidence (the full-scan compare covers row identity
  and content, which can fail while every count still matches; the
  runner emits failed only when counts/scan evidence differed or the
  cleanup/replacement failed, which is the abort shape) — a forged failed
  status with exact successful counts and ok scan evidence, or an ok
  status carrying evidence-differing counts or failed scan evidence, is
  tampered history. The human-edit content allowance in the exact DB proof is
  bound to the recorded probe BOTH ways: the deterministic
  human-edit row content is accepted ONLY when the corresponding
  recorded probe is `ok` and names the deterministic target, and an `ok`
  probe is trusted for the replay oracle mutation ONLY when the SQLite
  authority contains the deterministic human-edit value
  (`human-edit-c<cycle>` in the probe's deterministic field of that
  cycle/table main row) — a forged `ok` probe with adjusted counters but
  an unchanged DB never mutates the replay oracle and fails the resume
  closed. Abort
  records must match the runner's
  exact one-failed-unit contract, and no cycle/operation/resource record
  may
  exist outside the checkpointed window (a record for
  `lastCompletedCycle + 1` requires an in-flight marker naming it). A
  corrupt partial line, a missing middle-cycle record, a duplicate
  identity, an unknown field, a forged kind/table, a count mismatch, an
  out-of-window record, or a missing resource sample is a safe
  pre-mutation failure; an interrupted cycle that simply has no record yet
  is reconciled deterministically instead.
- **Checkpoint staleness.** An in-flight marker whose cycle is OLDER than
  `state.lastCompletedCycle` is rejected — arbitrary old markers are
  never rewritten as completed. Only the current completed marker
  (lagged at `lastCompletedCycle`) or the next cycle's in-flight marker
  is ever accepted.
- **Failed-run markers block resume.** A run that ended with a close,
  replacement-close, or finalization failure persists a redacted failed
  marker (`cleanup`, `replacementCleanup`, or `finalization`) in
  `state.json`; a later `--resume` REJECTS that state instead of silently
  overwriting the failed finalization with a passed run.
- **Bounded recovery invariant.** The filesystem and SQLite cannot be one
  transaction, so a process interruption at any point between them is
  repaired by idempotent, checkpointed recovery — never by silently
  starting fresh. The durable order per cycle is: atomic in-flight marker →
  cycle SQLite work → cycle record → atomic `state.json` checkpoint →
  resource sample → atomic completed marker. Both `checkpoint.json` and
  `state.json` are written atomically (temp file + rename), so a crash
  mid-write leaves the previous complete file in place and a reader can
  never observe a half-written state. Every recovery expectation and plan
  derives from the stored seed/params and the deterministic generator
  ALONE (a pure replay planner) — SQLite is only ever CHECKED against the
  independently derived expected state, never used to change the plan,
  including when `lastCompletedCycle` is 0. Every interruption boundary
  either recovers deterministically or fails safely before any runtime
  opens:
  - Interruption before the cycle record (SQLite work committed, nothing
    recorded): resume re-runs the cycle once with reconciliation — the
    oracle is rebuilt from SQLite (the execution mirror), deterministic
    rows already committed are accepted only when their content matches,
    the actor stream comes from the pure deterministic replay (never a
    re-plan against partial rows), and cycle/operation/resource records
    are deduplicated by identity.
  - Interruption after the cycle record, before the state checkpoint:
    resume re-proves the recorded cycle BEFORE advancing state — the
    record must be non-aborted with the exact deterministic totals, every
    non-aborted actor identity must be recorded, and SQLite must contain
    EXACTLY the deterministic rows of that cycle (ids and content). A
    missing, tampered, or partial row fails closed; only a proven cycle
    advances the state from its recorded totals — no SQLite replay, no
    duplicate rows, counters exactly consistent with the JSONL history.
  - Interruption after the state checkpoint, before the completed marker:
    resume repairs the stale in-flight marker (re-persists state, backfills
    the resource sample, advances the marker) and continues from the
    checkpointed cycle.
  - A corrupt or partial `state.json`/`checkpoint.json` write: resume
    rejects it with a stable reason before any runtime opens.
  Each recovered resume persists a redacted recovery reason (`cycle` plus a
  fixed vocabulary value such as `interrupted-cycle-reconciled`) in
  `state.json` and surfaces it in the summary.
- **Fresh-run isolation.** A fresh run in a REUSED output directory (no
  `--resume`) deletes only runner-owned state before the runtime opens:
  the per-run JSONL streams (`cycles.jsonl`, `operations.jsonl`,
  `resources.jsonl`), the SQLite authority and its sidecars (`soak.sqlite`,
  `soak.sqlite-wal`, `soak.sqlite-journal`, `soak.sqlite-shm` — stale
  sidecars can carry rows from an interrupted previous run), the atomic
  resume documents `state.json` and `checkpoint.json` (HIGH 3: a crash
  after the new DB opens but before the first state write must make a
  later `--resume` FAIL with the clean "no state.json" reason instead of
  accepting the previous run identity or a zero-cycle stale state), the
  atomic-write staging files left by a crash between a temp write and its
  rename (the retired fixed `state.json.tmp`, `checkpoint.json.tmp`,
  `summary.json.tmp` names AND the unique `<name>.tmp-<pid>-<seq>`
  staging shape — the fixed names by exact path, the unique shape by an
  anchored pattern on the known artifact base names only, never a
  wildcard sweep), and the
  logger-owned current plus rotated log files (`<log>.txt`,
  `<log>.<N>.txt`) when the log lives inside the output directory — by
  BOTH lexical and real path, so a symlinked log directory that resolves
  outside the real output dir is never cleared.
  Arbitrary external or operator-supplied paths — notably a custom
  `--log-file` outside the output dir — are never touched. A fresh run
  therefore can never leak prior cycle history, a previous run identity,
  stale SQLite rows, or old log content into the new run's artifacts.
- `--cleanup-only` deletes the sandbox projection tabs
  (`<Entity>_System`, `<Entity>_Input`, `<Entity>_Conflicts`) for the
  active tables, requiring the live sandbox env vars. A `--tables` subset
  cleanup removes only the selected tables' tabs; the shared internal
  receipt tab is removed only by a full cleanup, because untouched tables
  still need it.

## Later Oracle execution

The planned third phase runs the soak on an always-on host — an Oracle Cloud
VM is the target — to extend coverage past the 24h budget:

- The run resumes with `--resume` after host maintenance; the artifact
  directory is the only state that must survive.
- `--cleanup-only` retires a spreadsheet cleanly when the sandbox is
  replaced.
- Oracle execution stays local-mode unless live env vars are provided; the
  deterministic seed and artifact contract are identical to the 6h/24h
  runs, so results remain comparable across hosts.
