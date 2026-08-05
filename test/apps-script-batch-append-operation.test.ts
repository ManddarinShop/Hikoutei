import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  createBatchAppendRowsOperation,
} from "../src/adapter/sheets/providers/apps-script-gateway/operations/write/batchAppendOperation.js";

const RECEIPT_HEADERS = ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"];

interface FakeRange {
  getValues: () => unknown[][];
  setValues: (values: unknown[][]) => void;
  setNumberFormat: (pattern: string) => void;
}

interface FakeSheetWrite {
  kind: "insertRowsAfter" | "setValues" | "setNumberFormat";
  row: number;
  column: number;
  count?: number;
}

interface FakeSheet {
  readonly name: string;
  getLastRow: () => number;
  getLastColumn: () => number;
  getRange: (row: number, column: number, numRows?: number, numColumns?: number) => FakeRange;
  insertRowsAfter: (afterRow: number, count: number) => void;
  isSheetHidden: () => boolean;
  hideSheet: () => void;
  snapshot: () => unknown[][];
  writes: FakeSheetWrite[];
}

function createFakeSheet(name: string, initialRows: unknown[][]): FakeSheet {
  const rows: unknown[][] = initialRows.map((row) => [...row]);
  const writes: FakeSheetWrite[] = [];
  return {
    name,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(0, ...rows.map((row) => row.length)),
    getRange(row, column, numRows = 1, numColumns = 1) {
      const startRowIndex = row - 1;
      const startColumnIndex = column - 1;
      return {
        getValues: () => Array.from({ length: numRows }, (_, rowOffset) =>
          Array.from({ length: numColumns }, (_, columnOffset) =>
            rows[startRowIndex + rowOffset]?.[startColumnIndex + columnOffset] ?? "")),
        setValues: (values) => {
          writes.push({ kind: "setValues", row, column });
          values.forEach((valueRow, rowOffset) => {
            const targetRow = rows[startRowIndex + rowOffset] ?? (rows[startRowIndex + rowOffset] = []);
            valueRow.forEach((value, columnOffset) => {
              targetRow[startColumnIndex + columnOffset] = value;
            });
          });
        },
        setNumberFormat: (pattern) => {
          writes.push({ kind: "setNumberFormat", row, column });
          // A date pattern makes the real sheet return Date objects for the
          // stored RAW serials in this range; the fake applies the same
          // conversion only for date-formatted cells, so numeric/boolean
          // cells in other columns stay numeric/boolean.
          if (pattern.includes("yyyy")) {
            for (let rowOffset = 0; rowOffset < numRows; rowOffset += 1) {
              const targetRow = rows[startRowIndex + rowOffset];
              if (targetRow === undefined) continue;
              for (let columnOffset = 0; columnOffset < numColumns; columnOffset += 1) {
                const cell = targetRow[startColumnIndex + columnOffset];
                if (typeof cell === "number") {
                  targetRow[startColumnIndex + columnOffset] =
                    new Date(Math.round(cell * 86_400_000 + Date.UTC(1899, 11, 30)));
                }
              }
            }
          }
        },
      };
    },
    insertRowsAfter(afterRow, count) {
      writes.push({ kind: "insertRowsAfter", row: afterRow, column: 1, count });
      for (let index = 0; index < count; index += 1) rows.splice(afterRow, 0, []);
    },
    isSheetHidden: () => true,
    hideSheet: () => undefined,
    snapshot: () => rows.map((row) => [...row]),
    writes,
  };
}

/** Parses one A1 cell such as "A2" into 1-based column/row numbers. */
function parseA1Cell(cell: string): { column: number; row: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  if (match === null) throw new Error("invalid A1 cell: " + cell);
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}

/**
 * Fake Advanced Sheets service for the temporary test-batch append write.
 * The real runtime stores RAW date serials and returns Date objects for
 * date-formatted cells; the fake stores the RAW ValueRange as-is and converts
 * a cell's numeric serial back to Date only when a date number format is
 * applied to that cell's column, so the postcondition hash round-trips
 * exactly like the real sheet while numeric/boolean cells remain
 * numeric/boolean. The call must follow the Apps Script Advanced Sheets
 * signature batchUpdate(resource, spreadsheetId), so the positional
 * spreadsheetId is asserted here.
 */
function createFakeSheets(dataSheet: FakeSheet, spreadsheetId: string) {
  return {
    Spreadsheets: {
      Values: {
        batchUpdate: (
          resource: { valueInputOption?: string; data?: Array<{ range: string; values: unknown[][] }> },
          targetSpreadsheetId: string,
        ) => {
          expect(targetSpreadsheetId).toBe(spreadsheetId);
          expect(resource.valueInputOption).toBe("RAW");
          for (const entry of resource.data ?? []) {
            const [sheetName, cells] = entry.range.split("!");
            expect(sheetName).toBe(`'${dataSheet.name}'`);
            const [startCell, endCell] = cells!.split(":");
            const start = parseA1Cell(startCell!);
            const end = parseA1Cell(endCell!);
            // RAW values are stored as-is; the date-formatted conversion
            // happens when the number format is applied to the column.
            const values = entry.values.map((row) => [...row]);
            dataSheet
              .getRange(start.row, start.column, end.row - start.row + 1, end.column - start.column + 1)
              .setValues(values);
          }
        },
      },
    },
  };
}

interface Sandbox {
  spreadsheet: {
    getId: () => string;
    getSheetByName: (name: string) => FakeSheet | null;
    insertSheet: (name: string) => FakeSheet;
  };
  dataSheet: FakeSheet;
  receiptSheet: FakeSheet;
  run: (args?: unknown) => unknown;
  flushCount: () => number;
}

function createSandbox(
  operation: ReturnType<typeof createBatchAppendRowsOperation>,
  initialDataRows: unknown[][],
  initialReceiptRows: unknown[][],
  options: { readonly lockDelayMs?: number } = {},
): Sandbox {
  const dataSheet = createFakeSheet("Sync_Conflicts", initialDataRows);
  const receiptSheet = createFakeSheet("__typed_sheets_internal_effect_receipts", initialReceiptRows);
  const spreadsheet = {
    getId: () => "spreadsheet-id-1",
    getSheetByName: (name: string) =>
      name === "Sync_Conflicts" ? dataSheet : name === "__typed_sheets_internal_effect_receipts" ? receiptSheet : null,
    insertSheet: () => receiptSheet,
  };
  let flushCount = 0;
  const SpreadsheetApp = {
    flush: () => {
      flushCount += 1;
    },
  };
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        // A delayed acquisition makes lock-wait timing observable so tests
        // can prove the script_lock phase stays out of the total duration.
        const lockWaitDeadline = Date.now() + (options.lockDelayMs ?? 0);
        while (Date.now() < lockWaitDeadline) { /* busy-wait for the fake lock */ }
        return true;
      },
      releaseLock: () => undefined,
    }),
  };
  const Utilities = {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
    // A content-dependent digest so postcondition hash comparisons are real.
    computeDigest: (_algorithm: string, value: string) => {
      const bytes = createHash("sha256").update(value, "utf8").digest();
      return Array.from(bytes, (byte) => (byte >= 128 ? byte - 256 : byte));
    },
    newBlob: (value: unknown) => ({
      getBytes: () => Array.from(new TextEncoder().encode(String(value))),
    }),
  };
  const evaluateSource = new Function(
    "LockService",
    "SpreadsheetApp",
    "Utilities",
    "PropertiesService",
    "Sheets",
    `return (${operation.fn});`,
  );
  const source = evaluateSource(
    LockService,
    SpreadsheetApp,
    Utilities,
    { getScriptProperties: () => undefined },
    createFakeSheets(dataSheet, spreadsheet.getId()),
  ) as (spreadsheet: unknown, args: unknown) => unknown;
  return {
    spreadsheet,
    dataSheet,
    receiptSheet,
    run: (args = operation.args) => source(spreadsheet, args),
    flushCount: () => flushCount,
  };
}

function baseOperation() {
  return createBatchAppendRowsOperation({
    sheetName: "Sync_Conflicts",
    registeredRange: "A:C",
    headers: ["Conflict_ID", "Status", "Resolved_At"],
    identityField: "Conflict_ID",
    rows: [{
      effectId: "effect-1",
      payloadHash: "payload-1",
      fields: {
        Conflict_ID: { kind: "string", value: "conflict-1" },
        Status: { kind: "string", value: "RESOLVED" },
        Resolved_At: { kind: "date", value: "2024-01-02T03:04:05.000Z" },
      },
    }],
  });
}

describe("Apps Script batch append operation", () => {
  it("builds an eval source that writes the append batch through the Advanced Sheets service", () => {
    const operation = baseOperation();

    // The temporary test-batch write intentionally uses the Advanced Sheets
    // service; everything else (receipts, identity guards, hashing, authority
    // fencing, replay, recovery) stays on built-in Apps Script services.
    expect(operation.fn).toContain("Sheets.Spreadsheets.Values.batchUpdate");
    for (const banned of [
      "createDeveloperMetadata",
      "createDeveloperMetadataFinder",
      "addDeveloperMetadata",
      "insertDimension",
      "updateCells",
    ]) {
      expect(operation.fn).not.toContain(banned);
    }
    expect(operation.fn).toContain("LockService.getScriptLock");
    expect(operation.fn).toContain("SpreadsheetApp.flush");
    expect(operation.fn).toContain("insertRowsAfter");
    expect(operation.fn).toContain("setValues");
    expect(operation.fn).toContain("setNumberFormat");
    expect(operation.fn).toContain("__typed_sheets_internal_effect_receipts");
    expect(operation.fn).toContain('phase_("append_write"');
    expect(operation.fn).toContain('phase_("postcondition"');
    expect(operation.fn).toContain("script_lock");
    // The previous built-in-services write must stay recoverable in the
    // commented rollback block at the end of the source.
    expect(operation.fn).toContain("ROLLBACK BLOCK");
    // The phase accumulator must live in the outer operation-function scope so
    // both run_() phase calls and the outer appendPhase_("script_lock", ...)
    // share one array.
    expect(operation.fn.indexOf("var phases = [];")).toBeGreaterThanOrEqual(0);
    expect(operation.fn.indexOf("var phases = [];")).toBeLessThan(
      operation.fn.indexOf("function run_()"),
    );
    expect(operation.args.rows[0]?.payloadHash).toBe("payload-1");
  });

  it("requires the registered identityField because replay locates by identity", () => {
    const withoutIdentity = {
      sheetName: "Sync_Conflicts",
      registeredRange: "A:C",
      headers: ["Conflict_ID", "Status", "Resolved_At"],
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: {
          Conflict_ID: { kind: "string", value: "conflict-1" },
          Status: { kind: "string", value: "RESOLVED" },
          Resolved_At: { kind: "date", value: "2024-01-02T03:04:05.000Z" },
        },
      }],
    } satisfies Omit<Parameters<typeof createBatchAppendRowsOperation>[0], "identityField">;
    expect(() => createBatchAppendRowsOperation(
      withoutIdentity as unknown as Parameters<typeof createBatchAppendRowsOperation>[0],
    )).toThrow("identityField is required");
    expect(() => createBatchAppendRowsOperation({
      sheetName: "Sync_Conflicts",
      registeredRange: "A:C",
      headers: ["Conflict_ID", "Status", "Resolved_At"],
      identityField: "Not_A_Header",
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: {
          Conflict_ID: { kind: "string", value: "conflict-1" },
          Status: { kind: "string", value: "RESOLVED" },
          Resolved_At: { kind: "date", value: "2024-01-02T03:04:05.000Z" },
        },
      }],
    })).toThrow("identityField must be a registered header");
  });

  it("requires the durable worker payload hash", () => {
    expect(() => createBatchAppendRowsOperation({
      sheetName: "System_State",
      registeredRange: "A:B",
      headers: ["id", "status"],
      identityField: "id",
      rows: [{
        effectId: "effect-1",
        fields: {
          id: { kind: "string", value: "u1" },
          status: { kind: "string", value: "pending" },
        },
      }],
    })).toThrow("every row needs a payloadHash");
  });

  it("rejects duplicate effect IDs inside the serialized source before touching the spreadsheet", () => {
    const operation = createBatchAppendRowsOperation({
      sheetName: "System_State",
      registeredRange: "A:A",
      headers: ["id"],
      identityField: "id",
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: { id: { kind: "string", value: "u1" } },
      }],
    });
    const duplicateArgs = {
      ...operation.args,
      rows: [operation.args.rows[0]!, operation.args.rows[0]!],
    };
    let spreadsheetAccesses = 0;
    const spreadsheet = new Proxy({}, {
      get() {
        spreadsheetAccesses += 1;
        throw new Error("spreadsheet must not be touched for invalid input");
      },
    });
    const lockService = {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }),
    };
    const evaluateSource = new Function("LockService", `return (${operation.fn});`);
    const source = evaluateSource(lockService) as (spreadsheet: unknown, args: unknown) => unknown;

    expect(() => source(spreadsheet, duplicateArgs)).toThrow(
      "batch append effectIds must be non-empty and unique",
    );
    expect(spreadsheetAccesses).toBe(0);
    expect(operation.fn.indexOf("validateInput_();")).toBeLessThan(
      operation.fn.indexOf("ensureReceiptSheet_(spreadsheet)"),
    );
  });

  it("executes a fresh append with SpreadsheetApp fakes, receipts, and all timing phases", () => {
    const operation = baseOperation();
    const sandbox = createSandbox(
      operation,
      [["Conflict_ID", "Status", "Resolved_At"]],
      [RECEIPT_HEADERS],
    );

    const result = sandbox.run() as {
      results: Array<{ effectId: string; status: string; visibleHash: string; visibleRevision: number }>;
      hasMore: boolean;
      timing: { durationMs: number; phases: Array<{ phase: string; durationMs: number }> };
    };

    expect(result.hasMore).toBe(false);
    expect(result.results).toEqual([{
      effectId: "effect-1",
      status: "applied",
      visibleHash: expect.any(String) as unknown as string,
      visibleRevision: 1,
    }]);
    expect(result.results[0]?.visibleHash.length).toBeGreaterThan(0);
    expect(result.timing.phases.map((phase) => phase.phase)).toEqual([
      "validate_input",
      "sheet_and_receipt_lookup",
      "receipt_read",
      "append_range_lookup",
      "append_write",
      "append_flush",
      "receipt_write",
      "receipt_flush",
      "postcondition",
      "result",
      "script_lock",
    ]);
    expect(result.timing.phases.every((phase) => phase.durationMs >= 0)).toBe(true);
    expect(result.timing.phases[result.timing.phases.length - 1]?.phase).toBe("script_lock");
    // Three flushes: the explicit service-boundary flush between the built-in
    // insertRowsAfter reservation and the Advanced Sheets RAW write, the
    // target-row flush, and the receipt flush.
    expect(sandbox.flushCount()).toBe(3);

    // durationMs already measures the whole operation including the lock
    // wait; the script_lock phase must never inflate the total further.
    const phaseTotal = result.timing.phases.reduce((sum, phase) => sum + phase.durationMs, 0);
    expect(result.timing.durationMs).toBeLessThanOrEqual(phaseTotal);

    // The data row landed below the header row.
    expect(sandbox.dataSheet.snapshot()).toEqual([
      ["Conflict_ID", "Status", "Resolved_At"],
      ["conflict-1", "RESOLVED", expect.any(Date)],
    ]);
    const appendedDate = sandbox.dataSheet.snapshot()[1]?.[2] as Date;
    expect(appendedDate.toISOString()).toBe("2024-01-02T03:04:05.000Z");

    // The hidden receipt row carries the same visible evidence the result
    // returned, so a replay can verify the row without re-appending.
    const receiptRow = sandbox.receiptSheet.snapshot()[1];
    expect(receiptRow).toEqual([
      "effect-1",
      "payload-1",
      "applied",
      result.results[0]?.visibleHash,
      1,
      expect.any(String) as unknown as string,
    ]);

    // The date column received the canonical UTC number format; the string
    // columns did not.
    const numberFormats = sandbox.dataSheet.writes.filter((write) => write.kind === "setNumberFormat");
    expect(numberFormats).toEqual([{ kind: "setNumberFormat", row: 2, column: 3 }]);
    expect(sandbox.dataSheet.writes.some((write) => write.kind === "insertRowsAfter")).toBe(true);
    expect(sandbox.receiptSheet.writes.some((write) => write.kind === "insertRowsAfter")).toBe(true);

    // The payload must still satisfy the decoder contract after execution.
    expect(operation.decode?.(result)).toEqual({
      results: result.results,
      hasMore: false,
      timing: result.timing,
    });
  });

  it("replays an exact effect as applied without adding another target or receipt row", () => {
    const operation = baseOperation();
    const sandbox = createSandbox(
      operation,
      [["Conflict_ID", "Status", "Resolved_At"]],
      [RECEIPT_HEADERS],
    );

    const first = sandbox.run() as {
      results: Array<{ visibleHash: string; visibleRevision: number }>;
    };
    const writesAfterFirst = {
      data: sandbox.dataSheet.writes.length,
      receipt: sandbox.receiptSheet.writes.length,
    };

    const replay = sandbox.run() as {
      results: Array<{ effectId: string; status: string; visibleHash: string; visibleRevision: number }>;
    };

    expect(replay.results).toEqual([{
      effectId: "effect-1",
      status: "applied",
      visibleHash: first.results[0]?.visibleHash,
      visibleRevision: 1,
    }]);
    expect(sandbox.dataSheet.snapshot()).toHaveLength(2);
    expect(sandbox.receiptSheet.snapshot()).toHaveLength(2);
    expect(sandbox.dataSheet.writes.length).toBe(writesAfterFirst.data);
    expect(sandbox.receiptSheet.writes.length).toBe(writesAfterFirst.receipt);
  });

  it("fails closed when the same effect ID is reused with a different payload", () => {
    const operation = baseOperation();
    const sandbox = createSandbox(
      operation,
      [["Conflict_ID", "Status", "Resolved_At"]],
      [RECEIPT_HEADERS],
    );
    sandbox.run();
    const writesBefore = {
      data: sandbox.dataSheet.writes.length,
      receipt: sandbox.receiptSheet.writes.length,
    };

    const changed = createBatchAppendRowsOperation({
      ...operation.args,
      rows: [{
        ...operation.args.rows[0]!,
        payloadHash: "payload-2",
        fields: {
          Conflict_ID: { kind: "string", value: "conflict-1" },
          Status: { kind: "string", value: "RESOLVED" },
          Resolved_At: { kind: "date", value: "2024-01-02T03:04:05.000Z" },
        },
      }],
    });

    expect(() => sandbox.run(changed.args)).toThrow(
      "effect ID cannot be reused with another payload: effect-1",
    );
    expect(sandbox.dataSheet.snapshot()).toHaveLength(2);
    expect(sandbox.receiptSheet.snapshot()).toHaveLength(2);
    expect(sandbox.dataSheet.writes.length).toBe(writesBefore.data);
    expect(sandbox.receiptSheet.writes.length).toBe(writesBefore.receipt);
  });

  it("fails closed on a duplicate identity before any write", () => {
    const operation = baseOperation();
    const sandbox = createSandbox(
      operation,
      [
        ["Conflict_ID", "Status", "Resolved_At"],
        ["conflict-1", "EXISTING", null],
      ],
      [RECEIPT_HEADERS],
    );

    expect(() => sandbox.run()).toThrow(
      "sync identity already exists: conflict-1 at row 2",
    );
    expect(sandbox.dataSheet.writes).toHaveLength(0);
    expect(sandbox.receiptSheet.writes).toHaveLength(0);
    expect(sandbox.dataSheet.snapshot()).toHaveLength(2);
  });

  it("keeps the script-lock phase diagnostic out of the total timing", () => {
    const operation = baseOperation();
    // A slow lock acquisition makes the double-count observable: the total
    // already covers the lock wait, so the nested script_lock phase must not
    // be added to durationMs a second time.
    const sandbox = createSandbox(
      operation,
      [["Conflict_ID", "Status", "Resolved_At"]],
      [RECEIPT_HEADERS],
      { lockDelayMs: 8 },
    );

    const result = sandbox.run() as {
      timing: { durationMs: number; phases: Array<{ phase: string; durationMs: number }> };
    };
    const phaseTotal = result.timing.phases.reduce((sum, phase) => sum + phase.durationMs, 0);
    expect(result.timing.phases[result.timing.phases.length - 1]?.phase).toBe("script_lock");
    expect(result.timing.phases[result.timing.phases.length - 1]?.durationMs).toBeGreaterThan(0);
    expect(result.timing.durationMs).toBeLessThanOrEqual(phaseTotal);
  });

  it("rejects a missing identity before any write", () => {
    // An empty identity cell on a pending row fails closed before any write.
    const missingIdentity = createBatchAppendRowsOperation({
      sheetName: "Sync_Conflicts",
      registeredRange: "A:C",
      headers: ["Conflict_ID", "Status", "Resolved_At"],
      identityField: "Conflict_ID",
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: {
          Conflict_ID: { kind: "string", value: "" },
          Status: { kind: "string", value: "RESOLVED" },
          Resolved_At: { kind: "date", value: "2024-01-02T03:04:05.000Z" },
        },
      }],
    });
    const missingSandbox = createSandbox(
      missingIdentity,
      [["Conflict_ID", "Status", "Resolved_At"]],
      [RECEIPT_HEADERS],
    );
    expect(() => missingSandbox.run()).toThrow(
      "sync identity is required for append: Conflict_ID",
    );
    expect(missingSandbox.dataSheet.writes).toHaveLength(0);

    // Duplicate identities already present in the sheet are ambiguous.
    const ambiguousSandbox = createSandbox(
      baseOperation(),
      [
        ["Conflict_ID", "Status", "Resolved_At"],
        ["conflict-1", "ONE", null],
        ["conflict-1", "TWO", null],
      ],
      [RECEIPT_HEADERS],
    );
    expect(() => ambiguousSandbox.run()).toThrow(
      "sync identity is duplicated: conflict-1 at rows 2 and 3",
    );
    expect(ambiguousSandbox.dataSheet.writes).toHaveLength(0);
  });

  it("fails closed when the target row postcondition does not match the written payload", () => {
    const operation = baseOperation();
    const sandbox = createSandbox(
      operation,
      [["Conflict_ID", "Status", "Resolved_At"]],
      [RECEIPT_HEADERS],
    );
    // Corrupt only the Status cell of the appended row so the identity lookup
    // still finds the row while the read-back hash cannot match the payload.
    const originalGetRange = sandbox.dataSheet.getRange;
    sandbox.dataSheet.getRange = (row, column, numRows = 1, numColumns = 1) => {
      const range = originalGetRange(row, column, numRows, numColumns);
      if (row === 2 && column === 1 && numRows === 1 && numColumns === 3) {
        const baseSetValues = range.setValues;
        range.setValues = (values) => {
          baseSetValues(values.map((valueRow) => valueRow.map((value, index) =>
            index === 1 && typeof value === "string" ? value.toLowerCase() : value)));
        };
      }
      return range;
    };

    expect(() => sandbox.run()).toThrow(
      "append postcondition changed for effectId: effect-1",
    );
  });

  it("converts RAW serials to Date only for date-formatted columns", () => {
    // Numeric and boolean cells must stay numeric/boolean in the fake
    // Advanced Sheets sandbox; only the date-formatted column returns Date
    // objects for its RAW serials, matching the real sheet.
    const operation = createBatchAppendRowsOperation({
      sheetName: "Sync_Conflicts",
      registeredRange: "A:D",
      headers: ["Conflict_ID", "Severity", "Resolved_At", "Acknowledged"],
      identityField: "Conflict_ID",
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: {
          Conflict_ID: { kind: "string", value: "conflict-1" },
          Severity: { kind: "number", value: 42 },
          Resolved_At: { kind: "date", value: "2024-01-02T03:04:05.000Z" },
          Acknowledged: { kind: "boolean", value: true },
        },
      }],
    });
    const sandbox = createSandbox(
      operation,
      [["Conflict_ID", "Severity", "Resolved_At", "Acknowledged"]],
      [RECEIPT_HEADERS],
    );

    const result = sandbox.run() as { results: Array<{ status: string }> };
    expect(result.results[0]?.status).toBe("applied");
    const appended = sandbox.dataSheet.snapshot()[1];
    expect(appended).toEqual([
      "conflict-1",
      42,
      expect.any(Date) as unknown as Date,
      true,
    ]);
    expect((appended?.[2] as Date).toISOString()).toBe("2024-01-02T03:04:05.000Z");

    // Only the date column received the canonical UTC number format; the
    // numeric and boolean columns were never formatted.
    const numberFormats = sandbox.dataSheet.writes.filter((write) => write.kind === "setNumberFormat");
    expect(numberFormats).toEqual([{ kind: "setNumberFormat", row: 2, column: 3 }]);
  });

  it("rejects incomplete or mismatched result evidence", () => {
    const operation = createBatchAppendRowsOperation({
      sheetName: "System_State",
      registeredRange: "A:A",
      headers: ["id"],
      identityField: "id",
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: { id: { kind: "string", value: "u1" } },
      }],
    });

    expect(operation.decode?.({
      results: [{ effectId: "effect-1", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
      hasMore: false,
    })).toEqual({
      results: [{ effectId: "effect-1", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
      hasMore: false,
    });
    // The decoder still requires receipt evidence to arrive as a verified
    // visibleHash/visibleRevision pair, never one without the other.
    expect(() => operation.decode?.({
      results: [{ effectId: "effect-1", status: "applied", visibleHash: "hash-1" }],
      hasMore: false,
    })).toThrow("result contains invalid receipt evidence");
    expect(() => operation.decode?.({
      results: [{ effectId: "effect-1", status: "applied", visibleRevision: 1 }],
      hasMore: false,
    })).toThrow("result contains invalid receipt evidence");
    expect(() => operation.decode?.({ results: [], hasMore: false })).toThrow(
      "batch append operation response is invalid",
    );
    expect(() => operation.decode?.({
      results: [{ effectId: "other", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
      hasMore: false,
    })).toThrow("result effectIds do not match submitted rows");
  });
});
