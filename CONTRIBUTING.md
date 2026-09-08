# Contributing to Hikoutei

Hikoutei is a typed repository and safe write layer for Google Sheets-backed
MVPs: SQLite is the application authority, Google Sheets is an asynchronous
human-facing projection. Before contributing, read
[`AGENTS.md`](AGENTS.md) and [`docs/code-guidelines.md`](docs/code-guidelines.md) —
they define the positioning, architecture rules, and type-first style that
every change must respect.

## Development setup

Package management is pnpm (workspaces declared in `pnpm-workspace.yaml`;
pinned via the `packageManager` field in `package.json`): the root package
(`hikoutei`) plus `packages/protocol/ikisaki` (`@hikoutei/ikisaki`, the durable
consistency queue).

```sh
pnpm install --frozen-lockfile # installs root and workspace dependencies
npm test           # unit and provider/contract tests (no live Google calls)
npm run typecheck  # production typecheck
npm run typecheck:test
npm run build      # builds workspaces in dependency order, then root compile/reconcile/smoke, then MCP
npm pack --dry-run # preview package contents
```

Live Google Sheets verification is opt-in and manual (credentials, quota, and
a deployed spreadsheet). The normal suite uses fake providers and SQLite
fixtures.

## Repository layout

```text
src/api/                    public entity lifecycle API (the only public surface)
src/internal/               read-only sync-status observability for first-party tooling
src/types/                  ambient typing for the node:sqlite built-in
packages/library/core/contracts/     pure contracts (domain model, storage interfaces, sync protocol)
packages/library/core/storage/       SQLite storage + MikroORM persistence adapter
packages/library/core/sync-engine/   outbound worker, reconciliation, flush unit-of-work, runtime core
packages/library/core/composition/   composition root (wires adapters; local/sync factories)
packages/library/cloud/sheets/       google-sheets-api sync provider
packages/library/cloud/google-auth/  shared Google service-account authentication
packages/library/cloud/cli/          `hikoutei setup`/`adopt` CLI (service-side provisioning)
packages/protocol/ikisaki/           durable consistency-queue package (workspace)
packages/mcp/                        spreadsheet-db-mcp server (workspace)
test/                       root Vitest suite (package tests live with their packages)
docs/                       local-only gitignored mirrors (resolve only where they exist)
design/                     local-only normative v1 design and execution checklist
```

`src` does not mean public: `src/index.ts` is the only application-facing
entrypoint. MikroORM, provider, polling, and sync-state internals are not part
of the contract.

## Branch strategy

- Create a task branch from `develop` with an English kebab-case name
  (`feature/...`, `fix/...`, `chore/...`, `docs/...`).
- Open a pull request to `develop`; keep PRs reviewable and scoped to one
  change.
- Do not push directly to `develop`; do not force-push.
- When resolving PR conflicts, prefer merging the latest `develop` into the PR
  branch, resolving, committing, and pushing normally. Do not rebase unless
  explicitly requested.

## Commit convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <summary>

- body lines explaining why, if non-obvious
```

Types used in this repository: `feat`, `fix`, `docs`, `chore`, `test`,
`refactor`, `perf`. Examples:

```text
feat(sync): auto-start the Sheets sync from environment configuration
fix(ikisaki): expose terminal failed-head supersede and recoverable error codes
docs(readme): rewrite README for onboarding and add internal consistency model
```

## Pull request checklist

- [ ] `npm test` passes (add focused tests for behavior changes)
- [ ] `npm run typecheck` and `npm run typecheck:test` pass
- [ ] `npm run build` passes
- [ ] Commit messages follow Conventional Commits
- [ ] Only files that belong to the change are staged
- [ ] README or `docs/` updated when the change affects usage or the sync model
- [ ] Benchmark results recorded durably when the change affects performance
      (see the benchmark section below)

The PR template (`Summary` / `Why` / `Changes` / `Tests` / `Limitations`)
must be filled in.

## Documentation rules

- When the sync model changes, sync the affected guides in the separate
  Hikoutei-Website- repository; the `docs/` mirrors
  (`docs/architecture.md`, `docs/write-and-synchronization-flow.md`,
  `docs/internal-consistency-model.md`) are local-only — consult them only
  when present in your checkout.
- `docs/` and `design/` are listed in `.gitignore` and are local-only working
  directories: they are not tracked and not shipped with the package (commit
  `634197e` stopped tracking them). Do not force-add or wholesale add those
  ignored trees; keep substantive guidance in tracked files such as this one.
- README updates cover intended use case, when not to use, the
  SQLite-authoritative model, quota constraints, quick start, limitations, and
  roadmap as applicable.
- `design/` contains the normative v1 design; conflicting names or policies in
  historical documents are not implementation requirements.

## Benchmarks

When a change affects throughput, latency, or quota behavior, measure it and
record the result durably:

- date and branch
- exact command or script
- dataset size and scenario steps
- environment/backend details
- result table with a separate no-setup/steady-state column
- comparison with the previous relevant benchmark
- known caveats

Record results in the benchmarks guide of the separate Hikoutei-Website-
repository (or the existing GitHub performance issue when one is open). A benchmark is not complete if it only
appears in chat.

## Issues and labels

Use the issue templates (bug report, feature request, task, performance). The
repository uses `type:`, `area:`, and `status:` labels defined in
`.github/labels.yml`:

- `type: bug|feature|docs|refactor|test|chore|performance`
- `area: core|adapter|setup|performance|...`
- `status: needs triage|ready|blocked|...`

## Code style

Follow `docs/code-guidelines.md`: type-first contracts, `as const` constants
with derived unions, discriminated unions for state, runtime guards at
untrusted boundaries, and structured errors with stable domains and codes.
Do not use `null` to represent success/failure status inside validated
contracts.
