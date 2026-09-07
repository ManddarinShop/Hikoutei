# @hikoutei/sheets

## Purpose
Google Sheets sync adapter leaf: the `google-sheets-api` provider (outbound
effects, provisioning, table reads, row anchors, snapshots). Sheets is an async
projection and human input surface, never the source of truth.

## Boundary
Must not import `@hikoutei/sync-engine` (enforced by
`test/protocol-import-boundary.test.ts`). Never forwards SDK objects beyond the
transport module; telemetry carries only redacted counts/durations/codes.

## Entry
`src/sheets/providers/google-sheets-api/GoogleSheetsApiSyncProvider.ts`;
wire contract in `@hikoutei/contracts` (`src/sheets/googleSheetsApi.ts`).
