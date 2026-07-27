import { describe, expect, it } from "vitest";
import {
  SYNC_GATEWAY_ADMIN_OPERATIONS,
  SYNC_GATEWAY_OPERATIONS,
} from "../src/adapter/apps-script-gateway/protocol/constants.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
  SyncGatewayProtocolError,
} from "../src/adapter/apps-script-gateway/errors.js";
import {
  canonicalSyncJson,
  createSyncGatewayEnvelope,
} from "../src/adapter/apps-script-gateway/protocol/syncProtocol.js";
import { createSyncGatewayAdminEnvelope } from "../src/adapter/apps-script-gateway/syncAdminProtocol.js";

describe("signed Apps Script gateway protocol contracts", () => {
  it("derives operations from shared runtime constants", () => {
    const envelope = createSyncGatewayEnvelope({
      operation: SYNC_GATEWAY_OPERATIONS.READ_SNAPSHOT,
      payload: { ok: true },
      sheetId: "sheet-1",
      registeredRange: "A:Z",
      secret: "secret",
      issuedAt: 1_700_000_000_000,
      requestId: "request-1",
    });

    expect(envelope.operation).toBe(SYNC_GATEWAY_OPERATIONS.READ_SNAPSHOT);
    expect(SYNC_GATEWAY_ADMIN_OPERATIONS.PROVISION_REGISTRY).toBe("provisionRegistry");
  });

  it("uses the common structured error for invalid protocol input", () => {
    expect(() =>
      createSyncGatewayEnvelope({
        operation: "unknown" as never,
        payload: null,
        sheetId: "sheet-1",
        registeredRange: "A:Z",
        secret: "secret",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "SyncGatewayProtocolError",
        domain: "adapter.sync_gateway",
        code: SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_OPERATION,
      }),
    );

    expect(() => createSyncGatewayAdminEnvelope({
      operation: "provisionRegistry",
      payload: { registrations: [] },
      sheetId: "sheet-1",
      secret: "",
    })).toThrow(SyncGatewayProtocolError);
  });

  it("keeps JSON null as a payload value rather than an absent state", () => {
    expect(canonicalSyncJson({ empty: null })).toBe('{"empty":null}');
  });
});
