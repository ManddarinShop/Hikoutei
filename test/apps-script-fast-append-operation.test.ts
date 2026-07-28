import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFastAppendRowsOperation,
} from "../src/adapter/sheets/providers/apps-script-gateway/operations/write/fastAppendOperation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thin Code.gs fast-append operation", () => {
  it("appends normalized values without metadata or flush work", () => {
    const operation = createFastAppendRowsOperation({
      sheetName: "LoadTest_Customers",
      headers: ["id", "name"],
      rows: [{
        effectId: "effect-1",
        fields: {
          id: { kind: "string", value: "customer-1" },
          name: { kind: "string", value: "Ada" },
        },
      }],
    });

    const setValues = vi.fn();
    const getRange = vi.fn(() => ({ setValues }));
    const sheet = {
      getLastRow: vi.fn(() => 3),
      getRange,
      getDeveloperMetadata: vi.fn(),
      addDeveloperMetadata: vi.fn(),
    };
    const spreadsheet = {
      getSheetByName: vi.fn(() => sheet),
    };
    const flush = vi.fn();
    vi.stubGlobal("SpreadsheetApp", { flush });

    const result = executeAppsScriptSource(operation.fn, spreadsheet, operation.args) as {
      readonly results: readonly { readonly effectId: string; readonly status: string }[];
      readonly hasMore: boolean;
      readonly startRow?: number;
    };

    expect(result.results).toEqual([{ effectId: "effect-1", status: "applied" }]);
    expect(result.hasMore).toBe(false);
    expect(result.startRow).toBe(4);
    expect(getRange).toHaveBeenCalledWith(4, 1, 1, 2);
    expect(setValues).toHaveBeenCalledWith([["customer-1", "Ada"]]);
    expect(sheet.getDeveloperMetadata).not.toHaveBeenCalled();
    expect(sheet.addDeveloperMetadata).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("decodes one applied result and rejects an incomplete response", () => {
    const operation = createFastAppendRowsOperation({
      sheetName: "LoadTest_Customers",
      headers: ["id"],
      rows: [{
        effectId: "effect-1",
        fields: { id: { kind: "string", value: "customer-1" } },
      }],
    });

    const timing = {
      operationKinds: ["append"],
      operationCounts: { append: 1, update: 0, delete: 0 },
      durationMs: 12,
      phases: [{ phase: "set_values", durationMs: 8 }],
    };
    expect(operation.decode?.({
      results: [{ effectId: "effect-1", status: "applied" }],
      hasMore: false,
      timing,
    })).toEqual({
      results: [{ effectId: "effect-1", status: "applied" }],
      hasMore: false,
      timing,
    });
    expect(() => operation.decode?.({
      results: [{ effectId: "effect-1", status: "applied" }],
      hasMore: false,
      timing: { operationKinds: [], phases: [] },
    })).toThrow("Apps Script timing response is invalid");
    expect(() => operation.decode?.({ results: [], hasMore: false })).toThrow(
      "fast append operation response is invalid",
    );
  });
});

type AppsScriptOperationSource = (spreadsheet: unknown, args: unknown) => unknown;

function executeAppsScriptSource(
  source: string,
  spreadsheet: unknown,
  args: unknown,
): unknown {
  const factory = new Function(`return (${source});`) as () => AppsScriptOperationSource;
  return factory()(spreadsheet, args);
}
