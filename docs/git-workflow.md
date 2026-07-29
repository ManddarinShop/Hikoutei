# Git Workflow

## Branch Model

Use a simple branch model.

```txt
main      stable releases
next      integration branch, optional
feature/* feature work
fix/*     bug fixes
chore/*   maintenance
```

If the project is still early, `main` plus short-lived feature branches is enough.

Do not commit directly to `main` once the first usable version is published.

## Branch Naming

Use English kebab-case branch names.

Examples:

```txt
feature/core-schema
feature/memory-adapter
feature/version-locking
feature/google-sheets-adapter
feature/readme-quickstart
fix/conflict-error-message
chore/node-version-matrix
```

## Commit Messages

Use Conventional Commits.

Format:

```txt
<type>(<scope>): <summary>
```

Common types:

```txt
feat
fix
docs
test
refactor
build
ci
chore
```

Examples:

```txt
feat(core): add schema definition API
feat(core): add version-based stale write protection
feat(adapter): add in-memory sheet adapter
test(core): cover duplicate header detection
docs(readme): clarify Google Sheets limitations
ci(node): add Node version matrix
```

## PR Size

Keep PRs reviewable.

Target size:

```txt
300-1,000 changed lines
```

Split larger changes by responsibility.

For this repository, use the current work sequence below when splitting a
larger change.

## Current Work Sequence

The repository already has the public entity API, the MikroORM + SQLite
provider, the durable outbox, and the signed Apps Script gateway. Keep future
changes aligned with that boundary:

```txt
1. public entity and relation contract
2. SQLite transaction, canonical state, and outbox behavior
3. outbound worker, gateway, recovery, and reconciliation
4. inbound User_Input polling and field-level Conflict resolution
5. optional persistence or Sheet provider implementations
```

The current provider is replaceable behind the public API, but SQLite remains
the authority for application reads and writes. Do not move business decisions
or canonical state into Google Sheets while extending the gateway.

## Release Policy

Use semantic versioning. Before `1.0.0`, breaking changes are allowed but must
be documented in the README or release notes. A release should describe which
parts of the public entity API, SQLite provider, outbound worker, and inbound
design are actually implemented; planned polling or conflict behavior must not
be presented as a completed feature.

## Pull Request Template

Each PR should include:

```md
## Summary

## Why

## Changes

## Tests

## Limitations
```

## Labels

Use lowercase labels matching commit types where possible.

```txt
feat
fix
docs
test
refactor
build
ci
chore
```

Additional useful labels:

```txt
core
adapter
docs
release
```

## CI Expectations

Minimum CI before first release:

- install
- typecheck
- test
- build

Recommended Node matrix:

```txt
Node 18
Node 20
Node 22
Node 24
```

Google integration tests should not run by default unless credentials are available.

## Release Checklist

Before publishing:

- README quickstart works
- package exports are correct
- `npm pack` contents are checked
- tests pass
- typecheck passes
- build output is verified
- package name availability is checked
- limitations are documented
- no credentials or local files are included

## Issue Strategy

Initial issues should be small and implementation-oriented.

Examples:

```txt
Add relation mapping validation
Add SQLite/outbox transaction test
Add Apps Script operation recovery test
Add User_Input polling scenario
Add Conflict resolution CAS test
Clarify SQLite authority in the README
```

Avoid opening vague issues such as:

```txt
Build ORM
Add transactions
Support everything
```

## Project Narrative

The public project story should be:

> Google Sheets is practical for early MVPs and internal tools, but manual edits introduce schema drift and stale writes. This library provides a typed entity and safe write layer with SQLite as the application authority, durable Sheet outbox effects, and field-level conflict protection at the synchronization boundary.

Do not claim full database semantics.
