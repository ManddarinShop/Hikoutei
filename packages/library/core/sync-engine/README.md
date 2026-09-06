# @hikoutei/sync-engine

## Purpose
Sync-ORM engine: outbound worker/supervisors, reconciliation/adoption, the
scalar flush unit-of-work, and the internal `Hikoutei` runtime core (contract,
close state machine, option validators).

## Boundary
Runtime core is adapter-free (provider arrives port-typed); mapped persistence
glue lives in `@hikoutei/storage`, imported one-directionally. Never imports
`composition`/`cli`; Sheet delivery and polling belong here, not on `Hikoutei`.

## Entry
`src/api/hikouteiCore.ts` (runtime core); `src/api/EntityManager.ts`, `src/sync/`.
