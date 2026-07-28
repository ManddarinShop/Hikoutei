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

Good PR sequence:

1. project scaffold
2. core schema and column parsers
3. memory adapter
4. repository read methods
5. insert/update methods
6. optimistic locking
7. README and examples
8. Google Sheets adapter

## First Milestone PR Plan

Recommended first milestone:

```txt
PR 1: project scaffold
PR 2: schema and parser core
PR 3: memory adapter and read repository
PR 4: insert/update with version conflict
PR 5: README quickstart and limitations
```

Do not start with Google OAuth or Apps Script. Those belong after the core model is stable.

## Release Policy

Use semantic versioning.

Before `1.0.0`, breaking changes are allowed but should be documented.

Suggested early versions:

```txt
0.1.0 core schema + memory adapter
0.2.0 repository CRUD + optimistic locking
0.3.0 Google Sheets adapter
0.4.0 README, examples, CI hardening
```

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
Add duplicate header detection
Add missing key column error
Add number parser
Add memory adapter
Add version conflict test
Add README limitations section
```

Avoid opening vague issues such as:

```txt
Build ORM
Add transactions
Support everything
```

## Project Narrative

The public project story should be:

> Google Sheets is practical for early MVPs and internal tools, but manual edits introduce schema drift and stale writes. This library provides a typed repository layer that fails fast on schema drift and protects writes with version-based conflict detection.

Do not claim full database semantics.
