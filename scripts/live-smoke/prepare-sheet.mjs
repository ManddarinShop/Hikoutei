// Live-smoke preparation for existing-sheet adoption
// (design/existing-sheet-adoption-design.md §10/§11).
//
// Creates a fresh, never-library-provisioned tab with real data (20 rows,
// contiguous bound block + ignored `memo` column) on an SA-owned spreadsheet
// and records the exact written rows so the smoke script compares against the
// REAL prepared data instead of a re-derived baseline.
//
// Tab layout: memo(A, ignored) | invoiceNo(B) | customer(C) | total(D).
// The MVP layout requires ignored columns to sit LEFT of the managed block
// (a trailing ignored column reads as segmentation and blocks adoption), and
// `total` must be declared `number` in the smoke entity (numeric cells).
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   HIKOUTEI_ADOPT_SMOKE_SPREADSHEET_ID=<saOwnedSpreadsheetId> \
//   node scripts/live-smoke/prepare-sheet.mjs
//
// State file (tab name + baseline rows) defaults to
// .local/adopt-smoke-sheet.private.json; override with
// HIKOUTEI_ADOPT_SMOKE_STATE=<path>.
//
// §13: HIKOUTEI_ADOPT_SMOKE_MULTI=1 prepares TWO tabs in the SAME
// spreadsheet (AdoptSmoke_Invoices_* + AdoptSmoke_Customers_*) and records
// BOTH entities' specs + baseline rows in the state file under `tabs` (with
// the first tab ALSO mirroring the single-entity top-level fields so the
// runner's single-flow guards still resolve).
import { GoogleAuth } from "google-auth-library";
import { sheets } from "@googleapis/sheets";
import { writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!creds) throw new Error("GOOGLE_APPLICATION_CREDENTIALS required");
const spreadsheetId = process.env.HIKOUTEI_ADOPT_SMOKE_SPREADSHEET_ID;
if (!spreadsheetId) throw new Error("HIKOUTEI_ADOPT_SMOKE_SPREADSHEET_ID required (an SA-owned spreadsheet — the SA lost spreadsheets.create, so reuse an existing one)");
const statePath = process.env.HIKOUTEI_ADOPT_SMOKE_STATE ?? ".local/adopt-smoke-sheet.private.json";

const auth = new GoogleAuth({ keyFilename: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const client = sheets({ version: "v4", auth });
const opt = { retry: false, timeout: 30_000 };

const suffix = randomUUID().slice(0, 8);

const ROWS = 20;
const customers = ["Acme", "Beta", "Gamma", "Delta", "Epsilon"];
const tiers = ["gold", "silver", "bronze", "platinum"];
const pad = (n) => String(n).padStart(3, "0");

// Creates + populates one fresh tab (header row + ROWS data rows) and returns
// its full written rows (header + data) for the baseline comparison.
async function createTab(tabTitle, headers, rowBuilder) {
  await client.spreadsheets.batchUpdate({
    spreadsheetId,
    resource: { requests: [{ addSheet: { properties: { title: tabTitle } } }] },
  }, opt);
  const rows = [headers, ...Array.from({ length: ROWS }, (_, i) => rowBuilder(i + 1))];
  await client.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabTitle}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  }, opt);
  const check = await client.spreadsheets.values.get({ spreadsheetId, range: `${tabTitle}!A1:D${ROWS + 1}` }, opt);
  if (check.data.values?.length !== ROWS + 1) throw new Error(`populate failed: ${check.data.values?.length} rows`);
  return { tabName: tabTitle, rows };
}

// §12: HIKOUTEI_ADOPT_SMOKE_LEGACY=1 prepares a LEGACY-header variant
// (memo | Invoice No | Customer Name | Total (USD)) and records the
// columnMap in the state file — positionally identical to the canonical
// layout, so the smoke's positional checks work for both.
const legacy = process.env.HIKOUTEI_ADOPT_SMOKE_LEGACY === "1";
const invoiceHeaders = legacy
  ? ["memo", "Invoice No", "Customer Name", "Total (USD)"]
  : ["memo", "invoiceNo", "customer", "total"];
const invoiceColumnMap = legacy
  ? { "Invoice No": "invoiceNo", "Customer Name": "customer", "Total (USD)": "total" }
  : undefined;
const invoiceRow = (i) => [
  i % 3 === 0 ? `legacy note ${i}` : "",
  `INV-${pad(i)}`,
  customers[i % customers.length],
  String(i * 100),
];
const customerHeaders = ["memo", "customerId", "name", "tier"];
const customerRow = (i) => [
  i % 3 === 0 ? `legacy note ${i}` : "",
  `CUS-${pad(i)}`,
  customers[i % customers.length],
  tiers[i % tiers.length],
];

// §13: multi-entity mode — TWO tabs in the SAME spreadsheet.
const multi = process.env.HIKOUTEI_ADOPT_SMOKE_MULTI === "1";

let state;
if (multi) {
  const inv = await createTab(`AdoptSmoke_Invoices_${suffix}`, invoiceHeaders, invoiceRow);
  const cust = await createTab(`AdoptSmoke_Customers_${suffix}`, customerHeaders, customerRow);
  state = {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    multi: true,
    // First tab ALSO mirrors the single-entity top-level fields so the runner's
    // module-scope guards (baseline/ROWS) still resolve before it branches.
    tabName: inv.tabName,
    rows: ROWS,
    baselineRows: inv.rows,
    tabs: [
      { entity: "AdoptSmokeInvoice", tabName: inv.tabName, rows: ROWS, baselineRows: inv.rows, ...(invoiceColumnMap === undefined ? {} : { columnMap: invoiceColumnMap }) },
      { entity: "AdoptSmokeCustomer", tabName: cust.tabName, rows: ROWS, baselineRows: cust.rows },
    ],
    marker: randomUUID(),
  };
} else {
  const tabName = `AdoptSmoke_Invoices_${suffix}`;
  const created = await createTab(tabName, invoiceHeaders, invoiceRow);
  state = {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    tabName,
    rows: ROWS,
    baselineRows: created.rows,
    ...(invoiceColumnMap === undefined ? {} : { columnMap: invoiceColumnMap }),
    marker: randomUUID(),
  };
}

mkdirSync(statePath.replace(/\/[^/]+$/, ""), { recursive: true });
writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ created: true, spreadsheetId, multi, tabs: multi ? state.tabs.map((t) => t.tabName) : state.tabName, populatedRows: ROWS, legacy, statePath }));