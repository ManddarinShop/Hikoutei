# Hikoutei Quick Start

The project is called Hikoutei and is currently published on npm as
`hikoutei`.

## Installation

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

The root API does not expose MikroORM types. The current built-in SQLite
provider uses those optional peer dependencies internally; a future provider
can replace it without changing the entity lifecycle API.

## Define a scalar entity

Entity metadata and environment-specific Sheet routes are separate:

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    active: { type: "boolean" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    routes: {
      User: {
        systemState: { tabName: "Users_System", registeredRange: "A:Z" },
      },
    },
  },
});
```

`createTypedSheets()` validates the descriptors and routes, opens the local
SQLite authority, registers canonical/outbox state, and prepares the current
persistence provider. It does not call Google Sheets or mutate a remote tab.

## Entity lifecycle

Use a request-local manager. Reads come from SQLite, never from the remote Sheet.
The Unit of Work owns identity maps and snapshots, so mutation followed by
`flush()` has the same meaning regardless of the persistence provider.

```ts
const em = hikoutei.em.fork();

const user = em.create(User, {
  id: "u1",
  name: "Ada",
  active: true,
});
em.persist(user);
await em.flush();

const loaded = await em.findOne(User, { id: "u1" });
if (loaded !== null) {
  loaded.name = "Ada Lovelace";
  await em.flush();

  await em.transactional(async (transactionalEm) => {
    transactionalEm.remove(loaded);
  });
}
```

The stable lifecycle methods are `fork()`, `create()`, `find()`, `persist()`,
`remove()`, `flush()`, and `transactional()`. Relations and provider-specific
query operators are not part of the scalar release.

## Sheet setup and delivery

Provisioning is an explicit external operation. Supply a provider-neutral
`HikouteiSheetProvisioner` to `setupSheets()` from the service/deployment layer:

```ts
await hikoutei.setupSheets(provisioner);
```

The provisioner creates or verifies tabs and headers idempotently. Apps Script
signing, transport, operation definitions, and the outbound worker remain
internal implementation details.

A successful `flush()` commits the entity table, canonical sync state, and
durable Sheet effect outbox in one SQLite transaction. It does not mean the
remote Sheet has already been updated; a separate worker delivers the outbox.
Keep the gateway secret on the server and out of browser code and Git.
