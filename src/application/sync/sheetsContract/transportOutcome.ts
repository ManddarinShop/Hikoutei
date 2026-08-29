/**
 * Structured classification of a provider transport outcome.
 *
 * The direct Sheets transport can fail for three very different reasons that
 * the effect worker must not treat the same way:
 *
 * - `success`: a decoded, valid envelope was returned.
 * - `explicit_remote_failure`: the remote returned a structured rejection that
 *   proves no operation ran (e.g. a 4xx API validation failure). The remote
 *   state is known, so the effect can transition to a terminal failure state.
 * - `delivery_uncertain`: the transport gave no usable answer (timeout,
 *   network error, non-JSON/404 response, lost connection). The remote may or
 *   may not have committed the write, so the effect must be recovered through
 *   a postcondition probe rather than immediately redriven. A locally REFUSED
 *   request start (the shared pacing limiter queue exceeds its bound) is also
 *   delivery-uncertain: no remote call ran, but the durable worker still
 *   requeues through the same probe/redrive path rather than trusting an
 *   unverified "nothing happened". Per-effect guard/schema/identity
 *   rejections are not transport errors at all: they arrive as per-effect
 *   result statuses in a successful envelope and keep their existing terminal
 *   handling.
 *
 * This boundary lets future durable `delivery_uncertain` state and recovery
 * barriers classify a thrown transport error without re-deriving the rules at
 * every call site. It never weakens correctness: an uncertain outcome is never
 * promoted to `success`, and a proven pre-mutation rejection is never
 * reclassified as a retryable transport error.
 */

import { GoogleSheetsApiTransportError, GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES } from "../../../adapter/sheets/providers/google-sheets-api/errors.js";
import { PRESENCE_KINDS, presentValue } from "../../../shared/state/index.js";
import type { Presence } from "../../../shared/state/types.js";

export const TRANSPORT_OUTCOME_KINDS = {
  SUCCESS: "success",
  EXPLICIT_REMOTE_FAILURE: "explicit_remote_failure",
  DELIVERY_UNCERTAIN: "delivery_uncertain",
} as const;

export type TransportOutcomeKind =
  (typeof TRANSPORT_OUTCOME_KINDS)[keyof typeof TRANSPORT_OUTCOME_KINDS];

/** A classified transport outcome with redacted, safe diagnostics. */
export interface TransportOutcome {
  readonly kind: TransportOutcomeKind;
  readonly httpStatus: Presence<number>;
  /**
   * Remote/network code after runtime sanitization: either an allowlisted
   * stable value or the fixed `unknown` category, never an arbitrary
   * remote string.
   */
  readonly code: Presence<string>;
  readonly message: string;
}

/**
 * Fixed safe category that replaces any remote code not on the allowlist.
 *
 * Remote API error bodies are untrusted input: their `status` field could
 * carry an arbitrary string (an id, URL, or secret) instead of a canonical
 * Google API status name. Telemetry consumers must never see raw remote
 * text, so anything that is not an explicitly allowlisted stable code
 * collapses to this category.
 */
export const TRANSPORT_OUTCOME_UNKNOWN_CODE = "unknown";

/**
 * Allowlisted remote/network codes that may reach telemetry.
 *
 * Covers the canonical Google API status names (`error.status` of API
 * error bodies), well-known Node/gaxios network error codes, and the
 * provider's own stable transport codes (defensive: a locally produced
 * code is never treated as unknown). Anything else — a malformed,
 * secret-like, or novel remote string — is replaced by
 * `TRANSPORT_OUTCOME_UNKNOWN_CODE`.
 */
const SAFE_TRANSPORT_REMOTE_CODES: ReadonlySet<string> = new Set([
  // Canonical google.rpc.Code status names.
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "UNAUTHENTICATED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  // Well-known Node/gaxios network and timeout error codes.
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EPIPE",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "ENOBUFS",
  "ESHUTDOWN",
  "EPROTO",
  "ERR_SOCKET_CLOSED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
  "UND_ERR_DESTROYED",
  "UND_ERR_TIMEOUT",
  // Local provider stable codes (defensive; never emitted as unknown).
  ...Object.values(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES),
]);

/**
 * Sanitizes one untrusted remote code before it can reach telemetry.
 *
 * Returns the candidate unchanged only when it is an allowlisted stable
 * code; every other value — including non-string input and secret-like or
 * malformed remote text — maps to the fixed `unknown` category. Never
 * returns the raw candidate for unallowlisted input.
 */
export function sanitizeTransportRemoteCode(candidate: unknown): string {
  return typeof candidate === "string" && SAFE_TRANSPORT_REMOTE_CODES.has(candidate)
    ? candidate
    : TRANSPORT_OUTCOME_UNKNOWN_CODE;
}

/** Sanitizes a presence-wrapped remote code, preserving absence. */
function sanitizeRemoteCodePresence(presence: Presence<string>): Presence<string> {
  return presence.kind === PRESENCE_KINDS.PRESENT
    ? presentValue(sanitizeTransportRemoteCode(presence.value))
    : presence;
}

/**
 * Classifies a value thrown by the provider transport.
 *
 * `undefined`/`null` means no error was observed and is classified as success;
 * callers should normally pass a caught error. Any non-transport error is left
 * as `delivery_uncertain` rather than `success` because the caller cannot prove
 * the remote state either way.
 */
export function classifyTransportOutcome(error: unknown): TransportOutcome {
  if (error === undefined || error === null) {
    return {
      kind: TRANSPORT_OUTCOME_KINDS.SUCCESS,
      httpStatus: { kind: PRESENCE_KINDS.ABSENT },
      code: { kind: PRESENCE_KINDS.ABSENT },
      message: "",
    };
  }
  if (error instanceof GoogleSheetsApiTransportError) {
    const kind = isGoogleSheetsApiDeliveryUncertain(error)
      ? TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN
      : TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE;
    return {
      kind,
      httpStatus: error.status,
      // The remote code is untrusted input (it can echo arbitrary API
      // error-body text); only allowlisted stable codes may pass through.
      code: sanitizeRemoteCodePresence(error.remoteCode),
      message: error.message,
    };
  }
  // Unknown transport/Node error: assume the remote state is unverifiable.
  return {
    kind: TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN,
    httpStatus: { kind: PRESENCE_KINDS.ABSENT },
    code: { kind: PRESENCE_KINDS.ABSENT },
    message: error instanceof Error ? error.message : "Unexpected transport failure",
  };
}

/** Returns true when the remote state cannot be proven either way. */
export function isDeliveryUncertainOutcome(outcome: TransportOutcome): boolean {
  return outcome.kind === TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN;
}

/**
 * Returns true when the direct Sheets transport error implies an ambiguous
 * delivery.
 *
 * Google API non-2xx responses prove the batch did not execute only for the
 * pre-mutation rejection statuses below; timeouts, network failures, and
 * proxy-emitted 408/429/5xx responses can follow a committed write, and a
 * malformed 2xx reply cannot prove what was applied. Those are recovered
 * through the postcondition probe path, never closed as success.
 */
export function isGoogleSheetsApiDeliveryUncertain(
  error: GoogleSheetsApiTransportError,
): boolean {
  if (
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT ||
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR ||
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.INVALID_RESPONSE ||
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED
  ) {
    return true;
  }
  if (error.status.kind !== PRESENCE_KINDS.PRESENT) return true;
  const status = error.status.value;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    // The API rejected the request before executing any part of the batch.
    return false;
  }
  return true;
}
