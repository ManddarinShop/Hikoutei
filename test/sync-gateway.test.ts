import { describe, expect, it } from "vitest";
import { APPLICABILITY_KINDS } from "../src/shared/state/constants.js";
import {
  provisionRegisteredSyncSheets,
  type RegisteredSyncProjectionDefinition,
} from "../src/application/sync/gateway/SyncGatewayBootstrap.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../src/application/sync/gateway/errors.js";
import {
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
  serializeSyncProjectionEffectPayload,
  type SyncProjectionEffectPayload,
} from "../src/application/sync/gateway/syncGateway.js";
import type { RegisteredSyncSheet } from "../src/infrastructure/storage/sync/shared/syncRegistry.js";

const fields = {
  active: { kind: "boolean" as const, value: true },
  name: { kind: "string" as const, value: "Ada" },
  empty: null,
};

function payload(
  expectedCandidateHash: SyncProjectionEffectPayload["expectedCandidateHash"],
): SyncProjectionEffectPayload {
  return {
    sheetName: "User_Input",
    registeredRange: "A:Z",
    schemaVersion: 1,
    targetAnchor: "row-1",
    fields,
    targetVisibleHash: computeSyncVisibleHash(fields),
    createIfMissing: true,
    expectedCandidateHash,
  };
}

describe("sync gateway contract", () => {
  it("keeps absence typed internally while preserving null at the JSON boundary", () => {
    const serialized = serializeSyncProjectionEffectPayload(
      payload({ kind: APPLICABILITY_KINDS.NOT_APPLICABLE }),
    );
    const parsed = parseSyncProjectionEffectPayload(serialized);

    expect(JSON.parse(serialized)).toMatchObject({ expectedCandidateHash: null });
    expect(parsed.expectedCandidateHash).toEqual({
      kind: APPLICABILITY_KINDS.NOT_APPLICABLE,
    });
  });

  it("raises a structured error when the visible hash is tampered with", () => {
    const serialized = serializeSyncProjectionEffectPayload(
      payload({ kind: APPLICABILITY_KINDS.APPLICABLE, value: "candidate-1" }),
    );
    const tampered = serialized.replace(/targetVisibleHash":"[^"]+"/, "targetVisibleHash\":\"tampered\"");

    expect(() => parseSyncProjectionEffectPayload(tampered)).toThrow(
      SyncGatewayContractError,
    );
    expect(() => parseSyncProjectionEffectPayload(tampered)).toThrowError(
      expect.objectContaining({
        code: SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      }),
    );
  });

  it("rejects a non-canonical date cell at the payload boundary", () => {
    const invalidFields = {
      createdAt: { kind: "date" as const, value: "2026-01-02T03:04:05Z" },
    };
    const serialized = JSON.stringify({
      ...payload({ kind: APPLICABILITY_KINDS.NOT_APPLICABLE }),
      fields: invalidFields,
      targetVisibleHash: "not-used-because-date-is-invalid",
    });

    expect(() => parseSyncProjectionEffectPayload(serialized)).toThrowError(
      expect.objectContaining({ code: SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD }),
    );
  });

  it("rejects duplicate provisioning headers with the common gateway error", async () => {
    const sheet: RegisteredSyncSheet = {
      logicalSheetId: "logical-1",
      physicalSheetId: "physical-1",
      spreadsheetId: "spreadsheet-1",
      tabName: "User_Input",
      registeredRange: "A:Z",
      projection: "user_input",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "developer_metadata",
    };
    const definition: RegisteredSyncProjectionDefinition = {
      sheet,
      headers: ["id", "id"],
    };

    await expect(
      provisionRegisteredSyncSheets(
        {
          provisionRegistry: async () => ({
            registrations: [],
            createdSheets: [],
            initializedHeaders: [],
          }),
        },
        [definition],
      ),
    ).rejects.toMatchObject({
      code: SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    });
  });
});
