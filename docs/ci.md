# CI scenarios

Hikoutei's CI runs two installed-consumer scenarios against the packed
package. Each is built as an installed consumer: after `npm pack` it imports
from the packed tarball rather than from `src/**` or the source-only test
fake, and neither is allowed to import those.

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
tabs, so it runs as a packed consumer only in the normal CI, develop, and stable
verify jobs and has no live counterpart. It is local-only — an in-memory SQLite
authority with no backend concept — not a fake-backend scenario like the
internal sync/gateway E2E. Its entity lifecycle imports only the
root `hikoutei` package; the `hikoutei/orm` and `hikoutei/mikro-orm` dynamic
imports it performs are negative boundary assertions that must be rejected,
not part of the lifecycle.

## Backends and triggers

The normal CI, develop, and stable verification jobs run **both** installed-consumer
scenarios — the internal sync/gateway E2E and the installed root API smoke. The
internal E2E uses the **fake** backend (no Google Sheets contact, no
credentials); the root API smoke is local-only, an in-memory SQLite authority
(`:memory:`) with no backend concept. The workflows are:

- `.github/workflows/ci.yml` runs on pull requests and pushes to `main` and
  `develop`.
- `.github/workflows/develop-version.yml` creates the next patch version and
  `develop-vX.Y.Z` tag after a `develop` push.
- `.github/workflows/develop-publish.yml` verifies and publishes that tag with
  the `develop` dist-tag.
- `.github/workflows/main-version.yml` creates the next minor version and
  `vX.Y.Z` tag after a `main` push.
- `.github/workflows/stable-publish.yml` verifies and publishes that tag with
  the `latest` dist-tag.

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

## Kohkai dependency

Hikoutei consumes the standalone `@hikoutei/kohkai` package from the
`ManddarinShop/Kohkai` repository. The codec is not a Hikoutei workspace and
its source is not included in the Hikoutei tarball:

```json
{
  "dependencies": {
    "@hikoutei/kohkai": "0.1.0"
  }
}
```

The root CI, develop publish, and stable publish workflows verify that the
exact declared Kohkai version already exists on npm before installing or
publishing Hikoutei. The first integration release therefore requires:

1. publish `@hikoutei/kohkai@0.1.0` from the Kohkai repository using tag `v0.1.0`;
2. merge the Hikoutei dependency integration;
3. let the next develop release produce `0.3.2` from the current `0.3.1` baseline.

Existing Hikoutei releases remain unchanged. Apps Script cannot import npm
packages, so `apps-script/gateway/Code.gs` keeps the Hikoutei-specific gateway
and its self-contained codec mirror; the root tests compare it with the pinned
Kohkai compatibility vectors.

## Develop publication

A push to `develop` runs `.github/workflows/develop-version.yml`. It verifies
the merged package, increments only the patch component, updates
`package.json` and `package-lock.json`, commits the release version, and creates
an annotated tag such as `develop-v0.3.1`. The generated commit is guarded from
being processed as another release.

The tag triggers `.github/workflows/develop-publish.yml`. It repeats the
unit/type/build/package checks, the installed-package internal sync/gateway
E2E, and the installed root API smoke before publishing the numeric package
version with the npm `develop` dist-tag. The version has no `-beta` suffix, but
normal `npm install hikoutei` still resolves `latest` rather than this channel.
Install the develop channel explicitly:

```sh
npm install hikoutei@develop
```

The version calculation is isolated in `scripts/ci/release-version.mjs` and is
covered by `test/release-version.test.ts`. For example:

```text
0.3.0 + patch → 0.3.1
0.3.1 + patch → 0.3.2
```

The workflow requires a repository `RELEASE_TOKEN` secret with contents write
permission. A token other than the default `GITHUB_TOKEN` is used because a
push made by `GITHUB_TOKEN` does not trigger another workflow; the release tag
must trigger `develop-publish.yml`. The publish job separately requires
`NPM_TOKEN` plus npm provenance. The branch SHA is checked immediately before
pushing, and the commit plus tag use one atomic Git push, so a concurrent
develop merge fails without leaving a stale release tag. The version commit and
npm publication are not atomic; a failed publish can be retried from the
existing `develop-vX.Y.Z` tag after verifying that the version has not already
been published.

## Stable publication

A push to `main` runs `.github/workflows/main-version.yml`. It verifies the
merged package, increments the minor component, updates the package manifests,
commits the release version, and creates an annotated tag such as `v0.4.0`:

```text
0.3.1 + minor → 0.4.0
```

The tag triggers `.github/workflows/stable-publish.yml`. That workflow only
validates the numeric tag and matching package manifest versions, reruns the
full checks and installed-consumer scenarios, and publishes to npm with the
`latest` dist-tag. A `develop-v0.3.1` tag cannot trigger this numeric `vX.Y.Z`
workflow.

The main version workflow uses the same `RELEASE_TOKEN` requirement so its
`vX.Y.Z` tag triggers `stable-publish.yml`. The stable publish job also
requires the repository `NPM_TOKEN` secret and npm provenance before publishing
`latest`. After a stable main release, merge
`main` back into `develop` so the next patch release starts from the new stable
baseline. Stable package versions are
immutable on npm, so reusing a published version fails instead of replacing
it. Normal users install the stable channel with:

```sh
npm install hikoutei
```

## Artifacts

The CI, develop, and stable jobs each emit a JSON report for **both**
scenarios (internal sync/gateway E2E and installed root API smoke). The live
job emits a JSON report only for the internal sync/gateway E2E, the single
scenario it runs. Both runner scripts (`run-api-scenario.mjs` and
`run-root-api-scenario.mjs`) default their `--summary` option to
`GITHUB_STEP_SUMMARY`, so in GitHub Actions every CI/develop/stable invocation
writes a step summary even though none passes `--summary` explicitly. The live
internal E2E run is the only invocation that passes `--summary` explicitly
(`--summary="$GITHUB_STEP_SUMMARY"`), which resolves to the same default but
documents the intent. The develop and stable verify jobs upload their two
installed-consumer scenario reports as a dedicated reports artifact
(`if: always()`), separate from the package artifact (`if: success()`) that the
publish job consumes. Setup time and steady-state time are reported separately
for the internal E2E so spreadsheet creation and header provisioning do not
distort the internal sync/gateway measurements.

The develop and stable package artifacts are each a single directory that
holds the npm tarball and its `sha256` checksum together under
`$RUNNER_TEMP/hikoutei-{develop,stable}-package`. Their GitHub artifact names
are `hikoutei-develop-package` and `hikoutei-stable-package`; the installed
consumer report artifacts are `hikoutei-develop-fake-installed-consumer` and
`hikoutei-stable-fake-installed-consumer`. The normal CI report artifact is
`hikoutei-fake-installed-consumer`. The publish job downloads the corresponding
package directory, asserts it contains exactly one `hikoutei-*.tgz` and the
checksum file, verifies the checksum line names that exact tarball (not merely
any file present in the directory), and only then runs `sha256sum --check`
before publishing. Name/version validation, npm provenance, the
`develop`/`latest` dist-tags, and the stale branch SHA checks are enforced by
the corresponding workflows.

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
