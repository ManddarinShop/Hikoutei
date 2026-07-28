# MikroORM SQLite Adapter and Entity Facade Spike

## Purpose

This spike tests the proposed Sheets-side persistence shape without making
MikroORM the typed-sheets public API:

```text
application server
├─ primary entities → application MikroORM → primary database (for example MySQL)
└─ Sheets entities  → typed-sheets EntityManager → MikroORM SQLite executor → SQLite → Google Sheets outbox
```

The two MikroORM instances are intentionally separate. A Sheets entity uses a
dedicated SQLite database and cannot accidentally write through the
application's MySQL entity manager. `TypedSheetsOrm` and
`TypedSheetsEntityManager` are ours; MikroORM is only the first replaceable
SQLite execution engine behind them.

## Public entity lifecycle

The application-facing lifecycle follows the familiar entity-manager shape,
without returning a raw MikroORM manager or requiring provider-specific schema
builders:

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "typed-sheets";

const Order = defineTypedSheetsEntity({
  name: "Order",
  tableName: "orders",
  properties: {
    id: { type: "string", primary: true },
    orderNumber: { type: "string" },
    status: { type: "string" },
  },
});

const typedSheetsOrm = await createTypedSheets({
  dbName: "./typed-sheets.sqlite",
  entities: [Order],
  sync: {
    writerId: "orders-service",
    entities: {
      Order: {
        systemState: {
          spreadsheetId: process.env.GOOGLE_SHEET_ID!,
          tabName: "System_State",
          registeredRange: "A:D",
        },
        userInput: {
          spreadsheetId: process.env.GOOGLE_SHEET_ID!,
          tabName: "User_Input",
          registeredRange: "A:C",
        },
        editableFields: ["id", "orderNumber", "status"],
        businessKey: "orderNumber",
      },
    },
  },
});

const em = typedSheetsOrm.em.fork();

const order = em.create(Order, { id: "o-1", status: "pending" });
em.persist(order);
await em.flush();

const loaded = await em.findOne(Order, { id: "o-1" });
if (loaded !== null) {
  loaded.status = "paid";
  await em.flush();
}
```

The initial facade exposes `fork`, `create`, `find`, `findOne`, `persist`,
`remove`, `flush`, `transactional`, and `clear`. Reads use the local SQLite
state only; they do not wait for a Google Sheets API call. The initial filter
contract is an equality filter with optional `limit` and `offset`, rather than
the entire MikroORM query language.

`flush()` collects create, update, and delete changes, then the built-in mapping
planner writes the entity row, canonical state, row binding, business-key
index, and ordered Sheets outbox effects in one SQLite transaction. It does
not synchronously call Google Sheets. If planning throws, all of those local
writes roll back together.

The public route configuration requires exactly one `System_State` route and
may additionally declare one `User_Input` route. `System_State` receives the
complete canonical view plus a system tombstone marker. A direct create or a
direct change to a user-owned field also emits a candidate-preserving
`User_Input` reconcile effect; it does not overwrite an unresolved Sheet
candidate. A direct remove also creates a guarded `user_input_delete` effect
when a `User_Input` route exists. Its payload contains the complete expected
input row, so the gateway deletes only an anchored row whose visible revision
and full row hash still match. The worker blocks that effect rather than
deleting when an unresolved candidate owns any user-owned field.

The production-shaped sync gateway source at
`apps-script/gateway/Code.gs` is the thin operation data plane. Deploy the
current source before connecting a service; older deployments may not
understand the current signed operation protocol.

The low-level `flushCoordinator` seam remains available for an adapter author
or an advanced custom planner, but ordinary entity configuration no longer
needs it.

`onRegisteredProjections` is optional. When supplied, it receives the exact
registry routes and generated headers after the local SQLite registration has
succeeded; the example uses it to provision the reviewed Apps Script
allowlist. Omitting it keeps remote spreadsheet provisioning separate from
process startup.

## Package boundary

The typed-sheets entity lifecycle contracts are available from
`typed-sheets/orm`. The MikroORM-specific initializer and SQLite adapter are
available only from `typed-sheets/mikro-orm`. The root `typed-sheets` import
does not load MikroORM.

MikroORM is an optional peer dependency. This keeps the core/storage contract
replaceable by another persistence integration later.

```ts
import {
  initializeMikroOrmSqliteAdapter,
  migrateMikroOrmSqliteStorageSchema,
} from "typed-sheets/mikro-orm";

const storage = await initializeMikroOrmSqliteAdapter({
  dbName: "./typed-sheets.sqlite",
  entities: [Order],
});

// Explicit on purpose: startup does not mutate a production schema unless the
// application opts in.
await migrateMikroOrmSqliteStorageSchema(storage);
```

`migrateMikroOrmSqliteStorageSchema()` first applies MikroORM's safe,
non-destructive entity-schema update, then applies typed-sheets' versioned sync
schema. The sync schema keeps its existing `PRAGMA user_version` migration
contract while both schemas share the same SQLite connection.

## Proven transaction boundary

`MikroOrmSqliteAdapter.transactional()` provides the active MikroORM entity
manager and an adapter-neutral SQL executor together:

```ts
import { persistObservedRowWithSql } from "typed-sheets";

await storage.transactional(async ({ entityManager, sql }) => {
  const order = entityManager.create(Order, { id: "o-1", status: "pending" });
  entityManager.persist(order);
  await entityManager.flush();

  // The observation receipt, event ledger, canonical state, and Sheets outbox
  // all use this same transaction-bound SQL executor. A later failure rolls
  // the Order row back too.
  await persistObservedRowWithSql(sql, fence, observedRow);
});
```

Focused tests prove these operations commit or roll back together:

- MikroORM entity row
- typed-sheets canonical state
- pending Google Sheets effect
- writer lease and fencing (stale writer rejection)
- registered Sheet projection/allowlist

## Current boundary

The durable SQLite paths now have adapter-backed counterparts:

- writer lease, registry, canonical commit, and effect-outbox operations;
- `persistObservedRowWithSql()` / `persistObservedRowWithAdapter()` for
  observation receipt, event ledger, canonical state, conflict, quarantine,
  and effects;
- `persistResolutionCommandWithSql()` /
  `persistResolutionCommandWithAdapter()` for trusted conflict commands;
- `runSyncEffectWorkerWithAdapter()` from `typed-sheets/mikro-orm` for Sheets
  effect claiming, application, and recovery.

The legacy synchronous `node:sqlite` APIs remain available for existing
runtimes. The `WithSql` variants require a caller-owned transaction, while the
`WithAdapter` variants open one through the adapter. This distinction makes it
explicit at the call site whether a user-entity mutation must share the same
commit boundary.

The public mapping layer now derives canonical commits and projection effects
from entity lifecycle changes. It also supplies
`persistMappedObservedRowWithMikroOrm()` for the reverse half of the durable
boundary: an already-normalized, already-evaluated accepted observation is
stored and applied to the mapped MikroORM entity in one SQLite transaction.
It uses native MikroORM writes internally so it does not trigger a second
outbound `flush()` loop.

The raw Sheet snapshot → normalized observation → pure evaluator bridge is
still explicit. In particular, physical row-anchor discovery and projection
row-location persistence must be supplied by the existing gateway/ingestion
flow before an observation reaches `persistMappedObservedRowWithMikroOrm()`.
This prevents the mapping layer from guessing row identity from a row number or
business key.

`em.remove()` creates a canonical tombstone, a `System_State` tombstone
projection, and a guarded physical `User_Input` deletion when that route is
configured. A gateway response loss is resolved only through the deletion
effect's own receipt; an absent row by itself is never treated as proof that a
manual or unrelated deletion was ours. If the gateway or local conflict ledger
detects an active candidate, the input row is retained and the deletion effect
is marked `blocked_candidate` for explicit conflict handling.

The mapping/planner depends only on the adapter-neutral storage and entity
engine contracts. A future SQLite execution engine can replace MikroORM
without changing the `typedSheetsOrm.em.fork()` workflow or mapping
declarations.

## Runtime requirement

The current adapter uses MikroORM 7's Node SQLite dialect, which requires Node
22.17 or later. Node's built-in SQLite API is still marked experimental; that
warning is expected in the focused adapter tests.
