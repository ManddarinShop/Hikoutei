import { describe, expect, it } from "vitest";
import {
  AppsScriptSyncGatewayError,
  SYNC_GATEWAY_CLIENT_ERROR_CODES,
  type SyncGatewayClientErrorCode,
} from "../src/adapter/sheets/providers/apps-script-gateway/errors.js";
import { CoreErrorException } from "../src/domain/errors/index.js";
import {
  TRANSPORT_OUTCOME_KINDS,
  classifyTransportOutcome,
  isDeliveryUncertainOutcome,
} from "../src/application/sync/gateway/transportClassification.js";
import { absentValue, presentValue } from "../src/shared/state/index.js";

function transportError(code: SyncGatewayClientErrorCode, status = 200, remoteCode?: string): AppsScriptSyncGatewayError {
  return new AppsScriptSyncGatewayError(
    code,
    "boom",
    presentValue(status),
    remoteCode === undefined ? absentValue() : presentValue(remoteCode),
  );
}

describe("transport classification", () => {
  it("classifies timeout, network, and non-JSON responses as delivery uncertain", () => {
    expect(classifyTransportOutcome(transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.TIMEOUT)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(classifyTransportOutcome(transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.NETWORK_ERROR)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(classifyTransportOutcome(transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE, 404)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(classifyTransportOutcome(transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_REDIRECT, 302)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it.each([404, 408, 429, 500, 502, 503])(
    "classifies a structured JSON error at HTTP %i as delivery uncertain",
    (status) => {
      const outcome = classifyTransportOutcome(
        transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR, status, "operation_failed"),
      );
      expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
      expect(outcome.httpStatus).toEqual({ kind: "present", value: status });
    },
  );

  it.each(["operation_failed", "internal_error"])(
    "classifies a structured HTTP-200 %s as delivery uncertain",
    (remoteCode) => {
      const outcome = classifyTransportOutcome(
        transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR, 200, remoteCode),
      );
      expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
      expect(outcome.code).toEqual({ kind: "present", value: remoteCode });
    },
  );

  it("keeps a pre-mutation remote rejection as a known failure", () => {
    // Code.gs validates the signed envelope before any operation runs, so an
    // invalid_signature failure proves the Sheet was never touched.
    const outcome = classifyTransportOutcome(
      transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR, 200, "invalid_signature"),
    );
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE);
    expect(outcome.code.kind).toBe("present");
  });

  it("treats an unrecognized structured failure as delivery uncertain", () => {
    // An envelope-level code that is not a proven pre-mutation rejection cannot
    // prove that no partial remote write began.
    expect(classifyTransportOutcome(
      transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR, 200, "visible_guard_mismatch"),
    ).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it("preserves a pre-mutation rejection at a non-2xx status as explicit failure", () => {
    expect(classifyTransportOutcome(
      transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR, 409, "sheet_open_failed"),
    ).kind).toBe(TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE);
  });

  it("classifies a no-op (undefined) as success", () => {
    expect(classifyTransportOutcome(undefined).kind).toBe(TRANSPORT_OUTCOME_KINDS.SUCCESS);
  });

  it("classifies unknown errors as delivery uncertain rather than success", () => {
    const outcome = classifyTransportOutcome(new Error("surprise"));
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it("does not treat unrelated thrown errors as transport successes", () => {
    const outcome = classifyTransportOutcome(new Error("nope"));
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it("isDeliveryUncertainOutcome flags only ambiguous outcomes", () => {
    expect(isDeliveryUncertainOutcome(classifyTransportOutcome(transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.TIMEOUT))))
      .toBe(true);
    expect(isDeliveryUncertainOutcome(classifyTransportOutcome(undefined))).toBe(false);
    expect(isDeliveryUncertainOutcome(
      classifyTransportOutcome(transportError(SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR, 200, "invalid_payload")),
    )).toBe(false);
  });
});
