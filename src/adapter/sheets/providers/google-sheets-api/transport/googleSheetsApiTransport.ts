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
import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import { GOOGLE_SHEETS_API_SCOPES } from "../constants.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "../errors.js";

/** REST `CellFormat.numberFormat` object written by the provider. */
export interface GoogleSheetsApiNumberFormat {
  readonly type: "DATE_TIME";
  readonly pattern: string;
}

/** One cell value/format pair written through an updateCells request. */
export interface GoogleSheetsApiCell {
  readonly userEnteredValue?: {
    readonly stringValue?: string;
    readonly numberValue?: number;
    readonly boolValue?: boolean;
  };
  readonly userEnteredFormat?: {
    readonly numberFormat?: GoogleSheetsApiNumberFormat;
  };
}

/**
 * Row of an updateCells request; index `j` addresses the column
 * `startColumnIndex + j`. A `null` entry is never produced by the provider
 * (an included cell is always written), but the type keeps the boundary
 * explicit for test fixtures.
 */
export type GoogleSheetsApiCellRow = readonly (GoogleSheetsApiCell | null)[];

/** Write requests the direct provider emits; the SDK mapping is contained here. */
export type GoogleSheetsApiWriteRequest =
  | {
    readonly kind: "addSheet";
    readonly title: string;
    readonly sheetId: number;
  }
  | {
    readonly kind: "updateSheetProperties";
    readonly sheetId: number;
    readonly hidden: boolean;
  }
  | {
    readonly kind: "updateCells";
    readonly sheetId: number;
    readonly startRowIndex: number;
    readonly startColumnIndex: number;
    readonly rows: readonly GoogleSheetsApiCellRow[];
    /** Field mask such as "userEnteredValue" or "userEnteredFormat.numberFormat". */
    readonly fields: string;
  }
  | {
    readonly kind: "insertDimension";
    readonly sheetId: number;
    readonly dimension: "ROWS";
    readonly startIndex: number;
    /** Exclusive end index; `endIndex - startIndex` rows are inserted. */
    readonly endIndex: number;
    readonly inheritFromBefore: boolean;
  }
  | {
    readonly kind: "deleteDimension";
    readonly sheetId: number;
    readonly dimension: "ROWS";
    readonly startIndex: number;
    /** Exclusive end index; exactly one row is deleted by the provider. */
    readonly endIndex: number;
  }
  | {
    readonly kind: "setDataValidation";
    readonly sheetId: number;
    readonly startRowIndex: number;
    readonly endRowIndex: number;
    readonly startColumnIndex: number;
    readonly endColumnIndex: number;
    readonly strict: boolean;
  }
  | {
    /**
     * Harness/cleanup-only request kind: the provider itself never emits
     * deleteSheet. Live scenario cleanup uses it to remove fixture tabs;
     * keeping the SDK mapping and the stub behavior inside the transport
     * boundary lets that cleanup reuse the provider's narrow contract.
     */
    readonly kind: "deleteSheet";
    readonly sheetId: number;
  };

/** Request shape of one `spreadsheets.get` call. */
export interface GoogleSheetsApiGetSpreadsheetRequest {
  readonly spreadsheetId: string;
  readonly ranges: readonly string[];
  readonly fields: string;
  /**
   * Per-call timeout override. The provider gives READS a shorter internal
   * timeout than writes; omitted falls back to the transport's configured
   * timeout.
   */
  readonly timeoutMs?: number;
}

/** Request shape of one `spreadsheets.batchUpdate` call. */
export interface GoogleSheetsApiBatchUpdateRequest {
  readonly spreadsheetId: string;
  readonly requests: readonly GoogleSheetsApiWriteRequest[];
}

/**
 * Internal transport boundary; every method returns the raw (untrusted)
 * response body. The provider never forwards SDK objects beyond this module.
 */
export interface GoogleSheetsApiTransport {
  getSpreadsheet(request: GoogleSheetsApiGetSpreadsheetRequest): Promise<unknown>;
  batchUpdate(request: GoogleSheetsApiBatchUpdateRequest): Promise<unknown>;
}

/** Auth type accepted by the sheets factory (may resolve to a nested version). */
type SheetsAuth = NonNullable<Parameters<typeof sheets>[0]["auth"]>;

/** Options for the real HTTP transport backed by @googleapis/sheets. */
export interface GoogleSheetsApiHttpTransportOptions {
  /**
   * Injected auth for tests/alternate credentials. Defaults to Application
   * Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` service account).
   */
  readonly auth?: SheetsAuth;
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
  private readonly client: ReturnType<typeof sheets>;
  private readonly requestTimeoutMs: number;

  public constructor(options: GoogleSheetsApiHttpTransportOptions) {
    // google-auth-library may resolve to a version nested under googleapis-common
    // that differs from the top-level one; the boundary cast keeps the SDK
    // version mismatch contained in this module.
    const auth = options.auth ??
      (new GoogleAuth({ scopes: [...GOOGLE_SHEETS_API_SCOPES] }) as unknown as SheetsAuth);
    // The sheets factory accepts GoogleAuth; the narrow wrapper below owns the
    // SDK boundary so no other provider code touches the client type.
    this.client = sheets({ version: "v4", auth });
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  public async getSpreadsheet(
    request: GoogleSheetsApiGetSpreadsheetRequest,
  ): Promise<unknown> {
    try {
      const response = await this.client.spreadsheets.get(
        {
          spreadsheetId: request.spreadsheetId,
          ranges: [...request.ranges],
          fields: request.fields,
        },
        { timeout: request.timeoutMs ?? this.requestTimeoutMs, retry: false },
      );
      return response.data;
    } catch (error: unknown) {
      throw classifyGoogleSheetsApiError(error);
    }
  }

  public async batchUpdate(
    request: GoogleSheetsApiBatchUpdateRequest,
  ): Promise<unknown> {
    try {
      const response = await this.client.spreadsheets.batchUpdate(
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
      throw classifyGoogleSheetsApiError(error);
    }
  }
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

interface GaxiosErrorShape {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly apiErrorStatus: string | undefined;
}

function extractGaxiosErrorShape(error: unknown): GaxiosErrorShape {
  if (error === null || typeof error !== "object") {
    return { code: undefined, status: undefined, apiErrorStatus: undefined };
  }
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : undefined;
  const response = record.response;
  const responseRecord = response !== null && typeof response === "object"
    ? response as Record<string, unknown>
    : undefined;
  const rawStatus = responseRecord?.status;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus)
    ? rawStatus
    : typeof rawStatus === "string" && /^\d{3}$/.test(rawStatus)
      ? Number(rawStatus)
      : undefined;
  let apiErrorStatus: string | undefined;
  const data = responseRecord?.data;
  const dataRecord = data !== null && typeof data === "object"
    ? data as Record<string, unknown>
    : undefined;
  const errorBody = dataRecord?.error;
  const errorRecord = errorBody !== null && typeof errorBody === "object"
    ? errorBody as Record<string, unknown>
    : undefined;
  const rawApiStatus = errorRecord?.status;
  if (typeof rawApiStatus === "string" && rawApiStatus.length > 0) {
    apiErrorStatus = rawApiStatus;
  }
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
