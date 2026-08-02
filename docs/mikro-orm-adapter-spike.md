# MikroORM SQLite Adapter and Entity Facade Spike

This spike records the current provider boundary. MikroORM is the replaceable
SQLite execution engine behind Hikoutei's root EntityManager; it is not part of
the application-facing contract.

```text
application code
  └─ hikoutei root EntityManager
       └─ provider-neutral scalar persistence contract
            └─ MikroORM + SQLite
                 └─ [internal sync service]
                      └─ canonical state and Sheet effect outbox
```

## Root entity lifecycle

Applications use only the root package:

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const Order = defineTypedSheetsEntity({
  name: "Order",
  tableName: "orders",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./typed-sheets.sqlite",
  entities: [Order],
});

const em = hikoutei.em.fork();
const order = em.create(Order, { id: "o-1", status: "pending" });
em.persist(order);
await em.flush();
```

The facade exposes `fork`, `create`, `find`, `findOne`, `persist`, `remove`,
`flush`, and `transactional`. Reads use SQLite only. The root runtime creates
entity tables and does not require Sheet routes, gateway credentials, or sync
provisioning.

## Internal mapped service

The sync service uses the same adapter contracts but adds private mapping
configuration for routes and field ownership. Its bootstrap performs local
schema migration and projection registration, provisions the Apps Script
allowlist, and starts the effect/polling supervisors. Those modules are under
`src/application/sync/service/` and are not exported from `src/index.ts`.

In internal service mode, `flush()` plans and commits the entity row, canonical
state, row binding, business-key index, and ordered Sheet outbox effects in one
SQLite transaction. It still returns before the remote write completes.

The service uses the existing guarded operation model:

- `System_State` receives canonical materialization and tombstones.
- `User_Input` is updated only through guarded projection effects.
- response loss is recovered through durable receipts and postcondition reads.
- user edits are polled, evaluated with ownership and field-level CAS, and
  accepted changes are applied to SQLite without a duplicate User_Input loop.
- stale, conflicting, and invalid input remains in SQLite evidence tables.

The production-shaped gateway source is
`apps-script/gateway/Code.gs`. Its signed transport and operation types are
internal adapter details; application code does not construct them.

## Provider boundary

`ScalarEntityPersistenceProvider` is the engine-neutral contract used by the
public EntityManager. The current `MikroOrmScalarPersistenceProvider` maps it
to one MikroORM SQLite connection. The mapped sync runtime exposes the same
connection to storage SQL, entity writes, and outbox planning so a transaction
cannot commit an entity mutation without its local sync work.

A future provider can implement the scalar persistence contract without
changing entity lifecycle calls. A future worker process can reuse the internal
sync engine without changing the root API.

## Runtime requirement

The current adapter uses MikroORM 7's Node SQLite dialect, which requires Node
22.17 or later. Node's built-in SQLite API is still marked experimental; that
warning is expected in focused adapter tests.
