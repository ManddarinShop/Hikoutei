---
title: Public type reference
description: The 14 pinned type-only exports of the Hikoutei public contract, with one-line purposes.
---

# Public type reference

These are the type-only exports of the public API surface (`src/index.ts`).
They are pinned by a freeze snapshot (`test/type-surface-snapshot.test.ts`):
deleting or renaming any of them breaks the test build, which forces a
conscious review before the public contract changes. All value exports
(`defineTypedSheetsEntity`, `createTypedSheets`, `createTypedSheetsWithSync`,
`HIKOUTEI_SCALAR_TYPES`, `HIKOUTEI_ERROR_CODES`, `HikouteiError`) are pinned
separately by the root-surface tests.

## Entity descriptor types (`defineTypedSheetsEntity`)

| Type | Purpose |
| --- | --- |
| `HikouteiScalarType` | Closed set of scalar property types accepted by `defineTypedSheetsEntity` — `"string"` \| `"number"` \| `"boolean"` \| `"date"`. |
| `HikouteiPropertyOptions` | Per-property descriptor options: scalar `type`, plus `primary`, `nullable`, `required`, `unique`. |
| `HikouteiPropertyDescriptorMap` | Map of property name to scalar options declared by one entity descriptor. |
| `HikouteiEntityDescriptorInput` | User-facing entity descriptor accepted by `defineTypedSheetsEntity`: descriptor name, SQLite `tableName`, and property map. |
| `HikouteiScalarValueType` | TypeScript value type derived from one declared scalar `type` (`string`, `number`, `boolean`, or `Date`). |
| `HikouteiPropertyValueType` | TypeScript property type for one property descriptor, honoring `nullable` (adds `| null`). |
| `HikouteiEntityInstance` | Inferred mutable entity instance shape (property value types, nullability applied) derived from a property map. |
| `HikouteiSortDirection` | Sort direction accepted by query options — `"asc"` \| `"desc"` — the ascending/descending local SQLite order. |

## Sync auto-start and existing-sheet adoption types (`createTypedSheetsWithSync`)

| Type | Purpose |
| --- | --- |
| `CreateTypedSheetsWithSyncOptions` | Options for `createTypedSheetsWithSync()`: SQLite `dbName`, declared `entities`, optional `env` override, optional `adopt` spec. |
| `AdoptEntitySpec` | One entity's existing-sheet adoption request: the existing tab to adopt, the business-key header (`identityFrom`), optional provisioned tab names, and explicit header→property `columnMap` bindings. |
| `AdoptionRunReport` | Complete read-only adoption dry-run report; `ok` is true only when every entity is ready. `mode: "dry-run"` never mutates the spreadsheet. |
| `AdoptionColumnBinding` | One bound column in an adoption report: entity property (`field`) plus the 0-based column index, column letter, and sheet header it binds to. |
| `AdoptionProblem` | One problem surfaced by the adoption dry-run analysis: `severity` (`"error"`/`"warning"`), stable `code`, human-readable `message`, and optional structured detail. |
| `LocalSyncRuntimeResult` | Result variant `{ kind: "local" }`: the sync env is absent or blank, so only the local runtime handle (`hikoutei`) is returned. |
| `RunningSyncServiceResult` | Result variant `{ kind: "sync" }`: the sync service started and this variant carries its public runtime handle. |

The remaining members of the result family — `AdoptDryRunResult` (a dry-run
report was produced and nothing was mutated), `TypedSheetsWithSyncResult`
(the union of all three), and the rest of the public surface — are exported
from the same root barrel.