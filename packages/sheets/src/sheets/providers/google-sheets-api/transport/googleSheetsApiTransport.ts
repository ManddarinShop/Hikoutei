/**
 * Narrow transport contract for the direct Google Sheets API provider.
 *
 * All Google SDK types stay behind this module: the rest of the provider
 * works with a small discriminated union of write requests and treats every
 * response as an untrusted `unknown` value that the preflight/reply modules
 * validate with runtime guards. Tests implement the same interface with an
 * in-memory spreadsheet model, so the planner and batch builder are exercised
 * without credentials or network access.
 */

import { GoogleAuth } from "google-auth-library";
import { readFileSync } from "node:fs";
import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { presentValue, absentValue, PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import {
  describeErrorForInternalLog,
  HIKOUTEI_LOG_LEVELS,
  logHikouteiInternalEvent,
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";
import { GOOGLE_SHEETS_API_SCOPES } from "../constants.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
  invalidProviderRequest,
} from "../errors.js";
import {
  parseRawErrorRecord,
  parseRawErrorText,
  parseRawHttpStatus,
} from "./rawErrorSchemas.js";

// P8-C sole-source: the wire contract types (write requests, transport
// boundary, values.get shapes) live in the contracts leaf; this module only
// re-exports them so existing adapter-internal and test import paths stay
// valid (contracts → adapter is the allowed direction).
import type {
  GoogleSheetsApiBatchUpdateRequest,
  GoogleSheetsApiCell,
  GoogleSheetsApiCellRow,
  GoogleSheetsApiGetSpreadsheetRequest,
  GoogleSheetsApiNumberFormat,
  GoogleSheetsApiTransport,
  GoogleSheetsApiValuesGetRequest,
  GoogleSheetsApiValuesGetResponse,
  GoogleSheetsApiWriteRequest,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";
export type {
  GoogleSheetsApiBatchUpdateRequest,
  GoogleSheetsApiCell,
  GoogleSheetsApiCellRow,
  GoogleSheetsApiGetSpreadsheetRequest,
  GoogleSheetsApiNumberFormat,
  GoogleSheetsApiTransport,
  GoogleSheetsApiValuesGetRequest,
  GoogleSheetsApiValuesGetResponse,
  GoogleSheetsApiWriteRequest,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";

/** Auth type accepted by the sheets factory (may resolve to a nested version). */
export type SheetsAuth = NonNullable<Parameters<typeof sheets>[0]["auth"]>;

/**
 * Advances (and returns) the next round-robin client index for a pool.
 *
 * Shared by the HTTP transport's own fallback cursor and the credential-pool
 * tests: a preferred (provider-admitted) index is returned WITHOUT advancing
 * the cursor, so admission-bound calls never skew the fallback rotation.
 * The cursor is a mutable carrier so callers keep the rotation across
 * requests; `clientCount` must be ≥ 1.
 */
export function nextPooledClientIndex(
  cursor: { next: number },
  clientCount: number,
  preferredIndex: number | undefined,
): number {
  if (preferredIndex !== undefined) {
    return preferredIndex;
  }
  const index = cursor.next % clientCount;
  cursor.next = (index + 1) % clientCount;
  return index;
}

/** Options for the real HTTP transport backed by @googleapis/sheets. */
export interface GoogleSheetsApiHttpTransportOptions {
  /**
   * Injected auth for tests/alternate credentials. Defaults to Application
   * Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` service account).
   * Ignored when `authPool`/`serviceAccountKeyFiles` build a pool.
   */
  readonly auth?: SheetsAuth;
  /**
   * Injected credential pool (one auth per Google quota principal). When
   * non-empty it replaces the single `auth`/ADC client; each pool entry gets
   * its own `sheets()` client. Provided for credential-free tests and for
   * callers that own auth construction; production wiring uses
   * `serviceAccountKeyFiles` instead.
   */
  readonly authPool?: readonly SheetsAuth[];
  /**
   * Service-account key-file pool: each entry is read and turned into its
   * own `GoogleAuth` client at construction (fail fast on unreadable or
   * malformed files). Error messages carry the PATH only — never the file
   * contents, client email, or any key material.
   */
  readonly serviceAccountKeyFiles?: readonly string[];
  readonly requestTimeoutMs: number;
}

/**
 * Real transport over the Google Sheets REST API.
 *
 * gaxios auto-retry is disabled for every call: retries are the durable
 * worker/recovery path's job, and a retried mutating request could replay an
 * already committed batch. All errors are mapped to
 * `GoogleSheetsApiTransportError` before leaving this module.
 */
export class GoogleSheetsApiHttpTransport implements GoogleSheetsApiTransport {
  private readonly clients: readonly ReturnType<typeof sheets>[];
  /** Fallback rotation cursor for requests WITHOUT an admitted index. */
  private readonly poolCursor: { next: number } = { next: 0 };
  private readonly requestTimeoutMs: number;

  public constructor(options: GoogleSheetsApiHttpTransportOptions) {
    // google-auth-library may resolve to a version nested under googleapis-common
    // that differs from the top-level one; the boundary cast keeps the SDK
    // version mismatch contained in this module.
    const pool: SheetsAuth[] = [...(options.authPool ?? [])];
    for (const keyFile of options.serviceAccountKeyFiles ?? []) {
      pool.push(loadServiceAccountAuth(keyFile));
    }
    if (pool.length === 0) {
      pool.push(options.auth ??
        (new GoogleAuth({ scopes: [...GOOGLE_SHEETS_API_SCOPES] }) as unknown as SheetsAuth));
    }
    // The sheets factory accepts GoogleAuth; the narrow wrapper below owns the
    // SDK boundary so no other provider code touches the client type. One
    // client per pooled credential; a 1-client pool is the historical
    // single-auth transport (no rotation ever changes the selection).
    this.clients = pool.map((auth) => sheets({ version: "v4", auth }));
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  /**
   * Picks the client for one request: the admitted pool identity when the
   * request carries a `credentialIndex` (provider-bound admission and
   * signing), otherwise the next round-robin entry (or the single default
   * client, byte-identical to the pre-pool transport).
   */
  private clientFor(credentialIndex: number | undefined): ReturnType<typeof sheets> {
    if (credentialIndex !== undefined) {
      const client = this.clients[credentialIndex];
      if (client === undefined) {
        // Fail CLOSED before any wire contact: signing with a different
        // identity than the one admission paced against would silently
        // defeat the per-identity quota contract.
        invalidProviderRequest(
          "Google Sheets API transport",
          "credentialIndex is outside the client pool",
        );
      }
      return client;
    }
    if (this.clients.length === 1) {
      return this.clients[0] as ReturnType<typeof sheets>;
    }
    const index = nextPooledClientIndex(this.poolCursor, this.clients.length, undefined);
    return this.clients[index] as ReturnType<typeof sheets>;
  }

  public async getSpreadsheet(
    request: GoogleSheetsApiGetSpreadsheetRequest,
  ): Promise<unknown> {
    try {
      const response = await this.clientFor(request.credentialIndex).spreadsheets.get(
        {
          spreadsheetId: request.spreadsheetId,
          ranges: [...request.ranges],
          fields: request.fields,
        },
        { timeout: request.timeoutMs ?? this.requestTimeoutMs, retry: false },
      );
      return response.data;
    } catch (error: unknown) {
      const mapped = classifyGoogleSheetsApiError(error);
      logTransportFailure(mapped);
      throw mapped;
    }
  }

  public async getValues(
    request: GoogleSheetsApiValuesGetRequest,
  ): Promise<GoogleSheetsApiValuesGetResponse> {
    try {
      const response = await this.clientFor(request.credentialIndex).spreadsheets.values.get(
        {
          spreadsheetId: request.spreadsheetId,
          range: request.range,
        },
        { timeout: request.timeoutMs ?? this.requestTimeoutMs, retry: false },
      );
      return { values: response.data.values ?? [] };
    } catch (error: unknown) {
      const mapped = classifyGoogleSheetsApiError(error);
      logTransportFailure(mapped);
      throw mapped;
    }
  }

  public async batchUpdate(
    request: GoogleSheetsApiBatchUpdateRequest,
  ): Promise<unknown> {
    try {
      const response = await this.clientFor(request.credentialIndex).spreadsheets.batchUpdate(
        {
          spreadsheetId: request.spreadsheetId,
          // The body comes from the same builder that
          // `serializeBatchUpdateRequests` measures, so the batch builder's
          // byte budget is exact for what gaxios sends on the wire.
          requestBody: toSdkBatchUpdateBody(request.requests),
        },
        { timeout: this.requestTimeoutMs, retry: false },
      );
      return response.data;
    } catch (error: unknown) {
      const mapped = classifyGoogleSheetsApiError(error);
      logTransportFailure(mapped);
      throw mapped;
    }
  }
}

/**
 * Required service-account key-file fields, checked by SHAPE (non-blank
 * string) only at load. Mirrors the sync auto-start bridge's mandatory
 * validation so a pool file that slips past the bridge still cannot build a
 * broken client.
 */
const SERVICE_ACCOUNT_KEY_FIELDS = ["type", "client_email", "private_key", "project_id"] as const;

/**
 * Builds one pooled `GoogleAuth` from a service-account key file.
 *
 * Reads, JSON-parses, and SHAPE-validates the file at transport construction
 * so a misconfigured pool fails fast and locally — a malformed key file must
 * never create a client that only breaks on first use. Required
 * service-account fields (`type`, `client_email`, `private_key`,
 * `project_id` as non-blank strings) are checked by shape only; failure
 * messages carry the path only, and the file contents (client email, private
 * key) never leave this function — the parsed JSON goes straight into
 * `GoogleAuth.credentials`.
 */
function loadServiceAccountAuth(keyFile: string): SheetsAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyFile, "utf8")) as unknown;
  } catch {
    throw new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
      `Unable to read the service-account key file: ${keyFile}`,
      absentValue(),
      absentValue(),
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
      `Service-account key file is not a JSON object: ${keyFile}`,
      absentValue(),
      absentValue(),
    );
  }
  // Validate the service-account shape ONCE at load: without this, ANY JSON
  // object builds a GoogleAuth client and the failure surfaces mid-run on
  // first signing attempt instead of at construction. Shape check only —
  // no field value is ever logged or embedded in an error message.
  const record = parsed as Record<string, unknown>;
  const invalidFields = SERVICE_ACCOUNT_KEY_FIELDS.filter(
    (field) => typeof record[field] !== "string" || (record[field] as string).trim() === "",
  );
  if (invalidFields.length > 0) {
    throw new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
      // Field NAMES are non-sensitive schema info; values never appear.
      `Service-account key file is missing required fields (${invalidFields.join(", ")}): ${keyFile}`,
      absentValue(),
      absentValue(),
    );
  }
  // The parsed key JSON goes straight into GoogleAuth.credentials; the cast
  // keeps the google-auth-library version-shape mismatch inside this module
  // (same boundary-cast rationale as the SheetsAuth alias above). The file
  // contents never appear in any log or error message.
  return new GoogleAuth({
    scopes: [...GOOGLE_SHEETS_API_SCOPES],
    credentials: parsed,
  } as unknown as ConstructorParameters<typeof GoogleAuth>[0]) as unknown as SheetsAuth;
}

/**
 * Maps a thrown SDK/gaxios/network error to the provider transport error.
 *
 * Exported separately so tests can exercise the mapping with shaped fixtures
 * instead of real network failures. Any error without a proven HTTP status is
 * classified conservatively as delivery-uncertain material (network/timeout),
 * never as a proven pre-mutation rejection.
 */
export function classifyGoogleSheetsApiError(error: unknown): GoogleSheetsApiTransportError {
  const shape = extractGaxiosErrorShape(error);
  if (shape.status !== undefined) {
    const remoteCode = typeof shape.apiErrorStatus === "string" &&
      shape.apiErrorStatus.length > 0
      ? shape.apiErrorStatus
      : String(shape.status);
    return new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      "Google Sheets API request failed",
      presentValue(shape.status),
      presentValue(remoteCode),
    );
  }
  if (isTimeoutError(error, shape.code)) {
    return new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT,
      "Google Sheets API request timed out",
      absentValue(),
      shape.code === undefined
        ? absentValue()
        : presentValue(shape.code),
    );
  }
  return new GoogleSheetsApiTransportError(
    GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
    "Google Sheets API transport failed",
    absentValue(),
    shape.code === undefined
      ? absentValue()
      : presentValue(shape.code),
  );
}

/**
 * Emits one redacted transport-failure event (fail-open, no message text).
 *
 * Timeout, network, 429, 408, and 5xx failures are classified retryable so
 * log consumers can bucket transient Sheets quota/pacing pressure; proven
 * pre-mutation 4xx status codes (400/401/403/404) are not. The HTTP status
 * is carried as a numeric count only; the spreadsheet ID, URL, and response
 * body never reach the log.
 */
function logTransportFailure(error: GoogleSheetsApiTransportError): void {
  const status = error.status.kind === PRESENCE_KINDS.PRESENT
    ? error.status.value
    : undefined;
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.TRANSPORT_REQUEST_FAILED,
    level: HIKOUTEI_LOG_LEVELS.WARN,
    component: HIKOUTEI_LOG_COMPONENTS.TRANSPORT,
    code: error.code,
    errorClass: "GoogleSheetsApiTransportError",
    retryable: isRetryableTransportStatus(status),
    ...(status === undefined ? {} : { counts: { status } }),
  });
}

/**
 * True when the status kind marks a transient remote condition.
 *
 * Mirrors the shared `isGoogleSheetsApiDeliveryUncertain` boundary: an
 * absent status (timeout/network), HTTP 408 (request timeout — the proxy or
 * API may still have committed the write), HTTP 429, and every 5xx are
 * retryable/uncertain; the proven pre-mutation 4xx rejections (400, 401,
 * 403, 404) are not. This only buckets telemetry — gaxios auto-retry stays
 * disabled (`retry: false`), so a mutating call is never blindly retried
 * here; the durable worker owns retries through the shared outcome
 * classifier.
 */
export function isRetryableTransportStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

interface GaxiosErrorShape {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly apiErrorStatus: string | undefined;
}

function extractGaxiosErrorShape(error: unknown): GaxiosErrorShape {
  const record = parseRawErrorRecord(error);
  if (record === undefined) {
    return { code: undefined, status: undefined, apiErrorStatus: undefined };
  }
  const code = parseRawErrorText(record.code);
  const responseRecord = parseRawErrorRecord(record.response);
  const status = parseRawHttpStatus(record.status) ??
    parseRawHttpStatus(responseRecord?.status);
  const dataRecord = parseRawErrorRecord(responseRecord?.data);
  const errorRecord = parseRawErrorRecord(dataRecord?.error);
  const apiErrorStatus = parseRawErrorText(errorRecord?.status);
  return { code, status, apiErrorStatus };
}

function isTimeoutError(error: unknown, code: string | undefined): boolean {
  if (code !== undefined && /TIMEOUT|TIMEDOUT|DEADLINE|ABORTED|ETIMEDOUT/i.test(code)) {
    return true;
  }
  return error instanceof Error && /timeout|timed out|deadline exceeded/i.test(error.message);
}

/**
 * Builds the SDK batchUpdate body from provider write requests. The SDK
 * request union is wider than the provider's narrow shapes; this boundary
 * cast is the only place both types meet.
 */
export function toSdkBatchUpdateBody(
  requests: readonly GoogleSheetsApiWriteRequest[],
): { readonly requests: sheets_v4.Schema$Request[] } {
  return {
    requests: requests.map(toSdkRequest) as sheets_v4.Schema$Request[],
  };
}

/**
 * Serializes the batchUpdate body exactly as the transport sends it, so the
 * batch builder's byte budget measures the real wire bytes (SDK-wrapped
 * request shapes, not the internal request union).
 */
export function serializeBatchUpdateRequests(
  requests: readonly GoogleSheetsApiWriteRequest[],
): string {
  return JSON.stringify(toSdkBatchUpdateBody(requests));
}

/** Maps one provider write request to the Google SDK request shape. */
function toSdkRequest(request: GoogleSheetsApiWriteRequest): unknown {
  switch (request.kind) {
    case "addSheet":
      return { addSheet: { properties: { title: request.title, sheetId: request.sheetId } } };
    case "updateSheetProperties":
      return {
        updateSheetProperties: {
          properties: { sheetId: request.sheetId, hidden: request.hidden },
          fields: "hidden",
        },
      };
    case "updateCells":
      return {
        updateCells: {
          start: {
            sheetId: request.sheetId,
            rowIndex: request.startRowIndex,
            columnIndex: request.startColumnIndex,
          },
          rows: request.rows.map(toSdkRow),
          fields: request.fields,
        },
      };
    case "insertDimension":
      return {
        insertDimension: {
          range: {
            sheetId: request.sheetId,
            dimension: request.dimension,
            startIndex: request.startIndex,
            endIndex: request.endIndex,
          },
          inheritFromBefore: request.inheritFromBefore,
        },
      };
    case "deleteDimension":
      return {
        deleteDimension: {
          range: {
            sheetId: request.sheetId,
            dimension: request.dimension,
            startIndex: request.startIndex,
            endIndex: request.endIndex,
          },
        },
      };
    case "addDimension":
      return {
        addDimension: {
          range: {
            sheetId: request.sheetId,
            dimension: request.dimension,
            startIndex: request.startIndex,
            endIndex: request.endIndex,
          },
        },
      };
    case "setDataValidation":
      return {
        setDataValidation: {
          range: {
            sheetId: request.sheetId,
            startRowIndex: request.startRowIndex,
            endRowIndex: request.endRowIndex,
            startColumnIndex: request.startColumnIndex,
            endColumnIndex: request.endColumnIndex,
          },
          rule: {
            condition: { type: "BOOLEAN" },
            strict: request.strict,
          },
        },
      };
    case "deleteSheet":
      return { deleteSheet: { sheetId: request.sheetId } };
  }
}

function toSdkRow(row: GoogleSheetsApiCellRow): unknown {
  return { values: row.map(toSdkCell) };
}

function toSdkCell(cell: GoogleSheetsApiCell | null): unknown {
  if (cell === null) return {};
  return {
    ...(cell.userEnteredValue === undefined ? {} : { userEnteredValue: cell.userEnteredValue }),
    ...(cell.userEnteredFormat === undefined ? {} : { userEnteredFormat: cell.userEnteredFormat }),
  };
}
