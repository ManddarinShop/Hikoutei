# Write and Synchronization Flow

Hikoutei commits local state first and materializes Google Sheets changes
asynchronously. The root ORM API is SQLite-only; the internal sync service owns
all Sheet communication.

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
route, gateway client, or provisioner. Reads always come from SQLite.

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
  ├─ retry or recover an uncertain response
  └─ mark the effect applied/failed
          │
          ▼
Apps Script gateway ──▶ Google Sheets
```

A successful `flush()` means that SQLite accepted the local change and queued
its projection effect. It does not mean that the remote Sheet write has
completed.

## Fast append, update, and delete

New System_State rows use the bounded fast append operation where possible.
Updates and deletes use guarded effects with expected visible revision/hash
evidence. The same internal worker handles retries, response-loss recovery, and
reconciliation. These operation types are implementation details and are not
methods on the public EntityManager.

## Inbound User_Input flow

The internal service polls registered `User_Input` projections on a bounded
interval. It reads the visible row, compares it with canonical SQLite state,
and sends changed fields through the evaluator:

```text
User_Input polling
  ├─ normalize literal/blank cells
  ├─ resolve business-key row binding
  ├─ validate ownership and field revisions
  ├─ classify accepted, conflict, stale, or quarantine
  └─ persist accepted observation and entity mutation in SQLite
```

Accepted observation writes update canonical state and the application entity in
the same SQLite transaction. They do not enqueue a duplicate User_Input effect;
only the required system projection repair/materialization is considered.
Conflicts, stale writes, duplicate keys, and malformed cells remain visible in
SQLite evidence tables for later handling.

## Provisioning and gateway boundary

Projection provisioning is an internal service-start operation. The bootstrap
generates route registrations and headers from the internal mapping, verifies
remote schema drift, and starts workers only after provisioning succeeds. The
Apps Script gateway remains intentionally thin:

1. verify the signed operation envelope
2. validate the operation contract
3. execute the allowlisted Sheet operation
4. return a structured result to the internal worker

Applications do not import or call the gateway client, protocol, operation
builders, polling functions, or provisioning interfaces.

## Failure model

An HTTP timeout or lost response does not prove that a Sheet write failed. The
worker preserves durable work, classifies recoverable failures, and uses
idempotent effects plus reconciliation to repair drift later. The SQLite commit
is the application success boundary; remote delivery is at-least-once and
asynchronous.
