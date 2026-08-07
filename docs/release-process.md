# Release process

> This document is the release checklist for the `hikoutei` package. It is
> written so a maintainer can run a release without inventing steps. The
> repository is an npm workspace: the root package is published; the
> `packages/outbox` workspace package is private and is not published.

## Versioning policy

- **Semver**: breaking public API changes require a minor or major bump
  depending on the pre-1.0 policy in effect; behavior-preserving additions are
  minor; bug fixes and internal changes are patch.
- The version on `develop` is bumped after a publish so the manifest never
  points below the published version.

## Before releasing

1. All target PRs are merged into `develop` and their CI checks pass.
2. The working tree is on a release branch created from the latest
   `origin/develop` (`chore/release-x.y.z`).
3. `npm install` has been run in a clean checkout so the workspace
   (`@hikoutei/outbox`) and root dependencies are present.

## Release steps

### 1. Bump the version

```sh
npm version patch --no-git-tag-version   # or minor / major
```

Verify `package.json` and `package-lock.json` both show the new version.

### 2. Verify

```sh
npm run typecheck
npm run typecheck:test
npm test
npm run build
npm pack --dry-run
```

The build script builds the `@hikoutei/outbox` workspace first, then the root
package.

### 3. Publish

```sh
npm publish
```

Publishing requires an npm account with write access to the `hikoutei`
package (2FA/OTP as configured). If publish fails with `401`/`404`, the
registry credentials in the environment are missing or invalid — authenticate
(`npm login` or an `NPM_TOKEN` with publish scope) before retrying.

### 4. Verify the published artifact

```sh
npm view hikoutei version
npm view hikoutei description
npm view hikoutei keywords
npm view hikoutei dist-tags
```

Confirm the version, description, and keywords match the release. Note the
npm search position for the target keywords as a before/after record when the
release changes metadata.

### 5. Sync the manifest back to develop

Commit the version bump:

```sh
git add package.json package-lock.json
git commit -m "chore(release): publish x.y.z"
```

Open a PR to `develop` with the `type: chore` label and merge it after CI
passes.

### 6. GitHub Release

Create a GitHub Release for the tag with a changelog:

- summary of user-facing changes since the previous release
- links to the merged PRs
- benchmark updates when the release changes throughput or quota behavior

The repository also has version/publish workflows (`.github/workflows/`:
`develop-version.yml`, `develop-publish.yml`, `stable-version.yml`,
`stable-publish.yml`); use them for the stable release flow when they apply
to the current release policy.

## Benchmark recording

If the release changes throughput, latency, or quota behavior, record the
measurement in `docs/sync-bulk-write-benchmark.md` before closing the release:
date and branch, exact command, dataset size and scenario, environment, a
result table with a separate no-setup/steady-state column, comparison with the
previous relevant benchmark, and known caveats. A benchmark that only appears
in chat is not complete.

## Label rules

Use the repository labels (`.github/labels.yml`) for issues and PRs:

- `type: bug|feature|docs|refactor|test|chore|performance` — what the change
  is
- `area: core|adapter|setup|performance|...` — which part it touches
- `status: needs triage|ready|blocked|...` — workflow state

A release PR is `type: chore`, `area: setup` (or the most relevant area), and
`status: ready` once CI passes.

## Failure handling

- **Publish partially succeeded (package published, manifest not synced)**:
  proceed to step 5 immediately so develop does not stay behind the published
  version.
- **CI fails on the release branch**: do not publish; fix, merge, and restart
  the release.
- **Publish credentials unavailable**: stop and ask the maintainer with npm
  access to authenticate or run `npm publish`; do not work around the
  registry auth.
