---
title: Write and synchronization flow
description: flush() commits locally and the outbox worker delivers to Google Sheets asynchronously — fast append, guarded updates, response-loss recovery, and User_Input polling.
---

# Write and synchronization flow

Hikoutei commits local state first and materializes Google Sheets changes
asynchronously. The root ORM API is SQLite-only; the internal sync service
owns all Sheet communication.

## Public ORM flow

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction
  └─ entity table
          │
          ▼
return to application
```

`createTypedSheets()` never contacts Google Sheets and does not require a Sheet
route, provider client, or provisioner. Reads always come from SQLite.

## Internal sync service flow

The service-side bootstrap uses the same SQLite adapter and adds the canonical
sync state and durable outbox to the flush transaction:

```text
EntityManager.flush()
          │
          ▼
SQLite transaction
  ├─ entity table
  ├─ canonical sync state
  ├─ projection registry/state
  └─ durable Sheet effect outbox
          │
          ▼
internal effect supervisor
  ├─ claim with a lease
  ├─ send a signed operation batch
  ├─ persist uncertain delivery and schedule a durable postcondition probe
  └─ mark the effect applied, terminally failed, or recoverably pending
          │
          ▼
Google Sheets API provider ──▶ Google Sheets
```

A successful `flush()` means that SQLite accepted the local change and queued
its projection effect. It does not mean that the remote Sheet write has
completed.

## Fast append, update, and delete

New `System_State` rows use the bounded fast append operation where possible.
Updates and deletes use guarded effects with expected visible revision/hash
evidence. The same internal worker handles retries, response-loss recovery,
and reconciliation. These operation types are implementation details and are
not methods on the public EntityManager.

### Spreadsheet-scoped batch merging

Outbound effects for one spreadsheet are grouped to the spreadsheet scope and
materialized in as few Google Sheets API round trips as possible. The provider
reads every affected tab with one sheet enumeration plus one ranged read, then
sends one `batchUpdate` whose requests target the different tabs' sheet ids —
instead of one request cycle per tab. Each tab's effects are still planned and
compare-and-set guarded against that tab's own preflight context, and fast
append keeps a per-tab anchor for replay recognition. This keeps the remote
request count constant per spreadsheet (roughly one read pass plus one write)
regardless of how many tabs a dispatch touches, which matters under Google
Sheets quota and rate limits.

## Inbound User_Input flow

The internal service polls registered `User_Input` projections on a bounded
interval. By default each pass runs an adaptive values-only preflight: it
reads the cheap value surface, compares it with canonical SQLite state, and
only escalates a table to the metadata-preserving snapshot read when the
preflight cannot certify it as unchanged.

Accepted observation writes update canonical state and the application entity
in the same SQLite transaction. Conflicts, stale writes, duplicate keys, and
malformed cells remain visible in SQLite evidence tables.

### Polling cadence configuration

Two optional environment variables control the polling cadence of the sync
auto-start path (`createTypedSheetsWithSync()` and the same env keys read by
`hikoutei` sync startup). Both default to **60,000 ms** when absent or blank:

| Env var | Option field | Constant | Default |
| --- | --- | --- | --- |
| `HIKOUTEI_SYNC_POLLING_INTERVAL_MS` | `options.pollingIntervalMs` | `SYNC_POLLING_INTERVAL_MS` | 60,000 |
| `HIKOUTEI_SYNC_FULL_SCAN_INTERVAL_MS` | `options.pollingFullScanIntervalMs` | `SYNC_FULL_SCAN_INTERVAL_MS` | 60,000 |

`HIKOUTEI_SYNC_POLLING_INTERVAL_MS` sets how often registered `User_Input`
projections are polled (the adaptive pass described above);
`HIKOUTEI_SYNC_FULL_SCAN_INTERVAL_MS` sets the cadence of the metadata safety
full scan — the pass that escapes the values-only preflight and re-reads the
table's full metadata to correct structural drift. An explicit option field
overrides the matching env var; absent values fall back to the constants in
the cadence table above.

Both variables fail closed on malformed input: the value must be a plain
decimal integer (a positive safe integer, in milliseconds). Hex (`0x10`),
exponent (`1e3`), signed, fractional, and whitespace-padded forms are
rejected with the stable `sync_startup_failed` error code so a mistyped
override can never silently change the polling behavior.

(Note: `HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS` is a separate, internal
request-start pacing override for the direct provider's transport limiters.
It is deliberately not a cadence knob and is not part of the public API.)

When polling detects a `User_Input` value A against canonical value B, it
persists the active candidate, candidate-time full-row visible revision/hash,
and an `OPEN` conflict, then queues an `OPEN` `Sync_Conflicts` audit effect.
Detection creates no resolution command. Repeated polling and a process restart
alone leave the conflict open.

Only a later local commit that strictly increases the canonical revision of the
same conflicted field triggers implicit system-wins resolution. An unrelated
field change or a same-value write that does not advance that field revision is
not approval. The command is fenced by canonical revision, candidate hash, and
candidate epoch; its Sheet reconcile also compares the stored candidate-time
row visible revision/hash. A later human edit therefore fails the guard instead
of being overwritten. Legacy conflicts without that visible evidence remain
unresolved rather than using a guessed baseline.

In this policy scope, deleting an entity with an unresolved conflict fails
closed before the local entity, canonical state, or outbox changes commit.

## Failure model

An HTTP timeout, non-JSON response, 404, or lost connection does not prove
that a Sheet write failed. The worker persists `delivery_uncertain` with a
durable probe schedule and dispatch identity, then promotes the effect only
after receipt-backed visible evidence is read. An explicit structured remote
failure uses the terminal failure path. SQLite also records a per-spreadsheet
authority epoch/token; provider mutations carrying an older token are
rejected. The SQLite commit is the application success boundary; remote
delivery is at-least-once and asynchronous.

## Reconciliation and cleanup

The periodic reconciliation scanner runs on its own schedule, independently
of whether the effect worker is busy: corruption that keeps the outbox busy
(a terminal failed head) is exactly what reconciliation must repair. When a
target stream is wedged behind a terminal `failed` head (a non-recoverable
error such as `delivery_uncertain_timeout`), the scanner supersedes that head
with its correction inside the same fenced SQLite transaction, so the repair
becomes the claimable stream head. Recoverable failed heads stay on the
worker retry path and are never superseded. On registered `User_Input` tabs
the same pass cleans surplus rows (duplicates of a bound business key,
evidence-free empty-ID rows, and unambiguous orphan identities) through
full-row CAS `user_input_delete` effects; rows referenced by active
candidates or conflicts are never deleted, and ambiguous orphans stay for
human review.

See [Internal consistency model](/guide/internal-consistency) for the detailed
state machine and recovery rules.
