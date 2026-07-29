# Code Guidelines

## Project Identity

This project is a TypeScript library that provides a typed entity and safe write layer for Google Sheets-backed MVP apps, internal tools, and low-traffic admin workflows. SQLite is the local authority; Google Sheets is an asynchronous human-facing projection.

The project is not a full database replacement, not a Prisma/JPA clone, and not a general-purpose Google Sheets API wrapper. Existing libraries such as `google-spreadsheet` and `@googleapis/sheets` already cover low-level Sheets access.

The core value is safety around the local-to-Sheets synchronization boundary:

- atomic SQLite entity and outbox commits
- stable entity and relation mappings
- stale user edits and field-level conflict resolution
- schema drift and invalid Sheet values
- durable retries and recovery after remote response loss
- API quota and Apps Script execution limits

## Positioning

Use this wording when describing the project:

> Typed repository and safe write layer for Google Sheets-backed MVPs.

Avoid these claims:

- Google Sheets replacement for MySQL/Postgres
- JPA for Google Sheets
- Prisma for Google Sheets
- transaction-safe database on top of Sheets

The honest boundary matters. Google Sheets has no native database transaction model, limited quota, weak query capabilities, and manual edit risk. The library should make those constraints explicit instead of hiding them.

## MVP Scope

The first implementation should stay small and prove the SQLite-authoritative synchronization model.

This section describes the target MVP contract. For what is implemented in the
current branch, see [`current-state-review.md`](current-state-review.md).
Inbound polling and conflict resolution may be specified here before their
end-to-end runtime path is complete.

Required MVP capabilities:

- public `defineTypedSheetsEntity()` definitions
- entity lifecycle operations through the typed-sheets EntityManager
- `manyToOne` and `oneToMany` relation metadata
- SQLite entity-table and sync-state initialization
- atomic entity, canonical sync state, and Sheet outbox commits
- explicit Sheet provisioning for new or existing spreadsheets
- separate worker processing for outbound effects
- initial polling-based User_Input observation
- field-level Conflict Sheet rows with `use_system` and `use_user` controls
- runtime validation at Sheet and gateway boundaries

MVP exclusions:

- `manyToMany` relations
- lazy loading and implicit remote reads
- cascade persist/remove
- SQL-like query language
- Google Sheets as the application source of truth
- automatic `onEdit` ingestion in the first polling release
- distributed or multi-process SQLite coordination
- generated primary keys in the first entity release
- dashboard UI and browser support matrix

## Architecture

Keep domain rules separate from application orchestration, infrastructure
storage, and Google API details.

Recommended package boundaries:

```txt
src/
  domain/                       # 정규화 값, 평가, 충돌, 상태 규칙
  shared/                       # 도메인 간 공유 상수·인코딩·상태 계약
  application/
    orm/                        # 공개 ORM facade, mapping, flush 계획
    sync/                       # worker, reconciliation, gateway orchestration
  adapter/
    persistence/
      contracts/                # 저장소 공통 계약
      providers/mikro-orm/      # 현재 MikroORM + SQLite 구현
    sheets/
      providers/apps-script-gateway/
        protocol/               # 서명·직렬화·응답 검증
        transport/              # HTTP operation client
        operations/
          write/                # fast append
          observation/           # visible ID 기반 snapshot 관측
          effect/               # update/delete effect
  infrastructure/
    storage/                    # SQLite canonical state와 outbox
  index.ts
```

`domain/`과 `shared/`는 외부 SDK를 몰라야 한다. `application/`은 use case와
동기화 흐름을 조율하고, `infrastructure/`는 SQLite 같은 외부 저장 기술을
담당한다. `adapter/`는 persistence와 Sheets provider를 각각 계약 뒤에
격리한다.

The domain should depend on adapter interfaces, not directly on Google Sheets
SDKs.

Tests should use fake gateways and in-memory SQLite/provider fixtures where
possible. Real Google integration tests should be opt-in because they require
credentials and consume quota.

## Code Modification Rules

Do not modify production source files under `src/**` unless the user explicitly asks for production implementation work.

When the user asks for planning, review, explanation, test scaffolding, or configuration only:

- do not edit `src/**`
- do not create new production files under `src/**`
- do not "fix" user-written production code opportunistically
- explain suspected production code issues in the response instead
- wait for explicit approval before changing production code

Allowed without extra confirmation when requested:

- documentation files
- planning notes
- test file scaffolding under `test/**`
- TypeScript/package/test configuration files
- `.gitignore`

If a production source issue blocks the requested work, describe the blocker and ask before editing `src/**`.

## Adapter Boundary

Adapters are split by capability and provider. A provider is a concrete
implementation such as MikroORM or Apps Script; a contract is the stable
boundary that core, ORM, storage, or runtime code consumes. The public package
must not require callers to import a provider-specific entity schema or raw SQL
connection.

- `adapter/persistence/contracts/`: SQL and persistence contracts independent of
  MikroORM, Prisma, or another future implementation
- `adapter/persistence/providers/mikro-orm/`: the current MikroORM-backed
  entity engine and SQLite storage bridge; it materializes typed-sheets entity
  definitions internally
- `adapter/sheets/providers/apps-script-gateway/`: the current signed Apps Script
  provider, separated into protocol, transport, and operation capabilities

The adapter should expose sheet-level operations in terms the core needs, not
Google-specific concepts. The current gateway boundary covers projection
provisioning, append-only System_State writes, guarded regular effects,
postcondition reads, and normalized visible-ID snapshot observation. Provider
connections and raw SQL executors remain implementation details rather than
normal public workflow objects.

Suggested responsibilities:

- provision and validate registered projection routes
- append new System_State rows in a bounded batch
- apply guarded update/delete effects
- read postconditions after uncertain writes
- return normalized snapshots whose rows are matched through the registered
  visible business-key column
- read User_Input values by its visible business-key column without remote
  metadata access

Do not leak Google SDK response objects into core repository logic.

## Sheet Schema and Observation Policy

Sheet schema drift must not be silently accepted by the observation or effect
worker.

The library should fail clearly when:

- a registered tab or range is missing
- a required projection header is missing
- headers are duplicated or reordered unexpectedly
- a row contains a formula, merged cell, Sheet error, or invalid normalized value
- a user edit does not identify one stable row

Unexpected columns outside the registered range are not part of the typed-sheets
contract. The gateway must validate only the registered range and fail closed
when its declared headers no longer match.

## SQLite and Conflict Policy

SQLite is the authority for application reads and writes. A successful entity
flush means that the entity table, sync state, and durable Sheet effect were
committed in one SQLite transaction. It does not mean that Google Sheets has
already converged.

The inbound and conflict rules below are the target policy. The current branch
contains a provider-side one-pass polling-to-evaluation-to-SQLite flow, but not
the complete public worker loop or Conflict checkbox resolution flow.

User_Input observations use field-level compare-and-set evidence:

- an accepted field updates the canonical entity and queues a System_State effect
- a stale field creates one Conflict row containing the current system value and
  the user candidate
- `use_system` keeps SQLite's current value
- `use_user` commits the candidate value to SQLite and queues the next projection
- either resolution is accepted only when revision, candidate hash, and epoch
  still match
- stale or ambiguous controls are reset and left visible for another decision

Conflict resolution is a SQLite transaction. The remote Conflict-row deletion is
an outbox effect and may be retried independently.

## Google Sheets API Constraints

Design with quota and latency in mind.

Current official Sheets API limits to consider:

- 300 read requests per minute per project
- 60 read requests per minute per user per project
- 300 write requests per minute per project
- 60 write requests per minute per user per project
- 2MB recommended max request payload
- 180 seconds max processing time per request
- quota exceeded responses return 429

This means the library should favor batch reads and avoid one API call per row where possible.

## Future Extensions

After the MVP is stable, possible extensions are:

- `onEdit` as an optional lower-latency observation source
- another persistence provider behind the typed-sheets engine contract
- generated primary keys and Sheet-side insert ergonomics
- `manyToMany` relations
- cascade and advanced relation loading
- operational status dashboard and repair tooling

Add these only after the base repository model is tested and documented.

## Testing Standard

Tests should prove behavior through realistic sheet states, not through shallow mocks.

The inbound and conflict cases below are acceptance criteria for the inbound
runtime. The accepted-edit and stale-edit polling cases are covered by the
current provider tests; the remaining Conflict cases are still pending.

Required test categories:

- public entity definitions materialize without exposing MikroORM types
- `manyToOne` and `oneToMany` mappings persist the owning foreign key
- entity flush commits entity state and outbox work together
- worker retries and recovers uncertain Sheet writes
- polling accepts a current user edit into SQLite
- stale edits create a field-level conflict
- each Conflict control is mutually exclusive and CAS-protected
- `use_system` and `use_user` produce the correct SQLite outcome
- stale resolution keeps the conflict visible and resets controls
- malformed Sheet/gateway payloads fail closed

The fake adapter should be simple but should preserve enough behavior to expose row/header bugs.

## Documentation Standard

README should explain:

- when this library is appropriate
- when it is not appropriate
- Google Sheets quota constraints
- schema drift problem
- stale write problem
- quick start
- API reference
- limitations
- roadmap

Do not market the project as a general database replacement.
