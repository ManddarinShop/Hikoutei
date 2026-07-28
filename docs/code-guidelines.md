# Code Guidelines

## Project Identity

This project is a TypeScript library for using Google Sheets as a lightweight, typed repository layer for MVP apps, internal tools, and low-traffic admin workflows.

The project is not a full database replacement, not a Prisma/JPA clone, and not a general-purpose Google Sheets API wrapper. Existing libraries such as `google-spreadsheet` and `@googleapis/sheets` already cover low-level Sheets access.

The core value is safety around common Google Sheets-as-data-store failure modes:

- schema drift caused by manual sheet edits
- stale writes and lost updates
- invalid row parsing
- duplicate or missing key columns
- API quota pressure
- future write serialization through Apps Script

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

The first implementation should stay small and prove the core safety model.

Required MVP capabilities:

- schema definition API
- adapter boundary for Sheets access
- header/schema validation
- required column detection
- duplicate header detection
- key column detection
- row parsing
- `text`, `number`, `boolean` basic column parsers
- `findAll`
- `findById`
- `insert`
- `update`
- `_version` based optimistic locking
- `SchemaDriftError`
- `ConflictError`
- `ParseError`

MVP exclusions:

- relations and joins
- SQL-like query language
- migration engine
- lazy loading
- multi-row atomic transactions
- Apps Script automatic installation
- Apps Script Web App gateway
- caching
- request collapse
- retry/backoff
- dashboard UI
- browser support matrix

## Architecture

Keep the core repository logic separate from Google API details.

Recommended package boundaries:

```txt
src/
  core/                         # 정규화 값, 평가, 상태 계약
  orm/                          # 공개 ORM facade, mapping, flush 계획
  adapter/
    persistence/
      contracts/                # 저장소 공통 계약
      providers/mikro-orm/      # 현재 MikroORM + SQLite 구현
    sheets/
      providers/apps-script-gateway/
        protocol/               # 서명·직렬화·응답 검증
        transport/              # HTTP operation client
        operations/
          read/                 # 테이블 읽기
          write/                # fast append
          observation/           # snapshot·anchor 관측
          effect/               # update/delete effect
  storage/                      # SQLite canonical state와 outbox
  runtime/                      # worker, reconciliation, gateway 조율
  index.ts
```

The core should depend on an adapter interface, not directly on Google Sheets SDKs.

The first tests should use an in-memory fake adapter. Real Google integration tests can come later and should be opt-in because they require credentials and quota.

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
boundary that core, ORM, storage, or runtime code consumes.

- `adapter/persistence/contracts/`: SQL and persistence contracts independent of
  MikroORM, Prisma, or another future implementation
- `adapter/persistence/providers/mikro-orm/`: the current MikroORM-backed
  entity engine and SQLite storage bridge
- `adapter/sheets/providers/apps-script-gateway/`: the current signed Apps Script
  provider, separated into protocol, transport, and operation capabilities

The adapter should expose sheet-level operations in terms the core needs, not Google-specific concepts.

Suggested responsibilities:

- read headers
- read rows
- append row
- replace row by index or key
- optionally re-read row before update

Do not leak Google SDK response objects into core repository logic.

## Schema Drift Policy

Schema drift must not be silently ignored.

The library should fail clearly when:

- a required column is missing
- the key column is missing
- headers are duplicated
- `_version` is required but missing
- a row cannot be parsed into the declared type

Unexpected extra columns may be allowed by default, but the behavior should be explicit and configurable later.

## Stale Write Policy

MVP optimistic locking should be based on a version column.

Expected behavior:

- read current row
- keep its `_version`
- before update, re-check the current `_version`
- if the version changed, throw `ConflictError`
- if unchanged, write the updated row with incremented `_version`

This is not a true database transaction. Document it as stale-write protection, not full transactional safety.

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

- read cache
- in-flight read collapse
- retry/backoff for 429 and transient 5xx
- Google Sheet template generator
- schema drift report
- Apps Script installer CLI
- Apps Script `LockService` write gateway
- audit log sheet
- `_createdAt` and `_updatedAt` system columns
- GitHub Action for schema verification

Add these only after the base repository model is tested and documented.

## Testing Standard

Tests should prove behavior through realistic sheet states, not through shallow mocks.

Required test categories:

- valid schema passes
- missing required column fails
- duplicate header fails
- missing key column fails
- invalid number/boolean parse fails
- `findAll` returns typed rows
- `findById` returns matching row
- `findById` returns null/undefined for missing key, whichever API chooses
- insert rejects duplicate key
- update increments `_version`
- update rejects stale version with `ConflictError`
- extra column behavior is documented by test

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
