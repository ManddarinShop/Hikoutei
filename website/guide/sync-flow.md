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
malformed cells remain visible in SQLite evidence tables. A conflict is not
left open indefinitely: the internal resolver submits a fenced
`acknowledge_system` command using the current canonical revision, active
candidate hash, and candidate epoch.

## Failure model

An HTTP timeout, non-JSON response, 404, or lost connection does not prove
that a Sheet write failed. The worker persists `delivery_uncertain` with a
durable probe schedule and dispatch identity, then promotes the effect only
after receipt-backed visible evidence is read. An explicit structured remote
failure uses the terminal failure path. SQLite also records a per-spreadsheet
authority epoch/token; provider mutations carrying an older token are
rejected. The SQLite commit is the application success boundary; remote
delivery is at-least-once and asynchronous.

See [Internal consistency model](/guide/internal-consistency) for the detailed
state machine and recovery rules.
