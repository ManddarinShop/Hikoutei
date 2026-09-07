# @hikoutei/storage

## Purpose
SQLite storage plumbing, the MikroORM-backed persistence adapter, and the
mapped flush/observation/projection/conflict persistence bridge. SQLite is the
authority: entity flush, canonical state, and the outbox share one transaction.

## Boundary
Imports `contracts`/`ikisaki` plus the Sheets conflict-projection tab schema —
never `sync-engine`/`composition`/`cli` or the Google SDK. `ikisaki` touches
stay on the narrow fencing/outbox-DDL port (`test/protocol-import-boundary.test.ts`).

## Entry
`src/persistence/providers/mikro-orm/` (engine, storage, API provider);
`src/storage/sqlite/`, `src/sync/`.
