# Contributing to Hikoutei

Hikoutei is a typed repository and safe write layer for Google Sheets-backed
MVPs: SQLite is the application authority, Google Sheets is an asynchronous
human-facing projection. Before contributing, read
[`AGENTS.md`](AGENTS.md) and [`docs/code-guidelines.md`](docs/code-guidelines.md) —
they define the positioning, architecture rules, and type-first style that
every change must respect.

## Development setup

The repository is an npm workspace: the root package (`hikoutei`) plus
`packages/ikisaki` (`@hikoutei/ikisaki`, the durable consistency queue).

```sh
npm install        # installs root and workspace dependencies
npm test           # unit and provider/contract tests (no live Google calls)
npm run typecheck  # production typecheck
npm run typecheck:test
npm run build      # builds the ikisaki workspace first, then clean + tsc for root
npm pack --dry-run # preview package contents
```

Live Google Sheets verification is opt-in and manual (credentials, quota, and
a deployed spreadsheet). The normal suite uses fake providers and SQLite
fixtures.

## Repository layout

```text
src/api/                    public entity lifecycle API (the only public surface)
src/cli/                    `hikoutei setup` CLI (service-side provisioning)
src/domain/                 pure normalization, evaluation, conflict rules
src/application/            ORM facade, sync engine, service bootstrap
src/adapter/                persistence (MikroORM/SQLite) and Sheets providers
src/infrastructure/         SQLite storage: canonical, observation, resolution, outbox
packages/ikisaki/           durable consistency-queue package (workspace)
docs/                       local-only architecture, flows, benchmarks, guidelines
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

- Keep `docs/architecture.md`, `docs/write-and-synchronization-flow.md`, and
  `docs/internal-consistency-model.md` consistent with the code when the sync
  model changes.
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

Record results in `docs/sync-bulk-write-benchmark.md` (or the existing GitHub
performance issue when one is open). A benchmark is not complete if it only
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
