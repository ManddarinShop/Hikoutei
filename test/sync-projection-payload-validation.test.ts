/**
 * sync projection payload validation tests. Covers projection effect payload boundary; promotes a valid wire payload and preserves stable serialization; keeps semantic hash validation outside the Zod shape schema; rejects empty fields after structural validation.
 *
 * Exercises the behavior through fake providers and SQLite fixtures with no live credentials.
 */
import { describe, expect, it } from "vitest";

import {
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
  serializeSyncProjectionEffectPayload,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { SYNC_SHEETS_ERROR_CODES } from "@hikoutei/contracts/sheets/errors.js";

function validPayload() {
  const fields = {
    name: { kind: "string" as const, value: "Ada" },
  };
  return {
    sheetName: "Users_System",
    registeredRange: "A:B",
    schemaVersion: 1,
    targetAnchor: "user-1",
    fields,
    targetVisibleHash: computeSyncVisibleHash(fields),
    createIfMissing: false,
    expectedCandidateHash: null,
  };
}

// Covers: projection effect payload boundary.
describe("projection effect payload boundary", () => {
  // Verifies: promotes a valid wire payload and preserves stable serialization.
  it("promotes a valid wire payload and preserves stable serialization", () => {
    const wirePayload = validPayload();
    const parsed = parseSyncProjectionEffectPayload(JSON.stringify(wirePayload));

    expect(parseSyncProjectionEffectPayload(serializeSyncProjectionEffectPayload(parsed))).toEqual(parsed);
  });

  it.each([
    ["null payload", "null"],
    ["missing required field", JSON.stringify({ ...validPayload(), sheetName: undefined })],
    ["wrong schema version", JSON.stringify({ ...validPayload(), schemaVersion: 0 })],
    ["wrong boolean", JSON.stringify({ ...validPayload(), createIfMissing: "false" })],
    ["invalid normalized cell", JSON.stringify({
      ...validPayload(),
      fields: { name: { kind: "string", value: 123 } },
    })],
  ])("rejects %s with the stable contract error", (_label, input) => {
    expect(() => parseSyncProjectionEffectPayload(input)).toThrowError(
      expect.objectContaining({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD }),
    );
  });

  // Verifies: keeps semantic hash validation outside the Zod shape schema.
  it("keeps semantic hash validation outside the Zod shape schema", () => {
    const payload = validPayload();
    expect(() => parseSyncProjectionEffectPayload(JSON.stringify({
      ...payload,
      targetVisibleHash: "stale-hash",
    }))).toThrowError(
      expect.objectContaining({
        code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        message: "effect payload targetVisibleHash does not match its fields",
      }),
    );
  });

  // Verifies: rejects empty fields after structural validation.
  it("rejects empty fields after structural validation", () => {
    const payload = validPayload();
    expect(() => parseSyncProjectionEffectPayload(JSON.stringify({
      ...payload,
      fields: {},
    }))).toThrowError(
      expect.objectContaining({
        code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        message: "effect payload must contain a field",
      }),
    );
  });
});
