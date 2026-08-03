# CI scenarios

Hikoutei's CI runs two installed-consumer scenarios against packed `hikoutei`
and `@hikoutei/canonical-codec` tarballs. Each is built as an installed
consumer: after `npm pack` it imports from the packed tarballs rather than from
`src/**` or the source-only test fake, and neither is allowed to import those.

1. **Internal sync/gateway E2E** (`scripts/ci/run-api-scenario.mjs`) drives the
   internal typed-sheets sync pipeline — projection registration, gateway
   provisioning, the bounded effect worker, polling, and the MikroORM-backed
   storage/CAS/hash machinery — and loads implementation modules directly from
   the packed `dist/` tree.
2. **Installed root API smoke** (`scripts/ci/run-root-api-scenario.mjs`)
   imports ONLY the installed package root entrypoint `hikoutei` (no internal
   package subpaths and no source imports) and exercises the public
   entity-lifecycle contract an application is meant to use.

The public contract is the high-level `hikoutei` root API: a SQLite-backed
entity lifecycle. Sheet configuration, registration, and synchronization remain
internal service concerns. The
`hikoutei/orm` and `hikoutei/mikro-orm` package subpaths are intentionally not
published; the root smoke performs those dynamic imports only as negative
boundary assertions (they must be rejected with `ERR_PACKAGE_PATH_NOT_EXPORTED`)
while the lifecycle itself imports only the root `hikoutei` entrypoint. This
guards the boundary directly in an installed consumer in addition to the
source-level tests.

## Internal sync/gateway E2E

The scenario is built as an installed consumer: after `npm pack` it imports the
package entrypoints from the packed tarball rather than from `src/**` or the
source-only test fake. It is not allowed to import those. Both backends execute
the same lifecycle:

1. create and register a mapped entity and its `System_State`/`User_Input`
   projections;
2. provision the Sheets tabs;
3. insert, read, update, and delete one entity through the entity manager;
4. run the bounded effect worker after each write;
5. edit a User_Input value and verify that polling reports the changed row;
6. restore the value, delete the entity, and verify the final projection state.

## Installed root API smoke

The root smoke imports only the installed `hikoutei` root entrypoint and drives
the stable public lifecycle end to end against an in-memory SQLite authority
(`dbName: ":memory:"`):

1. define a scalar entity with `defineTypedSheetsEntity()`;
2. open the runtime with `createTypedSheets()` and only `dbName` plus entity tokens;
3. obtain a request-local manager with `em.fork()`;
4. `create()` / `persist()` / `flush()` one entity and `findOne()`-verify it;
5. mutate the loaded entity, `flush()`, and re-read it through a fresh fork to
   confirm the mutation committed locally;
6. `remove()` / `flush()` and verify the entity is gone through a fresh fork;
7. close the runtime.

It uses assertions and writes a JSON report plus a clear pass summary. It never
contacts Google Sheets, never needs credentials, and never provisions remote
tabs, so it runs as a packed consumer only in the normal CI, beta, and stable
verify jobs and has no live counterpart. It is local-only — an in-memory SQLite
authority with no backend concept — not a fake-backend scenario like the
internal sync/gateway E2E. Its entity lifecycle imports only the
root `hikoutei` package; the `hikoutei/orm` and `hikoutei/mikro-orm` dynamic
imports it performs are negative boundary assertions that must be rejected,
not part of the lifecycle.

## Backends and triggers

The normal CI, beta, and stable verification jobs run **both** installed-consumer
scenarios — the internal sync/gateway E2E and the installed root API smoke. The
pull-request CI packs the codec tarball beside the root tarball and installs
both locally, so it does not depend on a previously published codec version.
Beta and stable release verification instead resolves the exact codec version
from npm after checking that it exists. The internal E2E uses the **fake**
backend (no Google Sheets contact, no credentials); the root API smoke is
local-only, an in-memory SQLite authority (`:memory:`) with no backend concept.
The workflows are:

- `.github/workflows/ci.yml` runs on pull requests and pushes to `main` and
  `develop`.
- `.github/workflows/beta-publish.yml` runs the same verification on a
  `develop` push before publishing the beta package.
- `.github/workflows/stable-publish.yml` runs the same verification on a
  `vX.Y.Z` tag before publishing the stable package.

Only the internal sync/gateway E2E has a live variant, in the separate
`.github/workflows/live-integration.yml` workflow. It is opt-in via
`workflow_dispatch` — a maintainer with write access dispatches it explicitly;
it never runs automatically on pull requests or pushes — and exercises
that single scenario against real Google Sheets with `--backend=live`. The installed root API smoke has no live
counterpart: it is a local-only lifecycle smoke against an in-memory SQLite
authority, so it never runs there.

Because live is opt-in via `workflow_dispatch`, it is triggered manually by a
maintainer with write access rather than automatically on pull requests, so
there is no forked-PR secret-exposure path. The three gateway secrets are
scoped to the live execution and cleanup steps only, not the whole job, so
checkout/setup/install/build never see them. The live run uses a dedicated test
spreadsheet and the following GitHub Actions secrets:

- `TYPED_SHEETS_GATEWAY_URL`
- `TYPED_SHEETS_GATEWAY_SHARED_SECRET`
- `TYPED_SHEETS_GATEWAY_SHEET_ID`

## Cleanup

Each live run generates unique tab names from the workflow run ID. The runner
writes a manifest before provisioning, cleans those tabs in a `finally` path,
and the workflow repeats cleanup with `if: always()` so a failed assertion does
not leave the fixture behind. The Apps Script receipt tab is also removed by
the cleanup operation. Do not point the live secrets at a production
spreadsheet; cleanup is intentionally scoped to the dedicated CI spreadsheet.

## Canonical codec publication

`@hikoutei/canonical-codec` is a separate public ESM package, while its source
and parity tests remain in this repository under `packages/canonical-codec/`.
The package has no runtime dependency on Hikoutei, MikroORM, Google SDKs, or
Node crypto. Apps Script continues to use the self-contained source fragment;
it never imports the npm package.

The codec workflow is `.github/workflows/canonical-codec-publish.yml` and is
triggered by a tag such as `canonical-codec-v0.1.0`. It validates the tag and
package version, runs package tests plus the Node/Apps Script parity test,
checks the public tarball contents, and publishes with `--access public
--provenance`. The `@hikoutei` npm scope and the repository `NPM_TOKEN` must be
configured before the first publish.

Publish the exact codec dependency before publishing Hikoutei. The beta and
stable root workflows query npm for the exact version declared in
`hikoutei`'s `dependencies`; they intentionally fail if that codec version is
not available. The initial sequence is therefore:

1. publish `@hikoutei/canonical-codec@0.1.0` with
   `canonical-codec-v0.1.0`;
2. release the next Hikoutei patch version (`0.3.1` by default).

The two npm download counters remain package-specific; installing Hikoutei may
fetch both tarballs, but it does not double the `hikoutei` counter.

## Beta publication

A push to `develop` runs `.github/workflows/beta-publish.yml`. It repeats the
unit/type/build/package checks, the installed-package internal sync/gateway
E2E, and the installed root API smoke before publishing to npm with the
`beta` dist-tag. Pull requests do not publish
beta packages; the workflow runs after the commit reaches `develop`.

The workflow requires the GitHub repository `NPM_TOKEN` secret and uses npm
provenance. The token must never be committed to the repository. Immediately
before publishing, the publish job checks that `develop` still points at the
workflow commit, so it rejects a run that was stale as observed at that
check. The check and the npm publish that follows are not atomic: `develop`
can advance between the check and the publish, so the check reduces but does
not eliminate the chance of publishing a superseded commit.

The workflow does not commit a generated version back to `develop`. It
publishes an ephemeral prerelease on the current numeric `package.json` version
line with the GitHub run ID and attempt. The calculation lives in
`scripts/ci/beta-version.mjs` (tested by `test/beta-version.test.ts`); the
workflow reads `package.json`, calls that helper, and then runs
`npm version --no-git-tag-version` in CI. For example, `0.3.0` produces
`0.3.0-beta.b30560831639.1`, and starting the next development cycle at
`0.3.1` produces `0.3.1-beta...`. The stable `package.json` version is
therefore unchanged by CI. A full workflow rerun receives a new version;
rerunning only the publish job intentionally reuses its verified artifact.
An already published beta version is not deleted; after a corrected run, the
`beta` dist-tag points to the new package on the current version line.

Install the newest beta package explicitly:

```sh
npm install hikoutei@beta
```

## Stable publication

Stable releases use `.github/workflows/stable-publish.yml` and a numeric Git
tag such as `v0.2.1`. The tag version must exactly match the versions in
`package.json` and both version fields in `package-lock.json`; the workflow does
not bump versions automatically.

Release procedure:

1. Choose the next SemVer version and update `package.json` and
   `package-lock.json` in a reviewed release commit.
2. Use a compatibility-preserving patch version for bug fixes (for example
   `0.2.1`) or a new minor version for a new public API/feature (for example
   `0.3.0`). Document intentional pre-1.0 compatibility breaks.
3. Create and push the matching `vX.Y.Z` tag.
4. The tag workflow reruns the checks, the installed-package internal
   sync/gateway E2E, and the installed root API smoke, then publishes the
   verified package with the `latest` dist-tag. A `develop` push
   does not change `latest`; for example, the `0.3.0` stable package is
   published only after the `v0.3.0` tag is pushed.

A stable package is immutable on npm, so reusing a published version fails
instead of replacing the existing package. Normal users can install the
`latest` release with `npm install hikoutei`.

## Artifacts

The CI, beta, and stable jobs each emit a JSON report for **both**
scenarios (internal sync/gateway E2E and installed root API smoke). The live
job emits a JSON report only for the internal sync/gateway E2E, the single
scenario it runs. Both runner scripts (`run-api-scenario.mjs` and
`run-root-api-scenario.mjs`) default their `--summary` option to
`GITHUB_STEP_SUMMARY`, so in GitHub Actions every CI/beta/stable invocation
writes a step summary even though none passes `--summary` explicitly. The live
internal E2E run is the only invocation that passes `--summary` explicitly
(`--summary="$GITHUB_STEP_SUMMARY"`), which resolves to the same default but
documents the intent. The beta and stable verify jobs upload their two
installed-consumer scenario reports as a dedicated reports artifact
(`if: always()`), separate from the package artifact (`if: success()`) that the
publish job consumes. Setup time and steady-state time are reported separately
for the internal E2E so spreadsheet creation and header provisioning do not
distort the internal sync/gateway measurements.

The beta and stable package artifacts are each a single directory that holds
the npm tarball and its `sha256` checksum together under
`$RUNNER_TEMP/hikoutei-{beta,stable}-package`. The publish job downloads that
directory, asserts it contains exactly one `hikoutei-*.tgz` and the checksum
file, verifies the checksum line names that exact tarball (not merely any file
present in the directory), and only then runs `sha256sum --check` before
publishing. Name/version validation, npm provenance, the `beta`/`latest`
dist-tags, and the beta stale-`develop` check are unchanged.

## Action versions

Every workflow pins `actions/checkout`, `actions/setup-node`,
`actions/upload-artifact`, and `actions/download-artifact` to the current
Node 24-compatible major (`v5`) so the JavaScript actions run on the runner's
Node 24 runtime:

| Action | Major | Runtime |
| --- | --- | --- |
| `actions/checkout` | `v5` | Node 24 |
| `actions/setup-node` | `v5` | Node 24 |
| `actions/upload-artifact` | `v5` | Node 24 |
| `actions/download-artifact` | `v5` | Node 24 |

All four are on the same major, so there is no exception to record. The pin
preserves behavior: artifacts are downloaded by name (not by artifact ID);
`upload-artifact` still zips by default; `setup-node` `cache: npm` is set
explicitly (the package has no `packageManager` field, so the auto-cache
shortcut never applies); and the publish steps set `NODE_AUTH_TOKEN` in their
own `env`, so npm provenance and the `id-token: write` permission are
unchanged. This major is the action's own runtime version; the build and
test job still uses `node-version: 22`.
