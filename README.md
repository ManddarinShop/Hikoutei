[한국어](README.ko.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Keep your app fast with SQLite. Keep your workflow visible in Google Sheets.**

A typed repository and safe write layer for Google Sheets-backed MVPs: your
application reads and writes local SQLite through typed entities, and committed
changes are asynchronously projected to Google Sheets for human review and
lightweight collaboration.

<a href="https://www.npmjs.com/package/hikoutei">npm</a> ·
<a href="docs/quick-start.md">Quick start</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">Issues</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

## What is Hikoutei?

Hikoutei gives TypeScript applications a typed entity API backed by local
SQLite, then asynchronously synchronizes committed changes to Google Sheets.

Your application does not wait on Google Sheets for normal reads and writes.
Sheets remains available for inspection, operations, and lightweight human
collaboration.

> Hikoutei is not a raw Sheets API wrapper, not a replacement for PostgreSQL,
> and it does not treat Google Sheets as the authoritative application
> database. SQLite is the source of truth; Sheets is the human-facing view.

## Quick start

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

**What happens to the Sheet?** The write commits to local SQLite immediately —
the application request never waits on Google. When the sync service is
enabled, Hikoutei later projects the entity to the registered Google Sheet in
the background. Human edits made in the sheet are observed, validated, and
either accepted back into SQLite or recorded as conflicts, never silently
overwritten.

## Why Hikoutei?

- Define typed entities instead of manually converting Sheet rows.
- Read and write through local SQLite without waiting for Google Sheets.
- Synchronize committed changes to Sheets in the background.
- Detect unexpected column changes and duplicate headers.
- Avoid overwriting newer Sheet edits during conflicting updates.

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

## Is Hikoutei the right abstraction for you?

Hikoutei does not replace `google-spreadsheet` or `@googleapis/sheets` — it
sits one level above them. If you only need raw spreadsheet access, use the API
client directly.

| Capability | Hikoutei | google-spreadsheet | @googleapis/sheets |
| --- | :-: | :-: | :-: |
| Typed entity model | ✅ | ❌ | ❌ |
| Fast local application reads | ✅ | ❌ | ❌ |
| Async projection to Sheets | ✅ | ❌ | ❌ |
| Durable write retry and deduplication | ✅ | ❌ | ❌ |
| Conflict-aware Sheet updates | ✅ | ❌ | ❌ |
| Direct row and cell manipulation | Limited | ✅ | ✅ |
| Full Google Sheets API access | Provider only | Partial | ✅ |

## Google Sheets setup

Google Sheets synchronization is a service-side concern. Applications do not
import a provider client, pass Sheet routes to `createTypedSheets()`, or choose
an operation for each write. The sync runtime uses one Google Sheets API
provider (the internal `googleSheetsApi` bootstrap option) with a service
account — no Apps Script deployment.

**Fastest path:** install the gcloud CLI, run `gcloud auth login`, then
`npx hikoutei setup` — it creates the project, service account, key, and a
spreadsheet owned by that service account, and writes
`GOOGLE_APPLICATION_CREDENTIALS` plus `HIKOUTEI_SYNC_SPREADSHEET_URL` into
your `.env`. The manual steps below remain available for advanced setups.

### Env-driven sync auto-start

Set the spreadsheet URL in the environment and `createTypedSheets()` starts
the Sheets sync internally — `flush()` then flows to Google Sheets through
the outbox worker with no per-call setup:

```sh
HIKOUTEI_SYNC_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/<ID>/edit
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

```ts
const hikoutei = await createTypedSheets({ dbName: "./hikoutei.sqlite", entities: [User] });
```

Without `HIKOUTEI_SYNC_SPREADSHEET_URL`, `createTypedSheets()` stays
local-only (SQLite). Startup failures are diagnosed with clear messages:
invalid URL, missing/invalid credentials file, or a service account not
shared on the spreadsheet (the error tells you which email to share).

### Service-account provider (googleSheetsApi)

1. **Create a service account.** Enable the Google Sheets API in a Cloud
   project, create a service account with the
   `https://www.googleapis.com/auth/spreadsheets` scope, and share the target
   spreadsheet with its email as an **Editor**. The provider creates tabs,
   writes effect rows and receipt records, and manages row anchors, so Viewer
   access is not enough.
2. **Keep the key server-side.** Put the service-account key path in
   `GOOGLE_APPLICATION_CREDENTIALS` on the server and the spreadsheet ID in an
   untracked secret store. Never put the key in browser code or Git.
3. **Start the internal sync bootstrap** with `googleSheetsApi` configured. It
   creates and verifies headers on the registered tabs, then starts outbox
   delivery and User_Input polling.

Hikoutei uses a durable local outbox, idempotent delivery, and conflict-aware
updates so temporary API failures do not lose committed application writes. The
provider never logs credentials, spreadsheet IDs, URLs, or payloads, and it
spaces request starts to stay inside Google's quota windows. See the
[internal consistency model](docs/internal-consistency-model.md) for the
detailed state machine and recovery rules.

Live Google calls are opt-in; fake providers and SQLite fixtures are the normal
verification path. The detailed setup and troubleshooting steps are in the
[Quick start](docs/quick-start.md).

## Installation

The project and npm package are both called `hikoutei`. The built-in SQLite
provider currently requires MikroORM:

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

MikroORM is an implementation detail and does not appear in Hikoutei's public
entity API.

## Documentation

- [Quick start](docs/quick-start.md) — installation, ORM lifecycle, and service-side sync setup.
- [Architecture](docs/architecture.md) — how the local store and Sheet views
  fit together.
- [Write and synchronization flow](docs/write-and-synchronization-flow.md) —
  asynchronous delivery and recovery behavior.
- [Internal consistency model](docs/internal-consistency-model.md) — durable
  outbox, idempotent delivery, and conflict-aware updates.
- [Development](docs/development.md) — local development and test commands.
- [Benchmark notes](docs/sync-bulk-write-benchmark.md) — dated measurements
  and their limitations.

## Limitations

- Google Sheets has quota, latency, and API rate limits.
- Sheet updates are asynchronous; the application should read its local state.
- SQLite is local to the service and is not a distributed coordination layer.
- Schema changes, manual edits, and conflicting updates still need an
  operational policy from the application.

## Project status

Hikoutei is in active development. The entity API is usable, while Sheet edit
ingestion and conflict presentation are still evolving. Review release notes
before upgrading minor versions.

## Roadmap

- Complete ingestion of intentional user edits from Google Sheets.
- Improve update/delete conflict handling and presentation.
- Add setup tooling for registry and direct provider deployment.

See the [open issues](https://github.com/ManddarinShop/Hikoutei/issues)
for current work.

## License

Hikoutei is released under the [MIT License](LICENSE).
