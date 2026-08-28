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
const tabName = `AdoptSmoke_Invoices_${suffix}`;

const ROWS = 20;
const customers = ["Acme", "Beta", "Gamma", "Delta", "Epsilon"];
const pad = (n) => String(n).padStart(3, "0");
const rows = [["memo", "invoiceNo", "customer", "total"]];
for (let i = 1; i <= ROWS; i++) {
  rows.push([
    i % 3 === 0 ? `legacy note ${i}` : "",
    `INV-${pad(i)}`,
    customers[i % customers.length],
    String(i * 100),
  ]);
}

await client.spreadsheets.batchUpdate({
  spreadsheetId,
  resource: { requests: [{ addSheet: { properties: { title: tabName } } }] },
}, opt);

await client.spreadsheets.values.update({
  spreadsheetId,
  range: `${tabName}!A1`,
  valueInputOption: "USER_ENTERED",
  requestBody: { values: rows },
}, opt);

const check = await client.spreadsheets.values.get({ spreadsheetId, range: `${tabName}!A1:D${ROWS + 1}` }, opt);
if (check.data.values?.length !== ROWS + 1) throw new Error(`populate failed: ${check.data.values?.length} rows`);

mkdirSync(statePath.replace(/\/[^/]+$/, ""), { recursive: true });
writeFileSync(statePath, JSON.stringify({
  spreadsheetId,
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  tabName,
  rows: ROWS,
  baselineRows: rows,
  marker: randomUUID(),
}, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ created: true, spreadsheetId, tabName, populatedRows: ROWS, statePath }));