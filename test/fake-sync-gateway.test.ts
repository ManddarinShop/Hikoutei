import { describe, expect, it } from "vitest";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../src/shared/state/index.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../src/application/sync/gateway/errors.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../src/application/sync/gateway/constants.js";
import {
  FakeSyncSheetGateway,
  type FakeSyncSheetInput,
} from "./support/FakeSyncSheetGateway.js";

function createSheetInput(): FakeSyncSheetInput {
  return {
    physicalSheetId: "physical-1",
    sheetName: "User_Input",
    registeredRange: "A:Z",
    projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
    schemaVersion: 1,
    headers: ["id"],
    rows: [
      {
        targetId: "entity-1",
        fields: {
          id: { kind: "string", value: "entity-1" },
        },
        activeCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
      },
    ],
  };
}

describe("FakeSyncSheetGateway", () => {
  it("returns values without metadata anchors for User_Input snapshots", async () => {
    const gateway = new FakeSyncSheetGateway([createSheetInput()]);

    const snapshot = await gateway.readSnapshot({
      physicalSheetId: "physical-1",
      sheetName: "User_Input",
      registeredRange: "A:Z",
      projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const row = snapshot.rows[0];

    expect(row?.physicalAnchor).toEqual({ kind: PRESENCE_KINDS.ABSENT });
    expect(row?.cells.id?.cellKind).toBe("literal");
    expect(row?.cells.id?.normalizedCell).toEqual({
      kind: "string",
      value: "entity-1",
    });
  });

  it("uses the common gateway error for invalid fake options", () => {
    const createInvalidGateway = () =>
      new FakeSyncSheetGateway([createSheetInput()], { maxEffectsPerApply: 0 });

    expect(createInvalidGateway).toThrowError(
      expect.objectContaining({
        code: SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
      }),
    );
    expect(createInvalidGateway).toThrow(SyncGatewayContractError);
  });
});
