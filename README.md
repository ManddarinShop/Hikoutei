<div align="center">

# Hikoutei

**Typed repository and safe write layer for Google Sheets-backed MVPs.**

<a href="https://www.npmjs.com/package/typed-sheets">npm</a> ·
<a href="https://github.com/ManddarinShop/google-sheets-orm/issues">Issues</a> ·
<a href="apps-script/gateway/Code.gs">Apps Script gateway</a>

[![npm version](https://img.shields.io/npm/v/typed-sheets?style=flat-square)](https://www.npmjs.com/package/typed-sheets)
[![license](https://img.shields.io/npm/l/typed-sheets?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

> [!NOTE]
> **Hikoutei** is the project brand. The package is currently published as
> `typed-sheets` while the public package identity is still stabilizing.

Hikoutei gives TypeScript applications an entity-oriented repository API backed
by local SQLite, with Google Sheets used as an asynchronous, human-readable
projection. It is designed for MVPs, internal tools, prototypes, and low-traffic
administrative workflows where a spreadsheet is part of the product experience.

It is intentionally **not** a general-purpose database replacement, a Prisma or
JPA clone, or a general Google Sheets API wrapper.

## Table of contents

- [Why Hikoutei](#why-hikoutei)
- [When to use it](#when-to-use-it)
- [When not to use it](#when-not-to-use-it)
- [Architecture](#architecture)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Google Sheets gateway](#google-sheets-gateway)
- [Write and synchronization flow](#write-and-synchronization-flow)
- [Earlier path vs. current path](#earlier-path-vs-current-path)
- [Performance snapshot](#performance-snapshot)
- [Limitations](#limitations)
- [Roadmap](#roadmap)
- [Development](#development)
- [License](#license)

## Why Hikoutei

Google Sheets is easy for a team to inspect and edit, but it is a difficult
place to enforce repository guarantees. Hikoutei keeps the authoritative state
and write decisions in SQLite, then materializes safe, durable effects to a
Google Sheet.

The library focuses on the failure modes that matter in this setup:

- schema drift from manual header changes
- duplicate or missing key columns
- invalid row values
- stale writes and lost updates
- durable retry state for remote writes
- Apps Script and Google Sheets latency limits

## When to use it

Hikoutei is a good fit when:

- the application already runs on a TypeScript/Node.js server
- SQLite can be the local canonical store
- users need to inspect or occasionally edit data in Google Sheets
- eventual consistency is acceptable
- the workload is an MVP, internal tool, prototype, or low-traffic admin flow

## When not to use it

Choose a conventional database and direct Google APIs instead when you need:

- strong cross-row or cross-service transactions
- high write throughput or many concurrent writers
- complex SQL queries, joins, or reporting workloads
- multi-region or multi-server coordination
- immediate read-after-write consistency in Google Sheets
- Google Sheets to behave like the primary database

## Architecture

```text
Application server
  └─ Hikoutei EntityManager
       └─ replaceable persistence adapter (currently MikroORM)
            └─ SQLite canonical state + durable outbox
                 └─ background effect worker
                      └─ signed Apps Script operation gateway
                           └─ Google Sheets projection
```

SQLite is the canonical read and write store. A successful entity flush commits
local state and durable outbox work; it does not wait for Google Sheets to
converge. The worker drains the outbox independently and retries recoverable
remote failures.

## Installation

```sh
npm install typed-sheets @mikro-orm/core @mikro-orm/sql
```

The MikroORM packages are optional peer dependencies of the root package. They
are required only when the MikroORM persistence adapter is used.

## Quick start

The public API is entity-oriented: load an entity, mutate it, and flush the
unit of work.

```ts
import { defineEntity, p } from "@mikro-orm/sql";
import { defineTypedSheetsEntityMapping } from "typed-sheets/orm";
import { initializeMappedTypedSheetsOrm } from "typed-sheets/mikro-orm";

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
  dbName: "./hikoutei.sqlite",
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
`persist()`, `remove()`, `flush()`, `transactional()`, and `clear()`.
Reads are served from SQLite and do not wait for a Google Sheets request.

## Google Sheets gateway

Deploy [`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs) as a Google
Apps Script Web App. The shipped gateway is intentionally thin:

1. verify the signed operation envelope
2. validate the operation contract
3. execute the allowlisted Sheet operation
4. return a structured result to the server worker

Canonical state, outbox decisions, retry policy, reconciliation, and entity
evaluation remain in the Node/SQLite side of Hikoutei. Do not put the shared
gateway secret in browser code or commit it to Git.

Provisioning is explicit. Initialize the local SQLite registry first, then use
`provisionRegisteredSyncSheets()` through the operation-backed gateway.

## Write and synchronization flow

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction
  ├─ canonical entity state
  └─ durable outbox effect
          │
          ▼
background worker
  ├─ claim with a lease
  ├─ send a signed operation batch
  ├─ retry or recover an uncertain response
  └─ mark the effect applied/failed
          │
          ▼
Apps Script gateway ── fast range write ──▶ Google Sheets
```

The fast append path favors one contiguous range write and defers expensive
repair work to reconciliation. This makes the common SQLite-to-Sheets path
cheap while keeping a separate safety net for drift and response loss.

## Earlier path vs. current path

The current design is a path-level evolution rather than a promise that every
old beta release is directly comparable. The important changes are:

| Area | Earlier synchronization path | Hikoutei current path |
| --- | --- | --- |
| Authority | Mixed Sheet metadata and remote checks | SQLite is the canonical source |
| Write path | Per-effect metadata, snapshot, CAS, receipt, and postcondition work | Durable SQLite outbox plus batched fast append |
| Gateway | More synchronization decisions executed in Apps Script | Thin signed operation dispatcher |
| Repair | Repair work competed with initial writes | Reconciliation is a separate safety net |
| Polling | Full snapshot and metadata-oriented scan | One batched values-only read followed by local comparison |
| Public API | Low-level insert/update/delete concepts | Entity lifecycle: `persist`, mutate, `flush`, `remove` |

The current design deliberately accepts at-least-once remote delivery and uses
idempotent effects plus reconciliation instead of trying to prove a remote
write exactly once from a possibly lost HTTP response.

## Performance snapshot

These are measured repository benchmarks, not universal Google Sheets
guarantees. They separate raw Gateway throughput from the complete operational
worker path.

### Lightweight polling improvement

The same 66-row operational shape was measured with the earlier full-snapshot
poll and the current values-only poll:

| Path | Elapsed | Remote read | Result |
| --- | ---: | ---: | --- |
| Earlier full snapshot poll | 27,652 ms | — | baseline |
| Current first lightweight poll | 2,109 ms | 573 ms | about 13x faster |
| Current steady-state poll | 2,240 ms | 530 ms | about 12x faster |

The current poll performs one signed request containing three batched
`getValues()` operations and compares values locally. It does not yet evaluate
user edits into canonical writes.

### Fast append ceiling

With a clean Sheet and reconciliation disabled, the real library interface sent
370 synthetic six-column rows through the local server and deployed Gateway in
one request:

| Rows | Elapsed | Rows/s | Cells/s | Result |
| ---: | ---: | ---: | ---: | --- |
| 20 | 2,275 ms | 8.79 | 52.75 | applied |
| 100 | 2,729 ms | 36.64 | 219.86 | applied |
| 370 | 3,792 ms | 97.57 | 585.44 | applied |

All 490 rows across the measured stages were acknowledged successfully. This
is a raw fast-append measurement; it excludes SQLite outbox draining,
reconciliation, postcondition checks, and delete handling.

### End-to-end operational path

For the real `User`/`Order`/`OrderItem` server flow, 370 new Orders and 740
OrderItems produced 1,110 materialized rows in 36,865 ms, with zero failed
effects. The dominant cost was HTTP/Apps Script dispatch and range lookup, not
local ORM flush or raw `setValues()` execution.

See the full dated measurements in
[`docs/sync-bulk-write-benchmark.md`](docs/sync-bulk-write-benchmark.md).

## Limitations

- Google Sheets remains eventually consistent and subject to quota and latency
  limits.
- SQLite is the canonical store; this is not a multi-server coordination layer.
- `_version` and effect state provide stale-write protection, not distributed
  transactions.
- User edits, update/delete conflict handling, and reconciliation require
  separate operational policies.
- Apps Script Web App execution limits and response loss are external failure
  modes that the worker must recover from.
- The package should not be used for high-throughput transactional workloads.

## Roadmap

- stabilize the `Hikoutei` public brand while maintaining the `typed-sheets`
  beta package compatibility path
- finish the user-edit ingestion contract through `onEdit` and lightweight
  polling
- harden update/delete effects and conflict presentation
- add a setup-oriented CLI for registry and Apps Script deployment
- publish a stable package once the operational sync contract is proven

For implementation notes and current issues, see the
[open issues](https://github.com/ManddarinShop/google-sheets-orm/issues).

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
Google Sheets tests are opt-in because they require deployment credentials and
consume external quota.

## Further reading

- [MikroORM adapter and entity facade](docs/mikro-orm-adapter-spike.md)
- [SQL layer plan](docs/sql-layer-plan.md)
- [Task queue write model](docs/task-queue-write-model.md)
- [Sync observability](docs/sync-observability.md)
- [Full benchmark history](docs/sync-bulk-write-benchmark.md)
- [Apps Script gateway source](apps-script/gateway/Code.gs)

## License

Hikoutei is released under the [MIT License](LICENSE).
