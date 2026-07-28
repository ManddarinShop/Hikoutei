# Hikoutei Architecture

Hikoutei separates the local canonical data model from the Google Sheets
projection. The application server owns the entity lifecycle and SQLite state;
Google Sheets is updated asynchronously through a thin Apps Script gateway.

## System shape

```text
Application server
  └─ Hikoutei EntityManager
       └─ replaceable persistence adapter (currently MikroORM)
            └─ SQLite canonical state + durable outbox
                 └─ background effect worker
                      └─ signed Apps Script operation gateway
                           └─ Google Sheets projection
```

## Responsibilities

### Application server

The server exposes the application-facing entity API and decides when an
entity is created, mutated, or removed. It does not treat a successful remote
HTTP response as the source of truth.

### EntityManager and persistence adapter

The entity manager follows an entity lifecycle similar to MikroORM: load an
entity, mutate it, and flush the unit of work. The persistence adapter keeps the
public API independent from the current MikroORM implementation so another
SQLite engine can be introduced later.

### SQLite canonical state

SQLite is the authoritative read and write store. A local transaction persists
the entity state and the durable effect that must eventually be materialized in
Sheets.

### Durable outbox and effect worker

The outbox records remote work until it is applied or classified as failed. The
worker claims work with a lease, sends signed operation batches, recovers expired
leases, and applies retry policy without blocking the application request.

### Apps Script gateway

The gateway validates a signed operation envelope and executes an allowlisted
Sheet operation. It is intentionally not the owner of entity evaluation,
canonical state, retry policy, or reconciliation decisions.

### Google Sheets projection

Sheets is the human-readable projection. It can lag behind SQLite, and external
limits such as Apps Script execution time, Google Sheets quotas, network timeout,
or response loss can affect convergence.

## Consistency boundary

A successful `flush()` means:

- the local entity state was accepted by SQLite
- the corresponding remote effect was durably queued

It does not mean that the Google Sheet has already converged. The worker and
reconciliation safety net complete the remote side asynchronously.

## Design boundary

Hikoutei is intended for a single SQLite writer process. It is not a distributed
transaction coordinator or a replacement for a high-throughput relational
database.
