# Hikoutei Development

## Local verification

Install dependencies and run the normal checks:

```sh
npm ci
npm test
npm run typecheck
npm run typecheck:test
npm run build
npm pack --dry-run
```

The default test suite uses a fake Sheets provider and SQLite/MikroORM fixtures.
It does not require live Google credentials.

## Google integration tests

Live Google Sheets tests are opt-in. The tracked live path is
service-account-only: it requires a service-account key, a shared
spreadsheet, and consumes external quota. Keep secrets in an untracked
environment file and never commit them.

The internal end-to-end scenario runs against the fake backend by default
and against the live backend in full-direct mode:

```sh
node scripts/ci/run-api-scenario.mjs --backend fake
node scripts/ci/run-api-scenario.mjs --backend live --outbound direct
```

The live backend is the service-account-only direct provider, used for
provisioning, outbound effects, observation, `mutateRow`, and cleanup. It
requires `GOOGLE_APPLICATION_CREDENTIALS` and
`GOOGLE_SHEETS_TEST_SPREADSHEET_ID` — and nothing else. The report
records only `sheetMatched: true` for the direct mode and never prints
spreadsheet IDs.

`--backend live` always runs the direct provider; the removed gateway mode no
longer exists, so any `--outbound` value other than `direct` is rejected.

## Benchmarks

Performance measurements should be recorded in
[`sync-bulk-write-benchmark.md`](sync-bulk-write-benchmark.md). Separate:

- one-time setup from steady-state work
- raw transport writes from full worker drain
- reconciliation from the normal append path
- local SQLite/ORM time from HTTP and provider time

The benchmark history is not a universal Sheets performance guarantee. Network
latency, Sheets API behavior, quotas, and spreadsheet state can
change the result. The full direct provider (`googleSheetsApi`) is not a
performance claim either: the raw-transport benchmarks under `scripts/bench/`
measure the unguarded API path (no receipts, no compare-and-set), while the
provider adds fail-closed guarantees (receipts and compare-and-set), so its
throughput is unverified until measured through the full worker.

## Package preview

Before publishing, inspect the tarball contents:

```sh
npm pack --dry-run
```

The package should include the built `dist/` output and the public
documentation only — no Apps Script deployment. The sync provider calls the
Google Sheets REST API (`spreadsheets.get` / `spreadsheets.batchUpdate`)
through a service account, so the tarball contains no gateway sources or
manifest; the service account needs only the Spreadsheets scope.
