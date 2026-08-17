/**
 * Minimal direct Google Sheets client for soak-only observation, simulated
 * human edits, and sandbox cleanup.
 *
 * This is test-harness surface, NOT part of the mutation path: entity
 * mutations always flow through the public `createTypedSheets()` runtime.
 * The client talks to the raw Sheets REST API through the repository's own
 * `@googleapis/sheets` dependency and ADC service-account credentials. It
 * never prints spreadsheet IDs, URLs, emails, or cell payloads; failures are
 * reported by status class and stable remote code only. All request starts
 * of one client share a pacing gate (default 2,500 ms, matching the library
 * provider's safe default) so harness observation can never burst past the
 * library's own quota pacing.
 */

import { GoogleAuth } from "google-auth-library";
import { sheets } from "@googleapis/sheets";

/** Tab suffixes the sync projection owns for each entity. */
export const PROJECTION_TAB_SUFFIXES = Object.freeze(["_System", "_Input", "_Conflicts"]);

/** Internal receipt tab shared by every runtime projection. */
export const RECEIPT_TAB_NAME = "__typed_sheets_internal_effect_receipts";

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Default minimum interval between direct-client request starts.
 *
 * Matches the library provider's safe default (2,500 ms): the soak harness's
 * observation/probe/cleanup requests share ONE pacing gate per client, so a
 * convergence or probe phase can never fire an unpaced burst on top of the
 * library's own worker traffic and invalidate the quota test the library is
 * under. Harness-only: the soak workload (cycles, operations, probes) is
 * unchanged; only request START times are spaced.
 */
export const DEFAULT_REQUEST_START_INTERVAL_MS = 2_500;

/**
 * Effective request timeout: the configured default, capped by the
 * remaining run deadline (never negative).
 *
 * Without a deadline the default applies unchanged. With one, every
 * request timeouts at `min(default, deadline - now)` so a slow Sheets
 * request can never outlive the run budget by more than the default
 * timeout cap.
 *
 * @param {number} requestTimeoutMs configured default timeout.
 * @param {number | undefined} deadlineAtMs epoch deadline (same clock as Date.now()).
 * @param {number} [nowMs] current epoch milliseconds (default Date.now()).
 * @returns {number} timeout in milliseconds, floor 0.
 */
export function resolveRequestTimeoutMs(requestTimeoutMs, deadlineAtMs, nowMs = Date.now()) {
  if (deadlineAtMs === undefined) return requestTimeoutMs;
  return Math.min(requestTimeoutMs, Math.max(0, deadlineAtMs - nowMs));
}

/**
 * Fails fast when the run deadline already expired.
 *
 * Throws a `DirectSheetsError` with the stable `deadline_expired` status
 * class (allowlisted for redacted artifacts) so a request never starts
 * after the deadline and the harness records a stable reason instead of
 * a misleading transport/HTTP class.
 *
 * NOTE: this is a pure guard; the client request path must use
 * {@link resolveDeadlineTimeout}, which performs the expiry check AND the
 * timeout computation from ONE clock read so the deadline can never cross
 * between two checks and silently produce a 0ms (no-abort) timeout.
 *
 * @param {number | undefined} deadlineAtMs epoch deadline, or undefined.
 * @param {number} [nowMs] current epoch milliseconds (default Date.now()).
 * @returns {void} throws when `nowMs >= deadlineAtMs`.
 */
export function assertWithinRequestDeadline(deadlineAtMs, nowMs = Date.now()) {
  if (deadlineAtMs !== undefined && nowMs >= deadlineAtMs) {
    throw new DirectSheetsError(
      "direct sheets request skipped: run deadline expired",
      "deadline_expired",
    );
  }
}

/**
 * ONE atomic remaining-deadline calculation for one request.
 *
 * Reads the clock exactly once: when the remaining budget is already
 * exhausted (or negative) it throws the stable `deadline_expired` error —
 * a request can never start with a 0ms timeout (which HTTP clients treat
 * as "no timeout") because the deadline crossed between a separate guard
 * check and a timeout computation. Otherwise it returns the request
 * timeout capped by the remaining budget, so a slow Sheets request can
 * never outlive the run budget by more than the default timeout cap.
 *
 * @param {number} requestTimeoutMs configured default timeout.
 * @param {number | undefined} deadlineAtMs epoch deadline, or undefined.
 * @param {number} [nowMs] current epoch milliseconds (default Date.now()).
 * @returns {number} timeout in milliseconds, always > 0.
 */
export function resolveDeadlineTimeout(requestTimeoutMs, deadlineAtMs, nowMs = Date.now()) {
  if (deadlineAtMs === undefined) return requestTimeoutMs;
  const remainingMs = deadlineAtMs - nowMs;
  if (remainingMs <= 0) {
    throw new DirectSheetsError(
      "direct sheets request skipped: run deadline expired",
      "deadline_expired",
    );
  }
  return Math.min(requestTimeoutMs, remainingMs);
}

/**
 * Combines the run deadline with an operation/phase deadline.
 *
 * The effective deadline for ONE request is the EARLIER of the two: a
 * convergence/probe phase must finish inside its own phase timeout even
 * when the run budget is much larger, and the run deadline still caps
 * every phase when it is the tighter bound. An undefined side simply
 * lets the other side rule.
 *
 * @param {number | undefined} deadlineAtMs run epoch deadline, or undefined.
 * @param {number | undefined} phaseDeadlineAtMs operation/phase epoch
 *   deadline (e.g. `min(run deadline, now + phase timeout)`), or undefined.
 * @returns {number | undefined} the effective epoch deadline, or undefined.
 */
export function combinedDeadlineAtMs(deadlineAtMs, phaseDeadlineAtMs) {
  if (deadlineAtMs === undefined) return phaseDeadlineAtMs;
  if (phaseDeadlineAtMs === undefined) return deadlineAtMs;
  return Math.min(deadlineAtMs, phaseDeadlineAtMs);
}

/**
 * Creates the raw client bound to ADC service-account credentials.
 *
 * `deadlineAtMs` (optional) caps every request timeout at the remaining
 * run budget and aborts requests once the deadline expired; `requestTimeoutMs`
 * remains the per-request ceiling. `requestStartIntervalMs` (optional,
 * default 2,500 ms) paces ALL request starts of this client through one
 * shared read+write gate — the soak harness's observation requests must not
 * burst past the library's own pacing. `now`/`sleep` are injectable so
 * pacing tests can drive the gate without real time; the deadline clock
 * always stays on `Date.now()`.
 */
export function createDirectSheetsClient({
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  deadlineAtMs,
  requestStartIntervalMs = DEFAULT_REQUEST_START_INTERVAL_MS,
  now = Date.now,
  sleep,
} = {}) {
  const auth = new GoogleAuth({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const client = sheets({ version: "v4", auth });
  const requestTimeout = requestTimeoutMs;
  if (!Number.isSafeInteger(requestStartIntervalMs) || requestStartIntervalMs < 0) {
    throw new RangeError("requestStartIntervalMs must be a non-negative safe integer");
  }

  /**
   * One shared request-start gate for EVERY request of this client.
   *
   * Reads and writes share the gate, mirroring the library provider's single
   * limiter: at most one harness request can start per interval no matter how
   * many calls race. The slot reservation happens SYNCHRONOUSLY before any
   * await (same algorithm as the library's `RequestStartLimiter`), so two
   * concurrent callers can never compute the same remaining time and start
   * together. An interval of 0 disables pacing (tests only). The pacing wait
   * itself is NOT deadline-aware: the authoritative expiry check still runs
   * immediately before each request starts, so a sleep that overshoots a
   * phase/run deadline makes the request abort with `deadline_expired`
   * instead of firing after the budget.
   */
  let lastStartAt;
  const paceNextRequest = async () => {
    const current = now();
    const nextStart = lastStartAt === undefined
      ? current
      : Math.max(current, lastStartAt + requestStartIntervalMs);
    lastStartAt = nextStart;
    const waitMs = Math.max(0, nextStart - current);
    if (waitMs > 0) {
      await (sleep ?? defaultSleep)(waitMs);
    }
  };

  /**
   * One atomic deadline resolution for the next request: throws
   * `deadline_expired` when the effective budget is gone, else returns
   * the deadline-capped timeout. Used by EVERY request method so the
   * expiry guard and the timeout computation share a single clock read.
   *
   * `phaseDeadlineAtMs` is the ACTIVE OPERATION deadline for the call
   * (e.g. `min(run deadline, now + phase timeout)` for a convergence or
   * probe phase): the effective deadline is the EARLIER of it and the
   * client's run deadline, so a phase can never outlive its own timeout
   * just because the run budget is larger.
   */
  const nextRequestTimeout = (phaseDeadlineAtMs) =>
    resolveDeadlineTimeout(
      requestTimeout,
      combinedDeadlineAtMs(deadlineAtMs, phaseDeadlineAtMs),
    );

  /**
   * Reads several tabs' rows in ONE spreadsheets.get request.
   *
   * Performs a single batched GET (one range per requested tab) under the
   * ONE shared pacing gate and ONE atomic effective-timeout resolution,
   * so a multi-tab observation is a single request start that can never
   * outlive the active deadline. Returns a plain record keyed by
   * REQUESTED tab name in request order: every requested name is present,
   * and an absent tab maps to an empty rows array (the same contract as
   * `readTabRows` for a missing tab). Sheets in the response that were
   * not requested are ignored. Failure handling is unchanged: errors
   * carry only the stable status class, never ids, URLs, or payloads.
   *
   * `options.deadlineAtMs` is the ACTIVE OPERATION deadline (phase
   * deadline): the request is asserted against `min(phase, run)` before
   * it starts and timeouts at the effective remaining budget.
   *
   * @param {string} spreadsheetId the spreadsheet to read.
   * @param {readonly string[]} tabNames requested tab names, in order.
   * @param {{ deadlineAtMs?: number }} [options] operation deadline.
   * @returns {Promise<Record<string, string[][]>>} rows keyed by
   *   requested tab name in requested order (empty array when absent).
   */
  async function readTabsRows(spreadsheetId, tabNames, options = {}) {
    await paceNextRequest();
    const timeout = nextRequestTimeout(options.deadlineAtMs);
    const ranges = tabNames.map((tabName) => `${quoteTabName(tabName)}!A1:ZZ`);
    const response = await client.spreadsheets.get({
      spreadsheetId,
      ranges,
      fields: "sheets(properties(title),data(rowData(values(formattedValue))))",
    }, { timeout, retry: false }).catch(toStatusError);
    const sheetByTitle = new Map();
    for (const entry of response?.data?.sheets ?? []) {
      if (entry?.properties?.title !== undefined) {
        sheetByTitle.set(entry.properties.title, entry);
      }
    }
    const rowsByTab = {};
    for (const tabName of tabNames) {
      const sheet = sheetByTitle.get(tabName);
      const grid = (sheet?.data ?? [])[0];
      rowsByTab[tabName] = (grid?.rowData ?? []).map((row) =>
        (row?.values ?? []).map((cell) => cell?.formattedValue ?? ""));
    }
    return rowsByTab;
  }

  /**
   * Reads one tab's rows as arrays of display strings (observation only).
   *
   * Implemented through {@link readTabsRows} for a single tab, so both
   * entry points share the exact same request shape, pacing gate, and
   * deadline handling. A missing tab yields an empty rows array.
   *
   * `options.deadlineAtMs` is the ACTIVE OPERATION deadline (phase
   * deadline): when set, the request timeouts at `min(default, effective
   * remaining)` where the effective deadline is the earlier of the phase
   * deadline and the run deadline, and the request is asserted against it
   * before it starts.
   */
  async function readTabRows(spreadsheetId, tabName, options = {}) {
    const rowsByTab = await readTabsRows(spreadsheetId, [tabName], options);
    return rowsByTab[tabName];
  }

  /**
   * Overwrites one field cell of the row whose id column matches (human
   * edit). `deadlineAtMs` is the probe phase's ACTIVE OPERATION deadline;
   * every request of the call (tab read, sheet-id lookup, write) is
   * asserted and timeouts against `min(phase deadline, run deadline)`.
   */
  async function mutateInputCell({ spreadsheetId, tabName, identity, headerName, value, deadlineAtMs }) {
    const rows = await readTabRows(spreadsheetId, tabName, { deadlineAtMs });
    const headers = rows[0] ?? [];
    const idColumn = headers.indexOf("id");
    const fieldColumn = headers.indexOf(headerName);
    if (idColumn < 0) throw new DirectSheetsError("identity header not found", "harness_error");
    if (fieldColumn < 0) throw new DirectSheetsError("field header not found", "harness_error");
    const rowIndex = rows.findIndex((row, index) =>
      index > 0 && row[idColumn] === identity);
    if (rowIndex < 0) throw new DirectSheetsError("identity row not found", "harness_error");
    const sheetId = await requireSheetId(spreadsheetId, tabName, deadlineAtMs);
    // MEDIUM 5: the write timeout is resolved NOW — immediately before this
    // SDK request — never from a clock read taken before the earlier read
    // and sheet-id lookup, so a slow multi-request mutation can never run
    // with a stale timeout past the effective deadline.
    await paceNextRequest();
    const timeout = nextRequestTimeout(deadlineAtMs);
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          updateCells: {
            start: { sheetId, rowIndex, columnIndex: fieldColumn },
            rows: [{ values: [{ userEnteredValue: { stringValue: String(value) } }] }],
            fields: "userEnteredValue",
          },
        }],
      },
    }, { timeout, retry: false }).catch(toStatusError);
    return { rowNumber: rowIndex + 1 };
  }

  /** Resolves one tab's numeric sheetId (never logged). */
  async function requireSheetId(spreadsheetId, tabName, deadlineAtMs) {
    await paceNextRequest();
    const timeout = nextRequestTimeout(deadlineAtMs);
    const response = await client.spreadsheets.get({
      spreadsheetId,
      ranges: [],
      fields: "sheets.properties(sheetId,title)",
    }, { timeout, retry: false }).catch(toStatusError);
    const sheet = (response?.data?.sheets ?? []).find((entry) =>
      entry?.properties?.title === tabName);
    if (sheet?.properties?.sheetId === undefined) {
      throw new DirectSheetsError("tab not found", "harness_error");
    }
    return sheet.properties.sheetId;
  }

  /**
   * Deletes the named projection tabs (cleanup only).
   *
   * The shared internal receipt tab is deleted ONLY for a full-table
   * cleanup (`includeReceiptTab: true`); a `--tables` subset cleanup must
   * never remove the receipt tab because the untouched tables still need
   * it. The pure selection logic lives in {@link resolveTabsToDelete} so
   * tests can exercise both subset and full behavior without credentials.
   */
  async function deleteTabs(spreadsheetId, tabNames, options = {}) {
    const includeReceiptTab = options.includeReceiptTab === true;
    // MEDIUM 5: each SDK request resolves its own deadline timeout at the
    // moment it starts — the sheet list read and the batch delete never
    // share one stale timeout. `options.deadlineAtMs` is the ACTIVE
    // OPERATION deadline (phase): the effective deadline for each request
    // is the earlier of it and the client's run deadline, and every
    // request is asserted against it before it starts.
    await paceNextRequest();
    const timeout = nextRequestTimeout(options.deadlineAtMs);
    const response = await client.spreadsheets.get({
      spreadsheetId,
      ranges: [],
      fields: "sheets.properties(sheetId,title)",
    }, { timeout, retry: false }).catch(toStatusError);
    const properties = (response?.data?.sheets ?? []).map((entry) => entry?.properties);
    const targets = resolveTabsToDelete(properties, tabNames, includeReceiptTab);
    if (targets.length === 0) return { deleted: 0 };
    await paceNextRequest();
    const writeTimeout = nextRequestTimeout(options.deadlineAtMs);
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: targets.map((sheetId) => ({ deleteSheet: { sheetId } })) },
    }, { timeout: writeTimeout, retry: false }).catch(toStatusError);
    return { deleted: targets.length };
  }

  return { readTabRows, readTabsRows, mutateInputCell, deleteTabs };
}

/** Default pacing sleep backed by setTimeout (injectable in tests). */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure tab-selection logic for cleanup (testable without credentials).
 *
 * Returns the sheet ids to delete: the named projection tabs plus, ONLY
 * when `includeReceiptTab` is true, the shared receipt tab. A subset
 * cleanup (`includeReceiptTab: false`) keeps the receipt tab so untouched
 * tables can keep projecting.
 *
 * @param {Array<{ sheetId?: number, title?: string } | undefined>} properties
 * @param {readonly string[]} tabNames projection tab names to remove.
 * @param {boolean} includeReceiptTab full-cleanup flag.
 * @returns {number[]} sheet ids selected for deletion, in sheet order.
 */
export function resolveTabsToDelete(properties, tabNames, includeReceiptTab) {
  const targets = [];
  for (const propertiesEntry of properties) {
    const { sheetId, title } = propertiesEntry ?? {};
    if (sheetId === undefined || title === undefined) continue;
    const named = tabNames.includes(title);
    const receipt = includeReceiptTab && title === RECEIPT_TAB_NAME;
    if (named || receipt) targets.push(sheetId);
  }
  return targets;
}

/** Harness error carrying a stable class only (no remote payload). */
export class DirectSheetsError extends Error {
  constructor(message, statusClass) {
    super(message);
    this.name = "DirectSheetsError";
    this.statusClass = statusClass;
  }
}

/**
 * Maps SDK failures to status-class-only harness errors.
 *
 * The message carries the stable status class (an HTTP status or a
 * network/transport class) and NOTHING else: raw provider messages, API
 * error reasons, response bodies, spreadsheet IDs, and URLs never enter
 * the error, its message, or any artifact.
 */
function toStatusError(error) {
  const status = error?.response?.status ?? error?.code;
  // Numeric HTTP statuses classify as `http_<NNN>`; known named classes
  // pass through; ANY other string (an SDK code or payload fragment) maps
  // to the fixed `unknown` category so no arbitrary provider text can
  // reach an artifact or console line.
  let statusClass = "unknown";
  if (typeof status === "number") {
    statusClass = `http_${status}`;
  } else if (status === "network_or_unknown") {
    statusClass = "network_or_unknown";
  }
  throw new DirectSheetsError(
    `direct sheets request failed: ${statusClass}`,
    statusClass,
  );
}

/** Quotes a tab name for A1 notation. */
function quoteTabName(tabName) {
  return `'${tabName.replace(/'/g, "''")}'`;
}
