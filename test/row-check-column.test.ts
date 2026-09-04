/**
 * Check-column feature tests: the deterministic row-check token formula
 * (written at row creation, maintained by the Sheet's recalc engine) and
 * the narrow polling reads that gate the historical full-field observation.
 *
 * Everything runs on the credential-free StubSheetsTransport, whose in-memory
 * model EVALUATES the row-check formula at read time via the SAME contracts
 * renderer the SQLite side uses (mirroring the live-API behavior proven by
 * the P7 experiment: recalc visible on the FIRST read after batchUpdate;
 * cell-targeted updateCells preserves neighbors).
 */

import { describe, expect, it } from "vitest";

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import {
  computeRowCheckValue,
  renderRowCheckCell,
  SYNC_ROW_CHECK_HEADER,
} from "@hikoutei/contracts/sheets/rowCheck.js";
import type {
  ReadSyncRowChecksRequest,
  ReadSyncSnapshotRequest,
  SyncProjectionEffect,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { computeSyncVisibleHash } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { absentValue, presentValue, notApplicableValue } from "@hikoutei/contracts/state/index.js";
import { GoogleSheetsApiSyncProvider } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import { GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME } from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import { GOOGLE_SHEETS_API_ROW_CHECK_FIELDS } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightFields.js";
import { buildRowCheckFormula } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/rowCheckFormula.js";
import {
  StubSheetsTransport,
  StubSpreadsheet,
  toStubCell,
  type StubSheet,
} from "./support/StubSheetsTransport.js";

const SPREADSHEET_ID = "stub-spreadsheet";
const INPUT_SHEET_ID = "users:user_input";
const INPUT_HEADERS = ["id", "score", "active"] as const;
// Registered range A:D = 3 user columns + the trailing __hikoutei_row_id
// system column; the check column is E (outside the range).
const INPUT_RANGE = "A:D";

const cell = {
  string: (value: string): NormalizedCell => ({ kind: "string", value }),
  number: (value: number): NormalizedCell => ({ kind: "number", value }),
  bool: (value: boolean): NormalizedCell => ({ kind: "boolean", value }),
  date: (value: string): NormalizedCell => ({ kind: "date", value }),
};

function inputDefinition(): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "entity:users",
      physicalSheetId: INPUT_SHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      tabName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "business_key",
    },
    headers: [...INPUT_HEADERS],
    // Production user_input definitions carry the business-key header
    // (registeredTypedSheetsProjectionDefinitions); the narrow check read
    // receives the same name per request.
    identityField: "id",
  };
}

function buildProvider(transport: StubSheetsTransport): GoogleSheetsApiSyncProvider {
  return new GoogleSheetsApiSyncProvider({
    spreadsheetId: SPREADSHEET_ID,
    definitions: [inputDefinition()],
    transport,
    requestTimeoutMs: 60_000,
    rateLimitIntervalMs: 0,
  });
}

/** Seed a provisioned input tab (registered headers + row-id + check). */
function seedInputTab(
  spreadsheet: StubSpreadsheet,
  opts: { readonly checkHeader?: boolean } = {},
): StubSheet {
  const tab = spreadsheet.addTab("Users_Input", {
    headers: opts.checkHeader === false
      ? [...INPUT_HEADERS, "__hikoutei_row_id"]
      : [...INPUT_HEADERS, "__hikoutei_row_id", SYNC_ROW_CHECK_HEADER],
  });
  spreadsheet.addTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, {
    headers: ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"],
    hidden: true,
  });
  return tab;
}

/** Write the row-check formula cell for one 1-based row of a seeded tab. */
function seedCheckFormula(tab: StubSheet, rowNumber: number): void {
  tab.cells.set(`${rowNumber - 1},4`, {
    userEnteredValue: {
      formulaValue: buildRowCheckFormula(1, 3, rowNumber),
    },
  });
}

function seedRow(
  tab: StubSheet,
  rowNumber: number,
  fields: { id: NormalizedCell; score?: NormalizedCell; active?: NormalizedCell },
  anchor: string,
  withFormula = true,
): void {
  tab.cells.set(`${rowNumber - 1},0`, toStubCell(fields.id));
  tab.cells.set(`${rowNumber - 1},1`, toStubCell(fields.score ?? null));
  tab.cells.set(`${rowNumber - 1},2`, toStubCell(fields.active ?? null));
  tab.cells.set(`${rowNumber - 1},3`, toStubCell(anchor));
  if (withFormula) seedCheckFormula(tab, rowNumber);
}

function createEffect(
  effectId: string,
  anchor: string,
  fields: Readonly<Record<string, NormalizedCell>>,
): SyncProjectionEffect {
  const targetVisibleHash = computeSyncVisibleHash(fields);
  return {
    effectId,
    payloadHash: `payload-${effectId}`,
    effectKind: "candidate_reconcile",
    physicalSheetId: INPUT_SHEET_ID,
    projection: "user_input",
    targetKind: "entity",
    targetId: `entity:${anchor}`,
    rowBindingId: presentValue(`row:${anchor}`),
    conflictId: absentValue(),
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: absentValue(),
    payload: {
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      schemaVersion: 1,
      targetAnchor: anchor,
      fields,
      targetVisibleHash,
      createIfMissing: true,
      expectedCandidateHash: notApplicableValue(),
    },
  };
}

function rowChecksRequest(
  overrides: Partial<ReadSyncRowChecksRequest> = {},
): ReadSyncRowChecksRequest {
  return {
    physicalSheetId: INPUT_SHEET_ID,
    sheetName: "Users_Input",
    registeredRange: INPUT_RANGE,
    projection: "user_input",
    schemaVersion: 1,
    identityField: "id",
    ...overrides,
  };
}

describe("check-column formula at row creation", () => {
  it("writes the deterministic token-join formula cell into the check column on create", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const fields = {
      id: cell.string("u1"),
      score: cell.number(3.14),
      active: cell.bool(true),
    };
    const result = await provider.applyEffects({
      physicalSheetId: INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
      postconditionMode: "deferred",
      effects: [createEffect("create-u1", "anchor-u1", fields)],
    });
    expect(result.results.map((entry) => entry.status)).toEqual(["applied"]);

    // The append batch carries one extra updateCells request: the row-check
    // formula at column E (0-based 4) referencing ONLY that row's user
    // data columns (A:C).
    const batch = transport.appliedBatchUpdates[0] ?? [];
    const checkWrite = batch.find((request) =>
      request.kind === "updateCells" && request.startColumnIndex === 4);
    expect(checkWrite?.kind).toBe("updateCells");
    if (checkWrite?.kind !== "updateCells") return;
    expect(checkWrite.rows).toEqual([[{
      userEnteredValue: { formulaValue: buildRowCheckFormula(1, 3, 2) },
    }]]);
    expect(tab.cell(1, 4)?.userEnteredValue?.formulaValue)
      .toBe(buildRowCheckFormula(1, 3, 2));

    // The stub's recalc engine computes the token join on the FIRST read
    // after the batch, and the value equals the SQLite-side expectation
    // renderer byte-for-byte (the determinism pair proven for
    // string/int/decimal/bool in the live experiment).
    const [checks] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(checks?.status).toBe("checks_available");
    expect(checks?.rows).toHaveLength(1);
    const row = checks?.rows[0];
    expect(row?.rowNumber).toBe(2);
    expect(row?.identity).toEqual(cell.string("u1"));
    const expected = computeRowCheckValue([...INPUT_HEADERS], (header) =>
      (fields as Readonly<Record<string, NormalizedCell>>)[header]);
    expect(row?.check).toEqual(presentValue(expected));
    expect(expected).toBe("s2:u1|n4:3.14|b4:TRUE");
  });

  it("keeps the created row findable: the check column never enters range-scoped reads or hashes", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedInputTab(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const fields = { id: cell.string("u1"), score: cell.number(1), active: cell.bool(false) };
    await provider.applyEffects({
      physicalSheetId: INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
      postconditionMode: "deferred",
      effects: [createEffect("create-u1", "anchor-u1", fields)],
    });
    // The values-only whole-table read (fast-path preflight) and the
    // snapshot read both STOP at the registered range end (D): the check
    // column stays invisible to every existing hash/blank-row/anchor rule.
    const [rows] = await provider.readRowsBatch([{
      physicalSheetId: INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
      headers: [...INPUT_HEADERS],
    }]);
    expect(rows?.rows[0]?.fields["id"]).toEqual(cell.string("u1"));
    expect(Object.keys(rows?.rows[0]?.fields ?? {})).toEqual([...INPUT_HEADERS]);
    const snapshot = await provider.readSnapshot({
      physicalSheetId: INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
    } as ReadSyncSnapshotRequest);
    expect(Object.keys(snapshot.rows[0]?.cells ?? {})).toEqual([...INPUT_HEADERS]);
  });

  it("recalculates the check after a field update and preserves the formula cell", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    seedRow(tab, 2, { id: cell.string("u1"), score: cell.number(1), active: cell.bool(true) }, "anchor-u1");
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const updateFields: Readonly<Record<string, NormalizedCell>> = {
      id: cell.string("u1"),
      score: cell.number(2),
      active: cell.bool(true),
    };
    await provider.applyEffects({
      physicalSheetId: INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
      postconditionMode: "deferred",
      effects: [{
        ...createEffect("update-u1", "anchor-u1", updateFields),
        expectedVisibleRevision: 1,
        expectedVisibleHash: computeSyncVisibleHash({
          id: cell.string("u1"),
          score: cell.number(1),
          active: cell.bool(true),
        }),
        payload: {
          ...createEffect("update-u1", "anchor-u1", updateFields).payload,
          createIfMissing: false,
          targetVisibleHash: computeSyncVisibleHash(updateFields),
        },
      }],
    });
    // The update touched only column B; the E-column formula survived
    // (cell-targeted updateCells preserves neighbors — proven 3/3) and the
    // recalc reflects the new value on the next narrow read.
    expect(tab.cell(1, 4)?.userEnteredValue?.formulaValue)
      .toBe(buildRowCheckFormula(1, 3, 2));
    const [checks] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(checks?.rows[0]?.check)
      .toEqual(presentValue(computeRowCheckValue([...INPUT_HEADERS],
        (header) => ({ id: cell.string("u1"), score: cell.number(2), active: cell.bool(true) }[header]))));
  });
});

describe("narrow row-check read", () => {
  it("requests ONLY the identity + anchor + check column bands with the row-check mask", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    seedRow(tab, 2, { id: cell.string("u1"), score: cell.number(45292) }, "anchor-u1");
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await provider.readRowChecksBatch([rowChecksRequest()]);
    const last = transport.getSpreadsheetRequests[transport.getSpreadsheetRequests.length - 1];
    expect(last?.ranges).toEqual([
      "'Users_Input'!A1:A1048576",
      "'Users_Input'!D1:D1048576",
      "'Users_Input'!E1:E1048576",
    ]);
    expect(last?.fields).toBe(GOOGLE_SHEETS_API_ROW_CHECK_FIELDS);
  });

  it("renders mixed value shapes exactly as SQLite's expected renderer does", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    const rows: {
      readonly anchor: string;
      readonly fields: { id: NormalizedCell; score?: NormalizedCell; active?: NormalizedCell };
    }[] = [
      { anchor: "a1", fields: { id: cell.string("keep"), score: cell.number(1), active: cell.bool(true) } },
      { anchor: "a2", fields: { id: cell.string("blank-score"), active: cell.bool(false) } },
      { anchor: "a3", fields: { id: cell.string("no-bool"), score: cell.number(-12.75) } },
      { anchor: "a4", fields: { id: cell.string("date-ish"), score: cell.date("2024-01-01T00:00:00.000Z") } },
    ];
    rows.forEach((row, index) => seedRow(tab, index + 2, row.fields, row.anchor));
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [checks] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(checks?.status).toBe("checks_available");
    expect(checks?.rows).toHaveLength(rows.length);
    checks?.rows.forEach((observed, index) => {
      const fields = rows[index]!.fields as Readonly<Record<string, NormalizedCell | undefined>>;
      expect(observed.check).toEqual(presentValue(
        computeRowCheckValue([...INPUT_HEADERS], (header) => fields[header] ?? null) ?? "",
      ));
    });
    // Spot-check the exact token semantics (blank AND empty string render
    // the zero-length `s` token; booleans are `b`-tagged TRUE/FALSE;
    // numbers/dates render `n`-tagged in standard form; text is `s`-tagged).
    expect(checks?.rows[1]?.check).toEqual(presentValue("s11:blank-score|s0:|b5:FALSE"));
    expect(checks?.rows[2]?.check).toEqual(presentValue("s7:no-bool|n6:-12.75|s0:"));
    expect(checks?.rows[3]?.check).toEqual(presentValue("s8:date-ish|n5:45292|s0:"));
  });

  it("encodes delimiter collisions and blank permutations into DISTINCT checks", async () => {
    // REGRESSION (review finding 1): the historical `TEXTJOIN` gate was
    // non-injective — ["a|b","c"] and ["a","b|c"] joined identically, and
    // blank permutations collapsed. The token encoding escapes the
    // delimiter and gives EVERY column a positional token, so rows whose
    // joined TEXT would have collided compute different checks and the
    // human edit is never hidden.
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    seedRow(tab, 2, { id: cell.string("a|b"), score: cell.string("c") }, "anchor-x");
    seedRow(tab, 3, { id: cell.string("a"), score: cell.string("b|c") }, "anchor-y");
    // Row 4: a value moved across a blank boundary ("z", blank, blank) vs
    // (blank, blank, "z") — the old ignore_empty join collapsed both to "z".
    seedRow(tab, 4, { id: cell.string("z") }, "anchor-z1");
    seedRow(tab, 5, { id: cell.string(""), score: cell.string("z") }, "anchor-z2");
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [checks] = await provider.readRowChecksBatch([rowChecksRequest()]);
    const texts = checks?.rows.map((row) => row.check.kind === "present" ? row.check.value : null) ?? [];
    expect(texts[0]).toBe("s3:a|b|s1:c|s0:");
    expect(texts[1]).toBe("s1:a|s3:b|c|s0:");
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts[2]).toBe("s1:z|s0:|s0:");
    expect(texts[3]).toBe("s0:|s1:z|s0:");
    expect(texts[2]).not.toBe(texts[3]);
  });

  it("reports NO check evidence when the formula cell was replaced by a literal", async () => {
    // REGRESSION (review finding 2): a human pastes the check cell's own
    // text as a LITERAL. The literal renders the same string forever (it
    // cannot recalc), so later data edits would be silently missed. The
    // read verifies formula provenance: only the exact generated row
    // formula yields check evidence.
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    seedRow(tab, 2, { id: cell.string("u1"), score: cell.number(1) }, "anchor-u1");
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [before] = await provider.readRowChecksBatch([rowChecksRequest()]);
    const expected = before?.rows[0]?.check;
    expect(expected).toEqual(presentValue("s2:u1|n1:1|s0:"));

    // Replace the formula with a literal that EQUALS the current expected
    // check, then edit the data: a provenance-blind read would keep saying
    // "clean"; the provenance gate reports no evidence for the tampered row.
    tab.cells.set("1,4", toStubCell(cell.string("s2:u1|n1:1|s0:")));
    tab.cells.set("1,1", toStubCell(cell.number(999)));
    const [after] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(after?.rows[0]?.check).toEqual(absentValue());
  });

  it("reports the system row-id (anchor) band for row-mapping evidence", async () => {
    // REGRESSION (review finding 4): the narrow read must carry the anchor
    // cell so the polling gate can see anchor deletion/duplication/
    // misplacement instead of silently calling the row clean.
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    seedRow(tab, 2, { id: cell.string("u1"), score: cell.number(1) }, "anchor-u1");
    seedRow(tab, 3, { id: cell.string("u2"), score: cell.number(2) }, "anchor-u2");
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [checks] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(checks?.rows[0]?.anchor).toEqual(presentValue("anchor-u1"));
    expect(checks?.rows[1]?.anchor).toEqual(presentValue("anchor-u2"));

    // A human deletes the anchor cell: the row stays visible (identity +
    // check carry content) and the anchor reads absent — the gate's
    // escalation trigger (unit-covered in the polling gate tests).
    tab.cells.delete("1,3");
    const [after] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(after?.rows[0]?.anchor).toEqual(absentValue());
    expect(after?.rows[0]?.check.kind).toBe("present");
  });

  it("surfaces a human edit as a check mismatch on the very next read", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    seedRow(tab, 2, { id: cell.string("u1"), score: cell.number(1) }, "anchor-u1");
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [before] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(before?.rows[0]?.check).toEqual(presentValue("s2:u1|n1:1|s0:"));

    // Human edits the score cell directly in the sheet.
    tab.cells.set("1,1", toStubCell(cell.number(999)));
    const [after] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(after?.rows[0]?.check).toEqual(presentValue("s2:u1|n3:999|s0:"));
  });

  it("reports checks_unavailable for a legacy tab without the check header", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet, { checkHeader: false });
    seedRow(tab, 2, { id: cell.string("u1") }, "anchor-u1", false);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [checks] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(checks?.status).toBe("checks_unavailable");
  });

  it("treats legacy rows without a formula as absent check evidence (mixed mode)", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    // Row 2 was created before the feature (no formula); row 3 after.
    seedRow(tab, 2, { id: cell.string("legacy") }, "anchor-legacy", false);
    seedRow(tab, 3, { id: cell.string("modern") }, "anchor-modern", true);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [checks] = await provider.readRowChecksBatch([rowChecksRequest()]);
    expect(checks?.status).toBe("checks_available");
    expect(checks?.rows).toEqual([
      { rowNumber: 2, identity: cell.string("legacy"), anchor: presentValue("anchor-legacy"), check: absentValue() },
      { rowNumber: 3, identity: cell.string("modern"), anchor: presentValue("anchor-modern"), check: presentValue("s6:modern|s0:|s0:") },
    ]);
  });
});

describe("rowNumbers-scoped observation (targeted full-field band read)", () => {
  function seededTab(spreadsheet: StubSpreadsheet): StubSheet {
    const tab = seedInputTab(spreadsheet);
    seedRow(tab, 2, { id: cell.string("r2") }, "anchor-r2");
    seedRow(tab, 3, { id: cell.string("r3") }, "anchor-r3");
    seedRow(tab, 4, { id: cell.string("r4") }, "anchor-r4");
    return tab;
  }

  function inputSnapshotRequest(
    overrides: Partial<ReadSyncSnapshotRequest> = {},
  ): ReadSyncSnapshotRequest {
    return {
      physicalSheetId: INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
      ...overrides,
    };
  }

  it("reads only the header row + the requested contiguous band and snapshots only those rows", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seededTab(spreadsheet);
    // A human formula edit inside a targeted row must still be classified
    // FORMULA (metadata-preserving mask), exactly like the whole-table read.
    tab.cells.set("3,1", { userEnteredValue: { formulaValue: "=1+1" }, effectiveValue: { numberValue: 2 } });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const [observed] = await provider.observeSnapshots([
      inputSnapshotRequest({ rowNumbers: [3, 4] }),
    ]);
    const last = transport.getSpreadsheetRequests[transport.getSpreadsheetRequests.length - 1];
    // Header band + ONE contiguous run 3:4 over the registered width only.
    expect(last?.ranges).toEqual([
      "'Users_Input'!A1:D1",
      "'Users_Input'!A3:D4",
    ]);
    expect(observed?.snapshot.rows.map((row) => row.rowNumber)).toEqual([3, 4]);
    expect(observed?.snapshot.rows[0]?.cells["id"]?.normalizedCell).toEqual(cell.string("r3"));
    expect(observed?.snapshot.rows[1]?.cells["score"]?.cellKind).toBe("formula");
    // Clean rows outside the bands are absent (they were skipped by the
    // gate); anchors are still resolved from the banded system column.
    expect(observed?.snapshot.rows[0]?.physicalAnchor).toEqual(presentValue("anchor-r3"));
    expect(observed?.anchors.assigned).toBe(0);
    expect(observed?.anchors.existing).toBe(2);
  });

  it("expands an over-budget band plan into sequential band requests (no whole-table degradation)", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedInputTab(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    // 45 scattered rows need 45 band ranges + header (> 40 per-request
    // budget): the unified engine SPREADS the plan across sequential
    // requests instead of degrading to one uncapped whole-table read.
    const rowNumbers = Array.from({ length: 45 }, (_, index) => index * 2 + 2);

    const [observed] = await provider.observeSnapshots([inputSnapshotRequest({ rowNumbers })]);
    const dataCalls = transport.getSpreadsheetRequests.filter((request) => request.ranges.length > 0);
    const bandRanges = dataCalls.flatMap((request) => [...request.ranges]);
    // Header + every requested row exactly once, ≤ 40 ranges per request,
    // and no whole-table range anywhere.
    expect(dataCalls.every((request) => request.ranges.length <= 40)).toBe(true);
    expect(bandRanges.filter((range) => range.endsWith(":D1"))).toHaveLength(1);
    const covered = bandRanges
      .flatMap((range) => {
        const match = /!A(\d+):D(\d+)$/.exec(range);
        if (match === null) return [];
        return Array.from({ length: Number(match[2]) - Number(match[1]) + 1 },
          (_, offset) => Number(match[1]) + offset);
      })
      .filter((row) => row >= 2);
    expect([...new Set(covered)].sort((a, b) => a - b))
      .toEqual([...rowNumbers].sort((a, b) => a - b));
    // The banded reply reassembles into one logical grid the historical
    // snapshot rules run over (this fixture's tab is header-only, so every
    // targeted row resolves blank — the point is the plan covered them all
    // without one uncapped whole-table request).
    expect(observed?.snapshot.rows).toHaveLength(0);
  });
});

describe("check-column polling read size", () => {
  it("keeps the polling read payload narrow versus the whole-table observation", async () => {
    // SIZE REGRESSION GUARD: 300 seeded rows; the gated read must stay
    // dramatically smaller than the historical whole-table polling
    // observation (readMode FULL — the exact mask the gate replaces,
    // carrying effectiveValue + formattedValue + BOTH number-format
    // wrappers + data validation per cell). The values-only
    // `readRowsBatch` preflight is NOT the replaced read and is much
    // smaller than an observation by construction.
    const spreadsheet = new StubSpreadsheet();
    const tab = seedInputTab(spreadsheet);
    for (let index = 0; index < 300; index += 1) {
      const id = `user-${String(index).padStart(4, "0")}`;
      tab.cells.set(`${index + 1},0`, toStubCell(cell.string(id)));
      tab.cells.set(`${index + 1},1`, toStubCell(cell.number(index)));
      tab.cells.set(`${index + 1},2`, toStubCell(cell.bool(index % 2 === 0)));
      tab.cells.set(`${index + 1},3`, toStubCell(`anchor-${id}`));
      tab.cells.set(`${index + 1},4`, { userEnteredValue: {
        formulaValue: buildRowCheckFormula(1, 3, index + 2),
      } });
    }
    const events: { readonly operation: string; readonly responseBytes?: number }[] = [];
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [inputDefinition()],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 0,
      onRequest: (event) => {
        events.push({ operation: event.operation, ...(event.responseBytes === undefined ? {} : { responseBytes: event.responseBytes }) });
      },
    });

    await provider.readRowChecksBatch([rowChecksRequest()]);
    const checksBytes = events.at(-1)?.responseBytes ?? 0;
    await provider.readSnapshot({
      physicalSheetId: INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: INPUT_RANGE,
      projection: "user_input",
      schemaVersion: 1,
      readMode: "full",
    } as ReadSyncSnapshotRequest);
    const observationBytes = events.at(-1)?.responseBytes ?? 0;
    expect(checksBytes).toBeGreaterThan(0);
    // The gated read carries three narrow bands (including the per-row
    // formula text the provenance check needs); the replaced observation
    // carries every cell's value + display + format wrappers. At least
    // 2x smaller on the stub; the live experiment measured ~2,200x.
    expect(checksBytes * 2).toBeLessThan(observationBytes);
  });
});

describe("row check renderer (contracts single source)", () => {
  it("renders one POSITIONAL token per column: tagged types, escaped text", () => {
    const fields: Readonly<Record<string, NormalizedCell | undefined>> = {
      a: cell.string("x"),
      b: null,
      c: cell.string(""),
      d: cell.number(0),
      e: cell.bool(false),
    };
    expect(computeRowCheckValue(["a", "b", "c", "d", "e"], (h) => fields[h] ?? null))
      .toBe("s1:x|s0:|s0:|n1:0|b5:FALSE");
  });

  it("is injective: delimiter collisions, blank permutations, and type twins never share a check", () => {
    const join = (a: NormalizedCell, b: NormalizedCell) =>
      computeRowCheckValue(["a", "b"], (h) => (h === "a" ? a : b))!;
    // Delimiter inside a text value cannot fake a column boundary.
    expect(join(cell.string("a|b"), cell.string("c")))
      .not.toBe(join(cell.string("a"), cell.string("b|c")));
    // A value moved across a blank boundary changes the check.
    expect(join(cell.string("z"), null)).not.toBe(join(null, cell.string("z")));
    // Type-aware: the string "12" never equals the number 12, and the
    // blank token never equals the one-character text "e".
    expect(join(cell.string("12"), null)).not.toBe(join(cell.number(12), null));
    expect(renderRowCheckCell(cell.string("e"))).not.toBe(renderRowCheckCell(null));
    // The escape-shaped "\|" string still cannot fake a boundary: the
    // length prefix, not any escape, defines the token end.
    expect(join(cell.string("a|b"), cell.string("c")))
      .not.toBe(join(cell.string("a"), cell.string("b|c")));
  });

  it("returns null when a header has no canonical value (not derivable)", () => {
    expect(computeRowCheckValue(["a", "b"], (header) =>
      header === "a" ? cell.string("x") : undefined)).toBe(null);
  });
});
