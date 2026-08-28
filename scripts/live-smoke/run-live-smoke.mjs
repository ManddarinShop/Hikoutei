// Existing-sheet adoption LIVE SMOKE runner
// (design/existing-sheet-adoption-design.md §10/§11).
//
// Runs the six-scenario plan against a real SA-owned spreadsheet:
//   1. dry-run  — read-only report, verified, spreadsheet untouched
//   2. adopt    — System_State/Conflicts provisioned, row-id column appended,
//                 deterministic anchors (entity:<pk>) written, cells preserved
//   3. seeding  — SQLite: row_binding/entity_state/business_key_index/
//                 sheet_visible_state (observed-hash baseline), zero quarantine
//   4. backfill — empty System_State tab filled by reconciliation bulk append
//   5. absorption (D6) — a human cell edit flows sheet → SQLite → System_State
//   6. cleanup safety (D5) — the cleanup scan deletes/reverts nothing
//
// Every run uses a FRESH tab (via prepare-sheet.mjs) and a FRESH SQLite DB, so
// runs never contaminate each other. Artifact:
//   <artifactDir>/adopt-live-smoke-<runId>.json
//
// Usage:
//   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
//   node scripts/live-smoke/run-live-smoke.mjs
//   # after scripts/live-smoke/prepare-sheet.mjs created the state file
//   # HIKOUTEI_ADOPT_SMOKE_STATE (default .local/adopt-smoke-sheet.private.json)
//   # artifact dir override: HIKOUTEI_ADOPT_SMOKE_ARTIFACT_DIR (default .local)
import { defineTypedSheetsEntity } from "../../dist/index.js";
import { createInternalSyncService } from "../../dist/application/sync/service/SyncServiceBootstrap.js";
import { ExistingSheetAdoptionDryRunReportError } from "../../dist/application/sync/service/adopt/existingSheetAdoption.js";
import { GoogleAuth } from "google-auth-library";
import { sheets } from "@googleapis/sheets";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------- config
const statePath = process.env.HIKOUTEI_ADOPT_SMOKE_STATE ?? ".local/adopt-smoke-sheet.private.json";
const artifactDir = process.env.HIKOUTEI_ADOPT_SMOKE_ARTIFACT_DIR ?? ".local";
const sheet = JSON.parse(readFileSync(statePath, "utf8"));
const spreadsheetId = sheet.spreadsheetId;
const TAB = sheet.tabName;
const SYSTEM_TAB = `${TAB}_System`;
const CONFLICTS_TAB = `${TAB}_Conflicts`;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 6);
const DB_PATH = `${artifactDir}/adopt-smoke-${RUN_ID}.sqlite`;
const ARTIFACT = `${artifactDir}/adopt-live-smoke-${RUN_ID}.json`;
const ROWS = sheet.rows;
const pad = (n) => String(n).padStart(3, "0");
const customers = ["Acme", "Beta", "Gamma", "Delta", "Epsilon"];
// Terra review (should-fix #2): use the EXACT rows the prepare script wrote
// (persisted in the state file) instead of a re-derived baseline.
const baseline = sheet.baselineRows;
if (!Array.isArray(baseline) || baseline.length !== ROWS + 1) {
  throw new Error(`baselineRows missing or stale in ${statePath} — re-run scripts/live-smoke/prepare-sheet.mjs`);
}
const EDIT_ROW = 5; // sheet row 5 = INV-004
const EDIT_VALUE = "EditedLive";

const auth = new GoogleAuth({ keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const api = sheets({ version: "v4", auth });
const opt = { retry: false, timeout: 30_000 };
const withRetry = async (fn, label) => {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return await fn(); } catch (error) {
      lastError = error;
      const status = error?.status ?? error?.code ?? "";
      if (!(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(status) || status === 429 || (status >= 500 && status < 600))) break;
      await sleep(2_000 * attempt);
    }
  }
  throw new Error(`${label} failed after retries: ${lastError?.message ?? lastError}`);
};
const readTab = async (range) => withRetry(async () => (await api.spreadsheets.values.get({ spreadsheetId, range: `${TAB}!${range}` }, opt)).data.values ?? [], `readTab ${range}`);
const readSystemTab = async () => withRetry(async () => (await api.spreadsheets.values.get({ spreadsheetId, range: `${SYSTEM_TAB}!A1:Z` }, opt)).data.values ?? [], "readSystemTab");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- entity
const AdoptSmokeInvoice = defineTypedSheetsEntity({
  name: "AdoptSmokeInvoice",
  tableName: "adopt_smoke_invoice",
  properties: {
    invoiceNo: { type: "string", primary: true },
    customer: { type: "string" },
    // The legacy sheet stores `total` as numeric cells (USER_ENTERED), so the
    // property MUST be number — a string declaration makes every polling pass
    // quarantine the row as invalid_cell (observed number vs declared string;
    // §11 finding — seeding cell-kind validation is a §9 follow-up).
    total: { type: "number" },
  },
});

const projections = {
  spreadsheetId,
  entities: {
    AdoptSmokeInvoice: {
      systemState: { tabName: SYSTEM_TAB, registeredRange: "A:D" },
      syncConflicts: { tabName: CONFLICTS_TAB, registeredRange: "A:O" },
      userInput: { tabName: TAB, registeredRange: "A:D" },
      userOwnedFields: ["invoiceNo", "customer", "total"],
    },
  },
};

const RUN = { runId: RUN_ID, spreadsheetId, spreadsheetUrl: sheet.spreadsheetUrl, tab: TAB, steps: {} };
const events = { polling: [], reconciliation: [], effectErrors: [], pollingErrors: [] };
let service;

function serviceOpts(mode) {
  return {
    dbName: DB_PATH,
    entities: [AdoptSmokeInvoice],
    projections,
    writerId: `adopt-smoke-writer-${RUN_ID}`,
    workerId: `adopt-smoke-worker-${RUN_ID}`,
    maxEffects: 200,
    pollingIntervalMs: 30_000,
    pollingFullScanIntervalMs: 3_600_000,
    reconciliationIntervalMs: 10_000,
    effectIdleIntervalMs: 1_000,
    // Direct Google Sheets API mode (ADC) — mandatory for adopt (MVP), and the
    // provider's safe default pacing (900 ms / 1,000) applies.
    googleSheetsApi: {},
    adopt: {
      mode,
      entities: {
        AdoptSmokeInvoice: {
          tabName: TAB,
          identityFrom: "auto",
          // §12: legacy-header variant carries the explicit header → property
          // bindings recorded by the prepare script.
          ...(sheet.columnMap === undefined ? {} : { columnMap: sheet.columnMap }),
        },
      },
    },
    onPollingReport: (r) => events.polling.push({ t: Date.now(), rowsScanned: r.rowsScanned, changedRows: r.changedRows, appliedRows: r.appliedRows, quarantinedRows: r.quarantinedRows, unknownBusinessKeyRows: r.unknownBusinessKeyRows, duplicateBusinessKeyRows: r.duplicateBusinessKeyRows }),
    onPollingError: (e) => events.pollingErrors.push(String(e?.message ?? e)),
    onReconciliationReport: (r) => events.reconciliation.push({ t: Date.now(), effectsEnqueued: r.effectsEnqueued }),
    onEffectError: (e) => events.effectErrors.push(String(e?.message ?? e)),
  };
}

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " — " + JSON.stringify(detail) : ""}`);
  return { name, ok, detail };
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };

try {
  // ============================================================ step 1: dry-run
  let report = null;
  try {
    await createInternalSyncService(serviceOpts("dry-run"));
    throw new Error("dry-run must not start the service");
  } catch (error) {
    assert(error instanceof ExistingSheetAdoptionDryRunReportError, `dry-run threw unexpected error: ${error?.constructor?.name}: ${error?.message}`);
    report = error.report;
  }
  const ent = report.entities[0];
  const bindings = Object.fromEntries(ent.bindings.map((b) => [b.field, b.columnLetter]));
  // §12: with a columnMap the resolved PK column's header is the MAPPED
  // legacy header (e.g. "Invoice No"), not the property name.
  const expectedPkColumn = sheet.columnMap === undefined
    ? "invoiceNo"
    : Object.entries(sheet.columnMap).find(([, property]) => property === "invoiceNo")?.[0];
  const s1 = [
    check("dry-run.ok", report.ok === true, { ok: report.ok }),
    check("dry-run.status-ready", ent.status === "ready", { status: ent.status }),
    check("dry-run.bindings", bindings.invoiceNo === "B" && bindings.customer === "C" && bindings.total === "D", bindings),
    check("dry-run.ignored-memo", ent.ignoredColumns.some((c) => c.header === "memo" && c.columnLetter === "A"), ent.ignoredColumns),
    check("dry-run.contiguous", ent.contiguity === "contiguous", { contiguity: ent.contiguity, segments: ent.segments }),
    check("dry-run.no-column-occupied", !ent.problems.some((p) => p.code === "COLUMN_OCCUPIED"), ent.problems.map((p) => p.code)),
    check("dry-run.no-error-problems", !ent.problems.some((p) => p.severity === "error"), ent.problems),
    check("dry-run.pk-existing-column", ent.pk.source === "existing-column" && ent.pk.column === expectedPkColumn, ent.pk),
    check("dry-run.rows", ent.totalRows === ROWS && ent.emptyRows === 0, { totalRows: ent.totalRows, emptyRows: ent.emptyRows }),
    check("dry-run.rowid-to-be-added", ent.columnsToBeAdded.includes("__hikoutei_row_id"), ent.columnsToBeAdded),
    check("dry-run.tabs-to-provision", ent.tabsToProvision.includes(SYSTEM_TAB) && ent.tabsToProvision.includes(CONFLICTS_TAB), ent.tabsToProvision),
  ];
  RUN.steps["1-dry-run"] = { pass: s1.every((c) => c.ok), checks: s1, report: ent };

  // ============================================================ step 2: adopt
  const before = await withRetry(() => api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(title,sheetId)" }, opt), "get-before");
  const tabsBefore = before.data.sheets.map((s) => s.properties.title);
  assert(!tabsBefore.includes(SYSTEM_TAB) && !tabsBefore.includes(CONFLICTS_TAB), "system tabs must not pre-exist");

  service = await createInternalSyncService(serviceOpts("adopt"));
  await sleep(2_000); // give provisioning a beat to settle

  const after = await withRetry(() => api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(title)" }, opt), "get-after");
  const tabsAfter = after.data.sheets.map((s) => s.properties.title);
  const nowVisible = tabsAfter.includes(SYSTEM_TAB) && tabsAfter.includes(CONFLICTS_TAB);

  const adoptedValues = await readTab("A1:E21");
  const headerRow = adoptedValues[0] ?? [];
  const anchors = adoptedValues.slice(1).map((r) => r[4]);
  const expectedAnchors = Array.from({ length: ROWS }, (_, i) => `entity:INV-${pad(i + 1)}`);
  const cellsPreserved = JSON.stringify(adoptedValues.map((r) => r.slice(0, 4))) === JSON.stringify(baseline);
  // §12: with a columnMap the LEGACY headers must be preserved verbatim.
  const legacyHeadersPreserved = sheet.columnMap === undefined
    ? undefined
    : JSON.stringify(headerRow.slice(0, 4)) === JSON.stringify(baseline[0]);
  const s2 = [
    check("adopt.system-tabs-provisioned", nowVisible, { before: tabsBefore.length, systemTab: tabsAfter.includes(SYSTEM_TAB), conflictsTab: tabsAfter.includes(CONFLICTS_TAB) }),
    check("adopt.rowid-header-appended", headerRow[4] === "__hikoutei_row_id", headerRow),
    check("adopt.deterministic-anchors", JSON.stringify(anchors) === JSON.stringify(expectedAnchors), { first: anchors[0], last: anchors.at(-1) }),
    check("adopt.existing-cells-preserved", cellsPreserved, cellsPreserved ? undefined : "A1:D21 diverged from baseline"),
    ...(legacyHeadersPreserved === undefined ? [] : [check("adopt.legacy-headers-preserved", legacyHeadersPreserved === true)]),
  ];
  RUN.steps["2-adopt"] = { pass: s2.every((c) => c.ok), checks: s2 };

  // ============================================================ step 3: seeding
  const db = new DatabaseSync(DB_PATH);
  const count = (sql, ...params) => db.prepare(sql).get(...params).n;
  const bindingsCount = count("SELECT COUNT(*) AS n FROM row_binding WHERE state = 'active'");
  const anchorsCount = count("SELECT COUNT(*) AS n FROM row_binding WHERE state = 'active' AND anchor_reference LIKE 'entity:%'");
  const entitiesCount = count("SELECT COUNT(*) AS n FROM entity_state WHERE status = 'active'");
  const bizkeyCount = count("SELECT COUNT(*) AS n FROM business_key_index WHERE state = 'active'");
  const visibleCount = count("SELECT COUNT(*) AS n FROM sheet_visible_state WHERE projection = 'user_input' AND confirmed_snapshot_hash IS NOT NULL");
  const quarantineCount = count("SELECT COUNT(*) AS n FROM quarantine_record");
  // Terra review (nice-to-have #4): verify EVERY anchor↔entity_id pair 1:1,
  // not just a LIMIT 1 sample. Anchor = entity:<visible pk>; canonical id =
  // entity:<logicalSheetId>:<pk>. The canonical prefix is DERIVED from the
  // first binding so the smoke does not hardcode the logical sheet id.
  const allBindings = db.prepare("SELECT anchor_reference, entity_id, state FROM row_binding ORDER BY entity_id").all();
  const firstPk = allBindings[0]?.anchor_reference?.slice("entity:".length) ?? "";
  const CANON_PREFIX = allBindings[0]?.entity_id?.slice(0, allBindings[0].entity_id.length - firstPk.length) ?? "";
  const expectedPairs = Array.from({ length: ROWS }, (_, i) => ({
    anchor_reference: `entity:INV-${pad(i + 1)}`,
    entity_id: `${CANON_PREFIX}INV-${pad(i + 1)}`,
    state: "active",
  }));
  const pairsMatch = JSON.stringify(allBindings.map((b) => ({ anchor_reference: b.anchor_reference, entity_id: b.entity_id, state: b.state }))) === JSON.stringify(expectedPairs);
  const sampleBinding = allBindings[0];
  const s3 = [
    check("seed.row-binding-20", bindingsCount === ROWS && anchorsCount === ROWS, { bindingsCount, anchorsCount }),
    check("seed.entity-state-20", entitiesCount === ROWS, { entitiesCount }),
    check("seed.business-key-index-20", bizkeyCount === ROWS, { bizkeyCount }),
    check("seed.visible-state-hashes-20", visibleCount === ROWS, { visibleCount }),
    check("seed.no-quarantine", quarantineCount === 0, { quarantineCount }),
    check("seed.anchor-entity-pairs-1to1", pairsMatch, pairsMatch ? undefined : { sample: allBindings.slice(0, 3) }),
    check("seed.anchor-shape", sampleBinding.anchor_reference === `entity:${sampleBinding.entity_id.slice(CANON_PREFIX.length)}` && sampleBinding.state === "active", sampleBinding),
  ];
  RUN.steps["3-seeding"] = { pass: s3.every((c) => c.ok), checks: s3 };

  // ============================================================ step 4: System_State backfill
  const backfillStart = Date.now();
  let systemRows = [];
  while (Date.now() - backfillStart < 180_000) {
    systemRows = await readSystemTab();
    if (systemRows.length >= ROWS + 1) break;
    await sleep(5_000);
  }
  const dataRows = systemRows.slice(1).filter((r) => r.some((c) => (c ?? "") !== ""));
  const backfilledPk = new Set(dataRows.map((r) => r[0]));
  const expectedPk = new Set(Array.from({ length: ROWS }, (_, i) => `INV-${pad(i + 1)}`));
  // Terra review (nice-to-have #5): verify projected CONTENT, not just the PK
  // column. System_State row layout: [pk, customer, total, tombstone].
  const byPk = new Map(dataRows.map((r) => [r[0], r]));
  const contentMatches = [...expectedPk].every((pk) => {
    const i = Number(pk.slice(4));
    const row = byPk.get(pk);
    return row !== undefined && row[1] === customers[i % customers.length] && String(row[2]) === String(i * 100);
  });
  const s4 = [
    check("backfill.system-tab-20-rows", dataRows.length === ROWS, { dataRows: dataRows.length, elapsedMs: Date.now() - backfillStart }),
    check("backfill.all-pks-present", [...expectedPk].every((pk) => backfilledPk.has(pk)), { missing: [...expectedPk].filter((pk) => !backfilledPk.has(pk)) }),
    check("backfill.field-values-match", contentMatches, contentMatches ? undefined : "customer/total projection values diverge from seeded data"),
  ];
  RUN.steps["4-backfill"] = { pass: s4.every((c) => c.ok), checks: s4, reconciliationEvents: events.reconciliation.length };

  // ============================================================ step 5: edit absorption (D6)
  const EDITED_PK = "INV-004";
  const canonicalId = `${CANON_PREFIX}${EDITED_PK}`;
  const beforeEdit = db.prepare("SELECT normalized_value FROM entity_field_state WHERE entity_id = ? AND field_name = 'customer'").get(canonicalId);
  await withRetry(() => api.spreadsheets.values.update({ spreadsheetId, range: `${TAB}!C${EDIT_ROW}`, valueInputOption: "USER_ENTERED", requestBody: { values: [[EDIT_VALUE]] } }, opt), "edit-cell");
  const pollReport = await service.pollingSupervisor.runOnce();
  await sleep(500);
  const afterEdit = db.prepare("SELECT normalized_value FROM entity_field_state WHERE entity_id = ? AND field_name = 'customer'").get(canonicalId);
  const revision = db.prepare("SELECT entity_revision FROM entity_state WHERE entity_id = ?").get(canonicalId);

  // System_State projection should refresh to the absorbed value.
  const projStart = Date.now();
  let projRow = null;
  while (Date.now() - projStart < 60_000) {
    const sysNow = await readSystemTab();
    projRow = sysNow.slice(1).find((r) => r[0] === EDITED_PK);
    if (projRow?.[1] === EDIT_VALUE) break;
    await sleep(3_000);
  }
  const quarantineAfterEdit = count("SELECT COUNT(*) AS n FROM quarantine_record");
  const parseNorm = (json) => { try { return JSON.parse(json)?.value; } catch { return json; } };
  const s5 = [
    check("absorb.sqlite-updated", parseNorm(afterEdit?.normalized_value) === EDIT_VALUE, { before: parseNorm(beforeEdit?.normalized_value), after: parseNorm(afterEdit?.normalized_value) }),
    check("absorb.revision-advanced", (revision?.entity_revision ?? 0) >= 2, revision),
    check("absorb.no-quarantine", quarantineAfterEdit === 0, { quarantineAfterEdit }),
    check("absorb.no-unknown-keys", (pollReport?.unknownBusinessKeyRows ?? 0) === 0 && (pollReport?.quarantinedRows ?? 0) === 0, { unknown: pollReport?.unknownBusinessKeyRows, quarantined: pollReport?.quarantinedRows }),
    check("absorb.system-projection-updated", projRow?.[1] === EDIT_VALUE, { row: projRow, elapsedMs: Date.now() - projStart }),
  ];
  RUN.steps["5-absorption"] = { pass: s5.every((c) => c.ok), checks: s5 };

  // ============================================================ step 6: cleanup safety (D5)
  const reconBefore = events.reconciliation.length;
  const cleanupStart = Date.now();
  while (Date.now() - cleanupStart < 180_000 && events.reconciliation.length === reconBefore) await sleep(5_000);
  await sleep(8_000); // let any enqueued cleanup effects land
  // Terra review (should-fix #3): close the slow-delete race — before reading
  // the tab, assert the outbox is fully drained AND that no delete effect was
  // enqueued at all (a misbehaving cleanup scan would enqueue
  // user_input_delete, which could otherwise land AFTER the 8s sleep).
  const nonTerminal = count("SELECT COUNT(*) AS n FROM sheet_effect_outbox WHERE status IN ('pending', 'processing', 'delivery_uncertain')");
  const deleteEffects = count("SELECT COUNT(*) AS n FROM sheet_effect_outbox WHERE effect_kind IN ('user_input_delete', 'resolution_delete')");
  const postCleanup = await readTab("A1:E21");
  const postCells = JSON.stringify(postCleanup.map((r) => r.slice(0, 4)));
  const expectedAfterEdit = baseline.map((r, i) => (i === EDIT_ROW - 1 ? [r[0], r[1], EDIT_VALUE, r[3]] : r));
  const postAnchors = postCleanup.slice(1).map((r) => r[4]);
  const entitiesAfter = count("SELECT COUNT(*) AS n FROM entity_state WHERE status = 'active'");
  const quarantineAfterCleanup = count("SELECT COUNT(*) AS n FROM quarantine_record");
  const s6 = [
    check("cleanup.reconciliation-ran", events.reconciliation.length > reconBefore, { scans: events.reconciliation.length - reconBefore }),
    check("cleanup.outbox-drained-no-deletes", nonTerminal === 0 && deleteEffects === 0, { nonTerminal, deleteEffects }),
    check("cleanup.rows-preserved", postCells === JSON.stringify(expectedAfterEdit), postCells === JSON.stringify(expectedAfterEdit) ? undefined : "tab cells diverged after cleanup scan"),
    check("cleanup.anchors-preserved", JSON.stringify(postAnchors) === JSON.stringify(expectedAnchors), { first: postAnchors[0] }),
    check("cleanup.entities-still-20", entitiesAfter === ROWS, { entitiesAfter }),
    check("cleanup.no-quarantine", quarantineAfterCleanup === 0, { quarantineAfterCleanup }),
  ];
  RUN.steps["6-cleanup"] = { pass: s6.every((c) => c.ok), checks: s6 };

  db.close();
  RUN.pass = Object.values(RUN.steps).every((s) => s.pass);
} catch (error) {
  RUN.pass = false;
  RUN.error = { message: String(error?.message ?? error), stack: error?.stack?.split("\n").slice(0, 6) };
  console.error("SMOKE ERROR:", error);
} finally {
  if (service) { try { await service.close(); } catch (e) { console.error("close error:", e); } }
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(ARTIFACT, JSON.stringify(RUN, null, 2), { mode: 0o600 });
  console.log(`\nSMOKE ${RUN.pass ? "PASSED" : "FAILED"} — artifact: ${ARTIFACT}`);
  process.exit(RUN.pass ? 0 : 1);
}