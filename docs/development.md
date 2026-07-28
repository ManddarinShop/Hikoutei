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

Live Google Sheets tests are opt-in. They require a deployed Apps Script
gateway, credentials, a spreadsheet, and consume external quota. Keep secrets
in an untracked environment file and never commit them.

## Benchmarks

Performance measurements should be recorded in
[`sync-bulk-write-benchmark.md`](sync-bulk-write-benchmark.md). Separate:

- one-time setup from steady-state work
- raw Gateway writes from full worker drain
- reconciliation from the normal append path
- local SQLite/ORM time from HTTP and Apps Script time

The benchmark history is not a universal Sheets performance guarantee. Network
latency, Apps Script execution behavior, quotas, and spreadsheet state can
change the result.

## Package preview

Before publishing, inspect the tarball contents:

```sh
npm pack --dry-run
```

The package should include the built `dist/` output, public documentation, and
the deployable [`apps-script/gateway/Code.gs`](../apps-script/gateway/Code.gs).
