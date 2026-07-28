# Task Queue Write Model

## Goal

Define the queued write model before implementing task queue operations in the
Apps Script gateway.

The queue is an internal write engine detail. The public API should continue to
move toward an entity lifecycle such as `findById()`, mutate, then
`save(entity)` or `remove(entity)`. Users should not need to understand queue
sheets during normal use.

## Non-Goals

- Do not replace the strict synchronous write path in the first queue branch.
- Do not expose a SQL queue API.
- Do not add Redis, Pub/Sub, or an external queue backend.
- Do not promise database transactions or MySQL/Postgres latency.
- Do not make queued writes the default until read-your-writes behavior and
  failure reporting are designed.

## Sheets

The queued model separates system-owned data from user-facing spreadsheet
views. The system-owned canonical sheet is the source of truth for repository
reads, writes, queue processing, cache warmup, and version checks. The visible
user sheet is a projection that can be refreshed from the canonical sheet.

| Sheet | Purpose |
| --- | --- |
| `Users` or another user sheet | User-facing projection for viewing and light manual inspection. |
| `_typed_sheets_data_Users` or another canonical sheet | Hidden/protected system-owned canonical table. |
| `_typed_sheets_task_queue` | Durable append-only write task log. |
| `_typed_sheets_meta` | Processor cursor, schema metadata, and diagnostics. |

Internal sheets should be hidden when the gateway creates or initializes them.
Hidden sheets are still editable by spreadsheet owners, so the gateway must
validate queue rows before processing.

## Canonical and Projection Sheets

The canonical sheet is the only sheet the write processor trusts. User-facing
projection sheets are generated views of canonical state.

```text
server write
  -> _typed_sheets_task_queue
  -> _typed_sheets_data_Users
  -> optional Users projection sync
```

This keeps manual edits to `Users` from corrupting the system-owned row state.
If a user manually inserts, updates, or deletes data in the visible projection,
the canonical sheet remains unchanged.

First implementation policy:

- queue processors read and write canonical sheets only
- repository reads should use canonical sheets when queued mode is enabled
- projection sync is optional and is not part of the current gateway processor
- visible sheet edits are not imported automatically
- a future projection sync may overwrite visible sheet edits
- `onEdit` import can be designed later as an explicit opt-in feature

This intentionally makes the visible sheet a projection, not the source of
truth. The naming in implementation should reflect that distinction:

- canonical sheet: an internal name recorded in metadata
- projection sheet: `<sheetName>`
- queue sheet: `_typed_sheets_task_queue`

Canonical sheet names must not be derived by direct prefixing alone. Direct
`_typed_sheets_data_<sheetName>` mapping can collide with an existing user
sheet, exceed Google Sheets title limits, or fail when a logical table name
contains characters that need escaping.

The gateway should store logical-to-physical sheet mappings in `_typed_sheets_meta`:

| Field | Meaning |
| --- | --- |
| `logicalSheetName` | Public table name used by repository config and queue tasks. |
| `canonicalSheetName` | Actual hidden/protected sheet title used by the processor. |
| `projectionSheetName` | Visible user-facing sheet title. |

First implementation mapping policy:

- reserve `_typed_sheets_` as an internal prefix
- reject user-facing projection names that start with `_typed_sheets_`
- create canonical names with a short deterministic suffix such as
  `_typed_sheets_data_<slug>_<hash>`
- truncate the slug so the final sheet title stays within Google Sheets limits
- resolve rare collisions by adding or extending the suffix, then persist the
  chosen title in `_typed_sheets_meta`
- never recompute canonical names from logical names when a metadata mapping
  already exists

The projection sync can start as a full rewrite for MVP-sized sheets. Later
versions can add incremental projection sync if full rewrites become too slow.

## `_typed_sheets_task_queue` Schema

Proposed header row:

| Column | Type | Description |
| --- | --- | --- |
| `taskId` | string | Unique id for idempotency and debugging. |
| `transactionId` | string | Groups tasks that must be applied together. |
| `transactionIndex` | number | Order inside the transaction. |
| `sequence` | number | Monotonic ordering value assigned by the gateway. |
| `status` | string | `pending`, `processing`, `done`, or `failed`. |
| `operation` | string | `insert`, `update`, or `delete`. |
| `sheetName` | string | Logical target table name, mapped to a canonical sheet during processing. |
| `keyHeader` | string | Repository key column name, usually `id`. |
| `keyValue` | string | Target key value. |
| `expectedVersion` | number or blank | Version fence for update/delete. |
| `payloadJson` | string | Serialized operation payload. |
| `attempts` | number | Number of processing attempts for the transaction. |
| `lastErrorCode` | string or blank | Last gateway error code. |
| `lastErrorMessage` | string or blank | Last gateway error message. |
| `createdAt` | ISO string | Task creation time. |
| `updatedAt` | ISO string | Last status update time. |
| `taskFingerprint` | string | Stable hash of the immutable enqueue request fields, retained after payload redaction for idempotency checks. |

The queue should be append-first. Updating `status`, `attempts`, and error
columns is allowed during processing.

When the queue schema gains `taskFingerprint`, the Apps Script template must
append that column to an existing legacy queue before processing or enqueueing.
Pending and non-redacted rows can be backfilled from their immutable fields.
Legacy `done` rows whose payload was already redacted cannot be reconstructed;
the migration keeps a task-id-only compatibility marker for replay and records
that limitation.

## Queue Transactions

A queue transaction is a group of tasks created by one repository write flush or
one explicit future unit of work. It is identified by `transactionId`.

This is not a database transaction across arbitrary Google Sheets operations.
It is a gateway processing contract:

- tasks with the same `transactionId` are claimed together
- tasks in the group are validated together
- materialization is attempted only after every task in the group is valid
- if one task in the group fails validation, no task in that group is applied
- every task in the group receives the same final outcome: `done` or `failed`

The first implementation should process one transaction group at a time under
the Apps Script document lock. For bulk processing, the processor should build
the next in-memory table state first, validate every task, then write the
canonical sheet. This gives the gateway a practical all-or-nothing boundary
before the sheet mutation call.

The document lock is the primary concurrency boundary. Google Sheets does not
provide row-level or sheet-level locks that fit this model, and every queued
write is already serialized through the task queue. The processor should
therefore use one document lock while claiming, validating, applying, and
marking transaction groups.

The lock protects against concurrent typed-sheets processors and server
requests. It does not make multiple SpreadsheetApp writes atomic, and it does
not prevent spreadsheet owners from manually editing visible projection sheets.

If Apps Script fails after mutating the canonical sheet but before marking
the transaction `done`, stale `processing` recovery must reconcile the whole
transaction as a group. If every task postcondition is visible, mark the entire
transaction `done`. If none of the task postconditions are visible and attempts
remain, move the entire transaction back to `pending`. If only part of the
group appears applied, mark the whole group `failed` with a `partial_apply`
error and require manual recovery.

## Status Values

| Status | Meaning |
| --- | --- |
| `pending` | Task is queued and has not been claimed. |
| `processing` | Gateway claimed the task under document lock. |
| `done` | Task was applied to the canonical sheet. |
| `failed` | Task could not be applied after validation or retry policy. |

The first processor can use a simple lock-based claim model:

1. Acquire Apps Script document lock.
2. Read a bounded window of complete `pending` transaction groups.
3. Hold any incomplete transaction group until a later processor pass.
4. Mark every task in each claimed transaction `processing`.
5. Apply transactions in `sequence` order.
6. Mark every task in a transaction with the same final status: `done` or
   `failed`.
7. Release lock.

Because Apps Script can time out, the processor must handle stale
`processing` transactions in a later pass. A transaction with `processing`
status and an old `updatedAt` must not be blindly moved back to `pending`. The
processor first reconciles whether each task's intended effect is already
visible in the canonical sheet:

- insert is already applied when the key exists and the row matches the queued
  row/version
- update is already applied when the key exists and the row matches
  `rowToWrite` and the written `_version`
- delete is already applied when the key is absent and the task has enough
  prior-version evidence to prove this delete removed it

If every task postcondition is already true, mark the transaction `done`. If no
task postconditions are true and the retry policy allows it, increment
`attempts` for every task in the transaction and move the transaction back to
`pending`. If only part of the transaction appears applied, mark the
transaction `failed` with `partial_apply`.

Stale recovery must happen before applying any later pending transaction. The
processor should scan from the lowest relevant `sequence` and reconcile stale
`processing` transaction groups before claiming higher-sequence `pending`
groups. This avoids misclassifying deletes or re-inserts. For example, if a
timed-out delete removed `u1`, a later pending insert for `u1` must not run
before the delete transaction is reconciled.

Delete recovery needs stronger evidence than key absence alone. A queued delete
should retain enough postcondition evidence to distinguish "the intended delete
already happened" from "the row is absent for another reason". First
implementation options are:

- keep the deleted row's previous key/version evidence until the transaction is
  `done`
- record an apply marker in `_typed_sheets_meta` before or after the canonical
  write
- mark ambiguous delete recovery as `partial_apply` instead of retrying blindly

## Task Payloads

`payloadJson` should contain only modeled repository data and metadata required
to apply the operation.

Insert payload:

```json
{
  "row": {
    "id": "u1",
    "email": "a@test.com",
    "age": 20,
    "active": true,
    "_version": 1
  }
}
```

Update payload:

```json
{
  "expectedVersion": 1,
  "rowToWrite": {
    "id": "u1",
    "email": "a@test.com",
    "age": 21,
    "active": true,
    "_version": 2
  }
}
```

Delete payload:

```json
{
  "expectedVersion": 2,
  "rowToDelete": {
    "id": "u1",
    "email": "a@test.com",
    "age": 21,
    "active": true,
    "_version": 2
  }
}
```

The queue row duplicates `operation`, `sheetName`, `keyHeader`, `keyValue`, and
`expectedVersion` outside the JSON payload so the processor can filter and
diagnose tasks without parsing every payload first.

## Repository Cache Policy

Queued writes split "accepted into the queue" from "applied to canonical data".
Repository cache entries must therefore represent confirmed canonical state
only. A queued write must not update the confirmed cache with the submitted
payload just because the task append succeeded.

Current implementation policy:

- queued repositories keep a repository-local confirmed snapshot cache with a
  short configurable TTL; direct repositories do not use this cache
- queued write success means the task was durably appended, not that canonical
  data changed
- before a queued write is materialized, invalidate the confirmed snapshot
  instead of mutating it optimistically
- do not expose queued payload values as confirmed repository reads
- a later read should refresh from the canonical sheet after invalidation or
  TTL expiry
- failed transactions must not require cache rollback because pending payloads
  were never written into confirmed cache

The cache is process-local and does not coordinate multiple Node.js instances.
If the Apps Script processor runs outside the repository process, the TTL is
the upper bound for observing a previously cached canonical snapshot.

Future pending-aware APIs may keep a separate pending layer for user
experience, but that layer must stay distinct from confirmed canonical cache.
For example, `save(entity)` may report that a write was queued, while
`findById()` continues to return confirmed canonical data unless an explicit
pending-read mode is designed.

## Queue Data Retention and Redaction

Queue sheets are hidden internal sheets, but they are still part of the user's
spreadsheet and can contain sensitive application data. Treat
`_typed_sheets_task_queue` as part of the sensitive data surface.

Because `payloadJson` may contain full row data, including deleted values in
`rowToDelete`, the queue must not retain successful task payloads indefinitely.

First implementation retention policy:

- keep full `payloadJson` while a transaction is `pending` or `processing`
- after a transaction reaches `done`, replace `payloadJson` with a small
  redacted summary such as `{"redacted":true}`
- keep `taskId`, `transactionId`, `sequence`, `status`, `operation`,
  `sheetName`, `keyHeader`, `keyValue`, `expectedVersion`, timestamps, and
  attempts for diagnostics
- keep full payloads for `failed` transactions only while they are needed for
  debugging or manual recovery
- provide a future cleanup operation that can purge old `done` rows or redact
  old `failed` payloads after a retention window

Error fields must also avoid leaking row contents. `lastErrorCode` should be a
stable code, and `lastErrorMessage` should be short, structured, and avoid
embedding full row values, secrets, credentials, or arbitrary payload JSON.

## Ordering

The gateway should assign `sequence` while holding the document lock. Processor
order is:

```text
sequence ascending
```

This preserves user intent for sequences such as:

```text
insert u1 -> update u1 -> delete u1 -> insert u1
```

Within a transaction, `transactionIndex` preserves the caller's intended order.
Across transactions, `sequence` preserves enqueue order.

Cross-sheet transactions must be part of the first queue contract even if the
initial implementation keeps the public API small. A single `transactionId` may
contain tasks for multiple `sheetName` values, and the processor must never
split that transaction across processor runs.

Cross-sheet processor order:

1. Claim the complete transaction group under the document lock.
2. Read every affected canonical sheet.
3. Validate every affected sheet schema and every task precondition.
4. Build the next in-memory state for every affected sheet.
5. If any validation fails, mark the whole transaction `failed` without writing.
6. Write affected sheets in deterministic `sheetName` order.
7. Mark every task in the transaction `done` only after every affected sheet was
   written successfully.

This is still not a true database transaction. Apps Script and SpreadsheetApp
do not provide an atomic multi-sheet commit. The queue contract is therefore:

- before the first sheet write, the transaction is all-or-fail
- after one or more sheet writes, recovery is based on postcondition
  reconciliation
- if every affected sheet already reflects the queued result, mark the
  transaction `done`
- if no affected sheet reflects the queued result and attempts remain, retry the
  transaction
- if only some affected sheets reflect the queued result, mark the transaction
  `failed` with `partial_apply`

This keeps future relationship-style operations possible without exposing
cross-sheet mechanics in the public repository API.

## Transaction Dependencies

Transactions are processed in `sequence` order, but one failed transaction can
still affect a later transaction because the later transaction may depend on
state the failed transaction was supposed to create.

Example:

```text
tx_001: insert order_1
tx_002: cancel order_1
```

If `tx_001` fails, `tx_002` should not be retried blindly. The processor should
evaluate `tx_002` against the current canonical sheet state. If `order_1` does
not exist, `tx_002` fails with `conflict`.

First implementation policy:

- failed transactions do not roll back already completed earlier transactions
- failed transactions do not automatically block every later transaction
- later transactions are validated against current canonical state
- if a later transaction's precondition is missing because an earlier
  transaction failed, the later transaction fails with `conflict`
- `conflict` is not retried automatically

Later versions can add explicit dependency tracking:

```text
tx_002 dependsOnTransactionId = tx_001
```

With dependency tracking, a pending transaction could wait for its dependency,
or fail with `dependency_failed` if the dependency fails. That is a useful
future feature, but the first implementation should keep dependency handling
implicit through key/version preconditions.

## Idempotency

`taskId` is the idempotency key. It must be supplied by the client-side
repository executor or another deterministic internal caller before enqueue.
The gateway assigns `sequence`, not `taskId`. The queue stores a
`taskFingerprint` for the immutable enqueue request fields so it can compare a
replayed task after `payloadJson` has been redacted.

The gateway should reject duplicate `taskId` values on enqueue unless the
duplicate has the same task fingerprint. If a client retry replays the same
enqueue request after losing the first response, the gateway can return the
already queued task instead of appending another row. The client-side
repository transaction must reuse the original transaction/task IDs and
materialized payloads for that retry; generating new IDs would bypass this
idempotency check.

The public repository transaction API generates transaction identities
internally and does not expose queue task payloads. Queue materialization and
retry retention belong to the internal queue writer. Queue draining is a
separate processor operation:

```ts
await orders.transaction(async (tx) => {
  const order = await tx.findById("o1");
  if (order) {
    order.status = "canceled";
    tx.save(order);
  }
});
```

The queue writer keeps materialized task batches and task identities private to
the repository implementation. Callback failures clear pending work;
ambiguous enqueue failures remain an internal recovery state until a public
retry/status contract is introduced.

Processor idempotency rules:

- `done` transactions are never applied again.
- `failed` transactions are not retried unless explicitly reset.
- stale `processing` transactions are reconciled against all task
  postconditions before retry.
- already-applied transactions are marked `done`.
- unapplied transactions can move back to `pending` as a group.
- partially applied transactions become `failed` with `partial_apply`.

## Apply Semantics

The processor applies tasks against the latest canonical sheet state under
the Apps Script document lock.

Insert:

- fail with `conflict` if the key already exists
- append or include in bulk rewrite if the key is new
- write `_version` from the payload

Update:

- fail with `conflict` if the key is missing
- fail with `conflict` if current `_version` is not `expectedVersion`
- preserve unknown sheet columns when possible
- write the full modeled row with `_version` incremented before enqueue

Delete:

- fail with `conflict` if the key is missing
- fail with `conflict` if current `_version` is not `expectedVersion`
- delete the canonical row or omit it from the bulk rewrite result

Duplicate keys in the canonical sheet are `schema_drift`.

## Failure and Retry

Error codes should stay small and stable:

| Code | Meaning |
| --- | --- |
| `invalid_task` | Queue row or payload is malformed. |
| `schema_drift` | Headers, key column, or duplicate keys make the sheet unsafe. |
| `conflict` | Expected key/version condition failed. |
| `partial_apply` | A transaction appears only partly applied after recovery. |
| `processor_timeout` | Processor exceeded its safe execution window. |
| `internal_error` | Unexpected Apps Script failure. |

Retry policy:

- `invalid_task` is not retried automatically.
- `schema_drift` is not retried automatically until the sheet is fixed.
- `conflict` is not retried automatically.
- `partial_apply` is not retried automatically.
- `internal_error` can retry until `attempts` reaches a configured maximum.
- retry decisions are made per transaction, not per row task.
- stale `processing` transactions run postcondition reconciliation before
  retry.

Dead-letter policy:

- The first implementation can use `failed` as the dead-letter state for the
  whole transaction.
- Later versions can add `_typed_sheets_dead_letter` only if the queue sheet
  becomes hard to inspect.

## Read-Your-Writes

Queued writes change consistency. If `insert()` returns when a task is queued,
the canonical sheet and visible projection may not show the row yet.

Candidate strategies:

1. Explicit queue processing or status polling before strict reads.
2. In-memory cache that applies queued tasks immediately.
3. Pending-task overlay when reading from the canonical sheet.
4. Expose write operation status and let users choose when to wait.

The cache does not provide read-your-writes behavior. Expose queue processing as
an explicit operation and keep pending payloads separate from confirmed reads.

## Gateway Operations

Initial Apps Script operations:

| Operation | Purpose |
| --- | --- |
| `enqueueTasks` | Append one transaction worth of tasks with caller-supplied `taskId`/`transactionId` values and assign `sequence`. |
| `processTaskQueue` | Process a bounded queue window under lock. |
| `processTaskQueueBulk` | Process by rewriting affected canonical sheets in bulk. |
| `readTaskQueueStatus` | Return counts by status and recent failures. |

`processTaskQueueBulk` is the expected performance path. It should read the
affected canonical sheets once, apply all pending tasks in memory, and write
the resulting tables in as few SpreadsheetApp calls as possible.

## Apps Script Runtime Constraints

The queue processor must be designed around Apps Script quotas instead of
assuming a long-running worker. The most important constraints for this model
are:

- one Apps Script execution has a fixed maximum runtime window
- simultaneous executions can happen, but must be serialized with the document
  lock before queue mutation
- installable triggers have a daily total runtime quota
- SpreadsheetApp calls and property reads/writes are not free and should be
  minimized inside the lock

Because of this, queue processing must be resumable. `processTaskQueue` and
`processTaskQueueBulk` should accept bounded execution options:

```ts
interface ProcessTaskQueueOptions {
  maxTransactions?: number;
  maxRuntimeMs?: number;
}
```

The processor should check the elapsed runtime before starting each transaction
group. If the safe runtime budget is nearly exhausted, it should stop claiming
new transactions and return a partial progress response instead of risking an
Apps Script timeout.

Recommended first-pass behavior:

- claim only complete transaction groups
- process at most `maxTransactions` groups per call when provided
- stop before `maxRuntimeMs` is reached when provided
- leave unclaimed transactions in `pending`
- reconcile stale `processing` transactions in a later call
- expose counts for processed, remaining, failed, and stale transactions

This keeps queue processing compatible with manual button runs, time-based
triggers, and server-triggered gateway calls.

## Repository Integration Plan

Implementation should happen in separate branches:

1. Add gateway queue sheets and operations.
2. Add focused gateway adapter methods for enqueue/process/status.
3. Add cross-sheet transaction validation and recovery tests.
4. Add an internal queued write executor.
5. Group same-flush writes with one `transactionId`.
6. Add read-your-writes behavior.
7. Expose a documented opt-in repository mode.

The current synchronous executor remains the default until the queued mode has
clear consistency and failure behavior.

## Benchmark Requirements

Every queue benchmark must record:

- date and branch
- exact command or script
- dataset size and scenario steps
- backend details and Apps Script deployment URL type
- total time
- no-setup or steady-state time
- enqueue-only time
- processor-only time
- comparison with the previous synchronous benchmark
- caveats such as Apps Script latency and manual browser steps

Use the existing performance issue as the durable benchmark record.

## Open Questions

- Should task queue sheets be hidden by default or only by setup option?
- Should sequence be global or per target sheet?
- What should the first explicit unit-of-work API look like for generating
  `transactionId` values?
- Should `enqueueTasks` optionally trigger processing immediately?
- How should server memory cache behave across multiple server instances?
- How much formatting and unknown-column preservation should bulk rewrite
  guarantee?
