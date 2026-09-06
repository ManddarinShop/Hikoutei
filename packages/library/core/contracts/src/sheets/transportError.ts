/**
 * Structured transport error for the direct Google Sheets API outbound
 * provider. Extracted from the adapter (where it was co-located with the
 * provider's request-boundary helpers) into the contracts leaf: the shared
 * `classifyTransportOutcome` boundary must classify adapter-thrown errors by
 * class identity, so the class has to live where both sides can see it.
 *
 * The transport converts gaxios/network failures into
 * `GoogleSheetsApiTransportError` with explicit HTTP-status and stable-code
 * presence so `classifyTransportOutcome` can decide between a proven
 * pre-mutation rejection and an ambiguous delivery without reading raw SDK
 * error objects. (P8-B: contract-ish symbol moved with the transportOutcome
 * layer; the adapter module re-exports it so existing adapter import paths
 * stay valid.)
 */

import { CoreErrorException } from "../domain/errors/index.js";
import { PRESENCE_KINDS } from "../state/index.js";
import type { Presence } from "../state/index.js";

/** Stable transport error categories emitted by the direct provider. */
export const GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES = {
  /** The request exceeded its timeout; the remote may still have committed. */
  TIMEOUT: "google_sheets_api_timeout",
  /** No usable HTTP response (DNS/socket/fetch failure). */
  NETWORK_ERROR: "google_sheets_api_network_error",
  /** The API returned a non-2xx HTTP status. */
  HTTP_ERROR: "google_sheets_api_http_error",
  /** A 2xx response whose structure cannot prove what was applied. */
  INVALID_RESPONSE: "google_sheets_api_invalid_response",
  /**
   * The shared request-start limiter refused the admission BEFORE any SDK
   * call: the predicted wait exceeded the bounded queue horizon. No remote
   * request was sent, and the limiter horizon was not advanced, so the
   * durable worker requeues through the CAS/recovery path and a later pass
   * can be admitted again.
   */
  REQUEST_START_REFUSED: "google_sheets_api_request_start_refused",
} as const;

export type GoogleSheetsApiTransportErrorCode =
  (typeof GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES)[keyof typeof GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES];

/**
 * Provider-neutral transport error with explicit status/code presence.
 *
 * `status` is the HTTP status when one was observed; `code` carries a stable
 * remote/network code (API error status such as INVALID_ARGUMENT, or a Node
 * error code such as ECONNRESET) — never a URL, credential, or payload.
 */
export class GoogleSheetsApiTransportError extends CoreErrorException<
  "adapter.google_sheets_api",
  GoogleSheetsApiTransportErrorCode
> {
  readonly status: Presence<number>;
  readonly remoteCode: Presence<string>;

  public constructor(
    code: GoogleSheetsApiTransportErrorCode,
    message: string,
    status: Presence<number>,
    remoteCode: Presence<string> = { kind: PRESENCE_KINDS.ABSENT },
  ) {
    super("adapter.google_sheets_api", code, message);
    this.status = status;
    this.remoteCode = remoteCode;
  }
}