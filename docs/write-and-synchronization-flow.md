# Write and Synchronization Flow

Hikoutei commits local state first and materializes Google Sheets changes
asynchronously.

## Outbound flow: SQLite to Google Sheets

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction
  ├─ canonical entity state
  └─ durable outbox effect
          │
          ▼
background effect worker
  ├─ claim with a lease
  ├─ send a signed operation batch
  ├─ retry or recover an uncertain response
  └─ mark the effect applied/failed
          │
          ▼
Apps Script gateway ── fast range write ──▶ Google Sheets
```

The application request does not wait for the remote Sheet write. A successful
`flush()` means that SQLite accepted the entity change and the corresponding
effect was durably queued.

## Fast append

The common system-state append path favors one contiguous range write. It avoids
doing expensive metadata, snapshot, postcondition, and repair work before every
append. Those checks belong to a separate safety path so the common write can
remain small and predictable.

## Update and delete

Update and delete effects are still represented as durable outbox work and are
sent by the same worker. Their safety policy can be stricter than append because
overwriting or removing an existing row has a larger failure impact.

## Gateway boundary

The Apps Script gateway is intentionally thin:

1. verify the signed operation envelope
2. validate the operation contract
3. execute the allowlisted Sheet operation
4. return a structured result to the server worker

Entity evaluation, canonical state, retry policy, reconciliation, and effect
classification remain in the Node/SQLite side of Hikoutei.

## Uncertain remote results

An HTTP timeout or lost response does not prove that the Sheet write failed. The
worker treats that result as recoverable work, retries according to its policy,
and relies on idempotent effects and reconciliation to repair drift later.

The design therefore favors at-least-once delivery with a repair safety net over
trying to prove exactly-once behavior from a response that may never arrive.

## Inbound path: user edits

User-owned Sheet changes are a separate inbound concern. A future or configured
`onEdit`/lightweight polling path reads the user-editable values, compares them
with SQLite state, and sends the resulting observation into the evaluation and
conflict pipeline. This path is intentionally separate from the fast outbound
append path.
