# @hikoutei/contracts

## Purpose
Pure contract layer: domain model, state/identity/encoding primitives, SQL
storage interfaces, and the Sheets sync protocol boundary (wire shapes, option
shapes, transport boundary, redacted telemetry events).

## Boundary
Must not import external SDKs (deps are `ikisaki`/`kohkai`/`zod` only — no
Google/MikroORM packages). Mirror direction is contracts → adapter, never the
reverse (`src/sheets/googleSheetsApi.ts` header).

## Entry
`src/sheets/googleSheetsApi.ts` (provider wire contract); `src/storage/`,
`src/state/`, `src/shared/observability/`.
