# CI API scenarios

Hikoutei's  CI exercises the package as an installed consumer. The scenario is
not allowed to import `src/**` or the source-only test fake; it imports the
published package entrypoints after `npm pack`:

- `hikoutei`
- `hikoutei/orm`
- `hikoutei/mikro-orm`

Both backends execute the same lifecycle scenario:

1. create and register a mapped entity and its `System_State`/`User_Input`
   projections;
2. provision the Sheets tabs;
3. insert, read, update, and delete one entity through the entity manager;
4. run the bounded effect worker after each write;
5. edit a User_Input value and verify that polling reports the changed row;
6. restore the value, delete the entity, and verify the final projection state.

The fake backend runs when a pull request targets `main` or `develop`, and when
those branches receive a push. The live workflow runs for pull requests
targeting `main` or `develop`. Live is skipped for forked pull requests because
GitHub does not expose repository secrets to them; using `pull_request_target`
would expose the secret to untrusted PR code. It uses a dedicated test
spreadsheet and the following GitHub Actions secrets:

- `TYPED_SHEETS_GATEWAY_URL`
- `TYPED_SHEETS_GATEWAY_SHARED_SECRET`
- `TYPED_SHEETS_GATEWAY_SHEET_ID`

Each live run generates unique tab names from the workflow run ID. The runner
writes a manifest before provisioning, cleans those tabs in a `finally` path,
and the workflow repeats cleanup with `if: always()` so a failed assertion does
not leave the fixture behind. The Apps Script receipt tab is also removed by
the cleanup operation. Do not point the live secrets at a production
spreadsheet; cleanup is intentionally scoped to the dedicated CI spreadsheet.

Every run emits a JSON artifact and, for live runs, a step summary. Setup time
and steady-state time are reported separately so spreadsheet creation and
header provisioning do not distort CRUD/polling measurements.
