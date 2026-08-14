# AGENTS.md

## Project

Hikoutei (npm/import name `hikoutei`) is a TypeScript library that uses a local
SQLite entity store as the application authority and exposes Google Sheets as
an asynchronous human-facing projection for MVP apps, internal tools,
prototypes, and low-traffic admin workflows.

Use this positioning:

> Typed repository and safe write layer for Google Sheets-backed MVPs.

Do not describe the project as a database replacement, a Prisma/JPA clone, a
general-purpose Google Sheets API wrapper, or a transaction-safe database on top
of Sheets. SQLite is the authority; Sheets is an async projection and human
input surface, not the source of truth.

The authoritative design lives in [`docs/architecture.md`](docs/architecture.md),
[`docs/write-and-synchronization-flow.md`](docs/write-and-synchronization-flow.md),
[`docs/current-state-review.md`](docs/current-state-review.md), and
[`docs/code-guidelines.md`](docs/code-guidelines.md). Keep source and docs
consistent with those before inventing new structure.

## Public API direction

The public API is an entity-lifecycle EntityManager modeled on the MikroORM/JPA
workflow. Applications define entities with `defineTypedSheetsEntity()` and open
the runtime with `createTypedSheets()`, then use a request-local manager for
`fork()`, `create()`, `find()`, `findOne()`, `count()`, `findAndCount()`,
`persist()`, `remove()`, `flush()`, and `transactional()`:

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: { id: { type: "string", primary: true }, name: { type: "string" } },
});
const hikoutei = await createTypedSheets({ dbName: "./hikoutei.sqlite", entities: [User] });

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();
```

In a sync-enabled runtime, a successful `flush()` commits the entity table,
canonical sync state, and the durable Sheet effect outbox in one SQLite
transaction. A local-only runtime (no sync environment configured) opens
entity tables only and does not create or commit remote sync state or an
outbox. Either way, `flush()` does not mean a remote Sheet write has
completed. Applications must never read normal entity data from Sheets; they
read SQLite.

Keep the public API and the internal sync/provider engine separate.

The public surface exposes entity/runtime registration plus the
entity-lifecycle EntityManager: defining entities with
`defineTypedSheetsEntity()`, opening the runtime with `createTypedSheets()`,
and `fork()`, `create()`, `find()`, `findOne()`, `count()`, `findAndCount()`,
`persist()`, `remove()`, `flush()`, and `transactional()`. Google Sheet
provider setup and the sync bootstrap are internal and environment-driven
(the `googleSheetsApi` bootstrap option, `HIKOUTEI_SYNC_SPREADSHEET_URL`,
`GOOGLE_APPLICATION_CREDENTIALS`), not application-facing registration APIs.
Everything else is internal implementation and must not be part of the
application-facing contract: MikroORM types and provider internals,
the Google Sheets API provider, the outbound sync
worker, polling, and effect supervisor, storage schemas
(canonical/observation/resolution state), hash/compare-and-set evidence, and
low-level provider or protocol APIs.

The internal write engine may still classify work as insert-like, update-like,
or delete-like tasks for batching, outbox effects, and Sheets projection
materialization, but do not expose low-level insert/update/delete mechanics
merely because the engine needs those concepts internally. The EntityManager API
inherits the MikroORM/JPA workflow style, but MikroORM is the current
replaceable persistence engine behind the Hikoutei boundary, not part of the
application-facing API: applications must not depend on MikroORM types as a
public contract.

## Repository Layout

The source is organized by responsibility, not by a legacy layer. `domain/` and
`shared/` know nothing about external SDKs; `application/` orchestrates use
cases and synchronization; `adapter/` isolates persistence and Sheets providers
behind contracts; `infrastructure/` owns SQLite storage technology.

- `src/domain/`: normalization values, field evaluation, conflict transitions,
  and domain errors (`conflict/`, `errors/`, `evaluate/`, `model/`).
- `src/shared/`: cross-domain constants, stable encoding, and shared state
  contracts (`encoding/`, `state/`).
- `src/application/orm/`: public ORM facade, entity definitions, entity mapping,
  and flush planning (`api/`, `mapping/`, `persistence/`).
- `src/application/sync/`: outbound sync worker, effect supervisor, projection,
  reconciliation, provider orchestration, and telemetry (`sheets/`,
  `outbound/`, `telemetry/`).
- `src/adapter/persistence/`: persistence contracts and the current provider
  (`contracts/` for SQL/persistence contracts, `providers/mikro-orm/` for the
  MikroORM + SQLite engine, storage bridge, observation, and entity
  materialization).
- `src/adapter/sheets/`: Sheets provider contracts and the current Google
  Sheets API provider under `providers/google-sheets-api/` (transport/ and
  model/), the single sync provider for outbound effects, provisioning, table
  reads, row anchors, and snapshots.
- `src/infrastructure/storage/`: SQLite storage technology for canonical state,
  observation/conflict/resolution state, and the durable outbox (`sqlite/`,
  `state/` for canonical/mapped/observation/resolution, `sync/` for the outbound
  outbox and worker SQL).
- `src/index.ts`: the application-facing public entrypoint only.
- `test/`: Vitest unit and provider/contract tests, plus `test/support/`
  fixtures.
- `docs/`: architecture, sync flow, code guidelines, and current-state notes.
- `scripts/`: build and CI helper scripts (`clean-dist.mjs`,
  `ci/run-api-scenario.mjs`).

There is no `src/core/`, `src/setup/`, `src/runtime/`, `src/cli/`, or `spikes/`
directory anymore; treat those names as retired.

## Development Commands

- Install dependencies: `npm install` (or `npm ci` for a clean install)
- Run unit tests: `npm test`
- Run production typecheck: `npm run typecheck`
- Run test typecheck: `npm run typecheck:test`
- Build package: `npm run build`
- Preview package contents: `npm pack --dry-run`

There is currently no `test:integration` npm script. Live Google Sheets
verification is opt-in and manual: it requires a service account
(`GOOGLE_APPLICATION_CREDENTIALS`), a spreadsheet shared with it, and external
quota, and should never be the default
verification step. The normal suite uses fake providers and SQLite/MikroORM
fixtures and needs no credentials.

## Code Modification Rules

Follow `docs/code-guidelines.md`.

When the user asks for a bugfix, feature, refactor, or other code change, edit
`src/**` as needed while keeping the change scoped to the request. For planning,
review, explanation, test scaffolding, configuration, or documentation-only
work, keep changes outside `src/**` unless the user approves otherwise.

Allowed without extra confirmation when requested:

- documentation files
- planning notes
- test scaffolding under `test/**`
- TypeScript/package/test configuration files
- `.gitignore`

If a production source issue blocks the requested work, explain the blocker and
ask before editing `src/**`.

## Implementation Principles

- Keep `domain/` and `application/` logic independent from Google SDK and
  MikroORM details; depend on adapter contracts instead.
- Use adapter interfaces for sheet-level operations; never leak Google SDK
  response objects into repository logic.
- SQLite is the application authority. In a sync-enabled runtime, `flush()`
  commits the entity table, canonical sync state, and the durable Sheet effect
  outbox in one SQLite transaction; a local-only runtime commits entity tables
  only. Remote Sheet delivery is asynchronous and separate.
- Google Sheets is an async projection and human input surface, not the source
  of truth. The application reads SQLite; the worker observes `User_Input` only
  to evaluate intentional human changes and records conflicts in SQLite.
- Fail clearly on schema drift, duplicate headers, missing required/key columns,
  parse errors, stale/conflicting writes, and malformed provider payloads.
- Treat stale-write protection as field-level compare-and-set evidence, not a
  true database transaction. Outbound effects carry expected/target/observed
  visible-hash evidence to distinguish a failed write from a remote edit;
  conflict resolution uses revision, candidate-hash, and epoch as its
  compare-and-set controls.
- Prefer realistic tests using fake sheet states and SQLite/MikroORM fixtures
  over shallow mocks.
- Keep live Google integration tests opt-in because they require credentials
  and quota.

## Type-First Refactoring Style

Code cleanup in this project is contract refactoring, not merely shortening or
reformatting code. Prefer designs that make invalid states unrepresentable and
make the intended lifecycle visible at the type level.

- Model operation, lifecycle, resolution, validation, and result states with
  discriminated unions (a discriminant field such as `operation` or `status`
  selects the valid shape).
- Do not use `null` to represent mutually exclusive states when a
  state-specific type can express the contract. For example, an insert type
  should not carry `beforeRow`, `baseEntityRevision`, or delete evidence at
  all; existing-row and delete types should carry the fields they require.
- Keep untrusted adapter, provider, or JSON payloads at an `unknown`/raw input
  boundary. Validate them with runtime type guards, then promote them into
  state-specific internal types before evaluator or repository logic runs.
- A TypeScript type alone does not validate runtime JavaScript data. Pair
  compile-time types with runtime discriminants, constants, and type guards at
  every untrusted boundary.
- Reserve `null` for a real value-level meaning such as an empty Sheet cell,
  a genuinely optional association, or an unvalidated external payload. Do not
  use it as a success/failure/status marker inside validated domain contracts.
- Extract repeated protocol strings and magic values into `as const` runtime
  constants and derive union types from them. Share a constant only when the
  values have the same domain meaning; do not conflate JavaScript `typeof`
  names with domain tags merely because their text matches.
- Use structured errors with stable domains and machine-readable codes. Extend
  the shared core error type for throwing helpers, keep error codes in typed
  constants, and never require callers to parse human-readable messages.
- Prefer explicit result unions such as `{ status: "valid", value }` and
  `{ status: "invalid", reason }` over nullable result fields when callers
  need to branch on state.
- When refactoring a contract, add focused tests for each valid state and for
  malformed boundary input. Preserve behavior while making the invalid shape
  impossible after promotion.

## TypeScript Return Contracts

Make helper return contracts visible at the call site. Avoid helpers whose
success, nullability, or throwing behavior can only be understood by reading the
implementation.

- Use explicit return types for non-trivial helpers.
- Prefer names such as `requireFirstJsonObject` for helpers that return a value
  or throw.
- Prefer names such as `extractFirstJsonObjectOrNull` for helpers that can
  return `null`.
- Check nullable results with exact comparisons such as `value === null` instead
  of broad truthiness checks like `if (!value)` unless all falsy values are
  intentionally equivalent.
- Use `unknown` for untrusted external values before validation, then convert to
  a narrower internal type at the boundary.

## Code Comments

Add concise, open-source-style comments for exported functions, public methods,
adapter operations, and non-trivial private helpers. Comments should explain
what the function does, why it exists, and any important safety or concurrency
behavior. Avoid noisy comments that merely repeat the implementation.

When adding repository operations, adapter methods, setup helpers, or Sheets
provider operations, include a short comment near each function that helps a
new contributor understand the contract and failure mode.

## Testing Expectations

For behavior changes, run the narrowest useful Vitest target first, then run:

```sh
npm test
npm run typecheck
npm run typecheck:test
npm run build
```

When changing Google Sheets integration behavior, add or update focused tests,
but do not require live Google credentials for the normal test suite.

## Performance Benchmarks

When the user asks to run a performance test or benchmark, always preserve the
result in a durable record after reporting it in chat. Prefer updating the
existing GitHub performance issue when one exists; otherwise create or update a
local markdown note under `docs/` if the user has not asked to use GitHub.

Every recorded benchmark should include:

- date and branch
- exact command or script used
- dataset size and scenario steps
- environment/backend details
- result table
- a separate no-setup/steady-state column or row that excludes one-time
  preparation such as sheet creation, header initialization, Docker startup, or
  other setup work
- comparison with the previous relevant benchmark when available
- known caveats such as provider latency, network variance, or manual browser
  steps

Do not treat a benchmark as complete if the result only appears in chat.

## Git

Follow `docs/git-workflow.md`.

**Git approval rule:** Git-related operations that change repository state or
remote state require explicit user approval immediately before execution. This
includes creating, switching, deleting, rebasing, merging, cherry-picking, or
resetting branches; staging or committing; pushing or force-pushing; and
creating, editing, closing, reverting, or merging pull requests. Do not infer
approval from a request to implement code or from an earlier approval for a
different Git operation. Read-only inspection such as `git status`, `git log`,
and `git diff` is allowed, but ask before any state-changing Git command.

- Before making changes, check the current branch and create a new task branch
  unless the user explicitly asks to work on the current branch.
- Branch names: English kebab-case such as `feature/core-schema` or
  `fix/conflict-error-message`.
- Commit messages: Conventional Commits in the form
  `<type>(<scope>): <summary>`.
- Do not automatically commit just because a scoped code change is finished.
- When the user asks for another change and the next edit may mix with existing
  verified work, pause before editing and ask whether to commit the current
  changes first. Commit only after the user agrees or explicitly asks for it.
- Stage and commit only files that belong to the completed scope; leave
  unrelated local or untracked files out of the commit.
- Keep PRs reviewable and include summary, why, changes, tests, and
  limitations.
- When resolving PR conflicts, prefer merging the latest `origin/main` into the
  PR branch, resolving conflicts, committing, and pushing normally. Do not use
  rebase for PR conflict resolution unless the user explicitly asks for it.
- Never force push or use `--force-with-lease` unless the user explicitly
  approves that exact history-rewriting operation in the current conversation.

## Documentation

Follow the documentation standard in `docs/code-guidelines.md`. Keep
`docs/architecture.md`, `docs/write-and-synchronization-flow.md`, and
`docs/current-state-review.md` consistent with the code when you change the
synchronization model. README updates should cover the intended use case, when
not to use the library, the SQLite-authoritative model and async Sheets
projection, outbox/worker delivery, Google Sheets quota constraints, schema
drift, stale writes and conflict resolution, quick start, API reference,
limitations, and roadmap as applicable to the change.
