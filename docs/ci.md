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
those branches receive a push. The live workflow runs for pull requests
targeting `main` or `develop`. Live is skipped for forked pull requests because
GitHub does not expose repository secrets to them; using `pull_request_target`
would expose the secret to untrusted PR code. It uses a dedicated test
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

## Beta publication

A push to `develop` runs `.github/workflows/beta-publish.yml`. It repeats the
unit/type/build/package checks and the installed-package fake sync/gateway E2E
before publishing to npm with the `beta` dist-tag. Pull requests do not publish
beta packages; the workflow runs after the commit reaches `develop`.

The workflow requires the GitHub repository `NPM_TOKEN` secret and uses npm
provenance. The token must never be committed to the repository. The publish
job also checks that `develop` still points at the workflow commit so an older
run cannot publish after a newer commit has landed.

The workflow does not commit a generated version back to `develop`. It
publishes an ephemeral prerelease on the current numeric `package.json` version
line with the GitHub run ID and attempt. For example, `0.3.0` produces
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
