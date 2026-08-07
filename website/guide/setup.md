---
title: Google Sheets setup
description: Env-driven sync auto-start and the service-account Google Sheets API provider — three steps to connect Hikoutei to a spreadsheet.
---

# Google Sheets setup

Google Sheets synchronization is a service-side concern. Applications do not
import a provider client, pass Sheet routes to `createTypedSheets()`, or choose
an operation for each write.

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

## Service-account provider (googleSheetsApi)

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
