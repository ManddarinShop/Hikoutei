# typed-sheets

SQLite-authoritative typed entity storage with Google Sheets as a projection
for MVPs, internal tools, prototypes, and low-traffic administrative workflows.

`typed-sheets` exposes an entity-manager API shaped like MikroORM while keeping
the public contract independent from the underlying execution engine. The
current execution engine is MikroORM 7 over SQLite; it can be replaced behind
the typed-sheets adapter boundary later.

This project is not a general-purpose ORM, a MySQL/Postgres replacement, or a
general Google Sheets API wrapper.

## Architecture

```text
application server
  └─ TypedSheetsOrm.em
       └─ replaceable entity engine (currently MikroORM)
            └─ SQLite canonical state + durable outbox
                 └─ background effect worker
                      └─ signed Apps Script operation gateway
                           └─ Google Sheets projection
```

SQLite is the authoritative read and write store. Entity changes are flushed
to SQLite together with canonical state and outbox work. Google Sheets is
updated asynchronously, so a successful `flush()` does not mean that the
remote projection has already converged.

## Installation

```sh
npm install typed-sheets @mikro-orm/core @mikro-orm/sql
```

The MikroORM packages are optional peer dependencies of the root package and
are required only when the MikroORM adapter is used.

## Entity lifecycle

The public workflow is entity-oriented:

```ts
import { defineEntity, p } from "@mikro-orm/sql";
import {
  defineTypedSheetsEntityMapping,
} from "typed-sheets/orm";
import {
  initializeMappedTypedSheetsOrm,
} from "typed-sheets/mikro-orm";

const OrderSchema = defineEntity({
  name: "Order",
  tableName: "orders",
  properties: {
    id: p.string().primary(),
    status: p.string(),
  },
});

class Order extends OrderSchema.class {
  declare id: string;
  declare status: string;
}

OrderSchema.setClass(Order);

const orderMapping = defineTypedSheetsEntityMapping({
  entity: Order,
  logicalSheetId: "orders",
  primaryKey: "id",
  businessKey: "id",
  schemaVersion: 1,
  fields: [
    {
      property: "id",
      cellKind: "string",
      ownership: "user",
      required: true,
      unique: true,
    },
    {
      property: "status",
      cellKind: "string",
      ownership: "user",
      required: true,
    },
  ],
  projections: [
    {
      physicalSheetId: "orders-system",
      spreadsheetId: process.env.GOOGLE_SHEET_ID!,
      tabName: "Orders_System",
      registeredRange: "A:C",
      projection: "system_state",
    },
  ],
});

const typedSheetsOrm = await initializeMappedTypedSheetsOrm({
  dbName: "./typed-sheets.sqlite",
  entities: [Order],
  mappings: [orderMapping],
  writer: { writerId: "orders-service" },
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

The current manager supports `fork()`, `create()`, `find()`, `findOne()`,
`persist()`, `remove()`, `flush()`, `transactional()`, and `clear()`. Reads are
served from SQLite and do not wait for a Google Sheets request.

## Apps Script gateway

Deploy [`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs) as a Google
Apps Script Web App. The shipped source is intentionally a thin signed
operation dispatcher: it validates the envelope, opens the configured Sheet,
executes allowlisted operation data, and performs the Sheet I/O requested by
the Node-side client. Canonical state, outbox decisions, reconciliation, and
retry policy remain in the server library.

Provisioning is explicit. Use `provisionRegisteredSyncSheets()` with an
operation-backed gateway after the local SQLite registry has been initialized.
Do not put the shared gateway secret in browser code or commit it to Git.

## Consistency and failure model

- SQLite is the canonical store; Sheets is eventually consistent projection data.
- Entity flushes enqueue durable effects rather than waiting for remote writes.
- The worker uses leases and retry/recovery state in SQLite.
- The fast System_State append path uses one range write; reconciliation repairs
  drift after response loss or an incomplete remote write.
- User-owned Sheet changes are observed through the read-only ingestion path and
  then evaluated by the core conflict pipeline.
- A single SQLite writer process is supported. This is not a cross-server
  coordination system.
- Google Apps Script execution limits, Sheets quotas, network timeouts, and
  external response loss still apply.

## Package boundaries

- `typed-sheets`: core contracts, entity facade, storage, and runtime contracts.
- `typed-sheets/orm`: engine-neutral entity mapping and lifecycle facade.
- `typed-sheets/mikro-orm`: MikroORM-backed SQLite adapter and initializer.
- `apps-script/gateway/Code.gs`: deployable thin gateway source.

MikroORM is kept behind the adapter boundary so a different SQLite execution
engine can be introduced without changing the application-facing entity API.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run typecheck:test
npm run build
npm pack --dry-run
```

The normal test suite uses fake gateways and SQLite/MikroORM fixtures. Live
Google Sheets tests are intentionally not part of the default commands because
they require deployment credentials and consume external quota.

## Further reading

- [MikroORM adapter and entity facade](docs/mikro-orm-adapter-spike.md)
- [Apps Script gateway source](apps-script/gateway/Code.gs)
- [SQL layer plan](docs/sql-layer-plan.md)
- [Task queue write model](docs/task-queue-write-model.md)
- [Sync observability](docs/sync-observability.md)
