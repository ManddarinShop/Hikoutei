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
- Typed scalar entity fields with runtime validation at the local boundary.
- Internal projection mappings with runtime validation for Sheet data.
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

The root API does not expose MikroORM types. The current built-in provider uses
those optional peer dependencies internally; a future provider can replace it
without changing the entity lifecycle API.

## Quick start

Define a scalar entity and use the local SQLite authority through a
request-local manager. Sheet routes, gateway credentials, provisioning, and
polling belong to the internal service bootstrap rather than the application
API.

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

`createTypedSheets()` opens the local entity tables only. The internal sync
service separately registers mappings, provisions remote tabs, starts the
outbound worker, and polls User_Input. In service mode, `flush()` commits the
entity, canonical sync state, and durable Sheet outbox locally; remote delivery
remains asynchronous.

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

Google Sheets synchronization is a service-side concern. Applications do not
import a gateway client, pass Sheet routes to `createTypedSheets()`, call
`setupSheets()`, or choose an operation for each write.

1. Copy [`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs) into a
   spreadsheet-bound Apps Script project, deploy it as a Web App, set the
   `/exec` URL, and run `setupSyncGateway()`.
2. Keep `TYPED_SHEETS_GATEWAY_URL`,
   `TYPED_SHEETS_GATEWAY_SHARED_SECRET`, and
   `TYPED_SHEETS_GATEWAY_SHEET_ID` in an untracked server environment or secret
   store. Never put the shared secret in browser code or Git.
3. Start the internal sync bootstrap. It validates the private route/ownership
   configuration, provisions and verifies headers, then starts outbox delivery
   and User_Input polling.

The gateway must be deployed with an access audience that can reach the
service; an external server normally requires **Anyone**. Use the deployed
`/exec` URL, not the editor-only `/dev` URL. When `Code.gs` changes, update the
existing Web App deployment with a new version. Live Google calls are opt-in;
fake gateways and SQLite fixtures are the normal verification path.
The detailed setup and troubleshooting steps are in the [Quick start](docs/quick-start.md).

## Documentation

- [Quick start](docs/quick-start.md) — installation, ORM lifecycle, and service-side sync setup.
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
