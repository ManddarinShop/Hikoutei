# Hikoutei Quick Start

The application-facing API owns entity definitions and the entity lifecycle.
The current SQLite provider is an implementation detail behind that API.

The current runtime supports the local entity lifecycle, SQLite-backed outbox
planning, outbound worker delivery, gateway provisioning, and the first
provider-side User_Input polling path. Global Conflict resolution is not yet
complete end to end.

## Installation

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

## Define entities

Use an explicit, immutable string primary key. The first public relation
surface supports `manyToOne` and `oneToMany`; relation loading is explicit and
does not imply lazy loading or cascade behavior.

```ts
import { defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});
```

Do not import `defineEntity`, `p`, or a provider-specific EntityManager in
application code.

## Local SQLite lifecycle

```ts
import { createTypedSheets } from "hikoutei";

const typedSheets = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = typedSheets.em.fork();
await em.transactional(async (tx) => {
  const user = tx.create(User, { id: "u1", name: "Ada" });
  tx.persist(user);
});

const user = await em.findOne(User, { id: "u1" });
if (user !== null) {
  user.name = "Ada Lovelace";
  await em.flush();
}
```

Application reads come from SQLite. `flush()` commits the entity row and, when
sync routes are configured, the local sync metadata and Sheet outbox in the
same SQLite transaction. It does not call Google Sheets synchronously.

## Separate Sheet routes

Physical Sheet names are not part of the entity definition. Add them at
runtime construction time:

```ts
const typedSheets = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
  sync: {
    writerId: "users-service",
    entities: {
      User: {
        systemState: {
          spreadsheetId: process.env.GOOGLE_SHEET_ID!,
          tabName: "Users_System",
          registeredRange: "A:C",
        },
        userInput: {
          spreadsheetId: process.env.GOOGLE_SHEET_ID!,
          tabName: "Users_Input",
          registeredRange: "A:B",
        },
        editableFields: ["id", "name"],
      },
    },
  },
});
```

The route registration is stored in SQLite. If an
`onRegisteredProjections` callback is supplied, it receives the exact local
registration definitions for Apps Script provisioning. Provisioning is still
an explicit remote operation.

## Worker boundary and inbound flow

Run the outbound sync worker in a separate process. Its current responsibility
is to drain the SQLite outbox, claim leases, deliver signed gateway operations,
and recover uncertain remote writes. The provider-side polling pass can also
read `User_Input`, evaluate observations against SQLite state, apply accepted
edits in the same SQLite transaction as their observation ledger, and enqueue
the next `System_State` projection. A long-running polling supervisor and the
global Conflict checkbox projection are still separate follow-up work.
The application server should not read Google Sheets as its source of truth.

## Gateway setup

Deploy [`apps-script/gateway/Code.gs`](../apps-script/gateway/Code.gs) as a
Google Apps Script Web App. Keep the gateway secret on the server and out of
browser code and Git.
