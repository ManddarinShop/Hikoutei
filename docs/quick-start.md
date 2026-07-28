# Hikoutei Quick Start

The project is called Hikoutei and is currently published on npm as
`typed-sheets`.

## Installation

```sh
npm install typed-sheets @mikro-orm/core @mikro-orm/sql
```

The MikroORM packages are optional peer dependencies of the root package. They
are required only when the MikroORM persistence adapter is used.

## Entity lifecycle

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

## Gateway setup

Deploy [`apps-script/gateway/Code.gs`](../apps-script/gateway/Code.gs) as a
Google Apps Script Web App. Initialize the local SQLite registry first, then
use `provisionRegisteredSyncSheets()` through the operation-backed gateway.

Keep the shared gateway secret on the server and out of browser code and Git.
