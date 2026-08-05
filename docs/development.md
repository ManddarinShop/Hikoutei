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

The default test suite uses fake gateways and SQLite/MikroORM fixtures. It does
not require live Google credentials.

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

The full-direct mode uses the service-account Google Sheets provider for
provisioning, outbound effects, observation, `mutateRow`, and cleanup. It
requires `GOOGLE_APPLICATION_CREDENTIALS` and
`GOOGLE_SHEETS_TEST_SPREADSHEET_ID` — and nothing else; it never reads the
`TYPED_SHEETS_GATEWAY_*` variables and never calls Apps Script. The report
records only `sheetMatched: true` for the direct mode and never prints
spreadsheet IDs.

A legacy Apps Script gateway mode (`--backend live` without
`--outbound direct`) still works for deployments without a service account;
it requires the three `TYPED_SHEETS_GATEWAY_*` secrets and a deployed gateway.

## Benchmarks

Performance measurements should be recorded in
[`sync-bulk-write-benchmark.md`](sync-bulk-write-benchmark.md). Separate:

- one-time setup from steady-state work
- raw Gateway writes from full worker drain
- reconciliation from the normal append path
- local SQLite/ORM time from HTTP and Apps Script time

The benchmark history is not a universal Sheets performance guarantee. Network
latency, Apps Script execution behavior, quotas, and spreadsheet state can
change the result. The full direct provider (`googleSheetsApi`) is not a
performance claim either: the raw-transport benchmarks under `scripts/bench/`
measure the unguarded API path (no receipts, no compare-and-set), while the
provider adds the same fail-closed guarantees as the Apps Script gateway, so
its throughput is unverified until measured through the full worker.

## Package preview

Before publishing, inspect the tarball contents:

```sh
npm pack --dry-run
```

The package should include the built `dist/` output, public documentation, and
the deployable [`apps-script/gateway/Code.gs`](../apps-script/gateway/Code.gs)
together with its [`appsscript.json`](../apps-script/gateway/appsscript.json)
manifest. The current fast-append implementation unconditionally calls the
Advanced Sheets Service for append target writes, so the manifest and Google
Cloud Sheets API activation are mandatory for the current temporary append
path; there is no runtime enablement switch.
