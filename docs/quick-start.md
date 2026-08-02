# Hikoutei Quick Start

Hikoutei is a typed repository and safe write layer for Google Sheets-backed MVPs.
SQLite is the application authority; Google Sheets is an asynchronous internal
projection and human input surface.

## Installation

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

The root API does not expose MikroORM, SQL, Apps Script, or sync-worker types.
The current built-in SQLite provider uses the optional MikroORM peer
dependencies internally.

## Define an entity

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
});
```

`createTypedSheets()` validates entity descriptors, opens the local SQLite
authority, and creates the declared entity tables. It does not contact Google
Sheets and accepts no Sheet route or gateway option.

## Entity lifecycle

Use a request-local manager. Reads come from SQLite, never from a remote Sheet.

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
}

await em.transactional(async (transactionalEm) => {
  const target = await transactionalEm.findOne(User, { id: "u1" });
  if (target !== null) transactionalEm.remove(target);
});
```

The stable lifecycle methods are `fork()`, `create()`, `find()`, `findOne()`,
`persist()`, `remove()`, `flush()`, and `transactional()`. Relations and
provider-specific query operators are not part of the scalar release.

## Internal Sheet synchronization

Applications do not call Sheet APIs or choose a write operation for each
entity change. A service-side internal sync bootstrap owns:

- projection routes and user-owned field configuration
- Apps Script URL, spreadsheet ID, and shared secret
- local projection registration and remote provisioning
- the outbound effect supervisor and durable outbox delivery
- User_Input polling, evaluation, conflict handling, and reconciliation

When that internal service mode is active, `flush()` commits the entity table,
canonical sync state, and durable Sheet effect outbox in one SQLite transaction.
The call still does not wait for the remote Sheet write.

The internal service provisions and validates the registered tabs before it
starts delivery. Schema drift or gateway setup failure stops service startup
rather than silently changing a remote Sheet. These service modules are under
`src/application/sync/service/` and are intentionally not re-exported from the
package root.

## Apps Script gateway

The deployable gateway is [`apps-script/gateway/Code.gs`](../apps-script/gateway/Code.gs).
A service deployment supplies its URL and shared secret through a secret store
or environment configuration. Never place the shared secret in browser code or
commit it to Git.

Live Google integration is opt-in and requires a deployed gateway, credentials,
a spreadsheet, and external quota. The normal test suite uses fake gateways and
SQLite fixtures without credentials.

## Read/write guarantees

- SQLite is the source of truth for application reads.
- `flush()` returns after the local SQLite transaction commits.
- Sheet delivery is asynchronous and at-least-once.
- Stale or conflicting User_Input edits are recorded in SQLite rather than
  silently overwriting canonical data.
- Gateway response loss is recoverable work, not proof of a failed remote write.
- Projection route/header drift fails explicitly.
