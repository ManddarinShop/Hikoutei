/**
 * Structured classification of a provider transport outcome.
 *
 * The provider transport can fail for three very different reasons that
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
 *
 * The classifier is host-neutral: it never imports the host transport error
 * type. A thrown value is promoted to the classifier view only when it
 * carries a recognized stable fault code, a message, and presence-shaped
 * status/remote-code fields; anything else keeps the historical
 * delivery-uncertain fallthrough for unknown errors.
 */

import { PRESENCE_KINDS } from "../contract/state.js";
import type { Presence } from "../contract/state.js";

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
 * Stable fault codes the classifier recognizes, mirroring the host
 * transport's stable code table (still single-sourced there).
 *
 * Kept as literals so the kernel never imports the host error type.
 */
const TRANSPORT_FAULT_CODES = {
  /** The request exceeded its timeout; the remote may still have committed. */
  TIMEOUT: "google_sheets_api_timeout",
  /** No usable HTTP response (DNS/socket/fetch failure). */
  NETWORK_ERROR: "google_sheets_api_network_error",
  /** The API returned a non-2xx HTTP status. */
  HTTP_ERROR: "google_sheets_api_http_error",
  /** A 2xx response whose structure cannot prove what was applied. */
  INVALID_RESPONSE: "google_sheets_api_invalid_response",
  /**
   * The shared request-start limiter refused the admission BEFORE any remote
   * call: the predicted wait exceeded the bounded queue horizon. No remote
   * request was sent, so the durable worker requeues through the
   * recovery path and a later pass can be admitted again.
   */
  REQUEST_START_REFUSED: "google_sheets_api_request_start_refused",
} as const;

/** Fault codes as a runtime list for the classifier-view guard. */
const TRANSPORT_FAULT_CODE_LIST: readonly string[] = Object.values(TRANSPORT_FAULT_CODES);

/**
 * Minimal structural view of a transport failure the classifier can read
 * without importing a host error type.
 */
export interface TransportFailureView {
  readonly code: string;
  readonly message: string;
  readonly status: Presence<number>;
  readonly remoteCode: Presence<string>;
}

/** Returns true for a presence-shaped status/remote-code field. */
function isPresenceField(value: unknown, valueType: "number" | "string"): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === PRESENCE_KINDS.ABSENT) return true;
  return record.kind === PRESENCE_KINDS.PRESENT && typeof record.value === valueType;
}

/**
 * Promotes a thrown value to the classifier view when it carries a
 * recognized fault shape (a stable fault code, a message, and
 * presence-shaped status/remote-code fields). Anything else stays on the
 * unknown-error fallthrough below.
 */
function asTransportFailureView(error: unknown): TransportFailureView | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record.code !== "string" || typeof record.message !== "string") return undefined;
  if (!TRANSPORT_FAULT_CODE_LIST.includes(record.code)) return undefined;
  if (!isPresenceField(record.status, "number")) return undefined;
  if (!isPresenceField(record.remoteCode, "string")) return undefined;
  return error as TransportFailureView;
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
 * host's own stable transport codes (defensive: a locally produced
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
  // Local host stable codes (defensive; never emitted as unknown).
  ...TRANSPORT_FAULT_CODE_LIST,
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
    ? { kind: PRESENCE_KINDS.PRESENT, value: sanitizeTransportRemoteCode(presence.value) }
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
  const view = asTransportFailureView(error);
  if (view !== undefined) {
    const kind = isDeliveryUncertainTransport(view)
      ? TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN
      : TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE;
    return {
      kind,
      httpStatus: view.status,
      // The remote code is untrusted input (it can echo arbitrary API
      // error-body text); only allowlisted stable codes may pass through.
      code: sanitizeRemoteCodePresence(view.remoteCode),
      message: view.message,
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
 * Returns true when a transport failure implies an ambiguous delivery.
 *
 * Non-2xx responses prove the batch did not execute only for the
 * pre-mutation rejection statuses below; timeouts, network failures, and
 * proxy-emitted 408/429/5xx responses can follow a committed write, and a
 * malformed 2xx reply cannot prove what was applied. Those are recovered
 * through the postcondition probe path, never closed as success.
 */
export function isDeliveryUncertainTransport(
  view: TransportFailureView,
): boolean {
  if (
    view.code === TRANSPORT_FAULT_CODES.TIMEOUT ||
    view.code === TRANSPORT_FAULT_CODES.NETWORK_ERROR ||
    view.code === TRANSPORT_FAULT_CODES.INVALID_RESPONSE ||
    view.code === TRANSPORT_FAULT_CODES.REQUEST_START_REFUSED
  ) {
    return true;
  }
  if (view.status.kind !== PRESENCE_KINDS.PRESENT) return true;
  const status = view.status.value;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    // The API rejected the request before executing any part of the batch.
    return false;
  }
  return true;
}
