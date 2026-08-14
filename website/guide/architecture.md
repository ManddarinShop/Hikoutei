---
title: Architecture
description: SQLite is the application authority; Google Sheets is an asynchronous human-facing projection. Entity lifecycle, sync service, and source boundaries.
---

# Architecture

Hikoutei owns a local SQLite entity store and exposes Google Sheets as an
asynchronous human-facing projection. SQLite is the authority; Sheets is an
internal service-side projection and human input surface.

## System shape

```text
Application code
  └─ hikoutei root API
       └─ EntityManager
            └─ SQLite entity tables
                 └─ [internal sync service in the same process]
                      ├─ canonical sync state
                      ├─ durable Sheet effect outbox
                      ├─ OutboundEffectWorker
                      ├─ ReconciliationWorker
                      ├─ InboundObservationWorker
                      └─ coordinated Sheets capabilities
                           └─ Google Sheets projections
```

The internal service reuses the same MikroORM SQLite adapter and transaction
boundary as the entity manager. Hikoutei's scalar Unit of Work owns lifecycle,
snapshots, identity maps, and the provider-neutral flush plan. The concrete
provider schedules that plan on a transaction-bound MikroORM manager, invokes
mapped canonical/outbox planning before entity SQL, and flushes both in one
SQLite transaction.

The sync runtime has three in-process worker boundaries. `OutboundEffectWorker`
claims and delivers durable outbox effects; `InboundObservationWorker` reads
and evaluates `User_Input`; and `ReconciliationWorker` checks projection drift
and enqueues repair effects. The SQLite outbox is the durable contract between
them: reconciliation never writes a Sheet directly. They share one coordinated
Sheets provider instance, exposed through capability-specific ports, so the
current process-local mutation and anchor lanes remain intact. The internal
runtime now routes those ports through a versioned in-process gateway client;
the gateway server owns the coordinator and its singleton lease, while workers
never receive the provider object directly. A future multi-process deployment
can reuse this request boundary, but still requires durable cross-process
Sheets coordination or a single externally hosted Sheets gateway.

## Root public API

The public surface contains entity definition, runtime creation, and the
request-local `EntityManager` lifecycle: `fork()`, `create()`, typed `find()` /
`findOne()`, `count()`, snapshot-consistent `findAndCount()`, `persist()`,
`remove()`, `flush()`, and `transactional()`. MikroORM query types, raw SQL,
provider clients, Sheet routes, provisioning, polling, and outbox controls are
internal.

## SQLite authority

Business entity tables are the authoritative application data. Normal reads
always come from SQLite and never from a Sheet. The public local runtime opens
entity tables only and does not contact Google Sheets or create sync tables.

When the internal sync service is active, the scalar persistence provider
extends the same SQLite transaction with:

```text
public EntityManager
  → scalar Unit of Work flush plan
  → scalar persistence provider transaction
       ├─ mapped canonical/outbox planner
       └─ MikroORM entity SQL
```

The mapped planner writes canonical sync state, projection registry/state, and
the durable Sheet effect outbox before the scheduled entity statements. Any
failure rolls the complete transaction back.

The service-side configuration supplies the required `System_State`,
`User_Input`, and `Sync_Conflicts` routes, spreadsheet identity, and
user-owned fields. Every internal sync runtime fails closed if any of the
three physical routes or its fixed headers are missing or drifted. The
SQLite registry persists each route's exact ordered projection headers and
ownership metadata as the worker manifest; a worker that reopens the database
without the host mapping must reject a missing or malformed manifest rather
than inventing defaults.

## Google Sheets projection

The internal service provisions and validates registered projection tabs
before starting delivery. It owns the Google Sheets API client, effect worker,
response-loss recovery, reconciliation, and User_Input polling.

Reconciliation is a lazy repair net with its own schedule: it compares the
projected tabs against the SQLite authority and enqueues CAS-carrying
corrections (repairs for System_State drift, full-row deletion effects for
surplus User_Input rows). It also supersedes terminal failed stream heads that
would otherwise wedge later writes forever; recoverable failures stay on the
worker retry path.

A successful public `flush()` means that the local SQLite transaction
committed. It does not mean that a remote Sheet write has completed.

## Conflict safety

When polling detects a `User_Input` value A against canonical value B, the
service persists the active candidate and an `OPEN` conflict in SQLite and
queues an `OPEN` `Sync_Conflicts` projection. Detection creates no resolution
command; polling and process restarts alone never resolve the conflict.

Only a later local commit that strictly increases the canonical revision of the
same conflicted field is an implicit system-wins signal. Unrelated-field changes
and same-value writes that do not advance that field revision are not approval.
Candidate-time row visible revision/hash and candidate hash/epoch fence the
resolution, so a later human edit is not overwritten. A legacy conflict without
candidate visible evidence remains unresolved.

In this policy scope, deleting an entity with an unresolved conflict fails
closed before its entity row, canonical state, or outbox effects can commit.
All queued Sheet audit and repair effects remain asynchronous.

## Source boundaries

```text
src/domain/                         pure normalization/evaluation/conflict rules
src/shared/                         shared encoding, constants, and state contracts
src/application/orm/                internal entity mapping and mapped flush planning
src/application/sync/               internal sync use cases and concrete composition
  ├─ outbound/                       effect dispatch and reconciliation algorithms
  └─ service/                        worker lifecycle and composition boundaries
src/adapter/persistence/            persistence SPI and SQLite/MikroORM implementation
src/adapter/sheets/                 Google Sheets API provider
src/infrastructure/storage/         focused canonical/observation/resolution SQL modules
src/api/                            root-facing entity and EntityManager
src/index.ts                        root public barrel only
```

`src` does not mean public. The only application-facing package entrypoint is
`src/index.ts`; provider, sync operations, polling, and sync state are not
part of the contract. Internal code imports focused owner modules rather than
using domain or storage mega-barrels. The sync/provider end-to-end harness runs
against repository source through its checked-in TypeScript loader;
installed-package scenarios exercise only the supported root API.
