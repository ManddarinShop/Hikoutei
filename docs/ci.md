# CI scenarios

Hikoutei's CI includes an **internal sync/gateway end-to-end scenario**. It is
not a public API smoke test. The scenario drives the internal typed-sheets sync
pipeline — projection registration, gateway provisioning, the bounded effect
worker, polling, and the MikroORM-backed storage/CAS/hash machinery — and
imports internal implementation entrypoints (the gateway, polling, worker, and
storage providers, plus the `hikoutei/orm` and `hikoutei/mikro-orm` modules).
Those modules are implementation surface, not the public contract.

The public contract is the high-level `hikoutei` root API: Sheet
configuration/registration and a MikroORM-style entity lifecycle. The current
`develop` branch has not yet received the final root API refactoring, so there
is **no public API CRUD smoke in CI yet**. It will be added as a separate
scenario once that refactoring lands in `develop`. Until then, do not read the
existing internal sync/gateway scenario as coverage for the public contract.

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

## Artifacts

Every run emits a JSON artifact and, for live runs, a step summary. Setup time
and steady-state time are reported separately so spreadsheet creation and
header provisioning do not distort the internal sync/gateway measurements.
