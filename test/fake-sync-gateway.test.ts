import { describe, expect, it } from "vitest";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../src/shared/state/index.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../src/application/sync/gateway/errors.js";
import {
  SYNC_GATEWAY_FAST_APPEND_STATUSES,
  SYNC_GATEWAY_PROJECTIONS,
} from "../src/application/sync/gateway/constants.js";
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
  it("returns the shared Presence contract for snapshot metadata", async () => {
    const gateway = new FakeSyncSheetGateway([createSheetInput()]);

    const snapshot = await gateway.readSnapshot({
      physicalSheetId: "physical-1",
      sheetName: "User_Input",
      registeredRange: "A:Z",
      projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const row = snapshot.rows[0];

    expect(row?.physicalAnchor).toEqual({
      kind: PRESENCE_KINDS.PRESENT,
      value: "fake-anchor:1",
    });
    expect(row?.visibleRevision).toEqual({
      kind: PRESENCE_KINDS.PRESENT,
      value: 0,
    });
    expect(row?.cells.id?.formulaHash).toEqual({ kind: PRESENCE_KINDS.ABSENT });
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

  it("replays an anchorless fast append by registered identity without adding a row", async () => {
    const gateway = new FakeSyncSheetGateway([{
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status"],
    }]);
    const request = {
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
        },
      }],
    } as const;

    // The append commits remotely, then the response is lost: the replay must
    // locate the row through the registered identity, exactly like the
    // built-in append path, instead of throwing on a missing anchor.
    gateway.dropNextResponseAfterApply();
    await gateway.fastAppendRows(request).catch(() => undefined);

    const replay = await gateway.fastAppendRows(request);
    expect(replay.results[0]).toMatchObject({
      effectId: "effect-1",
      status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED,
    });
    expect(replay.hasMore).toBe(false);

    const snapshot = await gateway.readSnapshot({
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    // The built-in append path never materializes anchor metadata, and the
    // replay must not add a second row.
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.physicalAnchor).toEqual({ kind: PRESENCE_KINDS.ABSENT });
    expect(snapshot.unanchoredRows).toEqual([2]);
  });

  it("ignores the advisory row anchor and replays an anchored fast append by registered identity", async () => {
    const gateway = new FakeSyncSheetGateway([{
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status"],
    }]);
    const request = {
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        // The worker always sends the payload anchor, but the built-in append
        // path treats it as advisory and never materializes the metadata.
        anchor: "worker-anchor-a",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
        },
      }],
    } as const;

    // The append commits remotely, then the response is lost.
    gateway.dropNextResponseAfterApply();
    await gateway.fastAppendRows(request).catch(() => undefined);

    // The advisory anchor was never materialized: the appended row is not
    // reachable through the anchor the worker sent.
    expect(() => gateway.readRow("physical-append", "worker-anchor-a"))
      .toThrow("fake row anchor does not exist: worker-anchor-a");

    // Replay resolves through the registered identity even when the advisory
    // anchor differs, exactly like the built-in append path, and adds no row.
    const replay = await gateway.fastAppendRows({
      ...request,
      rows: [{ ...request.rows[0]!, anchor: "worker-anchor-b" }],
    });
    expect(replay.results[0]).toMatchObject({
      effectId: "effect-1",
      status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED,
    });
    expect(replay.hasMore).toBe(false);

    const snapshot = await gateway.readSnapshot({
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.physicalAnchor).toEqual({ kind: PRESENCE_KINDS.ABSENT });
    expect(snapshot.unanchoredRows).toEqual([2]);
  });

  it("exempts receipted replay rows from the identity preflight and guards only pending rows", async () => {
    const gateway = new FakeSyncSheetGateway([{
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status"],
    }]);
    const appendRequest = {
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
        },
      }],
    } as const;

    gateway.dropNextResponseAfterApply();
    await gateway.fastAppendRows(appendRequest).catch(() => undefined);

    // The replay row already owns identity order-1 on the sheet; the preflight
    // skips receipted replays, so replaying the lost append succeeds instead
    // of failing the duplicate-identity check.
    await expect(gateway.fastAppendRows(appendRequest)).resolves.toMatchObject({
      results: [{ effectId: "effect-1", status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED }],
    });

    // A new pending row in the same batch is still guarded: it must not reuse
    // the identity the replay owns.
    await expect(gateway.fastAppendRows({
      ...appendRequest,
      rows: [
        appendRequest.rows[0]!,
        {
          effectId: "effect-2",
          payloadHash: "payload-2",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
    })).rejects.toThrow("sync identity already exists");
  });

  it("fails closed for fast append on a sheet without a registered identity", async () => {
    const gateway = new FakeSyncSheetGateway([{
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["status"],
    }]);

    // The real gateway refuses fast append for routes without a registered
    // identity field because replay could not locate the appended row.
    await expect(gateway.fastAppendRows({
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: { status: { kind: "string", value: "paid" } },
      }],
    })).rejects.toThrow("requires a registered identityField");
  });

  it("fails closed before appending when the registered identity already exists", async () => {
    const gateway = new FakeSyncSheetGateway([{
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status"],
      rows: [{
        targetId: "order-1",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
        },
      }],
    }]);

    await expect(gateway.fastAppendRows({
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      rows: [{
        effectId: "effect-1",
        payloadHash: "payload-1",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "pending" },
        },
      }],
    })).rejects.toThrow("sync identity already exists");

    const snapshot = await gateway.readSnapshot({
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    // The preflight runs before any mutation: the existing row is untouched.
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.cells.id?.normalizedCell).toEqual({
      kind: "string",
      value: "order-1",
    });
  });

  it("fails closed before appending any row when one batch duplicates an identity", async () => {
    const gateway = new FakeSyncSheetGateway([{
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status"],
    }]);

    await expect(gateway.fastAppendRows({
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      rows: [
        {
          effectId: "effect-1",
          payloadHash: "payload-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
        {
          effectId: "effect-2",
          payloadHash: "payload-2",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
    })).rejects.toThrow("sync identity already exists");

    const snapshot = await gateway.readSnapshot({
      physicalSheetId: "physical-append",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(snapshot.rows).toHaveLength(0);
  });
});
