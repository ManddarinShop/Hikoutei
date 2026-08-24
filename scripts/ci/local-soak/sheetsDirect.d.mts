/**
 * Type declarations for `scripts/ci/local-soak/sheetsDirect.mjs`.
 *
 * Hand-written ESM helper consumed by the soak CLI (live mode and cleanup
 * only). These declarations give the TypeScript test suite full type
 * checking without adding `scripts/**` to a `tsconfig` `include` set.
 */

/** Tab suffixes the sync projection owns for each entity. */
export const PROJECTION_TAB_SUFFIXES: readonly string[];

/** Internal receipt tab shared by every runtime projection. */
export const RECEIPT_TAB_NAME: string;

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS: number;

/**
 * Default minimum interval between direct-client request starts (2,500 ms,
 * matching the library provider's safe default). All reads and writes of
 * one client share this pacing gate, so soak observation/probe/cleanup
 * requests can never burst past the library's own quota pacing.
 */
export const DEFAULT_REQUEST_START_INTERVAL_MS: number;

/**
 * Effective request timeout: the configured default, capped by the
 * remaining run deadline (never negative).
 */
export function resolveRequestTimeoutMs(
  requestTimeoutMs: number,
  deadlineAtMs: number | undefined,
  nowMs?: number,
): number;

/**
 * Fails fast (DirectSheetsError, status class `deadline_expired`) when the
 * run deadline already expired.
 */
export function assertWithinRequestDeadline(
  deadlineAtMs: number | undefined,
  nowMs?: number,
): void;

/**
 * ONE atomic remaining-deadline calculation for one request: throws
 * `DirectSheetsError` (status class `deadline_expired`) when the budget is
 * already exhausted, otherwise returns the request timeout capped by the
 * remaining budget (always > 0 — a 0ms timeout would mean "no timeout"
 * to HTTP clients).
 */
export function resolveDeadlineTimeout(
  requestTimeoutMs: number,
  deadlineAtMs: number | undefined,
  nowMs?: number,
): number;

/**
 * Combines the run deadline with an operation/phase deadline: the
 * effective deadline for one request is the EARLIER of the two (a
 * convergence/probe phase must finish inside its own timeout even when
 * the run budget is larger; the run deadline still caps every phase).
 */
export function combinedDeadlineAtMs(
  deadlineAtMs: number | undefined,
  phaseDeadlineAtMs: number | undefined,
): number | undefined;

/** Raw client bound to ADC service-account credentials (observation only). */
export function createDirectSheetsClient(options?: {
  readonly requestTimeoutMs?: number;
  /** Epoch deadline; caps request timeouts and aborts requests once expired. */
  readonly deadlineAtMs?: number;
  /**
   * Minimum interval between request starts, shared by reads and writes
   * (default 2,500 ms; 0 disables pacing for tests). The deadline clock is
   * always `Date.now()`; `now`/`sleep` only drive the pacing gate.
   */
  readonly requestStartIntervalMs?: number;
  /** Injectable pacing clock (default `Date.now`). */
  readonly now?: () => number;
  /** Injectable pacing sleep (default `setTimeout`). */
  readonly sleep?: (ms: number) => Promise<void>;
}): {
  /**
   * `options.deadlineAtMs` is the ACTIVE OPERATION (phase) deadline: every
   * request is asserted against `min(phase deadline, run deadline)` before
   * it starts and timeouts at the effective remaining budget.
   */
  readTabRows(
    spreadsheetId: string,
    tabName: string,
    options?: { readonly deadlineAtMs?: number },
  ): Promise<string[][]>;
  /**
   * Reads several tabs' rows in ONE spreadsheets.get request (one range
   * per tab) under the shared pacing gate and one atomic effective
   * timeout. Returns a plain record keyed by REQUESTED tab name in
   * request order; an absent tab maps to an empty rows array.
   * `options.deadlineAtMs` is the ACTIVE OPERATION (phase) deadline.
   */
  readTabsRows(
    spreadsheetId: string,
    tabNames: readonly string[],
    options?: { readonly deadlineAtMs?: number },
  ): Promise<Record<string, string[][]>>;
  /** `deadlineAtMs` is the probe phase's ACTIVE OPERATION deadline. */
  mutateInputCell(input: {
    readonly spreadsheetId: string;
    readonly tabName: string;
    readonly identity: string;
    readonly headerName: string;
    readonly value: string;
    readonly deadlineAtMs?: number;
  }): Promise<{ readonly rowNumber: number }>;
  /**
   * Overwrites MULTIPLE field cells of the row whose id column matches in
   * ONE batchUpdate and verifies every field landed on the INTENDED
   * identity row. `fields` maps each target field header to its value.
   * `deadlineAtMs` is the probe phase's ACTIVE OPERATION deadline.
   */
  mutateInputCells(input: {
    readonly spreadsheetId: string;
    readonly tabName: string;
    readonly identity: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly deadlineAtMs?: number;
  }): Promise<{ readonly rowNumber: number }>;
  /**
   * Appends a NEW row (id + field values) to the target tab in ONE
   * batchUpdate (human row insert) and verifies the intended identity
   * landed exactly once. `row` maps the id column (`id`) and each field
   * header to its value. `deadlineAtMs` is the probe phase's ACTIVE
   * OPERATION deadline.
   */
  insertInputRow(input: {
    readonly spreadsheetId: string;
    readonly tabName: string;
    readonly row: Readonly<Record<string, string>>;
    readonly deadlineAtMs?: number;
  }): Promise<{ readonly rowNumber: number }>;
  /**
   * Deletes the row whose id column matches from the target tab in ONE
   * batchUpdate (human row delete) and verifies the intended identity is
   * gone. `deadlineAtMs` is the probe phase's ACTIVE OPERATION deadline.
   */
  deleteInputRow(input: {
    readonly spreadsheetId: string;
    readonly tabName: string;
    readonly identity: string;
    readonly deadlineAtMs?: number;
  }): Promise<{ readonly rowNumber: number }>;
  /** `options.deadlineAtMs` is the ACTIVE OPERATION (phase) deadline. */
  deleteTabs(
    spreadsheetId: string,
    tabNames: readonly string[],
    options?: { readonly includeReceiptTab?: boolean; readonly deadlineAtMs?: number },
  ): Promise<{ readonly deleted: number }>;
};

/**
 * Pure tab-selection logic for cleanup (testable without credentials).
 *
 * Returns the sheet ids to delete: the named projection tabs plus, ONLY
 * when `includeReceiptTab` is true, the shared receipt tab. A subset
 * cleanup (`includeReceiptTab: false`) keeps the receipt tab so untouched
 * tables can keep projecting. Throws `DirectSheetsError` (status class
 * `malformed_sheet_id`) when a matching tab carries a sheetId that is not
 * a non-negative safe integer, so a malformed id never reaches a delete
 * request.
 */
export function resolveTabsToDelete(
  properties: ReadonlyArray<{ readonly sheetId?: number; readonly title?: string } | undefined>,
  tabNames: readonly string[],
  includeReceiptTab: boolean,
): number[];

/**
 * ONE shared pure pre-write snapshot validation used by both the direct
 * human write (`mutateInputCell`) and the probe's readiness barrier.
 * Promotes a tab snapshot into a ready write coordinate, or fails closed
 * WITHOUT a write: a missing/duplicate/whitespace header, a non-empty row
 * with a blank or non-string identity, or a duplicated nonblank identity
 * (intended or not) returns a fixed `fail` status class; a structurally
 * valid tab lacking the intended identity returns `missing`; and on
 * `ready` the resolved column indexes and the target's rowIndex are
 * returned so the caller never revalidates. Fully blank padding rows are
 * ignored. Never returns an id or value.
 */
export function evaluateInputPreWrite(input: {
  readonly rows: ReadonlyArray<readonly unknown[]>;
  readonly identity: string;
  readonly headerName: string;
}):
  | { readonly status: "ready"; readonly idColumn: number; readonly fieldColumn: number; readonly rowIndex: number }
  | { readonly status: "missing" }
  | { readonly status: "fail"; readonly statusClass: string };

/**
 * Pure postcondition check for one direct human write, comparing the
 * pre-write and post-write snapshots BY VALIDATED IDENTITY (never by
 * mutable row order). Requires exactly one intended identity row before
 * and after, that row's target field to display `String(value)`, and —
 * when `rowIndex` (the ORIGINAL write coordinate) is supplied — that the
 * post-read row at that coordinate does not belong to a different nonblank
 * identity while still displaying the requested value. Non-target
 * identities are never compared field-by-field (concurrent actors
 * legitimately update them). A value placed on another identity, an
 * absent/duplicated identity, a blank or non-string identity in a non-empty
 * row, or a proven collateral write at the write coordinate returns
 * `identity_shifted`; never a raw id/value.
 */
export function evaluateInputPostcondition(input: {
  readonly beforeRows: ReadonlyArray<readonly unknown[]>;
  readonly afterRows: ReadonlyArray<readonly unknown[]>;
  readonly identity: string;
  readonly headerName: string;
  readonly value: string;
  readonly rowIndex?: number;
}): { readonly status: "ok" } | { readonly status: "identity_shifted" };

/**
 * Pure PRE-WRITE snapshot validation for a MULTI-FIELD direct human write
 * (`mutateInputCells`): promotes a User_Input tab snapshot into a ready
 * write coordinate for several fields of one row, or fails closed WITHOUT
 * a write. Validates every requested field header and returns a
 * field-name -> column-index map. A missing/duplicate/whitespace header, a
 * non-empty row with a blank or non-string identity, or a duplicated
 * nonblank identity returns a fixed `fail` status class; a structurally
 * valid tab lacking the intended identity returns `missing`; on `ready`
 * the id column, field columns, and the target's rowIndex are returned.
 * Never returns an id or value.
 */
export function evaluateInputPreWriteMulti(input: {
  readonly rows: ReadonlyArray<readonly unknown[]>;
  readonly identity: string;
  readonly headerNames: readonly string[];
}):
  | { readonly status: "ready"; readonly idColumn: number; readonly fieldColumns: Record<string, number>; readonly rowIndex: number }
  | { readonly status: "missing" }
  | { readonly status: "fail"; readonly statusClass: string };

/**
 * Pure postcondition check for a MULTI-FIELD direct human write, comparing
 * the pre-write and post-write snapshots BY VALIDATED IDENTITY. Requires
 * exactly one intended identity row before and after, that row to display
 * EVERY requested field value, and — when `rowIndex` (the ORIGINAL write
 * coordinate) is supplied — that the post-read row at that coordinate does
 * not belong to a different nonblank identity while still displaying any
 * requested value. A value placed on another identity, an absent/duplicated
 * identity, a blank or non-string identity in a non-empty row, or a proven
 * collateral write at the write coordinate returns `identity_shifted`;
 * never a raw id/value.
 */
export function evaluateInputPostconditionMulti(input: {
  readonly beforeRows: ReadonlyArray<readonly unknown[]>;
  readonly afterRows: ReadonlyArray<readonly unknown[]>;
  readonly identity: string;
  readonly headerNames: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly rowIndex?: number;
}): { readonly status: "ok" } | { readonly status: "identity_shifted" };

/**
 * Pure postcondition check for a direct human ROW INSERT: requires the
 * intended identity to exist exactly once in the post-write snapshot and
 * that identity's row to display every requested field value. A duplicated
 * identity, an absent identity, a blank or non-string identity in a
 * non-empty row, or any field that did not land on the intended identity
 * returns `identity_shifted`; never a raw id/value.
 */
export function evaluateInsertPostcondition(input: {
  readonly afterRows: ReadonlyArray<readonly unknown[]>;
  readonly identity: string;
  readonly headerNames: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
}): { readonly status: "ok" } | { readonly status: "identity_shifted" };

/**
 * Pure postcondition check for a direct human ROW DELETE: requires the
 * intended identity to exist exactly once in the pre-write snapshot and to
 * be ABSENT from the post-write snapshot. A duplicated identity, an absent
 * pre-write identity, a still-present post-write identity (a row shift
 * placed the delete on the wrong row), or a blank or non-string identity
 * in a non-empty row returns `identity_shifted`; never a raw id/value.
 */
export function evaluateDeletePostcondition(input: {
  readonly beforeRows: ReadonlyArray<readonly unknown[]>;
  readonly afterRows: ReadonlyArray<readonly unknown[]>;
  readonly identity: string;
  readonly idColumn: number;
}): { readonly status: "ok" } | { readonly status: "identity_shifted" };

/**
 * Pure runtime classifier for one direct-client SDK failure.
 *
 * Maps an untrusted SDK rejection to a stable `statusClass` and a
 * `retryable` flag using EXACT allowlists only (numeric HTTP statuses,
 * timeout/deadline codes, known network codes, else `unknown`). A strictly
 * bounded cause chain (top-level error plus up to two nested causes) is
 * inspected for string `code` candidates so a gaxios-wrapped native-fetch
 * network failure can surface its allowlisted code at `error.cause.cause.code`.
 * The raw message, code, body, URL, id, and cell data are never retained.
 */
export function classifyDirectError(error: unknown): {
  readonly statusClass: string;
  readonly retryable: boolean;
};

/** Harness error carrying a stable class and retryability only. */
export class DirectSheetsError extends Error {
  readonly statusClass: string;
  readonly retryable: boolean;
  constructor(message: string, statusClass: string, retryable?: boolean);
}
