# Current State Review

Date: 2026-07-29
Branch: `refactor/mapped-user-input-polling-review`

This document records the state found while aligning the repository with the
agreed design. It separates implemented foundations from scaffolding that
should not be mistaken for a complete inbound synchronization feature.

## Agreed direction

- SQLite business entity tables are the application authority.
- Google Sheets is an asynchronous projection and human input surface.
- The public API belongs to typed-sheets; the current MikroORM + SQLite engine
  is replaceable behind that boundary.
- Entity definitions use explicit, immutable, non-empty string primary keys.
- The first relation surface is `manyToOne` and `oneToMany`.
- A separate worker owns outbound delivery and initial polling-based inbound
  observation.
- Conflict is one global projection with field-level rows and `use_system` /
  `use_user` controls.

## Changes made in this cleanup phase

The following stale planning files described a different source of truth or a
retired SQL/task-queue direction, so they were removed. Git history still
contains them if historical comparison is needed:

- `docs/typed-sheets-plan.md`
- `docs/typed-sheets-mvp-scope-2026-06-29.md`
- `docs/sql-layer-plan.md`
- `docs/task-queue-write-model.md`

The architecture, synchronization flow, code guidelines, README, and quick
start now describe the SQLite-authoritative direction. The first provider-side
User_Input polling path is implemented on this branch; Conflict projection and
checkbox resolution remain target-flow documentation.

The public foundation now includes:

- `defineTypedSheetsEntity()` with scalar fields and the two initial relation
  kinds;
- `createTypedSheets({ entities, dbName, sync? })`;
- separate physical Sheet route configuration under `sync`;
- explicit string primary-key validation;
- lazy loading of the current MikroORM provider from the root factory;
- public lifecycle tests covering local persistence, route-backed outbox
  planning, relations, and invalid primary keys.

The root package now exports only this application-facing entity API. Domain,
storage, gateway, and MikroORM adapter contracts are internal or provider
subpath concerns; contract tests import those modules directly so a test cannot
accidentally define an implementation detail as public API.

The obsolete MikroORM spike document was removed. Its public examples had
drifted toward provider-specific mapping and raw storage calls even though the
supported application workflow is `defineTypedSheetsEntity()` plus
`createTypedSheets()`.

## Implementation status

| Area | Current state | Cleanup decision |
| --- | --- | --- |
| Public entity definition | Implemented and materialized by the current provider | Keep provider conversion private |
| Entity flush transaction | Implemented for entity table, sync state, and outbox | Keep as the SQLite transaction boundary |
| Outbound worker | Implemented with lease, retry, recovery, and reconciliation primitives | Keep in the separate worker process |
| User_Input polling | Provider-side one-pass observation, evaluation, SQLite entity mutation, conflict ledgering, and idempotent receipts are implemented | Add the worker loop/public orchestration and keep the source limited to polling initially |
| Conflict projection | Schema, effect kinds, and storage primitives exist | Finish global registration, two-checkbox observation, and field-level projection |
| `use_system` | Domain/storage acknowledgement path exists | Preserve current SQLite value and delete the remote row through outbox |
| `use_user` | Not implemented end to end | Apply candidate to the entity table with revision/CAS in the same SQLite transaction |
| Persistence abstraction | Adapter-neutral contracts and async adapter-backed storage are the only runtime path | Keep provider-specific SQL behind the adapter boundary |
| Tests | Public boundary and provider/domain contract tests plus accepted/conflict polling scenarios are present | Add deletion/invalid-cell/lease and Conflict checkbox scenarios before deleting lower-level coverage |

## Legacy code that should not be deleted yet

The direct `@mikro-orm/sql` entity definitions in the existing test suite and
provider adapter tests are provider-level contract fixtures. They are not the
desired application API, but deleting them now would remove coverage for the
current materializer and transaction bridge before equivalent public scenario
tests exist.

The duplicate synchronous `node:sqlite` storage path was removed. Runtime
storage now enters through the adapter-backed SQL contract, while provider-level
MikroORM fixtures remain because they verify the current materializer boundary.

The unused restore/cutover path was removed as well. It had no callers or
tests, and its `cutover_state` table is no longer created for new databases;
existing tables are left untouched by this cleanup.

The unused read-only snapshot persistence path was removed for the same reason:
gateway observation is now recorded through the normal observation ledger, so
there is no second storage writer with a different contract.

## Next implementation order

1. Add a one-pass polling entrypoint to the long-running worker and expose the
   provider-neutral worker contract.
2. Add a single global Conflict registration and field-level projection schema
   with `use_system` and `use_user` checkbox validation.
3. Implement `use_user` resolution as one fenced SQLite transaction that
   updates the business entity, canonical revision, resolution command, and
   next System_State outbox effect.
4. Add scenario tests for accepted edits, stale edits, server-side rebase,
   both-checkbox invalid input, each resolution choice, and stale resolution.
5. Keep the low-level provider/domain contract tests while adding the inbound
   and conflict scenario tests; do not reintroduce a second storage path.
