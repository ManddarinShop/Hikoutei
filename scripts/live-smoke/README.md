# Existing-sheet adoption — live smoke harness

Live verification for the existing-sheet adoption feature
(`design/existing-sheet-adoption-design.md` §10/§11). Runs the six-scenario
plan against a REAL SA-owned spreadsheet; every check must pass to keep the
"live validated" claim honest. Not part of CI (requires SA credentials and
network).

## Prerequisites

- A service account JSON with Sheets write access (the SA must **own** the
  spreadsheet; `HIKOUTEI_ADOPT_SMOKE_SPREADSHEET_ID` must point at it).
  Note: the SA may have lost `spreadsheets.create` (403) — the harness only
  needs `addSheet`/values access on an EXISTING SA-owned spreadsheet.
- Built `dist/` (`npm run build`) — the runner imports from `../../dist/`.

## Run

```bash
# 1) prepare: creates a fresh 20-row tab ("AdoptSmoke_Invoices_<suffix>",
#    layout: memo | invoiceNo | customer | total — ignored column LEFT of the
#    managed block) and records the exact written rows
GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
HIKOUTEI_ADOPT_SMOKE_SPREADSHEET_ID=<spreadsheetId> \
  node scripts/live-smoke/prepare-sheet.mjs

# 2) smoke: dry-run report → adopt → SQLite seeding → System_State backfill →
#    human-edit absorption (D6) → cleanup-scan safety (D5); ~2–4 min
GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
  node scripts/live-smoke/run-live-smoke.mjs
```

State/artifacts (gitignored defaults):

- State file: `HIKOUTEI_ADOPT_SMOKE_STATE` (default
  `.local/adopt-smoke-sheet.private.json`) — tab name + `baselineRows`.
- Artifact: `HIKOUTEI_ADOPT_SMOKE_ARTIFACT_DIR` (default `.local`) —
  `adopt-live-smoke-<runId>.json` + the run's SQLite DB.

Every run uses a FRESH tab (step 1) and a FRESH SQLite DB — runs never
contaminate each other; the tab left behind becomes library-owned, which is
why step 1 always creates a new one.

## Checks (36)

| Step | Verifies |
|---|---|
| 1 dry-run | report ok/ready, name bindings, ignored column, contiguity, no COLUMN_OCCUPIED, existing PK column, row counts, columns/tabs to be added |
| 2 adopt | System_State/Conflicts provisioned, `__hikoutei_row_id` appended, deterministic anchors `entity:<pk>`, existing cells 100% preserved |
| 3 seeding | row_binding/entity_state/business_key_index counts, visible-state hashes, zero quarantine, every anchor↔canonical-entity-id pair 1:1 |
| 4 backfill | System_State row count + PK set + projected field values |
| 5 absorption (D6) | SQLite field update + revision bump, zero quarantine, projection refresh |
| 6 cleanup (D5) | reconciliation ran, outbox drained with ZERO delete effects, rows/anchors preserved, zero quarantine |

Known modeling trap (§11 finding): the sheet's numeric `total` cells require
the entity property to be declared `number` — a `string` declaration makes the
first polling pass quarantine every row as `invalid_cell`. Cell-kind
validation at seeding time is a §9 follow-up.