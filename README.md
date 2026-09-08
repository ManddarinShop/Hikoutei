[한국어](README.ko.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Keep your app fast with SQLite. Keep your workflow visible in Google Sheets.**

A typed repository and safe write layer for Google Sheets-backed MVPs: your
application reads and writes local SQLite through typed entities, and committed
changes are asynchronously projected to Google Sheets for human review and
lightweight collaboration.

<a href="https://www.npmjs.com/package/hikoutei">npm</a> ·
<a href="website/guide/quick-start.md">Quick start</a> ·
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

## Why Hikoutei?

- Define typed entities instead of manually converting Sheet rows.
- Read and write through local SQLite without waiting for Google Sheets.
- Synchronize committed changes to Sheets in the background.
- Detect unexpected column changes and duplicate headers.
- Avoid overwriting newer Sheet edits during conflicting updates.

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

## Installation

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

Installing the library does not touch Google Cloud — it runs local-only
(SQLite) by default. Run the setup command below only when you want Sheet
sync.

## Setup (Google Sheets sync)

One-time, interactive. Install the gcloud CLI, then:

```sh
npx hikoutei setup
```

This creates the Cloud project, service account, key, and spreadsheet, and
writes `.env` for you. Without `HIKOUTEI_SYNC_SPREADSHEET_URL`,
`createTypedSheets()` stays local-only (SQLite). Details, credential pools,
quota guidance, and manual setup: [Google Sheets setup](website/guide/setup.md).

## Usage

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
    age: { type: "number" },
    active: { type: "boolean" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada", age: 36, active: true });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();

const loaded = await em.findOne(User, { id: "u1" });
if (loaded !== null) {
  em.remove(loaded);
  await em.flush();
}
```

More reads, transactions, and operators: [Quick start](website/guide/quick-start.md).

Writes commit to local SQLite immediately — the request never waits on Google.
Human edits in the Sheet flow back through polling — accepted into SQLite or
recorded as conflicts, never silently overwritten. The full pipeline (outbox,
delivery, conflict handling) is covered in
[Write and synchronization flow](website/guide/sync-flow.md).

## Learn more

- [Quick start](website/guide/quick-start.md) — installation, ORM lifecycle, sync setup.
- [Architecture](website/guide/architecture.md) — local store and Sheet views.
- [Write and synchronization flow](website/guide/sync-flow.md) — delivery and recovery.
- [Limitations](website/guide/limitations.md) — when to choose something else.
- [Project status and roadmap](website/guide/status.md) — what is done and next.

## License

Hikoutei is released under the [MIT License](LICENSE).
