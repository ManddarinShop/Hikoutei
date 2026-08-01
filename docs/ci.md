# CI scenarios

Hikoutei's CI includes an **internal sync/gateway end-to-end scenario**. It is
not a public API smoke test. The scenario drives the internal typed-sheets sync
pipeline — projection registration, gateway provisioning, the bounded effect
worker, polling, and the MikroORM-backed storage/CAS/hash machinery — and
loads implementation modules directly from the packed `dist/` tree. The
`hikoutei/orm` and `hikoutei/mikro-orm` package subpaths are intentionally not
published.

The public contract is the high-level `hikoutei` root API: Sheet
configuration/registration and a MikroORM-style entity lifecycle. Root API
coverage lives in the unit/provider tests; this installed-consumer scenario
intentionally remains focused on the internal sync/gateway pipeline and should
not be read as public API CRUD coverage.

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

## Backends and triggers

The fake backend runs when a pull request targets `main` or `develop`, and when
those branches receive a push. The live workflow is opt-in via
`workflow_dispatch`: a maintainer with write access dispatches it manually for a
trusted ref. It does not run automatically for pull requests or pushes, so
there is no forked-PR secret-exposure path and no `pull_request_target` path.
It uses a dedicated test spreadsheet and the following GitHub Actions secrets:

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

## Beta publication

A push to `develop` runs `.github/workflows/beta-publish.yml`. It repeats the
unit/type/build/package checks and the installed-package fake sync/gateway E2E
before publishing to npm with the `beta` dist-tag. Pull requests do not publish
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
4. The tag workflow reruns the checks and installed-consumer fake E2E, then
   publishes the verified package with the `latest` dist-tag. A `develop` push
   does not change `latest`; for example, the `0.3.0` stable package is
   published only after the `v0.3.0` tag is pushed.

A stable package is immutable on npm, so reusing a published version fails
instead of replacing the existing package. Normal users can install the
`latest` release with `npm install hikoutei`.

## Artifacts

The internal sync/gateway CI workflows emit a JSON artifact and, for live
runs, a step summary. The beta and stable publication workflows upload their
fake E2E reports and verified package artifacts when available. Setup time and
steady-state time are reported separately so spreadsheet creation and header
provisioning do not distort the internal sync/gateway measurements.

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
