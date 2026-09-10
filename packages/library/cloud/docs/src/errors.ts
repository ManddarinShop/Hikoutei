/**
 * Structured errors for the Google Docs API provider.
 *
 * The transport converts gaxios/network failures into `DocsTransportError`
 * with explicit HTTP-status and stable-code presence, mirroring the Sheets
 * transport contract. Docs fault codes are intentionally NOT in the shared
 * `classifyTransportOutcome` allowlist, so a Docs error that reaches that
 * boundary falls through to `delivery_uncertain` (requeue/probe) — the safe
 * direction for an unverified remote state. Quota feedback uses only the
 * `{ httpStatus, code }` presence pair via `isQuotaLimitedOutcome`, which
 * needs no fault-code interop.
 */

import type { Presence } from "@hikoutei/ikisaki";

/** Stable Docs transport fault codes (Docs vocabulary, never raw text). */
export const GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES = {
  /** The request exceeded its timeout; the remote may still have committed. */
  TIMEOUT: "google_docs_api_timeout",
  /** No usable HTTP response (DNS/socket/fetch failure). */
  NETWORK_ERROR: "google_docs_api_network_error",
  /** The API returned a non-2xx HTTP status. */
  HTTP_ERROR: "google_docs_api_http_error",
  /** A 2xx response whose structure cannot prove what was applied. */
  INVALID_RESPONSE: "google_docs_api_invalid_response",
  /** The request-start limiter refused admission BEFORE any remote call. */
  REQUEST_START_REFUSED: "google_docs_api_request_start_refused",
} as const;

export type GoogleDocsApiTransportErrorCode =
  (typeof GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES)[keyof typeof GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES];

/**
 * Thrown transport failure: stable code plus presence-shaped HTTP status
 * and remote code. Callers never parse the message (it may echo remote
 * payload fragments, ids, or URLs).
 */
export class DocsTransportError extends Error {
  public readonly code: GoogleDocsApiTransportErrorCode;
  public readonly status: Presence<number>;
  public readonly remoteCode: Presence<string>;

  public constructor(
    code: GoogleDocsApiTransportErrorCode,
    message: string,
    status: Presence<number>,
    remoteCode: Presence<string>,
  ) {
    super(message);
    this.name = "DocsTransportError";
    this.code = code;
    this.status = status;
    this.remoteCode = remoteCode;
  }
}

/**
 * True when the status marks a transient remote condition (retryable):
 * absent status (timeout/network), HTTP 408, 429, or any 5xx. Proven
 * pre-mutation 4xx rejections (400/401/403/404) are NOT retryable.
 */
export function isRetryableDocsStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}
