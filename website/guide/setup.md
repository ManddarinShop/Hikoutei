---
title: Google Sheets setup
description: Env-driven sync auto-start and the service-account Google Sheets API provider — three steps to connect Hikoutei to a spreadsheet.
---

# Google Sheets setup

Google Sheets synchronization is a service-side concern. Applications do not
import a provider client, pass Sheet routes to `createTypedSheets()`, or choose
an operation for each write.

## Automatic setup with `hikoutei setup` (recommended)

The `hikoutei setup` CLI automates the Google Cloud service-account bootstrap:
it creates (or reuses) a Cloud project, enables the Sheets API, creates a
service account and key, creates a spreadsheet owned by that service account,
and writes a ready-to-use `.env` — no console clicking and no spreadsheet
sharing step.

**Prerequisites:** the `gcloud` CLI is installed and you have logged in once:

```sh
gcloud auth login
```

Then run the setup from your project directory:

```sh
npx hikoutei setup
```

What happens:

1. **Preflight** — verifies `gcloud` is installed and an active account is
   logged in.
2. **Project** — creates `hikoutei-<slug>` (idempotent: reused when it already
   exists), or use an existing project with `--project <id>`.
3. **API** — enables `sheets.googleapis.com` for the project.
4. **Service account** — creates `hikoutei-sa` (reused when it already exists)
   and a key file secured with `chmod 600`.
5. **Spreadsheet** — creates a spreadsheet titled `hikoutei-sync-<project>`
   using the new key, so the service account owns it and no sharing is needed.
6. **Output** — writes `GOOGLE_APPLICATION_CREDENTIALS` and
   `HIKOUTEI_SYNC_SPREADSHEET_URL` into `.env`, preserving any unrelated lines
   already in the file.

The command asks for a y/N confirmation before creating cloud resources; pass
`--yes` for non-interactive runs. Preview the exact command sequence without
executing anything with `--dry-run`. Key material is never printed.

Options:

```text
--project <id>              Use an existing Google Cloud project.
--sa-name <name>            Service-account name (default: hikoutei-sa).
--spreadsheet-title <title> Spreadsheet title (default: hikoutei-sync-<project>).
--output <path>             .env file to write or update (default: .env).
--yes                       Skip interactive confirmation.
--dry-run                   Print the command plan without executing.
```

When the setup finishes, the sync runtime picks the spreadsheet up from the
environment automatically (see below).

## Env-driven sync auto-start

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

## Manual / advanced setup

Skip the CLI and wire everything by hand when you need an existing project or
spreadsheet, or when you prefer to manage Google Cloud resources yourself.

### Service-account provider (googleSheetsApi)

The sync runtime uses one Google Sheets API provider (the internal
`googleSheetsApi` bootstrap option) with a service account — no Apps Script
deployment.

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
updates so temporary API failures do not lose committed application writes.
The provider never logs credentials, spreadsheet IDs, URLs, or payloads, and
it spaces request starts to stay inside Google's quota windows.

Live Google calls are opt-in; fake providers and SQLite fixtures are the
normal verification path. Detailed setup and troubleshooting steps live in the
repository's `docs/quick-start.md`.
