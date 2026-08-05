import { describe, expect, it } from "vitest";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "../src/adapter/sheets/providers/google-sheets-api/errors.js";
import {
  TRANSPORT_OUTCOME_KINDS,
  classifyTransportOutcome,
  isDeliveryUncertainOutcome,
} from "../src/application/sync/sheets/transportOutcome.js";
import { absentValue, presentValue } from "../src/shared/state/index.js";

function transportError(
  code: GoogleSheetsApiTransportError["code"],
  status?: number,
  remoteCode?: string,
): GoogleSheetsApiTransportError {
  return new GoogleSheetsApiTransportError(
    code,
    "boom",
    status === undefined ? absentValue() : presentValue(status),
    remoteCode === undefined ? absentValue() : presentValue(remoteCode),
  );
}

describe("transport classification", () => {
  it("classifies timeout, network, and malformed-response errors as delivery uncertain", () => {
    expect(classifyTransportOutcome(transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(classifyTransportOutcome(transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.INVALID_RESPONSE, 200),
    ).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it.each([400, 401, 403, 404])(
    "classifies a pre-mutation HTTP rejection at status %i as explicit failure",
    (status) => {
      const outcome = classifyTransportOutcome(
        transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR, status, "INVALID_ARGUMENT"),
      );
      expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE);
      expect(outcome.httpStatus).toEqual({ kind: "present", value: status });
      expect(outcome.code).toEqual({ kind: "present", value: "INVALID_ARGUMENT" });
    },
  );

  it.each([408, 429, 500, 502, 503])(
    "classifies an ambiguous HTTP status %i as delivery uncertain",
    (status) => {
      const outcome = classifyTransportOutcome(
        transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR, status, "INTERNAL"),
      );
      expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
      expect(outcome.httpStatus).toEqual({ kind: "present", value: status });
    },
  );

  it("classifies a status-less HTTP error as delivery uncertain", () => {
    expect(classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR),
    ).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
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
    expect(isDeliveryUncertainOutcome(classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT),
    ))).toBe(true);
    expect(isDeliveryUncertainOutcome(classifyTransportOutcome(undefined))).toBe(false);
    expect(isDeliveryUncertainOutcome(classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR, 403, "PERMISSION_DENIED"),
    ))).toBe(false);
  });
});
