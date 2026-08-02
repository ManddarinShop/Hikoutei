# Hikoutei Architecture

Hikoutei owns a local SQLite entity store and exposes Google Sheets as an
asynchronous human-facing projection. SQLite is the authority; Sheets is an
internal service-side projection and human input surface.

> The root package API is ORM-only. Sheet synchronization is implemented inside
> `src`, but its bootstrap, gateway, worker, and storage contracts are not root
> exports.

## System shape

```text
Application code
  └─ hikoutei root API
       └─ EntityManager
            └─ SQLite entity tables
                 └─ [internal sync service in the same process]
                      ├─ canonical sync state
                      ├─ durable Sheet effect outbox
                      ├─ outbound effect worker
                      ├─ User_Input polling
                      └─ Apps Script gateway
                           └─ Google Sheets projections
```

The internal service reuses the same MikroORM SQLite adapter and transaction
boundary as the entity manager. A future deployment can extract the worker
process without changing the root entity lifecycle contract.

## Source boundaries

```text
src/domain/                         pure normalization/evaluation/conflict rules
src/application/orm/                public ORM facade and mapped flush planning
src/application/sync/               internal sync engine and service bootstrap
src/adapter/persistence/            SQLite/MikroORM implementation
src/adapter/sheets/                 Apps Script transport and operation adapter
src/infrastructure/storage/         canonical, observation, resolution, outbox state
src/api/                            root-facing entity and EntityManager facade
src/index.ts                        root public barrel only
apps-script/gateway/                deployable Apps Script code
```

`src` does not mean public. The only application-facing package entrypoint is
`src/index.ts`; package subpaths for providers, gateway operations, polling,
and sync state are not part of the contract.

## Root public API

Applications define scalar entities and open a local SQLite runtime:

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();
```

The public surface contains entity definition, runtime creation, and the
request-local `EntityManager` lifecycle: `fork()`, `create()`, `find()`,
`findOne()`, `persist()`, `remove()`, `flush()`, and `transactional()`.
MikroORM, raw SQL, gateway clients, Sheet routes, provisioning, polling, and
outbox controls are internal.

## SQLite authority

Business entity tables are the authoritative application data. Normal reads
always come from SQLite and never from a Sheet. The public local runtime opens
entity tables only and does not contact Google Sheets or create sync tables.

When the internal sync service is active, its mapped flush coordinator extends
the same SQLite transaction with:

```text
entity mutation
canonical sync state
projection registry/state
Sheet effect outbox
```

The service-side configuration supplies projection routes, spreadsheet identity,
and user-owned fields. Those values are not entity metadata or public ORM
options.

## Google Sheets projection

The internal service provisions and validates registered projection tabs before
starting delivery. It owns the signed Apps Script client, effect worker,
response-loss recovery, reconciliation, and User_Input polling.

The application does not call Sheet operations. A successful public `flush()`
means that the local SQLite transaction committed. It does not mean that a
remote Sheet write has completed.

`System_State` is materialized from canonical SQLite state. `User_Input` is
observed by the internal polling loop, evaluated with ownership and field-level
compare-and-set rules, and then committed back to SQLite. Stale, conflicting,
and malformed input is recorded in SQLite rather than silently overwriting the
entity table.

## Transaction and lifecycle boundary

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction (internal sync service mode)
  ├─ entity table
  ├─ canonical state and conflict evidence
  └─ durable Sheet effect outbox
          │
          ▼
internal outbound effect supervisor
  ├─ claim leases and send signed operations
  ├─ retry recoverable failures
  └─ reconcile remote drift
          │
          ▼
Apps Script gateway ──▶ Google Sheets

internal User_Input polling
  ├─ read registered projections
  ├─ evaluate ownership/revisions/CAS
  └─ persist accepted observations and entity mutations in SQLite
```

The service bootstrap starts provisioning, outbound delivery, and inbound polling
as one internal runtime. Shutdown stops polling first, waits for remote calls,
stops the outbound supervisor, and only then closes SQLite.

## Design limits

Hikoutei targets one local SQLite writer process and low-traffic MVP or internal
workflows. It is not a distributed transaction coordinator, a general-purpose
database, or a Google Sheets API replacement. Live Google integration remains
opt-in; normal tests use fake gateways and SQLite fixtures.
