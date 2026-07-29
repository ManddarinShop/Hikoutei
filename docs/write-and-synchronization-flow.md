# Write and Synchronization Flow

Hikoutei commits local SQLite state first and materializes Google Sheets
changes asynchronously.

The outbound flow below describes the current runtime. The inbound User_Input
section describes the implemented provider-side polling pass; the Conflict
projection and resolution worker remain incomplete.

## Outbound application write

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction
  ├─ business entity table
  ├─ SQLite sync state and revision state
  └─ durable Sheet effect outbox
          │
          ▼
background worker
  ├─ claim with a lease
  ├─ send a signed operation batch
  ├─ retry or recover an uncertain response
  └─ mark the effect applied, blocked, or failed
          │
          ▼
Apps Script gateway ── range write ──▶ Google Sheets
```

The application request does not wait for the remote Sheet write. A successful
`flush()` means that SQLite accepted the entity change and the corresponding
effect was durably queued.

## Relations

The initial relation model supports `manyToOne` and `oneToMany`.

```text
Order.user  ── owns ──▶ orders.user_id
User.orders ── inverse collection
```

The Sheet projection contains the foreign-key value, not a nested entity.
Relation loading is explicit through `populate`; lazy loading and cascade
operations are not part of the initial contract.

## Inbound User_Input polling flow

The first inbound release observes User_Input by polling. The
application must not use the remote value directly:

```text
User_Input polling (visible id/business key, values-only)
  -> normalized observed row without remote metadata lookup
  -> business-key lookup in SQLite
  -> structural and ownership validation
  -> field-level revision evaluation
  ├─ accepted field
  │    -> SQLite entity update
  │    -> System_State outbox effect
  └─ stale field
       -> sync_conflict row
       -> Conflict projection work (not yet materialized end to end)
```

An accepted observation and its mapped entity mutation commit through the same
SQLite transaction. A conflict never changes the business entity until a user
explicitly resolves it. The current provider pass is one-shot; a durable
long-running polling supervisor is still pending.

The business-key column is an immutable row identity contract and should be
protected from manual edits in the Sheet. A missing, unknown, or duplicated key
is rejected. Physical row movement after a Sheet row deletion is safe as long as
the remaining business-key values remain unique.

## Distinguishing a failed outbound write from a remote edit

Each regular outbound effect carries three pieces of visible-state evidence:

```text
A = expected visible hash before the write (stored in SQLite outbox)
B = target visible hash after the write (computed from the effect fields)
C = visible hash observed during the read-back
```

The gateway classifies the comparison as follows:

- `C == B`: the Sheet reflects the requested write; the effect can be applied.
- `C == A`: the write was not observed; the effect is returned to pending for
  retry.
- `C != A` and `C != B`: the Sheet contains an unexpected remote state; the
  effect is not silently overwritten and is recorded as changed/repair-needed.
- no usable `C`: the gateway cannot decide, so the worker keeps the effect
  recoverable instead of declaring success.

This distinguishes “our write did not land” from “the visible state changed in
another way.” Polling alone cannot prove that the latter was specifically a
human edit; it can only classify it as an unexpected remote change. An optional
`onEdit` source or an external audit trail is required for stronger attribution.

## Planned Conflict resolution flow

The target Conflict projection exposes `use_system` and `use_user` controls.

```text
use_system
  -> keep current SQLite value
  -> resolve conflict
  -> remove Conflict row through outbox

use_user
  -> compare-and-set the candidate against SQLite
  -> write candidate into the entity table
  -> enqueue the next System_State projection
  -> resolve conflict
  -> remove Conflict row through outbox
```

Both controls checked is invalid. A stale revision, candidate hash, or epoch
resets the controls and leaves the conflict visible with the latest system
value.

## Fast append and reconciliation

The common System_State append path can use one contiguous range write. It does
not make the Sheet canonical and does not skip durable local state. A separate
reconciliation scan compares SQLite's desired projection with the Sheet and
enqueues normal correction effects when remote drift is found.

## Gateway boundary

The Apps Script gateway is intentionally thin:

1. verify the signed operation envelope
2. validate the operation contract
3. execute the allowlisted Sheet operation
4. return a structured result to the worker

Entity evaluation, canonical state, conflict resolution, retry policy, and
effect classification remain on the Node/SQLite side.

## Uncertain remote results

An HTTP timeout or lost response does not prove that a Sheet write failed. The
worker uses durable effect identity, receipts, postcondition reads, retries,
and reconciliation to converge without treating an uncertain response as a
new local business write.
