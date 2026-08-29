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
an operation for each write — the root API accepts only `dbName` and
`entities`. The sync runtime uses one internal Google Sheets API provider with
a service account — no Apps Script deployment. Sync auto-start is selected by
`HIKOUTEI_SYNC_SPREADSHEET_URL` plus `GOOGLE_APPLICATION_CREDENTIALS`; there is
no public `googleSheetsApi` bootstrap option to configure.

**Fastest path:** install the gcloud CLI, then run `npx hikoutei setup` from your
project directory. On an interactive terminal it offers (press Enter) to
start `gcloud auth login --enable-gdrive-access --force` for you when the
active account is missing or lacks Drive access — you only complete the
browser approval yourself. (In `--yes`, CI, or non-TTY sessions, run that
login command yourself first.) Setup then creates the project, service
account, and key, creates a spreadsheet owned by your account, shares it
with the service account as an Editor, verifies service-account access, and
writes `GOOGLE_APPLICATION_CREDENTIALS` plus `HIKOUTEI_SYNC_SPREADSHEET_URL`
into your `.env`. The human access token is used in memory only and never
stored. Automatic setup runs on macOS and Linux; on Windows a non-dry-run
is refused before any mutation and manual setup is available. Interrupted runs resume from a local checkpoint
(`.hikoutei-setup-state.json`); a spreadsheet create whose outcome is
unknown is reconciled by its creation marker on the next run and setup
never creates a second spreadsheet (inspect Drive and rerun if setup
reports `sheet_create_uncertain`, and a create rejected up front with
HTTP 400/403 plus a confirmed-zero marker lookup rolls back to `key_ready`
so a corrected rerun starts a fresh marker). Sharing is write-ahead too:
`spreadsheet_share_started` is persisted before the idempotent SA writer
permission ensure and `spreadsheet_shared` after it, so a crash between
the remote permission mutation and the checkpoint write resumes the
ensure on the next run and never creates a second spreadsheet. The
service-account key is
created under a write-ahead contract too: the user-managed key list is
recorded as a baseline before the single gcloud key create, and
`key_create_started`/`key_ready` checkpoints let a crashed run recover a
staged or installed key instead of creating a second one. Only the
invocation that just persisted `key_create_started` may issue the one key
create; resumed runs are reconcile-only and, when no credential and no
post-baseline key are visible, poll the key list plus staged/final
evidence for up to two minutes (2, 4, 8, 16, 30, 30, 30 s) before failing
with `key_create_uncertain` — the create is never retried automatically.
An unmatched user-managed key with no local credential is never deleted
automatically — setup fails with `key_create_uncertain` and you inspect
the key list in the Google Cloud console before rerunning (a
verified-absent state requires removing the setup state file to reset the
key checkpoint); reused keys are enforced to owner-only mode 600. An exclusive lock directory
(`.hikoutei-setup-state.json.lock`) prevents concurrent runs and is never
removed automatically: a crash leaves an empty lock directory behind, and
removing it manually is required only when you are certain no setup is
running. Starting fresh requires removing or moving both the checkpoint and
the key file, or passing `--project` to recover an existing key —
checkpointed or identity-matched cloud resources are reused, and setup
never deletes cloud resources. The manual steps below remain available for
advanced setups.

**Setup progress.** `hikoutei setup` reports step-by-step progress to
**stderr** across the ten setup phases (cloud auth, Drive access, project,
APIs, service account, service-account key, spreadsheet, share,
service-account access, output): an **overall bar** advances only when a
phase actually completes — it is never an ETA and never guesses a
percentage — and a **detail line** shows the bounded propagation checks
(how many of the eight key/access checks have run) and the known 2, 4, 8,
16, 30, 30, 30 s waits, with a fixed `working…` label for unknown-duration
steps. On an interactive terminal the four-line block redraws in place;
in CI, non-TTY, or `NO_COLOR` sessions one static line is printed per
phase/retry event with no control sequences. Progress pauses and the
block is cleared during the interactive `gcloud auth login` handoff and
resumes with the retry. Progress never prints credentials, tokens, keys,
project ids, emails, paths, or raw command output, and it can never
change the setup result or exit code; `--dry-run` prints the command
plan only.

**Keep setup artifacts out of Git.** `hikoutei setup` writes its defaults
into the current directory: the service-account key
(`hikoutei-service-account.json`, owner-only mode 600 — a secret), the
resume checkpoint (`.hikoutei-setup-state.json` and its `.tmp`/unique-temp
and `.lock` siblings), private key staging/cleanup directories
(`.hikoutei-key-stage-*`, `.hikoutei-key-cleanup-*`), and
`.hikoutei-env-*` temporary env writes. The repository's `.gitignore`
already ignores these defaults, so a plain `git add .` does not pick them
up. A `.gitignore` is **not a security boundary**, though: it only keeps
untracked files out of `git add`, and it does not protect files that are
already tracked (remove a mistakenly tracked key from history and rotate
it — delete the user-managed key in the Cloud console and rerun setup).
When you use a custom `--output` or keep the key or checkpoint at custom
paths, add those exact paths to your application's ignore rules and never
commit them.

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

### Manual service-account setup

1. **Create a service account.** Enable the Google Sheets API in a Cloud
   project, create a service account with the
   `https://www.googleapis.com/auth/spreadsheets` scope, and share the target
   spreadsheet with its email as an **Editor**. The provider creates tabs,
   writes effect rows and receipt records, and manages row anchors, so Viewer
   access is not enough.
2. **Keep the key server-side.** Put the service-account key path in
   `GOOGLE_APPLICATION_CREDENTIALS` on the server and the spreadsheet ID in an
   untracked secret store. Never put the key in browser code or Git: add the
   key path (and any custom `.env`/checkpoint paths) to the application's
   `.gitignore` — the defaults created by `hikoutei setup` are already
   ignored, but a `.gitignore` is not a security boundary and does not
   protect already-tracked files.
3. **Run the application normally.** Start the app with
   `GOOGLE_APPLICATION_CREDENTIALS` and `HIKOUTEI_SYNC_SPREADSHEET_URL` set;
   `createTypedSheets()` detects them and starts the internal sync bootstrap —
   it creates and verifies headers on the registered tabs, then starts outbox
   delivery and User_Input polling. There is no provider option to pass and no
   internal bootstrap to start by hand.

> **Legacy spreadsheet note.** Spreadsheets provisioned by the old Apps Script
> provider with developer-metadata row anchors are not migrated: `User_Input`
> tabs now require the `__hikoutei_row_id` system column, so legacy tabs must
> be re-provisioned.

Hikoutei uses a durable local outbox, idempotent delivery, and conflict-aware
updates so temporary API failures do not lose committed application writes. The
provider never logs credentials, spreadsheet IDs, URLs, or payloads, and it
spaces request starts to stay inside Google's quota windows. See the
[internal consistency model](website/guide/internal-consistency.md) for the
detailed state machine and recovery rules.

Live Google calls are opt-in; fake providers and SQLite fixtures are the normal
verification path. The detailed setup and troubleshooting steps are in the
[Quick start](website/guide/quick-start.md).

## Installation

The project and npm package are both called `hikoutei`. The built-in SQLite
provider currently requires MikroORM:

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

MikroORM is an implementation detail and does not appear in Hikoutei's public
entity API.

## Documentation

- [Quick start](website/guide/quick-start.md) — installation, ORM lifecycle,
  and service-side sync setup.
- [Architecture](website/guide/architecture.md) — how the local store and
  Sheet views fit together.
- [Write and synchronization flow](website/guide/sync-flow.md) —
  asynchronous delivery and recovery behavior.
- [Internal consistency model](website/guide/internal-consistency.md) —
  durable outbox, idempotent delivery, and conflict-aware updates.
- [Contributing](website/guide/contributing.md) — local development and test
  commands.
- [Soak testing](website/guide/soak-testing.md) — the long-duration soak
  runner: source build, six scalar tables, 6h preflight and 24h direct-live
  runs, log envs, redaction contract, resume/cleanup, and acceptance
  criteria.
- [Benchmark notes](website/guide/benchmarks.md) — dated measurements and
  their limitations.

## Limitations

- Google Sheets has quota, latency, and API rate limits. The outbound sync
  worker batches effects to the spreadsheet scope, so remote request volume
  does not grow with the number of tabs a dispatch touches.
- Sheet updates are asynchronous; the application should read its local state.
- SQLite is local to the service and is not a distributed coordination layer.
- Schema changes, manual edits, and conflicting updates still need an
  operational policy from the application.
- The EntityManager is an ORM-style facade over scalar entities, not a full
  ORM: entity definitions are scalar-only (`string`, `number`, `boolean`,
  `date`), and v1 permits uniqueness only on the primary/business key.
- Relations, joins, `populate()`, migrations, cascades, bulk/ORM query
  builders, and raw SQL are unsupported in this milestone. Sheets is an async
  projection and human input surface, never a live query database.

## Local queries

Reads use Hikoutei-owned typed operators and always execute against SQLite:

```ts
const [users, total] = await em.findAndCount(
  User,
  {
    name: { like: "Ada%" },
    age: { gte: 18, lt: 65 },
    active: { in: [true] },
  },
  {
    orderBy: { age: "desc", name: "asc" },
    limit: 20,
    offset: 0,
  },
);
```

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, and `nin` are available where
valid for the declared scalar type; `like` is string-only. Equality shorthand
such as `{ active: true }` remains supported. `count()` returns the unpaged
filter total, and `findAndCount()` returns the filtered page plus a total
that ignores `limit`/`offset` — both read from one SQLite snapshot. When an
explicit `orderBy` omits the primary key, Hikoutei appends it in ascending
order as the final tie-breaker; when the primary key is explicitly ordered,
its supplied position and direction are preserved. Pagination without
`orderBy` uses primary-key ascending order.

An `offset` alone (no `limit`) is a valid offset-only read, and an explicit
`limit: 0` returns an empty page rather than being treated as "no limit".
`findOne()` returns one entity or `null` and accepts ordering but no paging
options. Malformed filters, operators, ordering, and paging options fail with
a stable `HikouteiError`; branch on `error.code` through the exported
`HIKOUTEI_ERROR_CODES` constants (`HIKOUTEI_ERROR_CODES.INVALID_QUERY` and
`HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE`, which resolve to the lowercase
runtime codes `invalid_query` and `invalid_scalar_value`) instead of guessing
strings or parsing messages.

## Project status

Hikoutei is in active development. The current EntityManager supports scalar
entity lifecycle operations, typed local filters and ordering, `limit` /
`offset` pagination, `count()`, snapshot-consistent `findAndCount()`, and
callback-style `transactional()` work. Normal reads always come from SQLite,
never Google Sheets. Sheet edit ingestion and conflict presentation are still
evolving. Review release notes before upgrading minor versions.

## Roadmap

The first EntityManager milestone, rich local reads, is complete. Remaining
milestones follow the implementation order below; no milestone is tied to a
date or release number.

1. **Lifecycle-safe writes**
   - Add `upsert` and direct/bulk mutation capabilities only through a
     Hikoutei-owned contract that preserves one SQLite transaction across the
     entity table, canonical state, and durable Sheet effect outbox.
   - Do not promise raw `nativeInsert`, `nativeUpdate`, `nativeDelete`, or SQL
     pass-through APIs that could bypass that atomic lifecycle.
2. **Relationships and loading**
   - Add many-to-one, one-to-many, and `populate()` capabilities.
   - Design SQLite relationship mapping, Sheets projection representation,
     schema behavior, and conflict semantics together before public release.
3. **Schema operations**
   - Add migration and schema drift management.
   - Integrate validation and operational workflows with the existing setup
     tooling.

### Synchronization and operations

The following work continues in parallel with the EntityManager milestones:

- Complete ingestion of intentional user edits from Google Sheets.
- Improve update/delete conflict handling and presentation.

See the [open issues](https://github.com/ManddarinShop/Hikoutei/issues)
for current work.

## License

Hikoutei is released under the [MIT License](LICENSE).
