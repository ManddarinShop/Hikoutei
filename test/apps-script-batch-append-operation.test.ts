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
        setNumberFormat: () => {
          writes.push({ kind: "setNumberFormat", row, column });
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
    `return (${operation.fn});`,
  );
  const source = evaluateSource(
    LockService,
    SpreadsheetApp,
    Utilities,
    { getScriptProperties: () => undefined },
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

describe("Built-in Apps Script batch append operation", () => {
  it("builds an eval source that uses only built-in Apps Script services", () => {
    const operation = baseOperation();

    for (const banned of [
      "Sheets.Spreadsheets",
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
    expect(sandbox.flushCount()).toBe(2);

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
