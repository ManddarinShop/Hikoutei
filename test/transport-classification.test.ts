/**
 * Transport outcome classification and remote-code sanitization coverage.
 *
 * Pins how raw Google Sheets API transport errors map to delivery outcomes
 * (success, explicit remote failure, or delivery-uncertain) and how untrusted
 * remote codes are allowlisted or collapsed to a safe unknown category.
 */

import { describe, expect, it } from "vitest";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/errors.js";
import {
  TRANSPORT_OUTCOME_KINDS,
  TRANSPORT_OUTCOME_UNKNOWN_CODE,
  classifyTransportOutcome,
  isDeliveryUncertainOutcome,
  sanitizeTransportRemoteCode,
} from "@hikoutei/ikisaki";
import { absentValue, presentValue } from "@hikoutei/contracts/state/index.js";

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

// Verifies raw transport errors map to the correct delivery outcome kind.
describe("transport classification", () => {
  // Verifies timeout, network, and malformed-response errors are delivery-uncertain.
  it("classifies timeout, network, and malformed-response errors as delivery uncertain", () => {
    expect(classifyTransportOutcome(transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(classifyTransportOutcome(transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR)).kind)
      .toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.INVALID_RESPONSE, 200),
    ).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  // Verifies pre-mutation HTTP rejections map to explicit remote failure.
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

  // Verifies ambiguous HTTP statuses map to delivery-uncertain outcomes.
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

  // Verifies an HTTP error without a status is treated as delivery-uncertain.
  it("classifies a status-less HTTP error as delivery uncertain", () => {
    expect(classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR),
    ).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  // Verifies an absent (no-op) transport result classifies as success.
  it("classifies a no-op (undefined) as success", () => {
    expect(classifyTransportOutcome(undefined).kind).toBe(TRANSPORT_OUTCOME_KINDS.SUCCESS);
  });

  // Verifies unknown thrown errors fail closed as delivery-uncertain, never success.
  it("classifies unknown errors as delivery uncertain rather than success", () => {
    const outcome = classifyTransportOutcome(new Error("surprise"));
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  // Verifies unrelated thrown errors are never classified as transport successes.
  it("does not treat unrelated thrown errors as transport successes", () => {
    const outcome = classifyTransportOutcome(new Error("nope"));
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  // Verifies the delivery-uncertain predicate flags only ambiguous outcomes.
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

// Verifies untrusted remote codes are allowlisted or collapsed to the safe category.
describe("transport remote-code sanitization", () => {
  // Verifies allowlisted Google API status codes pass through unchanged.
  it("preserves allowlisted Google API status codes", () => {
    for (const code of [
      "INVALID_ARGUMENT",
      "RESOURCE_EXHAUSTED",
      "PERMISSION_DENIED",
      "NOT_FOUND",
      "DEADLINE_EXCEEDED",
      "UNAUTHENTICATED",
      "FAILED_PRECONDITION",
      "ABORTED",
      "INTERNAL",
      "UNAVAILABLE",
    ]) {
      expect(sanitizeTransportRemoteCode(code)).toBe(code);
      expect(classifyTransportOutcome(
        transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR, 403, code),
      ).code).toEqual({ kind: "present", value: code });
    }
  });

  // Verifies known Node network error codes pass through unchanged.
  it("preserves known Node network codes", () => {
    for (const code of ["ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"]) {
      expect(sanitizeTransportRemoteCode(code)).toBe(code);
      expect(classifyTransportOutcome(
        transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR, undefined, code),
      ).code).toEqual({ kind: "present", value: code });
    }
  });

  // Verifies hostile, malformed, and secret-like codes collapse to the safe category.
  it("maps hostile, malformed, and secret-like remote codes to the fixed safe category", () => {
    const hostile = [
      "ya29.jwt-abcdefghijklmnop",
      "service@project.iam.gserviceaccount.com",
      "https://docs.google.com/spreadsheets/d/1AbC/edit",
      "/Users/me/.config/gcloud/application_default_credentials.json",
      "INVALID_ARGUMENT extra junk",
      "RATE_LIMIT_EXCEEDED quota project 12345",
      "400",
      "DEADLINE",
      "",
    ];
    for (const code of hostile) {
      expect(sanitizeTransportRemoteCode(code), code).toBe(TRANSPORT_OUTCOME_UNKNOWN_CODE);
    }
    // Non-string input is never emitted either.
    expect(sanitizeTransportRemoteCode(undefined)).toBe(TRANSPORT_OUTCOME_UNKNOWN_CODE);
    expect(sanitizeTransportRemoteCode(42)).toBe(TRANSPORT_OUTCOME_UNKNOWN_CODE);
    expect(sanitizeTransportRemoteCode(null)).toBe(TRANSPORT_OUTCOME_UNKNOWN_CODE);
  });

  // Verifies classified outcomes carry the sanitized code while keeping kind semantics.
  it("never forwards a hostile remote code into the classified outcome", () => {
    const outcome = classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR, 400, "ya29.jwt-secret"),
    );
    // Kind semantics are untouched: the proven pre-mutation rejection stays
    // explicit; only the untrusted code collapses to the safe category.
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE);
    expect(outcome.httpStatus).toEqual({ kind: "present", value: 400 });
    expect(outcome.code).toEqual({ kind: "present", value: TRANSPORT_OUTCOME_UNKNOWN_CODE });

    const network = classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR, undefined, "https://evil.example/x"),
    );
    expect(network.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    expect(network.code).toEqual({ kind: "present", value: TRANSPORT_OUTCOME_UNKNOWN_CODE });
  });

  // Verifies absent codes stay absent and local transport codes stay intact.
  it("keeps an absent remote code absent and allowlisted local codes intact", () => {
    expect(classifyTransportOutcome(
      transportError(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT),
    ).code).toEqual({ kind: "absent" });
    for (const code of Object.values(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES)) {
      expect(sanitizeTransportRemoteCode(code)).toBe(code);
    }
  });
});
