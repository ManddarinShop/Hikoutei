---
title: Quick start
description: Install Hikoutei, define a typed entity, and use the local SQLite authority through a request-local EntityManager.
---

# Quick start

## Installation

The project and npm package are both called `hikoutei`. The built-in SQLite
provider currently requires MikroORM:

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

MikroORM is an implementation detail and does not appear in Hikoutei's public
entity API.

## Define an entity and flush

Define a scalar entity and use the local SQLite authority through a
request-local manager.

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

user.name = "Ada Lovelace";
await em.flush();
```

`dbName` and `entities` are both optional: an omitted `dbName` falls back to
the `HIKOUTEI_DB_PATH` environment variable (then `./hikoutei.sqlite`), and
omitted `entities` use the tokens registered by `defineTypedSheetsEntity()`,
in registration order. The sync-only `HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS`
optionally tunes the provider's request-start spacing; it never affects
local-only mode.

## Query the local authority

Equality shorthand composes with Hikoutei-owned typed operators, ordering,
and pagination:

```ts
const [users, total] = await em.findAndCount(
  User,
  {
    name: { like: "Ada%" },
  },
  {
    orderBy: { name: "asc" },
    limit: 20,
    offset: 0,
  },
);
```

Supported operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`,
and string-only `like`, subject to the declared scalar type. `count()` returns
the unpaged total for a filter. `findAndCount()` reads its page and unpaged
total (which ignores `limit`/`offset`) from one SQLite snapshot. When an
explicit `orderBy` omits the primary key, Hikoutei appends it in ascending
order as the final tie-breaker; when the primary key is explicitly ordered,
its supplied position and direction are preserved. Pagination without
`orderBy` uses primary-key ascending order.

## Update, remove, and transactions

Updates flush like creates. Removals go through `remove()` plus `flush()`:

```ts
const loaded = await em.findOne(User, { id: "u1" });
if (loaded !== null) {
  em.remove(loaded);
  await em.flush();
}
```

Group a unit of work with `transactional()` — it commits atomically, and
throwing inside the callback rolls everything back:

```ts
await em.transactional(async (tx) => {
  tx.persist(tx.create(User, { id: "u2", name: "Bo" }));
  await tx.flush();
});
```

## What happens to the Sheet?

The write commits to local SQLite immediately — the application request never
waits on Google. When the sync service is enabled, Hikoutei later projects the
entity to the registered Google Sheet in the background. Human edits made in
the sheet are observed, validated, and either accepted back into SQLite or
recorded as conflicts, never silently overwritten.

The public API surface is:

```text
fork() · create() · find() · findOne() · count() · findAndCount() · persist() · remove() · flush() · transactional()
```

Sheet routes, provider credentials, provisioning, and polling belong to the
internal service bootstrap rather than the application API. See
[Google Sheets setup](/guide/setup) for the service-account provider.
