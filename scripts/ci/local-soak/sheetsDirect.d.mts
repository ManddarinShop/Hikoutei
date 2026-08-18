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
  /** `options.deadlineAtMs` is the ACTIVE OPERATION (phase) deadline. */
  deleteTabs(
    spreadsheetId: string,
    tabNames: readonly string[],
    options?: { readonly includeReceiptTab?: boolean; readonly deadlineAtMs?: number },
  ): Promise<{ readonly deleted: number }>;
};

/** Pure tab-selection logic for cleanup (testable without credentials). */
export function resolveTabsToDelete(
  properties: ReadonlyArray<{ readonly sheetId?: number; readonly title?: string } | undefined>,
  tabNames: readonly string[],
  includeReceiptTab: boolean,
): number[];

/** Harness error carrying a stable class only (no remote payload). */
export class DirectSheetsError extends Error {
  readonly statusClass: string;
  constructor(message: string, statusClass: string);
}
