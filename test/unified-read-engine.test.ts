/**
 * Unified read engine coverage (design/unified-read-engine.md Phase 1).
 *
 * Pins the engine contracts the three migrated lanes rely on:
 * (a) band PLANNING: pure chunk/pack rules against the authoritative row
 *     bound (≤ 9 500 cells/range, ≤ 40 ranges/request, ≤ 5 MB estimate per
 *     request, the LAST band of an unproven extent stays open);
 * (b) size-based SPLITTING at 30k scale: every lane's oversized logical read
 *     expands into sequential paced requests — no request anywhere carries
 *     an uncapped whole-table range;
 * (c) REASSEMBLY: band replies merge into the exact rows/grids the lane
 *     parsers consumed from the historical single request (no dropped or
 *     duplicated rows across band boundaries);
 * (d) per-lane, per-band TELEMETRY: one event per executed band carrying its
 *     own RAW responseBytes on the declared pacing lane;
 * (e) receipt BANDS: the cross-band aggregate (header on band one, global
 *     duplicate detection, exact first/last parsed rows) feeding the
 *     unchanged cursor ladder, plus the refreshReceiptForWrite missing-tab
 *     400 classification.
 *
 * Everything runs credential-free over StubSheetsTransport (the seeded
 * 30k-scale tabs substitute for the live burst; the stub answers instantly,
 * so "no timeouts" is proven as "no request exceeds the caps" + per-band
 * byte telemetry far below the 10 s budget).
 */

import { describe, expect, it } from "vitest";

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import type {
  FastAppendRow,
  ReadSyncRowChecksRequest,
  SyncProjectionEffect,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { computeSyncVisibleHash } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { GoogleSheetsApiRequestEvent } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { absentValue, notApplicableValue, presentValue } from "@hikoutei/contracts/state/index.js";
import { GoogleSheetsApiSyncProvider } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import {
  GOOGLE_SHEETS_API_RECEIPT_HEADERS,
  GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import { GoogleSheetsApiTransportError } from "@hikoutei/sheets/sheets/providers/google-sheets-api/errors.js";
import {
  GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightFields.js";
import {
  MAX_READ_CELLS_PER_RANGE,
  MAX_READ_RANGES_PER_REQUEST,
  READ_BYTES_PER_CELL,
  READ_HARD_MAX_BYTES,
  READ_SOFT_TARGET_BYTES,
  createReadCalibration,
  estimatedRangeBytes,
  packReadRequests,
  planRowBands,
  rowsPerBand,
  type PlannedRange,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/readPlan.js";
import {
  StubSheetsTransport,
  StubSpreadsheet,
  toStubCell,
  type StubSheet,
} from "./support/StubSheetsTransport.js";
import { SYSTEM_HEADERS } from "./support/googleSheetsFixtures.js";

const SPREADSHEET_ID = "stub-spreadsheet";
const SYSTEM_SHEET_ID = "entity:users:system_state";

const SYSTEM_DEFINITION: RegisteredSyncProjectionDefinition = {
  sheet: {
    logicalSheetId: "entity:users",
    physicalSheetId: SYSTEM_SHEET_ID,
    spreadsheetId: SPREADSHEET_ID,
    tabName: "Users_System",
    registeredRange: "A:C",
    projection: "system_state",
    schemaVersion: 1,
    ownershipManifestJson: "{}",
    businessKeyField: "id",
    anchorMode: "business_key",
  },
  headers: [...SYSTEM_HEADERS],
};

const INPUT_SHEET_ID = "users:user_input";
const INPUT_RANGE = "A:D";

const INPUT_DEFINITION: RegisteredSyncProjectionDefinition = {
  sheet: {
    logicalSheetId: "entity:users-input",
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
  headers: ["id", "score", "active"],
  identityField: "id",
};

function buildProvider(
  transport: StubSheetsTransport,
  onRequest?: (event: GoogleSheetsApiRequestEvent) => void,
): GoogleSheetsApiSyncProvider {
  return new GoogleSheetsApiSyncProvider({
    spreadsheetId: SPREADSHEET_ID,
    definitions: [SYSTEM_DEFINITION, INPUT_DEFINITION],
    transport,
    requestTimeoutMs: 60_000,
    rateLimitIntervalMs: 0,
    ...(onRequest === undefined ? {} : { onRequest }),
  });
}

function inputRowChecksRequest(): ReadSyncRowChecksRequest {
  return {
    physicalSheetId: INPUT_SHEET_ID,
    sheetName: "Users_Input",
    registeredRange: INPUT_RANGE,
    projection: "user_input",
    schemaVersion: 1,
    identityField: "id",
  };
}

/** Seed a deep user_input tab: `count` rows starting at row 2. */
function seedInputRows(spreadsheet: StubSpreadsheet, count: number): StubSheet {
  const tab = spreadsheet.addTab("Users_Input", {
    headers: ["id", "score", "active", "__hikoutei_row_id", "__hikoutei_row_check"],
  });
  for (let index = 0; index < count; index += 1) {
    const row = index + 1; // 0-based
    tab.cells.set(`${row},0`, toStubCell({ kind: "string", value: `u${String(index)}` }));
    tab.cells.set(`${row},3`, toStubCell(`anchor-u${String(index)}`));
  }
  return tab;
}

function appendRow(index: number): FastAppendRow {
  const identity = `burst-${String(index).padStart(5, "0")}`;
  return {
    ...SYSTEM_ROUTE,
    effectId: `append-${identity}`,
    payloadHash: `payload-${identity}`,
    fields: {
      id: { kind: "string", value: identity },
      status: { kind: "string", value: "pending" },
      __typed_sheets_deleted: { kind: "boolean", value: false },
    },
  } as FastAppendRow;
}

const SYSTEM_ROUTE = {
  physicalSheetId: SYSTEM_SHEET_ID,
  sheetName: "Users_System",
  registeredRange: "A:C",
  projection: "system_state" as const,
  schemaVersion: 1,
};

/** Seed a deep system tab: `count` rows starting at row 2. */
function seedSystemRows(spreadsheet: StubSpreadsheet, count: number): StubSheet {
  const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
  for (let index = 0; index < count; index += 1) {
    const row = index + 1; // 0-based
    tab.cells.set(`${row},0`, toStubCell({ kind: "string", value: `u${String(index)}` }));
    tab.cells.set(`${row},1`, toStubCell({ kind: "string", value: "pending" }));
    tab.cells.set(`${row},2`, toStubCell({ kind: "boolean", value: false }));
  }
  return tab;
}

/** Seed a deep hidden receipt tab: `count` receipts with unique ids. */
function seedReceiptRows(spreadsheet: StubSpreadsheet, count: number): StubSheet {
  const rows: (string | number)[][] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push([
      `seed-${String(index)}`,
      `seed-payload-${String(index)}`,
      "applied",
      "a".repeat(64),
      1,
      "2024-01-01T00:00:00.000Z",
    ]);
  }
  return spreadsheet.addTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, {
    headers: [...GOOGLE_SHEETS_API_RECEIPT_HEADERS],
    rows,
    hidden: true,
  });
}

// ---------------------------------------------------------------------------
// A1 range inspection helpers (shared by the cap assertions)
// ---------------------------------------------------------------------------

interface ParsedBand {
  readonly sheet: string;
  readonly firstColumn: number;
  readonly lastColumn: number;
  readonly startRow: number;
  /** 1 048 576 for the open-ended last band. */
  readonly endRow: number;
}

function parseBand(range: string): ParsedBand {
  const match = /^'((?:[^']|'')*)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (match === null) throw new Error(`unparsable band: ${range}`);
  const letters = (value: string): number => {
    let index = 0;
    for (const character of value) index = index * 26 + (character.charCodeAt(0) - 64);
    return index;
  };
  return {
    sheet: match[1]!,
    firstColumn: letters(match[2]!),
    lastColumn: letters(match[4]!),
    startRow: Number(match[3]),
    endRow: Number(match[5]),
  };
}

/** Requested CELLS of a CLOSED band (open bands are excluded from the cap). */
function closedBandCells(band: ParsedBand): number {
  return (band.endRow - band.startRow + 1) * (band.lastColumn - band.firstColumn + 1);
}

/** Assert the engine's per-request invariants over one transport's calls. */
function expectCapsHonored(transport: StubSheetsTransport): void {
  for (const request of transport.getSpreadsheetRequests) {
    expect(request.ranges.length).toBeLessThanOrEqual(MAX_READ_RANGES_PER_REQUEST);
    for (const range of request.ranges) {
      const band = parseBand(range);
      if (band.endRow < 1_048_576) {
        expect(closedBandCells(band)).toBeLessThanOrEqual(MAX_READ_CELLS_PER_RANGE);
      }
    }
  }
}

describe("readPlan pure planner", () => {
  it("collapses small bounds to the byte-identical historical open band", () => {
    const calibration = createReadCalibration();
    const bands = planRowBands({
      quote: "'Users'!",
      firstLetter: "A",
      lastLetter: "F",
      columnCount: 6,
      fromRow: 1,
      rowBound: 1_000,
      evidence: "values-only",
      calibration,
    });
    expect(bands).toEqual([{ range: "'Users'!A1:F1048576", cells: 6_000 }]);
  });

  it("plans the historical open band unchunked when NO bound is known", () => {
    const bands = planRowBands({
      quote: "'Users'!",
      firstLetter: "B",
      lastLetter: "B",
      columnCount: 1,
      fromRow: 2,
      rowBound: undefined,
      evidence: "values-only",
      calibration: createReadCalibration(),
    });
    expect(bands).toEqual([{ range: "'Users'!B2:B1048576", cells: 0 }]);
  });

  it("chunks past the bound and keeps the LAST band open-ended", () => {
    const calibration = createReadCalibration();
    const bands = planRowBands({
      quote: "'Users'!",
      firstLetter: "B",
      lastLetter: "B",
      columnCount: 1,
      fromRow: 2,
      rowBound: 30_001,
      evidence: "row-checks",
      calibration,
    });
    const rows = rowsPerBand(1, "row-checks", calibration);
    // row-checks bytes/cell dominates before the cell cap for 1-column bands.
    expect(rows).toBe(Math.floor(READ_SOFT_TARGET_BYTES / READ_BYTES_PER_CELL["row-checks"]));
    for (const band of bands.slice(0, -1)) {
      const parsed = parseBand(band.range);
      expect(parsed.endRow - parsed.startRow + 1).toBe(rows);
      expect(parsed.endRow).toBeLessThan(1_048_576);
    }
    const last = parseBand(bands[bands.length - 1]!.range);
    expect(last.endRow).toBe(1_048_576);
    // Full contiguous coverage 2..bound with no gap or overlap.
    let expectedStart = 2;
    for (const band of bands) {
      const parsed = parseBand(band.range);
      expect(parsed.startRow).toBe(expectedStart);
      if (parsed.endRow < 1_048_576) expectedStart = parsed.endRow + 1;
    }
  });

  it("closes the last band when the caller proves the extent (row sets)", () => {
    const bands = planRowBands({
      quote: "'Users'!",
      firstLetter: "A",
      lastLetter: "D",
      columnCount: 4,
      fromRow: 80,
      rowBound: 90,
      exactLastRow: 90,
      evidence: "values+formats",
      calibration: createReadCalibration(),
    });
    expect(bands).toHaveLength(1);
    expect(bands[0]!.range).toBe("'Users'!A80:D90");
    expect(bands[0]!.range).not.toContain("1048576");
  });

  it("packs bands under the range cap AND the hard byte estimate", () => {
    const calibration = createReadCalibration();
    // 45 tiny bands: one request per 40 (range cap dominates).
    const tiny: PlannedRange[] = Array.from({ length: 45 }, (_, index) => ({
      range: `'T'!A${String(index + 1)}:A${String(index + 1)}`,
      cells: 1,
    }));
    const packed = packReadRequests(tiny, "values-only", calibration);
    expect(packed.map((request) => request.length)).toEqual([40, 5]);
    // 2 MB-estimate bands: only two fit under the 5 MB hard pack ceiling.
    const heavyCells = Math.floor(2_000_000 / READ_BYTES_PER_CELL["values-only"]);
    const heavy: PlannedRange[] = Array.from({ length: 3 }, (_, index) => ({
      range: `'T'!A${String(index + 1)}:A${String(index + 1)}`,
      cells: heavyCells,
    }));
    const heavyPacked = packReadRequests(heavy, "values-only", calibration);
    expect(heavyPacked).toHaveLength(2);
    for (const request of heavyPacked) {
      const bytes = request.reduce(
        (total, item) => total + estimatedRangeBytes(item, "values-only", calibration),
        0,
      );
      expect(bytes).toBeLessThanOrEqual(READ_HARD_MAX_BYTES);
    }
  });

  it("calibration grows estimates (budget reduction) and never shrinks below 1", () => {
    const calibration = createReadCalibration();
    calibration.observe("values-only", 1_000, 9_000_000); // 9 KB/cell vs 120 B/cell
    expect(calibration.ratioFor("values-only")).toBeGreaterThan(1);
    const inflated = calibration.ratioFor("values-only");
    expect(rowsPerBand(1, "values-only", calibration) * 1).toBeLessThan(
      Math.floor(READ_SOFT_TARGET_BYTES / READ_BYTES_PER_CELL["values-only"]),
    );
    // Bounded multiplier + a below-estimate sample never deflates the plan.
    calibration.observe("values-only", 1_000, 10);
    expect(calibration.ratioFor("values-only")).toBe(inflated);
    expect(inflated).toBeLessThanOrEqual(20);
  });
});

describe("lane A polling through the engine (30k scale)", () => {
  it("settles cold titles with ONE metadata enumeration, then bands the gate read", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedInputRows(spreadsheet, 30_000);
    const transport = new StubSheetsTransport(spreadsheet);
    const events: GoogleSheetsApiRequestEvent[] = [];
    const provider = buildProvider(transport, (event) => events.push(event));

    const [first] = await provider.readRowChecksBatch([inputRowChecksRequest()]);
    expect(first).toBeDefined();
    // First request of the cold instance: the range-less bound enumeration.
    expect(transport.getSpreadsheetRequests[0]?.ranges).toHaveLength(0);
    // Then SEQUENTIAL band requests (no single request covers 30k rows).
    expectCapsHonored(transport);
    const dataCalls = transport.getSpreadsheetRequests.slice(1);
    expect(dataCalls.length).toBeGreaterThan(1);
    for (const call of dataCalls) {
      expect(call.ranges.length).toBeGreaterThan(0);
    }
    // Reassembly correctness: every row 2..30001 present exactly once, in
    // order, and the LAST band really reached the deep rows (a bound-driven
    // chunk plan never truncates coverage).
    const rows = first!.rows;
    expect(rows).toHaveLength(30_000);
    expect(rows[0]!.rowNumber).toBe(2);
    expect(rows[rows.length - 1]!.rowNumber).toBe(30_001);

    // Per-band telemetry: one polling event per executed request, each
    // carrying its OWN responseBytes (rebound of the calibration chain).
    const readEvents = events.filter((event) => event.operation === "getSpreadsheet");
    expect(readEvents.length).toBe(transport.getSpreadsheetCalls);
    for (const event of readEvents) {
      expect(event.pacing).toBe("polling");
      expect(event.ok).toBe(true);
      expect(event.responseBytes).toBeGreaterThan(0);
      // Each band streamed a fraction of the tab: far below what a 10 s
      // read could accumulate at the observed live throughput.
      expect(event.responseBytes!).toBeLessThan(8_000_000);
    }

    // Warm cache: the second gate batch pays NO second enumeration.
    const callsBefore = transport.getSpreadsheetCalls;
    await provider.readRowChecksBatch([inputRowChecksRequest()]);
    const added = transport.getSpreadsheetRequests.slice(callsBefore);
    expect(added.some((request) => request.ranges.length === 0)).toBe(false);
  }, 120_000);

  it("reassembles a banded escalation observation without dropped or duplicated rows", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = seedSystemRows(spreadsheet, 12_000);
    // Anchor-less system_state rows are fine: this pins snapshot reassembly.
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const [observed] = await provider.observeSnapshots([{
      ...SYSTEM_ROUTE,
    }]);
    expectCapsHonored(transport);
    // The 12k-row whole-table read expanded into sequential bands...
    expect(transport.getSpreadsheetRequests.filter((request) => request.ranges.length > 0).length)
      .toBeGreaterThan(1);
    // ...and the snapshot reassembled exactly the seeded rows, in order.
    expect(observed!.snapshot.rows).toHaveLength(12_000);
    expect(observed!.snapshot.rows[0]!.rowNumber).toBe(2);
    expect(observed!.snapshot.rows[observed!.snapshot.rows.length - 1]!.rowNumber)
      .toBe(12_001);
    expect(tab.lastContentRow()).toBe(12_000);
  }, 120_000);
});

describe("lane B preflight base through the engine (30k receipts)", () => {
  it("cold receipt full read is chunked; the cursor bands immediately after", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemRows(spreadsheet, 30_000);
    seedReceiptRows(spreadsheet, 30_000);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.fastAppendRows({
      ...SYSTEM_ROUTE,
      rows: [appendRow(1)],
    });
    expect(result.results[0]!.status).toBe("applied");
    expectCapsHonored(transport);
    const receiptRanges = transport.getSpreadsheetRequests
      .filter((request) => request.fields === GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS)
      .flatMap((request) => request.ranges.filter((range) =>
        range.includes(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)));
    // The cold full read started at the HEADER (chunk 1) and expanded.
    expect(receiptRanges[0]).toMatch(new RegExp(`'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F\\d+$`));
    expect(receiptRanges.length).toBeGreaterThan(1);
    // The next dispatch reads ONLY the tail band from the cursor (deep row).
    const before = transport.getSpreadsheetCalls;
    await provider.fastAppendRows({ ...SYSTEM_ROUTE, rows: [appendRow(2)] });
    const tailRanges = transport.getSpreadsheetRequests.slice(before)
      .filter((request) => request.fields === GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS)
      .flatMap((request) => request.ranges.filter((range) =>
        range.includes(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)));
    expect(tailRanges.length).toBeGreaterThanOrEqual(1);
    for (const range of tailRanges) {
      expect(parseBand(range).startRow).toBeGreaterThan(30_000);
    }
  }, 180_000);

  it("fails closed on a duplicate effectId that straddles receipt bands", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemRows(spreadsheet, 10);
    const receiptTab = seedReceiptRows(spreadsheet, 4_000);
    // Re-key a DEEP receipt row (1-based 3501) to the SAME effectId as the
    // head row's receipt (1-based 2): the two copies land in DIFFERENT bands
    // of the cold full read (bands chunk at 1 583 receipts), so only a
    // cross-band aggregate can catch it.
    receiptTab.cells.set("3500,0", receiptTab.cell(1, 0)!);
    await expect(
      buildProvider(new StubSheetsTransport(spreadsheet))
        .fastAppendRows({ ...SYSTEM_ROUTE, rows: [appendRow(7)] }),
    ).rejects.toThrow(/duplicate effectId/);
  }, 120_000);
});

describe("refreshReceiptForWrite (receipt-init subvariant)", () => {
  it("classifies the missing-tab 400 as still-absent and creates the tab atomically", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemRows(spreadsheet, 3);
    const inner = new StubSheetsTransport(spreadsheet);
    let intercepted = 0;
    // A transport that rejects ONLY the write-lane receipt refresh range with
    // the real API's proven pre-mutation missing-range 400.
    const transport = {
      ...inner,
      getSpreadsheet: async (request: Parameters<StubSheetsTransport["getSpreadsheet"]>[0]) => {
        if (request.ranges.some((range) => range.includes(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME))) {
          intercepted += 1;
          throw new GoogleSheetsApiTransportError(
            "google_sheets_api_http_error",
            "Range (receipts) not from spreadsheet",
            presentValue(400),
            presentValue("INVALID_ARGUMENT"),
          );
        }
        return inner.getSpreadsheet(request);
      },
      batchUpdate: (request: Parameters<StubSheetsTransport["batchUpdate"]>[0]) =>
        inner.batchUpdate(request),
      getValues: (request: Parameters<StubSheetsTransport["getValues"]>[0]) =>
        inner.getValues(request),
    };
    const provider = buildProvider(transport as unknown as StubSheetsTransport);
    const result = await provider.fastAppendRows({ ...SYSTEM_ROUTE, rows: [appendRow(1)] });
    expect(intercepted).toBe(1);
    expect(result.results[0]!.status).toBe("applied");
    // The batch atomically created the receipt tab (addSheet) after the
    // classified-as-still-absent refresh.
    const created = inner.appliedBatchUpdates.some((batch) =>
      batch.some((request) => request.kind === "addSheet"));
    expect(created).toBe(true);
    expect(spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toBeDefined();
  });
});

describe("30k-scale end-to-end simulation (all lanes, no uncapped request)", () => {
  it("burst + gate + probe all stream within caps with bounded per-band bytes", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemRows(spreadsheet, 30_000);
    seedInputRows(spreadsheet, 30_000);
    seedReceiptRows(spreadsheet, 5_000);
    const transport = new StubSheetsTransport(spreadsheet);
    const events: GoogleSheetsApiRequestEvent[] = [];
    const provider = buildProvider(transport, (event) => events.push(event));

    // (1) Burst append over a deep tab + deep receipt history.
    const burst = Array.from({ length: 200 }, (_, index) => appendRow(100 + index));
    const result = await provider.fastAppendRows({ ...SYSTEM_ROUTE, rows: burst });
    expect(result.results.every((entry) => entry.status === "applied")).toBe(true);

    // (2) Polling gate over the deep user_input tab.
    const [checks] = await provider.readRowChecksBatch([inputRowChecksRequest()]);
    expect(checks!.rows.length).toBeGreaterThanOrEqual(30_000);

    // (3) Response-loss probe for one just-applied effect (write lane):
    // lands on the banded scoped base + band verification, never a
    // whole-table read.
    const first = burst[0]!;
    const effect: SyncProjectionEffect = {
      effectId: first.effectId,
      payloadHash: first.payloadHash!,
      effectKind: "candidate_reconcile",
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state",
      targetKind: "entity",
      targetId: "entity:burst-00100",
      rowBindingId: presentValue("row:burst-00100"),
      conflictId: absentValue(),
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      repairGuardHash: absentValue(),
      payload: {
        sheetName: "Users_System",
        registeredRange: "A:C",
        schemaVersion: 1,
        targetAnchor: "entity:burst-00100",
        fields: first.fields as Record<string, NormalizedCell>,
        targetVisibleHash: computeSyncVisibleHash(first.fields as Record<string, NormalizedCell>),
        createIfMissing: true,
        expectedCandidateHash: notApplicableValue(),
      },
    };
    const probe = await provider.readEffectPostcondition(effect);
    expect(probe.disposition).toBe("applied");

    // Core invariant: EVERY request of EVERY lane honors the caps — no
    // request anywhere still asks for an uncapped whole-table range.
    expectCapsHonored(transport);
    const readEvents = events.filter((event) => event.operation === "getSpreadsheet");
    expect(readEvents.length).toBeGreaterThan(5);
    for (const event of readEvents) {
      expect(event.responseBytes).toBeGreaterThan(0);
      expect(event.responseBytes!).toBeLessThan(12_000_000);
    }
    // Splitting actually happened (a single 10 s whole-table request would
    // have produced far fewer events with a giant payload).
    const lanes = new Set(readEvents.map((event) => event.pacing));
    expect(lanes.has("polling")).toBe(true);
    expect(lanes.has("preflight")).toBe(true);
    expect(lanes.has("write")).toBe(true);
  }, 240_000);
});
