/**
 * Receipt-band and column-scoped base-read coverage for the direct Google
 * Sheets API provider (B-structure payload reduction).
 *
 * These tests pin the READ-SHAPE contracts:
 * (a) after applied batches the next dispatch requests the receipt TAIL band
 *     (never the historical `A1:F1048576` whole-tab read);
 * (b) a missing/trusted-broken cursor (blank sentinel after truncation) falls
 *     back to the byte-identical full receipt read;
 * (c) a human-added duplicate identity row is still detected fail-closed with
 *     the narrowed (identity-column-only) base read;
 * (d) receipt and target append positions stay exact across banded reads.
 *
 * Everything runs over the credential-free stub transport.
 */

import { describe, expect, it } from "vitest";
import { computeSyncVisibleHash } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { FastAppendRow } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { GoogleSheetsApiSyncProvider } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import type { GoogleSheetsApiTransport } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import {
  GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
  GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightFields.js";
import { GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME } from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import { StubSheetsTransport, StubSpreadsheet } from "./support/StubSheetsTransport.js";
import { SYSTEM_HEADERS } from "./support/googleSheetsFixtures.js";
import { GOOGLE_SHEETS_API_RECEIPT_HEADERS } from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";

const SPREADSHEET_ID = "stub-spreadsheet";
const SYSTEM_SHEET_ID = "entity:users:system_state";
const ORDERS_SHEET_ID = "orders:system_state";

const SYSTEM_DEFINITION: RegisteredSyncProjectionDefinition = {
  sheet: {
    logicalSheetId: "entity:users",
    physicalSheetId: SYSTEM_SHEET_ID,
    spreadsheetId: SPREADSHEET_ID,
    tabName: "Users_System",
    // system_state tabs carry no system row-id column: A:C is the full span.
    registeredRange: "A:C",
    projection: "system_state",
    schemaVersion: 1,
    ownershipManifestJson: "{}",
    businessKeyField: "id",
    anchorMode: "business_key",
  },
  headers: [...SYSTEM_HEADERS],
};

const ORDERS_DEFINITION: RegisteredSyncProjectionDefinition = {
  sheet: {
    logicalSheetId: "entity:orders",
    physicalSheetId: ORDERS_SHEET_ID,
    spreadsheetId: SPREADSHEET_ID,
    tabName: "Orders_System",
    registeredRange: "A:C",
    projection: "system_state",
    schemaVersion: 1,
    ownershipManifestJson: "{}",
    businessKeyField: "id",
    anchorMode: "business_key",
  },
  headers: [...SYSTEM_HEADERS],
};

function buildProvider(
  transport: GoogleSheetsApiTransport,
  definitions: readonly RegisteredSyncProjectionDefinition[] = [SYSTEM_DEFINITION],
): GoogleSheetsApiSyncProvider {
  return new GoogleSheetsApiSyncProvider({
    spreadsheetId: SPREADSHEET_ID,
    definitions,
    transport,
    requestTimeoutMs: 60_000,
    rateLimitIntervalMs: 0,
  });
}

function appendRows(prefix: string): FastAppendRow[] {
  const identity = `${prefix}-0000`;
  return [{
    effectId: `append-${identity}`,
    payloadHash: `payload-${identity}`,
    anchor: `anchor-${identity}`,
    fields: {
      id: { kind: "string", value: identity },
      status: { kind: "string", value: "pending" },
      __typed_sheets_deleted: { kind: "boolean", value: false },
    },
  }];
}

function appendRequest(prefix: string) {
  return {
    physicalSheetId: SYSTEM_SHEET_ID,
    sheetName: "Users_System",
    registeredRange: "A:C",
    projection: "system_state" as const,
    schemaVersion: 1,
    rows: appendRows(prefix),
  };
}

/** Every BASE-mask data read (excludes the range-less enumeration). */
function dataCalls(transport: StubSheetsTransport) {
  return transport.getSpreadsheetRequests.filter(
    (request) => request.ranges.length > 0 &&
      request.fields === GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
  );
}

/** The receipt-tab range requested by one data read (undefined if absent). */
function receiptRange(call: { readonly ranges: readonly string[] }): string | undefined {
  return call.ranges.find((range) => range.includes(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME));
}

describe("receipt read cursor (tail band + fallback)", () => {
  it("reads only the receipt tail band after applied batches", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    // Dispatch 1: the receipt tab does not exist yet; the batch creates it
    // with header row 1 and the first receipt at row 2.
    expect((await provider.fastAppendRows(appendRequest("first"))).results[0]?.status)
      .toBe("applied");
    // Dispatch 2: no verified READ coverage exists yet (a write never
    // advances the cursor), so the receipt tab is read in FULL once and the
    // cursor settles at the parsed tail (row 2).
    expect((await provider.fastAppendRows(appendRequest("second"))).results[0]?.status)
      .toBe("applied");
    const callsBefore = dataCalls(transport).length;
    const fullCall = dataCalls(transport)[callsBefore - 1]!;
    expect(receiptRange(fullCall)).toBe(
      `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F1048576`,
    );

    // Dispatch 3: the band starts AT the cursor row (the sentinel receipt)
    // and NEVER asks for the historical whole-tab range.
    expect((await provider.fastAppendRows(appendRequest("third"))).results[0]?.status)
      .toBe("applied");
    const bandedCall = dataCalls(transport)[dataCalls(transport).length - 1]!;
    expect(receiptRange(bandedCall)).toBe(
      `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A2:F1048576`,
    );
    expect(bandedCall.ranges).not.toContain(
      `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F1048576`,
    );
  });

  it("falls back to the historical full receipt read when the sentinel vanishes", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await provider.fastAppendRows(appendRequest("first"));
    await provider.fastAppendRows(appendRequest("second"));
    // Dispatch 3 bands from the cursor row 2 and settles it at row 3.
    await provider.fastAppendRows(appendRequest("third"));
    const bandedBefore = receiptRange(
      dataCalls(transport)[dataCalls(transport).length - 1]!,
    );
    expect(bandedBefore).toContain("!A2:F");

    // Delete the receipt DATA rows (keeping the header): the cursor now
    // points at a blank row — the tab-shrunken-below-the-cursor case.
    const receiptTab = spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
    if (receiptTab === undefined) throw new Error("receipt tab missing");
    for (const key of [...receiptTab.cells.keys()]) {
      const row = Number(key.split(",")[0]);
      if (row >= 1) receiptTab.cells.delete(key);
    }

    const callsBefore = dataCalls(transport).length;
    const result = await provider.fastAppendRows(appendRequest("fourth"));
    expect(result.results[0]?.status).toBe("applied");
    // The dispatch first tried the band, then re-ran the historical FULL
    // read (byte-identical fallback): two data calls, the last one asking
    // for A1:F1048576.
    const dispatchCalls = dataCalls(transport).slice(callsBefore);
    expect(dispatchCalls.length).toBe(2);
    expect(receiptRange(dispatchCalls[0]!)).toContain("!A3:F");
    expect(receiptRange(dispatchCalls[1]!)).toBe(
      `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F1048576`,
    );
    // The full read found no receipts and rebuilt coverage from row 1, so
    // the fourth batch's receipt landed at row 2 (fresh tab semantics).
    expect(receiptTab.cell(1, 0)?.userEnteredValue?.stringValue).toBe("append-fourth-0000");
  });

  it("replays an effect from MORE THAN ONE prior batch after cursor advances", async () => {
    // Regression (review 5차, Critical): the tail band alone only covers
    // receipts appended since the previous read. An effect whose ack was lost
    // is re-dispatched batches later, when its receipt row already sits
    // BELOW the advanced cursor — the cumulative memo must still classify
    // it as a replay instead of re-appending or failing delivery-uncertain.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await provider.fastAppendRows(appendRequest("first"));
    await provider.fastAppendRows(appendRequest("second"));
    await provider.fastAppendRows(appendRequest("third"));
    await provider.fastAppendRows(appendRequest("fourth"));
    const systemTab = spreadsheet.findTab("Users_System")!;
    const receiptTab = spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)!;
    const before = systemTab.lastContentRow();
    const receiptsBefore = receiptTab.lastContentRow();
    // "first"'s receipt (row 2) sits three band starts below the cursor.
    const replayFirst = await provider.fastAppendRows(appendRequest("first"));
    expect(replayFirst.results.map((entry) => entry.status)).toEqual(["applied"]);
    const replaySecond = await provider.fastAppendRows(appendRequest("second"));
    expect(replaySecond.results.map((entry) => entry.status)).toEqual(["applied"]);
    // No duplicate target rows and no duplicate receipt rows were appended.
    expect(systemTab.lastContentRow()).toBe(before);
    expect(receiptTab.lastContentRow()).toBe(receiptsBefore);
    expect(replayFirst.results[0]?.visibleHash).toBeDefined();
  });

  it("replays a same-effectId re-dispatch straight to the provider after banding", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await provider.fastAppendRows(appendRequest("first"));
    await provider.fastAppendRows(appendRequest("second"));
    // Third dispatch replays the FIRST batch's rows: the cursor never
    // advances past receipts written after the previous READ, so its receipt
    // (row 2) is exactly the band sentinel and stays visible.
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    const before = systemTab.lastContentRow();
    const replay = await provider.fastAppendRows(appendRequest("first"));
    expect(replay.results.map((entry) => entry.status)).toEqual(["applied"]);
    expect(systemTab.lastContentRow()).toBe(before);
  });

  it("keeps append positions exact across banded reads", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await provider.fastAppendRows(appendRequest("one"));
    await provider.fastAppendRows(appendRequest("two"));
    await provider.fastAppendRows(appendRequest("three"));
    await provider.fastAppendRows(appendRequest("four"));
    const systemTab = spreadsheet.findTab("Users_System");
    const receiptTab = spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
    if (systemTab === undefined || receiptTab === undefined) throw new Error("tabs missing");
    // Target rows 2..5 in dispatch order (identity band supplies exact
    // nextAppendRow), receipts rows 2..5 in the same order, header intact.
    for (const [index, prefix] of ["one", "two", "three", "four"].entries()) {
      expect(systemTab.cell(1 + index, 0)?.userEnteredValue?.stringValue)
        .toBe(`${prefix}-0000`);
      expect(receiptTab.cell(1 + index, 0)?.userEnteredValue?.stringValue)
        .toBe(`append-${prefix}-0000`);
    }
    expect(receiptTab.cell(0, 0)?.userEnteredValue?.stringValue)
      .toBe("effectId");
    // Stub lastContentRow() is 0-based: 1-based rows 2..5 → last index 4.
    expect(receiptTab.lastContentRow()).toBe(4);
    expect(systemTab.lastContentRow()).toBe(4);
  });
});

describe("receipt accumulation seeding (burst over a deep history)", () => {
  /**
   * Seeded receipt-history depth. Parameterized because the FIRST dispatch
   * after a cold cursor parses the whole tab once (stub grid materialization
   * is O(rows)); 20k rows ≈ 6 columns of cells and stays well under a
   * second here. Lower this if the suite's runtime budget tightens.
   */
  const SEED_ROWS = 20_000;
  const BURST_BATCHES = 5;
  const BURST_ROWS = 100;

  /** Parses the 1-based start row of one receipt-tab range. */
  function receiptStartRow(range: string): number {
    const match = new RegExp(`'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A(\\d+):`).exec(range);
    if (match === null || match[1] === undefined) throw new Error(`not a receipt range: ${range}`);
    return Number(match[1]);
  }

  it("bands over a seeded history without re-reading it and applies each effect once", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    // Deep synthetic receipt history: rows 2..SEED_ROWS+1, all unrelated
    // effectIds (unique hashes; the visible-hash is computed ONCE and reused
    // — the memo only needs parseable, non-colliding evidence).
    const sharedHash = computeSyncVisibleHash({ id: { kind: "string", value: "seed" } });
    const seededRows = Array.from({ length: SEED_ROWS }, (_, index) => [
      `seed-${String(index)}`,
      `seed-payload-${String(index)}`,
      "applied",
      sharedHash,
      1,
      "2024-01-01T00:00:00.000Z",
    ]);
    spreadsheet.addTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, {
      headers: [...GOOGLE_SHEETS_API_RECEIPT_HEADERS],
      rows: seededRows,
      hidden: true,
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    // BURST: several multi-row append dispatches over the seeded history.
    const receiptRangesByDispatch: string[][] = [];
    let seenDataCalls = 0;
    for (let batch = 0; batch < BURST_BATCHES; batch += 1) {
      const rows: FastAppendRow[] = Array.from({ length: BURST_ROWS }, (_, index) => {
        const identity = `b${String(batch)}r${String(index).padStart(3, "0")}`;
        return {
          ...appendRequest(identity).rows[0]!,
          effectId: `append-${identity}-0000`,
          payloadHash: `payload-${identity}-0000`,
          anchor: `anchor-${identity}-0000`,
        };
      });
      const result = await provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows,
      });
      expect(result.results.every((entry) => entry.status === "applied")).toBe(true);
      const calls = dataCalls(transport);
      receiptRangesByDispatch.push(
        calls.slice(seenDataCalls).flatMap((call) => call.ranges.filter((range) =>
          range.includes(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME))),
      );
      seenDataCalls = calls.length;
    }

    // (1) The receipt reads are COLD-FULL-ONCE, then TAIL BANDS over the
    // seeded history. Unified engine: the cold full read may span several
    // sequential CHUNKED bands (each ≤ the cell/byte caps), always starting
    // at the header row; every steady dispatch reads only the tail band at
    // the cursor, so the 20k seeded rows are never re-parsed by one.
    expect(receiptRangesByDispatch[0]?.[0]).toMatch(
      new RegExp(`'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F`),
    );
    for (const ranges of receiptRangesByDispatch.slice(1)) {
      expect(ranges.length).toBeGreaterThanOrEqual(1);
      for (const range of ranges) {
        expect(receiptStartRow(range)).toBeGreaterThanOrEqual(SEED_ROWS);
      }
    }

    // (2) Effects applied EXACTLY ONCE: target rows are the burst rows only
    // (no seeded-history interference shifted or duplicated them), and the
    // receipt tab holds its seeded history plus one receipt per burst row.
    const systemTab = spreadsheet.findTab("Users_System")!;
    const receiptTab = spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)!;
    const totalReceipts = 1 + SEED_ROWS + BURST_BATCHES * BURST_ROWS;
    expect(systemTab.lastContentRow()).toBe(BURST_BATCHES * BURST_ROWS);
    expect(receiptTab.lastContentRow()).toBe(totalReceipts - 1);
    const effectIds = new Set<string>();
    for (const [key, cell] of receiptTab.cells) {
      const [row, col] = key.split(",").map(Number) as [number, number];
      if (col !== 0 || row === 0) continue;
      const value = cell.userEnteredValue?.stringValue;
      if (value !== undefined) expect(effectIds.has(value)).toBe(false);
      if (value !== undefined) effectIds.add(value);
    }
    expect(effectIds.size).toBe(SEED_ROWS + BURST_BATCHES * BURST_ROWS);
    // The seeded history itself is untouched at the tab head.
    expect(receiptTab.cell(1, 0)?.userEnteredValue?.stringValue).toBe("seed-0");
  }, 60_000);
});

describe("column-scoped base read", () => {
  /** Pre-create the hidden receipt tab (headers only) so dispatches are
   * steady-state scoped reads — a receipt-init dispatch (tab absent) is
   * deliberately downgraded to the historical whole-table read. */
  function seedReceiptTab(spreadsheet: StubSpreadsheet): void {
    spreadsheet.addTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, {
      headers: [...GOOGLE_SHEETS_API_RECEIPT_HEADERS],
    });
  }

  it("detects a human-added duplicate identity row through the identity band", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: SYSTEM_HEADERS,
      rows: [
        ["dup", "pending", false],
        ["dup", "other", false],
      ],
    });
    seedReceiptTab(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await expect(provider.fastAppendRows(appendRequest("fresh")))
      .rejects.toThrow(/sync identity is duplicated: dup/);
    // The base read never asked for the middle/end columns tab-wide: only
    // the header row and the identity band carry the whole-tab evidence.
    const firstData = dataCalls(transport)[0]!;
    expect(firstData.ranges.filter((range) => range.includes("Users_System")))
      .toEqual(["'Users_System'!A1:C1", "'Users_System'!A2:A1048576"]);
  });

  it("reads a fresh batch's replay evidence without the full width", async () => {
    // An append-only steady dispatch reads the target tab through the
    // column-scoped bands only (the planned row itself is re-read
    // full-width+formats by the scoped verification pass when a replay or
    // numeric identity needs it); prove the write applies end-to-end.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: SYSTEM_HEADERS,
      rows: [["u1", "pending", false]],
    });
    seedReceiptTab(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    // One append keeps the run insert-only (updates need the worker effect
    // shape; the payload-level contract this pins is the REQUEST SHAPE).
    await provider.fastAppendRows(appendRequest("extra"));
    const dataCall = dataCalls(transport)[0]!;
    expect(dataCall.ranges.filter((range) => range.includes("Users_System")))
      .toEqual(["'Users_System'!A1:C1", "'Users_System'!A2:A1048576"]);
    const systemTab = spreadsheet.findTab("Users_System");
    expect(systemTab?.cell(2, 0)?.userEnteredValue?.stringValue).toBe("extra-0000");
  });

  it("falls back to the whole-table full-evidence read when key rows are not contiguous", async () => {
    // A human cleared the identity cell of a middle row: the scoped bands
    // cannot prove the row's NON-key columns are blank, so the dispatch must
    // refuse scoping and re-read the whole table with the full-evidence mask
    // (historical fail-closed validation over every user column).
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: SYSTEM_HEADERS,
      rows: [
        ["r1", "pending", false],
        // null = NO cell at all (an empty string keeps a real-API string
        // wrapper and is visible evidence, exactly like the full read).
        [null, "human note", false],
        ["r3", "pending", false],
      ],
    });
    seedReceiptTab(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    // The full-evidence re-read then fails closed exactly like the
    // historical read: a content row without a required identity.
    await expect(provider.fastAppendRows(appendRequest("fresh")))
      .rejects.toThrow(/sync identity is missing at row 3/);
    const scopedCall = dataCalls(transport)[0]!;
    expect(scopedCall.ranges.filter((range) => range.includes("Users_System")))
      .toEqual(["'Users_System'!A1:C1", "'Users_System'!A2:A1048576"]);
    // The fallback whole-table read carries the full-evidence (format) mask.
    const fallbackCall = transport.getSpreadsheetRequests.filter(
      (request) => request.ranges.length > 0 &&
        request.fields !== GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
    )[0]!;
    expect(fallbackCall.ranges.filter((range) => range.includes("Users_System")))
      .toEqual(["'Users_System'!A1:C1048576"]);
  });

  it("downgrades a receipt-init dispatch to the historical whole-table read", async () => {
    // Without the receipt tab the scoped path must NOT stack its conditional
    // verification read on top of the stale receipt-init refresh: the base
    // read itself is the historical whole-table full-evidence one.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: SYSTEM_HEADERS,
      rows: [["u1", "pending", false]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    expect((await provider.fastAppendRows(appendRequest("first"))).results[0]?.status)
      .toBe("applied");
    // No BASE-mask read ever touched the TARGET tab scoped: the whole base
    // read was the historical full-evidence one (the only BASE-mask request
    // is the receipt-tab refresh itself, which carries no target range).
    expect(dataCalls(transport).filter(
      (request) => request.ranges.some((range) => range.includes("Users_System")),
    )).toHaveLength(0);
    const firstData = transport.getSpreadsheetRequests.filter(
      (request) => request.ranges.length > 0,
    )[0]!;
    expect(firstData.ranges.some((range) =>
      /^'Users_System'!A1:C1048576$/.test(range),
    )).toBe(true);
  });
});

describe("leased paced-request budget (5차 re-review fixes)", () => {
  it("falls back to exactly ONE full receipt read when the API rejects the band (HTTP 400)", async () => {
    // Regression (review 5차 re-review, High): a transport-rejected tail
    // band first ran the full recovery read inside the catch, THEN failed
    // the band-start sentinel check on that full result and read the whole
    // tab a second time — enumeration + band + TWO full reads + write,
    // past the four-call budget. The rejection handler now resets the
    // cursor and the sentinel check is skipped for its recovery result.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await provider.fastAppendRows(appendRequest("first"));
    await provider.fastAppendRows(appendRequest("second"));
    // Third dispatch bands from the cursor row 2 and settles at row 3.
    await provider.fastAppendRows(appendRequest("third"));
    // The real API proves an out-of-bounds band with a pre-mutation 400.
    transport.fault = { kind: "rejectBandedReceiptRange" };
    const before = transport.getSpreadsheetRequests.length;
    const result = await provider.fastAppendRows(appendRequest("fourth"));
    expect(result.results[0]?.status).toBe("applied");
    const dispatch = transport.getSpreadsheetRequests.slice(before);
    // enumeration + the REJECTED band + exactly ONE full recovery read.
    expect(dispatch).toHaveLength(3);
    expect(dispatch[0]?.ranges).toHaveLength(0);
    expect(receiptRange(dispatch[1]!)).toContain("!A3:F");
    expect(receiptRange(dispatch[2]!)).toBe(
      `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F1048576`,
    );
    // Coverage re-based from the full read: the NEXT dispatch bands from the
    // re-parsed tail again instead of staying in full-read mode.
    const after = transport.getSpreadsheetRequests.length;
    expect((await provider.fastAppendRows(appendRequest("fifth"))).results[0]?.status)
      .toBe("applied");
    const rebased = transport.getSpreadsheetRequests.slice(after);
    expect(rebased.length).toBe(2);
    expect(receiptRange(dataCalls(transport)[dataCalls(transport).length - 1]!))
      .toContain("!A4:F");
  });

  it("consolidates verification-overflow routes into ONE enumeration-reusing full read", async () => {
    // Regression (review 5차 re-review, High): a multi-route dispatch whose
    // band plan overflows the 40-range budget re-entered the per-route
    // preflight, stacking one enumeration + one whole-table read PER
    // overflow route (4 reads + write for one overflow, 5 for a mixed
    // shared-verification dispatch). Every still-pending route now resolves
    // through ONE whole-table full-evidence read built from the base read's
    // own enumeration, with the band request skipped entirely.
    const spreadsheet = new StubSpreadsheet();
    const usersRows: (string | number | boolean)[][] = [];
    for (let index = 0; index < 82; index += 1) {
      usersRows.push([`u${String(index)}`, `s${String(index)}`, false]);
    }
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS, rows: usersRows });
    spreadsheet.addTab("Orders_System", {
      headers: SYSTEM_HEADERS,
      rows: [["o0", "s0", false]],
    });
    // 41 Users receipts sit on EVEN rows (2,4,...,82): banding them exceeds
    // the per-request range budget. The Orders replay needs only ONE band,
    // so it must fold into the SAME consolidated read.
    const replayIndexes = Array.from({ length: 41 }, (_, step) => step * 2);
    const fieldsFor = (index: number): FastAppendRow["fields"] => ({
      id: { kind: "string", value: `u${String(index)}` },
      status: { kind: "string", value: `s${String(index)}` },
      __typed_sheets_deleted: { kind: "boolean", value: false },
    });
    const ordersFields: FastAppendRow["fields"] = {
      id: { kind: "string", value: "o0" },
      status: { kind: "string", value: "s0" },
      __typed_sheets_deleted: { kind: "boolean", value: false },
    };
    spreadsheet.addTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, {
      headers: [...GOOGLE_SHEETS_API_RECEIPT_HEADERS],
      rows: [
        ...replayIndexes.map((index) => [
          `replay-u${String(index)}`,
          `payload-u${String(index)}`,
          "applied",
          computeSyncVisibleHash(fieldsFor(index)),
          1,
          "2024-01-01T00:00:00.000Z",
        ]),
        [
          "replay-o0",
          "payload-o0",
          "applied",
          computeSyncVisibleHash(ordersFields),
          1,
          "2024-01-01T00:00:00.000Z",
        ],
      ],
      hidden: true,
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport, [SYSTEM_DEFINITION, ORDERS_DEFINITION]);
    const usersRoute = {
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state" as const,
      sheetName: "Users_System",
      registeredRange: "A:C",
      schemaVersion: 1,
    };
    const ordersRoute = {
      physicalSheetId: ORDERS_SHEET_ID,
      projection: "system_state" as const,
      sheetName: "Orders_System",
      registeredRange: "A:C",
      schemaVersion: 1,
    };
    const replayRows: FastAppendRow[] = [
      ...replayIndexes.map((index) => ({
        ...usersRoute,
        effectId: `replay-u${String(index)}`,
        payloadHash: `payload-u${String(index)}`,
        fields: fieldsFor(index),
      })),
      { ...ordersRoute, effectId: "replay-o0", payloadHash: "payload-o0", fields: ordersFields },
    ];
    const result = await provider.fastAppendRows({ ...usersRoute, rows: replayRows });
    expect(result.results).toHaveLength(42);
    expect(result.results.every((entry) => entry.status === "applied")).toBe(true);
    // Every row was a receipt replay: no mutation was dispatched.
    expect(transport.batchUpdateCalls).toBe(0);
    const requests = transport.getSpreadsheetRequests;
    // Unified engine: the overflow-consolidation whole-table read is GONE.
    // 42 verification bands exceed the 40-range per-request budget and
    // expand into SEQUENTIAL band requests: enumeration + scoped base read
    // + two verification requests, every hashed cell still from ONE band
    // snapshot and no uncapped single request anywhere.
    expect(requests).toHaveLength(4);
    expect(requests[0]?.ranges).toHaveLength(0);
    expect(requests[1]?.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS);
    expect(requests[2]?.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS);
    expect(requests[3]?.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS);
    const verifyRanges = [...(requests[2]?.ranges ?? []), ...(requests[3]?.ranges ?? [])];
    expect(verifyRanges).toHaveLength(42);
    expect(requests[2]?.ranges.length).toBeLessThanOrEqual(40);
    // No uncapped WHOLE-TARGET-TABLE read anywhere (the small seeded
    // receipt tab legitimately collapses to its single historical open band).
    for (const range of requests.flatMap((request) => request.ranges)) {
      expect(range).not.toMatch(/System'!A1:[A-Z]+1048576$/);
    }

    // The legacy single-route path keeps the same SHAPE: an over-budget band
    // plan on ONE tab is enumeration + base + sequential verify bands.
    const before = transport.getSpreadsheetRequests.length;
    const single = await provider.fastAppendRows({
      ...usersRoute,
      rows: replayIndexes.map((index) => ({
        effectId: `replay-u${String(index)}`,
        payloadHash: `payload-u${String(index)}`,
        fields: fieldsFor(index),
      })),
    });
    expect(single.results.every((entry) => entry.status === "applied")).toBe(true);
    const dispatch = transport.getSpreadsheetRequests.slice(before);
    expect(dispatch).toHaveLength(4);
    expect(dispatch[1]?.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS);
    expect(dispatch[2]?.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS);
  });
});
