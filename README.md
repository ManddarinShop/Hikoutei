[한국어](README.ko.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Typed repository and safe write layer for Google Sheets-backed MVPs.**

<a href="https://www.npmjs.com/package/hikoutei">npm package</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">Issues</a> ·
<a href="apps-script/gateway/Code.gs">Apps Script gateway</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

Hikoutei helps TypeScript and Node.js applications use Google Sheets as a
human-friendly part of an MVP or internal workflow. Your application works
with typed entities and local SQLite; changes can be delivered to Google
Sheets asynchronously through the included Apps Script gateway.

Hikoutei is intentionally focused. It is not a general-purpose database
replacement, a Prisma/JPA clone, or a general Google Sheets API wrapper.

## Why Hikoutei?

- Entity-oriented lifecycle: create, find, mutate, persist, remove, and flush.
- Typed field mappings with runtime validation for Sheet data.
- Local SQLite reads for application workflows that should not wait on a remote
  spreadsheet request.
- Asynchronous Google Sheets views for human review and lightweight
  collaboration.
- Protection against common spreadsheet problems such as unexpected schema
  changes and accidentally overwriting newer changes.

## Installation

The project and npm package are both called `hikoutei`.

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

The MikroORM packages are optional peer dependencies of the root package, but
are required when using Hikoutei's built-in SQLite adapter.

## Quick start

After defining an entity mapping, use a request-local manager to work with
entities. A complete mapping and gateway setup are shown in the
[Quick start guide](docs/quick-start.md).

```ts
import { initializeMappedTypedSheetsOrm } from "hikoutei/mikro-orm";
import { User } from "./entities/User.js";
import { userMapping } from "./mappings/userMapping.js";

const hikoutei = await initializeMappedTypedSheetsOrm({
  dbName: "./hikoutei.sqlite",
  entities: [User],
  mappings: [userMapping],
  writer: { writerId: "users-service" },
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();
```

`flush()` updates the local application state and schedules the configured
Sheet view. Remote delivery is asynchronous, so start the sync worker
and provision the gateway as described in the [setup guide](docs/quick-start.md).

## When to use Hikoutei

Hikoutei is a good fit for:

- MVPs and prototypes where a spreadsheet is part of the product workflow.
- Internal tools and low-traffic administrative applications.
- Teams that want typed application data while keeping Sheets easy for people
  to inspect.
- Services that can use SQLite locally and accept asynchronous Sheet updates.

## When to choose something else

Use a conventional database and direct Google APIs when you need:

- Strong transactions across many rows or services.
- High write throughput or many concurrent writers.
- Complex queries, joins, or reporting workloads.
- Multi-server or multi-region coordination.
- Immediate read-after-write consistency in Google Sheets.
- Google Sheets to be the primary database for the application.

## Google Sheets setup

1. Define the entity-to-Sheet mapping in your server application.
2. Deploy [`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs) as a
   Google Apps Script Web App.
3. Provision the registered tabs and ranges from the server.
4. Run the sync worker that delivers pending changes.

Keep the gateway secret on the server. Do not put it in browser code or commit
it to Git.

## Documentation

- [Quick start](docs/quick-start.md) — installation, mapping, and gateway setup.
- [Architecture](docs/architecture.md) — how the local store and Sheet views
  fit together.
- [Write and synchronization flow](docs/write-and-synchronization-flow.md) —
  asynchronous delivery and recovery behavior.
- [Development](docs/development.md) — local development and test commands.
- [Benchmark notes](docs/sync-bulk-write-benchmark.md) — dated measurements
  and their limitations.

## Limitations

- Google Sheets has quota, latency, and Apps Script execution limits.
- Sheet updates are asynchronous; the application should read its local state.
- SQLite is local to the service and is not a distributed coordination layer.
- Schema changes, manual edits, and conflicting updates still need an
  operational policy from the application.

## Roadmap

- Complete ingestion of intentional user edits from Google Sheets.
- Improve update/delete conflict handling and presentation.
- Add setup tooling for registry and Apps Script deployment.
- Stabilize the public package release.

See the [open issues](https://github.com/ManddarinShop/Hikoutei/issues)
for current work.

## License

Hikoutei is released under the [MIT License](LICENSE).
