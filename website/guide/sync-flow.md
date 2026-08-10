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

## Inbound User_Input flow

The internal service polls registered `User_Input` projections on a bounded
interval. By default each pass runs an adaptive values-only preflight: it
reads the cheap value surface, compares it with canonical SQLite state, and
only escalates a table to the metadata-preserving snapshot read when the
preflight cannot certify it as unchanged.

Accepted observation writes update canonical state and the application entity
in the same SQLite transaction. Conflicts, stale writes, duplicate keys, and
malformed cells remain visible in SQLite evidence tables.

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
