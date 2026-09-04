/**
 * Provider surface contract for the direct Google Sheets API pathway.
 *
 * Extracted verbatim from the adapter's provider options/transport modules
 * (P8-C): the internal sync service validates provider options and resolves
 * defaults against the provider's wire contract, so the option shapes, the
 * transport boundary, and the wire defaults live in the contracts leaf where
 * both the engine and the adapter can see them. The adapter modules re-export
 * these declarations so existing adapter-internal and test import paths stay
 * valid — the mirror direction is contracts → adapter (never the reverse).
 *
 * The transport converts gaxios/network failures into
 * `GoogleSheetsApiTransportError` (also leaf-owned, see `transportError.ts`)
 * with explicit HTTP-status and stable-code presence.
 */

import type { Presence } from "../state/index.js";

/** Spreadsheets scope requested through Application Default Credentials. */
export const GOOGLE_SHEETS_API_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
] as const;

/** Defaults for the direct Google Sheets API transport and batching. */
export const GOOGLE_SHEETS_API_DEFAULTS = {
  /** Default per-request timeout; the durable worker owns retries, not gaxios. */
  REQUEST_TIMEOUT_MS: 60_000,
  MIN_REQUEST_TIMEOUT_MS: 1_000,
  MAX_REQUEST_TIMEOUT_MS: 120_000,
  /**
   * Default per-READ-request timeout (every getSpreadsheet call). Since the
   * unified read engine this bounds ONE BAND, not one logical read: a large
   * tab is streamed as sequential size-capped band requests, so a timeout
   * fails one bounded band (durable retry) instead of an all-or-nothing
   * multi-megabyte single request. Reads stay much shorter than writes so a
   * slow-but-working effect dispatch cannot outlive its effect lease; the
   * per-request 3 MB/5 MB estimate caps keep each band's expected stream
   * time far below this bound.
   */
  READ_TIMEOUT_MS: 10_000,
  /** Upper bound for read timeouts; reads must stay well under the lease. */
  MAX_READ_TIMEOUT_MS: 60_000,
  /**
   * Minimum interval between request starts of the WHOLE provider: reads
   * and writes use independent request-start limiters, so reads serialize
   * only against reads and writes only against writes, and a read and a
   * write can start concurrently. Google Sheets quota is enforced per
   * 100-second windows; the 800 ms default paces each class to at most 125
   * starts per 100 s, leaving headroom inside the default per-user/
   * per-project 100-second quotas for the observation and provisioning
   * reads that run beside the worker. The exact quota stays provider and
   * environment dependent, so operators can override the interval through
   * the internal sync env key
   * (HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS) or the internal provider option;
   * the safe default is intentionally conservative. The interval is part of
   * the effect-lease headroom contract: a worst-case dispatch (two
   * preflight/postcondition reads plus one write, each paced and timed out,
   * with up to one full interval of first-slot wait) must finish inside the
   * lease with the 30-second provider headroom, and the internal service
   * validation rejects an override that would let pacing outlive the lease
   * (the env override is bounded to the largest default-safe interval,
   * ~10 s). Admission is BOUNDED to one interval per request start: a call
   * whose slot lies more than one interval out is refused before any SDK
   * call with the stable delivery-uncertain
   * `google_sheets_api_request_start_refused` error (the durable worker
   * requeues), so an arbitrarily long queue of concurrent lock-free polling
   * reads can never make a write wait past its lease.
   */
  REQUEST_START_INTERVAL_MS: 800,
  /**
   * Maximum admitted wait for ONE request-start slot before the bounded
   * admission refuses it (delivery-uncertain, requeued durably). This is
   * intentionally larger than the pacing interval: a postcondition read
   * that verifies a just-written row shares the write limiter, and it must
   * be allowed to wait a few intervals for the write slot instead of being
   * refused by the read burst. The interval still spaces request STARTS
   * (quota safety); this bound only caps how long a call queued behind a
   * saturated limiter will wait before refusing rather than firing unpaced.
   */
  REQUEST_START_MAX_ADMISSION_WAIT_MS: 5_000,
  /**
   * The provider stops adding effects to one batchUpdate once the serialized
   * body would exceed this budget and returns `hasMore` for the suffix. The
   * Google API itself accepts larger bodies; this is the provider's own
   * safety valve so a pathological payload cannot monopolize a request.
   */
  MAX_BATCH_REQUEST_BYTES: 2 * 1024 * 1024,
  /**
   * Effect cap per batchUpdate, aligned with MAX_APPEND_ROWS_PER_REQUEST (the
   * worker's bulk claim window); the byte budget (MAX_BATCH_REQUEST_BYTES)
   * remains the primary request-size valve. Previously the cap of the removed
   * Apps Script gateway (`MAX_EFFECTS`).
   */
  MAX_EFFECTS_PER_REQUEST: 1_000,
  /** Append row cap per request, matching the worker's bulk claim window. */
  MAX_APPEND_ROWS_PER_REQUEST: 1_000,
  // -------------------------------------------------------------------------
  // Adaptive quota governor (transport layer, request-START gating only).
  // The binding quota for the deployed per-user project was measured as 60
  // READs/min: a 30k-effect burst peaked near 69 reads/min, producing 429s
  // on ~4.67% of reads and a delivery-uncertain requeue spiral. Interval
  // pacing alone cannot hold a per-minute ceiling, so a sliding-window
  // budget and 429 AIMD feedback gate request starts on top of it. The
  // budgets are DISABLED by default (Infinity) to keep the shipped defaults
  // behavior-identical to the pre-governor pacing (the 800 ms interval
  // already allows up to 75 starts/min, so any finite per-minute default
  // below that would locally refuse healthy workloads with zero 429s);
  // operators facing a measured per-minute quota ceiling opt in via the
  // RECOMMENDED_* values below.
  // -------------------------------------------------------------------------
  /** Sliding window the per-minute budgets enforce over. */
  QUOTA_BUDGET_WINDOW_MS: 60_000,
  /**
   * Per-window request-start budget for the READ lane. DISABLED by default
   * (Infinity) for zero behavior change; the RECOMMENDED value below is
   * 45/min (0.75x the measured binding 60/min per-user read quota).
   */
  QUOTA_READ_BUDGET_PER_WINDOW: Number.POSITIVE_INFINITY,
  /** Recommended READ budget for a measured 60/min per-user quota (0.75x). */
  RECOMMENDED_QUOTA_READ_BUDGET_PER_WINDOW: 45,
  /**
   * Per-window request-start budget for the WRITE lane. DISABLED by default
   * (Infinity); the RECOMMENDED value below is 10/min, well above the
   * measured 2-5/min write demand.
   */
  QUOTA_WRITE_BUDGET_PER_WINDOW: Number.POSITIVE_INFINITY,
  /** Recommended WRITE budget for the measured 2-5/min write demand. */
  RECOMMENDED_QUOTA_WRITE_BUDGET_PER_WINDOW: 10,
  /** HTTP status that marks a quota-limited (AIMD signal) response. */
  QUOTA_LIMIT_HTTP_STATUS: 429,
  /** google.rpc code that marks a quota-limited response when no status is present. */
  QUOTA_LIMIT_REMOTE_CODE: "RESOURCE_EXHAUSTED",
  /** Multiplicative decrease: pacing interval factor per observed 429. */
  QUOTA_BACKOFF_GROWTH_FACTOR: 2,
  /** Ceiling for the AIMD pacing multiplier (interval never exceeds 4x base). */
  QUOTA_BACKOFF_MAX_MULTIPLIER: 4,
  /** Additive increase: pacing multiplier divisor per recovery step. */
  QUOTA_RECOVERY_STEP_FACTOR: 2,
  /** Successful request starts of quiet before one recovery step. */
  QUOTA_RECOVERY_SUCCESS_THRESHOLD: 25,
  /** Milliseconds since the last 429 that alone earns a recovery step. */
  QUOTA_RECOVERY_QUIET_MS: 10_000,
} as const;

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
    /**
     * Formula text with the leading `=` (exactly what the UI shows; the
     * real API echoes it back in `userEnteredValue`). Used only by the
     * row-check column formula cells; every other write stays literal.
     */
    readonly formulaValue?: string;
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
    /**
     * Grows the tab's grid. `updateCells` never expands the grid (a proven
     * 400 for out-of-bounds ranges), so provisioning emits this BEFORE the
     * header write whenever the row-check column sits outside the current
     * grid width. 0-based exclusive end index, like the other dimension
     * requests.
     */
    readonly kind: "addDimension";
    readonly sheetId: number;
    readonly dimension: "COLUMNS";
    readonly startIndex: number;
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

/** Request shape of one `spreadsheets.values.get` call. */
export interface GoogleSheetsApiValuesGetRequest {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly timeoutMs?: number;
}

/** Raw `spreadsheets.values.get` response body (untrusted). */
export interface GoogleSheetsApiValuesGetResponse {
  readonly values?: readonly (readonly (string | number | boolean | null)[])[];
}

/**
 * Internal transport boundary; every method returns the raw (untrusted)
 * response body. The provider never forwards SDK objects beyond this module.
 */
export interface GoogleSheetsApiTransport {
  getSpreadsheet(request: GoogleSheetsApiGetSpreadsheetRequest): Promise<unknown>;
  batchUpdate(request: GoogleSheetsApiBatchUpdateRequest): Promise<unknown>;
  /**
   * Raw `spreadsheets.values.get` capability. Optional so existing test
   * stubs keep implementing the interface unchanged; only the existing-sheet
   * adoption reader consumes it (it must read foreign tabs that carry no
   * registered route metadata).
   */
  getValues?(request: GoogleSheetsApiValuesGetRequest): Promise<GoogleSheetsApiValuesGetResponse>;
}

/** Redacted telemetry event emitted for every transport request. */
export interface GoogleSheetsApiRequestEvent {
  readonly operation: "getSpreadsheet" | "batchUpdate";
  /** Pacing lane the request-start wait used (`polling`, `preflight`, or `write`). */
  readonly pacing: "polling" | "preflight" | "write";
  readonly operationCount: number;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly httpStatus: Presence<number>;
  readonly code: Presence<string>;
  /** Pacing wait before the request-start slot was granted (0 when none). */
  readonly pacingWaitMs?: number;
  /** Number of batchUpdate requests in the written batch. */
  readonly requestCount?: number;
  /** Serialized batchUpdate body-size estimate in bytes. */
  readonly bodyBytes?: number;
  /** Effects requested for this write batch. */
  readonly requestedEffects?: number;
  /** Effects included in the written batch (the budget-fitting prefix). */
  readonly includedEffects?: number;
  /**
   * Parsed-response size estimate in bytes (`JSON.stringify().length` of the
   * transport result). An ESTIMATE of the wire payload, not a measured byte
   * count: it excludes HTTP headers, compression framing, and JSON
   * re-serialization differences. Computed only while a telemetry sink is
   * attached, so a deployment without `onRequest` pays no estimation cost.
   */
  readonly responseBytes?: number;
}

/** Provider options without the bootstrap-supplied spreadsheet and routes. */
export interface GoogleSheetsApiProviderOptions {
  /** Stub transport for tests; omitted builds the real ADC-backed client. */
  readonly transport?: GoogleSheetsApiTransport;
  /** Per-request timeout; defaults to 60 seconds, bounded 1s..120s. */
  readonly requestTimeoutMs?: number;
  /**
   * Per-READ-request timeout (every getSpreadsheet call); defaults to
   * 10 seconds, bounded 1s..60s. Writes keep `requestTimeoutMs`, so a slow
   * dispatch (two preflight reads plus one write) cannot outlive its effect
   * lease.
   */
  readonly readTimeoutMs?: number;
  /**
   * Minimum interval between request starts per class; defaults to 800 ms.
   * This only SPACES request starts; admission is governed by the separate
   * independent bound `requestStartMaxWaitMs`, which refuses a request whose
   * predicted wait exceeds it before any SDK call (delivery-uncertain,
   * requeued durably).
   */
  readonly rateLimitIntervalMs?: number;
  /**
   * Maximum admitted wait for one request-start slot before refusal;
   * defaults to `REQUEST_START_MAX_ADMISSION_WAIT_MS` (5 s), independent of
   * the pacing interval. Lets a postcondition read wait a few intervals for
   * the shared write limiter instead of being refused by the read burst.
   */
  readonly requestStartMaxWaitMs?: number;
  /**
   * Per-minute request-start budget for the READ lane (sliding window);
   * DISABLED by default (`QUOTA_READ_BUDGET_PER_WINDOW` = Infinity) so the
   * shipped pacing matches the pre-budget behavior exactly. Set it to the
   * documented `RECOMMENDED_QUOTA_READ_BUDGET_PER_WINDOW` (45/min, under the
   * measured binding 60/min per-user read quota) when a per-minute ceiling
   * must be enforced. A start whose budget slot lies more than
   * `requestStartMaxWaitMs` out is refused with the same bounded
   * delivery-uncertain error as interval pacing; the budget and the lane
   * pacing SHARE that one admission bound. `Number.POSITIVE_INFINITY`
   * disables the budget.
   */
  readonly quotaReadBudgetPerMinute?: number;
  /**
   * Per-minute request-start budget for the WRITE lane; DISABLED by default
   * like the read budget. `RECOMMENDED_QUOTA_WRITE_BUDGET_PER_WINDOW`
   * (10/min) sits well above the measured 2-5/min write demand. Same
   * bounded-admission and disable semantics as the read budget.
   */
  readonly quotaWriteBudgetPerMinute?: number;
  /** Serialized batchUpdate byte budget; defaults to ~2 MB. */
  readonly maxBatchBytes?: number;
  /** Injectable clock for limiters and telemetry. */
  readonly now?: () => number;
  /** Injectable sleep used by the request-start limiters. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Redacted request telemetry sink. */
  readonly onRequest?: (event: GoogleSheetsApiRequestEvent) => void;
}

/** A1-notation helpers shared with the provider's model normalization. */

/** Converts A1 column letters to a 1-based column number. */
export function columnNumber(letters: string): number {
  let result = 0;
  for (const letter of letters) {
    result = result * 26 + letter.charCodeAt(0) - 64;
  }
  return result;
}

/** Converts a 1-based column number to A1 column letters (1 -> "A", 28 -> "AB"). */
export function columnLetters(column: number): string {
  let letters = "";
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/** Quotes a sheet tab name for A1 notation, doubling embedded single quotes. */
export function quoteA1SheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}