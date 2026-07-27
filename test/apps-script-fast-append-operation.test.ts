import { describe, expect, it } from "vitest";

import {
  createFastAppendRowsOperation,
} from "../src/adapter/apps-script-gateway/fastAppendOperation.js";

describe("thin Code.gs fast-append operation", () => {
  it("builds a single setValues operation without metadata work", () => {
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

    expect(operation.fn).toContain("setValues");
    expect(operation.fn).toContain('phase_("set_values"');
    expect(operation.fn).toContain('operationKinds: ["append"]');
    expect(operation.fn).not.toContain("getDeveloperMetadata");
    expect(operation.fn).not.toContain("addDeveloperMetadata");
    expect(operation.fn).not.toContain("flush");
    expect(operation.args.rows).toHaveLength(1);
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
