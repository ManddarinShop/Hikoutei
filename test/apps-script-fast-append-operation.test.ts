import { describe, expect, it } from "vitest";

import {
  createFastAppendRowsOperation,
} from "../src/adapter/sheets/providers/apps-script-gateway/operations/write/fastAppendOperation.js";

describe("Apps Script append operation compatibility", () => {
  it("builds one idempotent append operation backed by the Advanced Sheets test-batch write", () => {
    const operation = createFastAppendRowsOperation({
      sheetName: "LoadTest_Customers",
      registeredRange: "A:B",
      headers: ["id", "name"],
      identityField: "id",
      rows: [{
        effectId: "effect-1",
        fields: {
          id: { kind: "string", value: "customer-1" },
          name: { kind: "string", value: "Ada" },
        },
      }],
    });

    expect(operation.fn).toContain("Sheets.Spreadsheets.Values.batchUpdate");
    expect(operation.fn).not.toContain("createDeveloperMetadata");
    expect(operation.fn).toContain("SpreadsheetApp.flush");
    expect(operation.fn).toContain("insertRowsAfter");
    expect(operation.fn).toContain("range.startColumn");
    expect(operation.fn).toContain('phase_("append_write"');
    expect(operation.fn).toContain('operationKinds: ["append"]');
    expect(operation.fn).toContain("__typed_sheets_internal_effect_receipts");
    expect(operation.args.rows).toHaveLength(1);
  });

  it("rejects a missing identityField because replay cannot locate the row", () => {
    const withoutIdentity = {
      sheetName: "LoadTest_Customers",
      registeredRange: "A:A",
      headers: ["id"],
      rows: [{
        effectId: "effect-1",
        fields: { id: { kind: "string", value: "customer-1" } },
      }],
    } satisfies Omit<Parameters<typeof createFastAppendRowsOperation>[0], "identityField">;
    expect(() => createFastAppendRowsOperation(
      withoutIdentity as unknown as Parameters<typeof createFastAppendRowsOperation>[0],
    )).toThrow("identityField is required");
  });

  it("rejects range/header drift and non-canonical date cells before transport", () => {
    expect(() => createFastAppendRowsOperation({
      sheetName: "LoadTest_Customers",
      registeredRange: "B:C",
      headers: ["id"],
      identityField: "id",
      rows: [],
    })).toThrow("headers must match registeredRange");

    expect(() => createFastAppendRowsOperation({
      sheetName: "LoadTest_Customers",
      registeredRange: "A:A",
      headers: ["createdAt"],
      identityField: "createdAt",
      rows: [{
        effectId: "effect-1",
        fields: { createdAt: { kind: "date", value: "2026-01-02T03:04:05Z" } },
      }],
    })).toThrow("rows contain an invalid normalized cell");

    expect(() => createFastAppendRowsOperation({
      sheetName: "LoadTest_Customers",
      registeredRange: "A:A",
      headers: ["id"],
      identityField: "id",
      rows: [
        { effectId: "effect-1", fields: { id: { kind: "string", value: "one" } } },
        { effectId: "effect-1", fields: { id: { kind: "string", value: "two" } } },
      ],
    })).toThrow("effectIds must be non-empty and unique");
  });

  it("decodes one applied result and rejects an incomplete response", () => {
    const operation = createFastAppendRowsOperation({
      sheetName: "LoadTest_Customers",
      registeredRange: "A:A",
      headers: ["id"],
      identityField: "id",
      rows: [{
        effectId: "effect-1",
        fields: { id: { kind: "string", value: "customer-1" } },
      }],
    });

    const timing = {
      operationKinds: ["append"],
      operationCounts: { append: 1, update: 0, delete: 0 },
      durationMs: 12,
      phases: [{ phase: "append_write", durationMs: 8 }],
    };
    expect(operation.decode?.({
      results: [{ effectId: "effect-1", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
      hasMore: false,
      timing,
    })).toEqual({
      results: [{ effectId: "effect-1", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
      hasMore: false,
      timing,
    });
    expect(() => operation.decode?.({
      results: [{ effectId: "effect-1", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
      hasMore: false,
      timing: { operationKinds: [], phases: [] },
    })).toThrow("Apps Script timing response is invalid");
    expect(() => operation.decode?.({ results: [], hasMore: false })).toThrow(
      "batch append operation response is invalid",
    );
    expect(() => operation.decode?.({
      results: [{ effectId: "other-effect", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
      hasMore: false,
    })).toThrow("result effectIds do not match submitted rows");
  });
});
