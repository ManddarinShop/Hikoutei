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
    for (const entry of requireSheetsArray(response)) {
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
   * Reads ONE tab's rows AND its numeric sheetId in a single
   * `spreadsheets.get` (never logged).
   *
   * Used by mutateInputCell so the target sheetId is obtained TOGETHER with
   * the row snapshot in one request — there is no separate sheet-id lookup
   * sitting between identity resolution and the write. The read is asserted
   * against `min(phase deadline, run deadline)` before it starts and
   * timeouts at the effective remaining budget.
   *
   * @param {string} spreadsheetId the spreadsheet to read.
   * @param {string} tabName the target tab.
   * @param {number | undefined} deadlineAtMs active operation deadline.
   * @returns {Promise<{ rows: string[][], sheetId: number }>}
   */
  async function readInputSnapshot(spreadsheetId, tabName, deadlineAtMs) {
    await paceNextRequest();
    const timeout = nextRequestTimeout(deadlineAtMs);
    const range = `${quoteTabName(tabName)}!A1:ZZ`;
    const response = await client.spreadsheets.get({
      spreadsheetId,
      ranges: [range],
      fields: "sheets(properties(sheetId,title),data(rowData(values(formattedValue))))",
    }, { timeout, retry: false }).catch(toStatusError);
    const sheet = requireSheetsArray(response).find((entry) =>
      entry?.properties?.title === tabName);
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined) {
      throw new DirectSheetsError("tab not found", "missing_tab");
    }
    if (!isValidSheetId(sheetId)) {
      throw new DirectSheetsError("invalid sheet id", "malformed_sheet_id");
    }
    const grid = (sheet?.data ?? [])[0];
    const rows = (grid?.rowData ?? []).map((row) =>
      (row?.values ?? []).map((cell) => cell?.formattedValue ?? ""));
    return { rows, sheetId };
  }

  /**
   * Overwrites one field cell of the row whose id column matches (human
   * edit) and verifies the write landed on the INTENDED identity row.
   *
   * The target tab's rows AND its numeric sheetId are read in ONE
   * `spreadsheets.get` (closing the avoidable separate sheet-id lookup gap).
   * The write targets the row index from that single snapshot. Because
   * Sheets has no identity compare-and-set by cell value, a User_Input row
   * insert/delete between the snapshot and the write can shift the tab and
   * place the value on a DIFFERENT row; a deadline-bound direct postcondition
   * read therefore runs right after the write and compares the pre-write and
   * post-write snapshots BY VALIDATED IDENTITY. It requires exactly one
   * intended identity row before and after, that row's target field to
   * display the requested value, and every non-target identity present in
   * both snapshots to retain its pre-write target-field value. A value
   * placed on another identity, an absent or duplicated identity, or any
   * proven collateral field change rejects with the stable `identity_shifted`
   * status class (non-retryable) — the caller is never told the write
   * succeeded for the wrong identity. The harness never compensates with a
   * second row-index write and never retries.
   *
   * `deadlineAtMs` is the probe phase's ACTIVE OPERATION deadline; every
   * request of the call (snapshot read, write, postcondition read) is
   * asserted and timeouts against `min(phase deadline, run deadline)`.
   */
  async function mutateInputCell({ spreadsheetId, tabName, identity, headerName, value, deadlineAtMs }) {
    // ONE GET returns the row snapshot AND the tab's sheetId together, so
    // there is no separate sheet-id lookup between identity resolution and
    // the write.
    const { rows, sheetId } = await readInputSnapshot(spreadsheetId, tabName, deadlineAtMs);
    // ONE shared pre-write snapshot validation for headers, row shape, and
    // identity uniqueness (also the probe's readiness barrier) promotes the
    // snapshot to a ready write coordinate or fails closed without a write:
    // a malformed tab raises the fixed class (`missing_header`,
    // `malformed_header`, `identity_shifted`) and an absent target raises
    // `missing_identity` — never a retried or compensated write.
    const snapshotVerdict = evaluateInputPreWrite({ rows, identity, headerName });
    if (snapshotVerdict.status === "fail") {
      throw new DirectSheetsError("input snapshot invalid", snapshotVerdict.statusClass);
    }
    if (snapshotVerdict.status === "missing") {
      throw new DirectSheetsError("identity row not found", "missing_identity");
    }
    const { idColumn, fieldColumn, rowIndex } = snapshotVerdict;
    // MEDIUM 5: the write timeout is resolved NOW — immediately before this
    // SDK request — never from a clock read taken before the earlier
    // snapshot read, so a slow multi-request mutation can never run with a
    // stale timeout past the effective deadline.
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
    // Deadline-bound direct postcondition: prove the value landed on exactly
    // one intended identity row. A User_Input row shift between the snapshot
    // and the write can place the value on another identity, duplicate the
    // identity, or drop the target; any such verdict is the stable
    // `identity_shifted` non-retryable harness failure, never a reported
    // success for the wrong identity.
    const postRows = await readTabRows(spreadsheetId, tabName, { deadlineAtMs });
    const verdict = evaluateInputPostcondition({
      beforeRows: rows,
      afterRows: postRows,
      identity,
      headerName,
      value,
      // The ORIGINAL write coordinate: the postcondition proves collateral
      // only at this exact row, never by comparing unrelated identities.
      rowIndex,
    });
    if (verdict.status !== "ok") {
      throw new DirectSheetsError("direct human write shifted identity", "identity_shifted");
    }
    return { rowNumber: rowIndex + 1 };
  }

  /**
   * Overwrites MULTIPLE field cells of the row whose id column matches
   * (multi-field human edit) in ONE batchUpdate and verifies every field
   * landed on the INTENDED identity row.
   *
   * Mirrors {@link mutateInputCell} but writes several fields of one row
   * atomically in a single request. The target tab's rows AND its numeric
   * sheetId are read in ONE `spreadsheets.get`; the write targets the row
   * index from that single snapshot. Because Sheets has no identity
   * compare-and-set by cell value, a User_Input row insert/delete between
   * the snapshot and the write can shift the tab; a deadline-bound direct
   * postcondition read runs right after the write and compares the
   * pre-write and post-write snapshots BY VALIDATED IDENTITY. It requires
   * exactly one intended identity row before and after, that row to
   * display EVERY requested field value, and no proven collateral write at
   * the original write coordinate. A value placed on another identity, an
   * absent or duplicated identity, or any proven collateral field change
   * rejects with the stable `identity_shifted` status class
   * (non-retryable). The harness never compensates and never retries.
   *
   * `fields` maps each target field header to its value. `deadlineAtMs` is
   * the probe phase's ACTIVE OPERATION deadline; every request of the call
   * is asserted and timeouts against `min(phase deadline, run deadline)`.
   */
  async function mutateInputCells({ spreadsheetId, tabName, identity, fields, deadlineAtMs }) {
    const headerNames = Object.keys(fields);
    const { rows, sheetId } = await readInputSnapshot(spreadsheetId, tabName, deadlineAtMs);
    const snapshotVerdict = evaluateInputPreWriteMulti({ rows, identity, headerNames });
    if (snapshotVerdict.status === "fail") {
      throw new DirectSheetsError("input snapshot invalid", snapshotVerdict.statusClass);
    }
    if (snapshotVerdict.status === "missing") {
      throw new DirectSheetsError("identity row not found", "missing_identity");
    }
    const { fieldColumns, rowIndex } = snapshotVerdict;
    await paceNextRequest();
    const timeout = nextRequestTimeout(deadlineAtMs);
    const requests = headerNames.map((headerName) => ({
      updateCells: {
        start: { sheetId, rowIndex, columnIndex: fieldColumns[headerName] },
        rows: [{ values: [{ userEnteredValue: { stringValue: String(fields[headerName]) } }] }],
        fields: "userEnteredValue",
      },
    }));
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    }, { timeout, retry: false }).catch(toStatusError);
    const postRows = await readTabRows(spreadsheetId, tabName, { deadlineAtMs });
    const verdict = evaluateInputPostconditionMulti({
      beforeRows: rows,
      afterRows: postRows,
      identity,
      headerNames,
      values: fields,
      rowIndex,
    });
    if (verdict.status !== "ok") {
      throw new DirectSheetsError("direct human write shifted identity", "identity_shifted");
    }
    return { rowNumber: rowIndex + 1 };
  }

  /**
   * Appends a NEW row (id + field values) to the target tab in ONE
   * batchUpdate (human row insert) and verifies the intended identity
   * landed exactly once.
   *
   * The target tab's rows AND its numeric sheetId are read in ONE
   * `spreadsheets.get`. The insert targets the first fully-blank data row
   * from that single snapshot. Because Sheets has no identity
   * compare-and-set by cell value, a concurrent row insert/delete can shift
   * the tab; a deadline-bound direct postcondition read runs right after
   * the write and requires the intended identity to exist exactly once
   * with every requested field value. A duplicated identity, an absent
   * identity, or any field that did not land on the intended identity
   * rejects with the stable `identity_shifted` status class
   * (non-retryable). The harness never compensates and never retries.
   *
   * `row` maps the id column (`id`) and each field header to its value.
   * `deadlineAtMs` is the probe phase's ACTIVE OPERATION deadline; every
   * request of the call is asserted and timeouts against
   * `min(phase deadline, run deadline)`.
   */
  async function insertInputRow({ spreadsheetId, tabName, row, deadlineAtMs }) {
    const fieldNames = Object.keys(row).filter((name) => name !== "id");
    const { rows, sheetId } = await readInputSnapshot(spreadsheetId, tabName, deadlineAtMs);
    const headerVerdict = validateInputHeadersMulti(rows?.[0] ?? [], fieldNames);
    if (headerVerdict.status !== "ok") {
      throw new DirectSheetsError("input snapshot invalid", headerVerdict.status);
    }
    const existing = indexByIdentities(rows, headerVerdict.idColumn);
    if (existing === null) {
      throw new DirectSheetsError("input snapshot invalid", "identity_shifted");
    }
    if (existing.has(row.id)) {
      throw new DirectSheetsError("identity already exists", "identity_shifted");
    }
    const rowIndex = findAppendRowIndex(rows);
    await paceNextRequest();
    const timeout = nextRequestTimeout(deadlineAtMs);
    const requests = [
      {
        updateCells: {
          start: { sheetId, rowIndex, columnIndex: headerVerdict.idColumn },
          rows: [{ values: [{ userEnteredValue: { stringValue: String(row.id) } }] }],
          fields: "userEnteredValue",
        },
      },
      ...fieldNames.map((headerName) => ({
        updateCells: {
          start: { sheetId, rowIndex, columnIndex: headerVerdict.fieldColumns[headerName] },
          rows: [{ values: [{ userEnteredValue: { stringValue: String(row[headerName]) } }] }],
          fields: "userEnteredValue",
        },
      })),
    ];
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    }, { timeout, retry: false }).catch(toStatusError);
    const postRows = await readTabRows(spreadsheetId, tabName, { deadlineAtMs });
    const fieldValues = {};
    for (const headerName of fieldNames) fieldValues[headerName] = row[headerName];
    const verdict = evaluateInsertPostcondition({
      afterRows: postRows,
      identity: row.id,
      headerNames: fieldNames,
      values: fieldValues,
    });
    if (verdict.status !== "ok") {
      throw new DirectSheetsError("direct human insert shifted identity", "identity_shifted");
    }
    return { rowNumber: rowIndex + 1 };
  }

  /**
   * Deletes the row whose id column matches from the target tab in ONE
   * batchUpdate (human row delete) and verifies the intended identity is
   * gone.
   *
   * The target tab's rows AND its numeric sheetId are read in ONE
   * `spreadsheets.get`. The delete targets the row index from that single
   * snapshot. Because Sheets has no identity compare-and-set by cell value,
   * a concurrent row insert/delete can shift the tab and place the delete
   * on a DIFFERENT row; a deadline-bound direct postcondition read runs
   * right after the write and requires the intended identity to be ABSENT
   * from the post-write snapshot. A still-present identity (a shift placed
   * the delete on the wrong row), a duplicated identity, or an absent
   * pre-write identity rejects with the stable `identity_shifted` status
   * class (non-retryable). The harness never compensates and never retries.
   *
   * `deadlineAtMs` is the probe phase's ACTIVE OPERATION deadline; every
   * request of the call is asserted and timeouts against
   * `min(phase deadline, run deadline)`.
   */
  async function deleteInputRow({ spreadsheetId, tabName, identity, deadlineAtMs }) {
    const { rows, sheetId } = await readInputSnapshot(spreadsheetId, tabName, deadlineAtMs);
    const headerVerdict = validateInputHeadersMulti(rows?.[0] ?? [], []);
    if (headerVerdict.status !== "ok") {
      throw new DirectSheetsError("input snapshot invalid", headerVerdict.status);
    }
    const existing = indexByIdentities(rows, headerVerdict.idColumn);
    if (existing === null) {
      throw new DirectSheetsError("input snapshot invalid", "identity_shifted");
    }
    if (!existing.has(identity)) {
      throw new DirectSheetsError("identity row not found", "missing_identity");
    }
    const rowIndex = rows.findIndex((row, index) =>
      index > 0 && row[headerVerdict.idColumn] === identity);
    await paceNextRequest();
    const timeout = nextRequestTimeout(deadlineAtMs);
    await client.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 },
          },
        }],
      },
    }, { timeout, retry: false }).catch(toStatusError);
    const postRows = await readTabRows(spreadsheetId, tabName, { deadlineAtMs });
    const verdict = evaluateDeletePostcondition({
      beforeRows: rows,
      afterRows: postRows,
      identity,
      idColumn: headerVerdict.idColumn,
    });
    if (verdict.status !== "ok") {
      throw new DirectSheetsError("direct human delete shifted identity", "identity_shifted");
    }
    return { rowNumber: rowIndex + 1 };
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
    const properties = requireSheetsArray(response).map((entry) => entry?.properties);
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

  return {
    readTabRows,
    readTabsRows,
    mutateInputCell,
    mutateInputCells,
    insertInputRow,
    deleteInputRow,
    deleteTabs,
  };
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
    if (named || receipt) {
      if (!isValidSheetId(sheetId)) {
        throw new DirectSheetsError("invalid sheet id", "malformed_sheet_id");
      }
      targets.push(sheetId);
    }
  }
  return targets;
}

/**
 * Pure postcondition check for one direct human write: requires exactly
 * ONE row whose id equals `identity`, that row's `headerName` cell to
 * display `String(value)`, and no OTHER row to display that same value.
 *
 * Sheets has no identity compare-and-set by cell value, so a User_Input
 * row insert/delete between the identity snapshot and the write can shift
 * the tab and place the value on a different identity. This check turns
 * that into a deterministic verdict: a value placed on another identity,
 * an absent or duplicated identity row, or a duplicate value all collapse
 * to the stable `identity_shifted` status. Only cell-shape comparisons run
 * here; no id, value, or payload is ever returned.
 *
 * @param {object} input the postcondition inputs.
 * @param {readonly unknown[][]} input.rows postcondition tab rows.
 * @param {string} input.identity the intended identity value.
 * @param {string} input.headerName the target field header.
 * @param {string} input.value the value the write intended to place.
 * @returns {{ status: "ok" } | { status: "identity_shifted" }}
 */
/**
 * True when a sheetId from an untrusted SDK response is a usable numeric
 * id: a non-negative safe integer. `null`, strings, fractions, NaN,
 * negative, and out-of-safe-range values are never usable and must never
 * reach an update/delete request.
 *
 * @param {unknown} value a candidate sheetId.
 * @returns {boolean}
 */
function isValidSheetId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates the header row of a direct-write tab before writing and during
 * postcondition promotion. Headers must be non-empty, non-whitespace-only
 * strings with no duplicates, exactly one `id`, and exactly one requested
 * field; writing to the `id` column itself (`headerName === "id"`) is
 * rejected rather than treating one column as both id and field. Returns
 * the resolved column indexes on success, or a stable non-retryable harness
 * status class (`missing_header` / `malformed_header`) — never raw headers
 * or values.
 *
 * @param {readonly unknown[]} headers the tab's header row.
 * @param {string} headerName the requested target field header.
 * @returns {{ status: "ok", idColumn: number, fieldColumn: number } |
 *   { status: "missing_header" } | { status: "malformed_header" }}
 */
function validateInputHeaders(headers, headerName) {
  if (!Array.isArray(headers)) return { status: "malformed_header" };
  const seen = new Set();
  for (const header of headers) {
    // An empty or whitespace-only header (including a blank cell that the
    // read normalizes to "") is malformed; never a usable column.
    if (typeof header !== "string" || header.trim() === "") {
      return { status: "malformed_header" };
    }
    if (seen.has(header)) return { status: "malformed_header" };
    seen.add(header);
  }
  const idColumn = headers.indexOf("id");
  if (idColumn < 0) return { status: "missing_header" };
  if (headerName === "id") return { status: "malformed_header" };
  const fieldColumn = headers.indexOf(headerName);
  if (fieldColumn < 0) return { status: "missing_header" };
  return { status: "ok", idColumn, fieldColumn };
}

/**
 * Validates the header row of a direct-write tab for MULTIPLE target
 * fields (multi-field human edit / row insert). Headers must be
 * non-empty, non-whitespace-only strings with no duplicates, exactly one
 * `id`, and every requested field present; writing to the `id` column
 * itself is rejected. Returns the resolved id column and a field-name ->
 * column-index map on success, or a stable non-retryable harness status
 * class (`missing_header` / `malformed_header`). Never returns raw headers
 * or values.
 *
 * @param {readonly unknown[]} headers the tab's header row.
 * @param {readonly string[]} headerNames requested field headers.
 * @returns {{ status: "ok", idColumn: number, fieldColumns: Record<string, number> } |
 *   { status: "missing_header" } | { status: "malformed_header" }}
 */
function validateInputHeadersMulti(headers, headerNames) {
  if (!Array.isArray(headers)) return { status: "malformed_header" };
  const seen = new Set();
  for (const header of headers) {
    if (typeof header !== "string" || header.trim() === "") {
      return { status: "malformed_header" };
    }
    if (seen.has(header)) return { status: "malformed_header" };
    seen.add(header);
  }
  const idColumn = headers.indexOf("id");
  if (idColumn < 0) return { status: "missing_header" };
  const fieldColumns = {};
  for (const headerName of headerNames) {
    if (headerName === "id") return { status: "malformed_header" };
    const fieldColumn = headers.indexOf(headerName);
    if (fieldColumn < 0) return { status: "missing_header" };
    fieldColumns[headerName] = fieldColumn;
  }
  return { status: "ok", idColumn, fieldColumns };
}

/** Normalizes one sparse display cell: undefined/null/"" are the same blank. */
function normalizeCell(cell) {
  return cell === undefined || cell === null ? "" : String(cell);
}

/** True when a sparse display cell is blank (undefined/null/""). */
function isBlankCell(cell) {
  return cell === undefined || cell === null || cell === "";
}

/**
 * Indexes a tab's DATA rows by nonblank identity, skipping the header row
 * and fully blank/padding rows, returning the normalized target-field value
 * for each identity. Fails closed (returns `null`) on any malformed row: a
 * non-empty row whose identity is blank or not a string, or a duplicated
 * nonblank identity. The caller maps `null` to its status; no row content
 * or identity ever escapes.
 *
 * @param {readonly unknown[][]} rows tab rows including the header row.
 * @param {number} idColumn the id column index.
 * @param {number} fieldColumn the target-field column index.
 * @returns {Map<string, unknown> | null}
 */
function indexByIdentity(rows, idColumn, fieldColumn) {
  const byId = new Map();
  for (let index = 1; index < rows.length; index++) {
    const rawRow = rows[index];
    if (rawRow === undefined || rawRow === null) continue;
    if (!Array.isArray(rawRow)) return null;
    // Fully blank/padding rows (undefined/null/"") carry no identity and are
    // skipped; a non-empty row must have a nonblank string identity.
    if (rawRow.every(isBlankCell)) continue;
    const rawId = rawRow[idColumn];
    if (rawId === undefined || rawId === null || rawId === "") return null;
    if (typeof rawId !== "string") return null;
    if (byId.has(rawId)) return null;
    byId.set(rawId, normalizeCell(rawRow[fieldColumn]));
  }
  return byId;
}

/**
 * Indexes a tab's DATA rows by nonblank identity, skipping the header row
 * and fully blank/padding rows. Fails closed (returns `null`) on any
 * malformed row: a non-empty row whose identity is blank or not a string,
 * or a duplicated nonblank identity. Unlike {@link indexByIdentity} this
 * variant does not read a target field — it only validates identity
 * uniqueness, which is all a multi-field write, row insert, or row delete
 * needs before it resolves a write coordinate. No identity ever escapes.
 *
 * @param {readonly unknown[][]} rows tab rows including the header row.
 * @param {number} idColumn the id column index.
 * @returns {Map<string, true> | null}
 */
function indexByIdentities(rows, idColumn) {
  const byId = new Map();
  for (let index = 1; index < rows.length; index++) {
    const rawRow = rows[index];
    if (rawRow === undefined || rawRow === null) continue;
    if (!Array.isArray(rawRow)) return null;
    if (rawRow.every(isBlankCell)) continue;
    const rawId = rawRow[idColumn];
    if (rawId === undefined || rawId === null || rawId === "") return null;
    if (typeof rawId !== "string") return null;
    if (byId.has(rawId)) return null;
    byId.set(rawId, true);
  }
  return byId;
}

/**
 * Resolves the first fully-blank data row index (>= 1) for appending a new
 * row, or the row just past the last returned row when none is blank. The
 * header row (index 0) is never a target.
 *
 * @param {readonly unknown[][]} rows tab rows including the header row.
 * @returns {number} the append row index.
 */
function findAppendRowIndex(rows) {
  for (let index = 1; index < rows.length; index++) {
    const rawRow = rows[index];
    if (rawRow === undefined || rawRow === null || rawRow.every(isBlankCell)) {
      return index;
    }
  }
  return rows.length;
}

/**
 * ONE shared pure PRE-WRITE snapshot validation used by BOTH the direct
 * human write and the probe's readiness barrier.
 *
 * Promotes a User_Input tab snapshot into a ready write coordinate, or
 * fails closed WITHOUT a write. The full header and row-shape validation is
 * identical for both callers so the readiness barrier can never accept a
 * tab that the write itself would reject: a missing/duplicate/whitespace
 * header, a non-empty row with a blank or non-string identity, or a
 * duplicated nonblank identity (intended or not) returns a fixed `fail`
 * class; a structurally valid tab that simply lacks the intended identity
 * returns `missing` (the probe may reread before its deadline); and on
 * `ready` the resolved column indexes AND the target's rowIndex are
 * returned so the caller never revalidates. Fully blank padding rows are
 * ignored and never fail. No id, value, or payload ever escapes.
 *
 * @param {object} input the pre-write snapshot inputs.
 * @param {readonly unknown[][]} input.rows the tab rows including the header row.
 * @param {string} input.identity the intended identity value.
 * @param {string} input.headerName the target field header.
 * @returns {{ status:"ready", idColumn:number, fieldColumn:number, rowIndex:number } |
 *   { status:"missing" } | { status:"fail", statusClass:string }}
 */
export function evaluateInputPreWrite({ rows, identity, headerName }) {
  const headers = Array.isArray(rows) ? rows[0] : undefined;
  const headerVerdict = validateInputHeaders(headers ?? [], headerName);
  if (headerVerdict.status !== "ok") {
    return { status: "fail", statusClass: headerVerdict.status };
  }
  if (indexByIdentity(rows, headerVerdict.idColumn, headerVerdict.fieldColumn) === null) {
    return { status: "fail", statusClass: "identity_shifted" };
  }
  const rowIndex = rows.findIndex((row, index) =>
    index > 0 && row[headerVerdict.idColumn] === identity);
  if (rowIndex < 0) return { status: "missing" };
  return {
    status: "ready",
    idColumn: headerVerdict.idColumn,
    fieldColumn: headerVerdict.fieldColumn,
    rowIndex,
  };
}

/**
 * Pure postcondition check for one direct human write, comparing the
 * pre-write and post-write snapshots BY VALIDATED IDENTITY (never by
 * mutable row order).
 *
 * Sheets has no identity compare-and-set by cell value, so a User_Input
 * row insert/delete between the identity snapshot and the write can shift
 * the tab and place the value on a different row. This check turns that
 * into a deterministic verdict: it requires exactly one intended identity
 * row before and after (no duplicate nonblank identities), that row's
 * target field to display `String(value)`, and — when `rowIndex` (the
 * ORIGINAL write coordinate) is supplied — that the post-read row at that
 * coordinate does NOT belong to a different nonblank identity while still
 * displaying the requested value (a proven collateral write to the wrong
 * identity's row). New/deleted unrelated rows may appear (async
 * projection) and are never compared by order, and non-target identities
 * are NEVER compared field-by-field because concurrent actors legitimately
 * update them.
 *
 * NOTE: a collateral change that is fully overwritten again before the
 * postcondition read remains unobservable without identity compare-and-set
 * — the harness can only prove the write landed on the intended identity,
 * not that no other write ever touched a cell. A blank or non-string
 * identity in a non-empty row, or a duplicated nonblank identity, fails
 * closed. Only cell-shape comparisons run here; no id, value, or payload
 * is ever returned.
 *
 * @param {object} input the postcondition inputs.
 * @param {readonly unknown[][]} input.beforeRows pre-write snapshot rows.
 * @param {readonly unknown[][]} input.afterRows post-write snapshot rows.
 * @param {string} input.identity the intended identity value.
 * @param {string} input.headerName the target field header.
 * @param {string} input.value the value the write intended to place.
 * @param {number} [input.rowIndex] the original write row coordinate.
 * @returns {{ status: "ok" } | { status: "identity_shifted" }}
 */
export function evaluateInputPostcondition({
  beforeRows, afterRows, identity, headerName, value, rowIndex,
}) {
  const before = validateInputHeaders(beforeRows?.[0] ?? [], headerName);
  const after = validateInputHeaders(afterRows?.[0] ?? [], headerName);
  if (before.status !== "ok" || after.status !== "ok") return { status: "identity_shifted" };
  const expected = String(value);
  const beforeById = indexByIdentity(beforeRows, before.idColumn, before.fieldColumn);
  const afterById = indexByIdentity(afterRows, after.idColumn, after.fieldColumn);
  if (beforeById === null || afterById === null) return { status: "identity_shifted" };
  if (!beforeById.has(identity) || !afterById.has(identity)) return { status: "identity_shifted" };
  if (afterById.get(identity) !== expected) return { status: "identity_shifted" };
  // Proven collateral at the actual write coordinate: if the post-read row
  // at the ORIGINAL write rowIndex belongs to a DIFFERENT nonblank identity
  // AND still displays the requested value, the value we wrote landed on
  // another identity's row. A collateral value overwritten again before this
  // post-read is unobservable, so ONLY this coordinate row is examined.
  if (Number.isSafeInteger(rowIndex) && rowIndex >= 0 && rowIndex < afterRows.length) {
    const writeRow = afterRows[rowIndex];
    const writeId = writeRow?.[after.idColumn];
    if (!isBlankCell(writeId) && writeId !== identity &&
        normalizeCell(writeRow?.[after.fieldColumn]) === expected) {
      return { status: "identity_shifted" };
    }
  }
  return { status: "ok" };
}

/**
 * Pure PRE-WRITE snapshot validation for a MULTI-FIELD direct human write
 * (`mutateInputCells`): promotes a User_Input tab snapshot into a ready
 * write coordinate for several fields of one row, or fails closed WITHOUT
 * a write. Mirrors {@link evaluateInputPreWrite} but validates every
 * requested field header and returns a field-name -> column-index map. A
 * missing/duplicate/whitespace header, a non-empty row with a blank or
 * non-string identity, or a duplicated nonblank identity returns a fixed
 * `fail` class; a structurally valid tab lacking the intended identity
 * returns `missing`; on `ready` the id column, field columns, and the
 * target's rowIndex are returned. Fully blank padding rows are ignored.
 * Never returns an id or value.
 *
 * @param {object} input the pre-write snapshot inputs.
 * @param {readonly unknown[][]} input.rows the tab rows including the header row.
 * @param {string} input.identity the intended identity value.
 * @param {readonly string[]} input.headerNames the target field headers.
 * @returns {{ status:"ready", idColumn:number, fieldColumns:Record<string, number>, rowIndex:number } |
 *   { status:"missing" } | { status:"fail", statusClass:string }}
 */
export function evaluateInputPreWriteMulti({ rows, identity, headerNames }) {
  const headers = Array.isArray(rows) ? rows[0] : undefined;
  const headerVerdict = validateInputHeadersMulti(headers ?? [], headerNames);
  if (headerVerdict.status !== "ok") {
    return { status: "fail", statusClass: headerVerdict.status };
  }
  if (indexByIdentities(rows, headerVerdict.idColumn) === null) {
    return { status: "fail", statusClass: "identity_shifted" };
  }
  const rowIndex = rows.findIndex((row, index) =>
    index > 0 && row[headerVerdict.idColumn] === identity);
  if (rowIndex < 0) return { status: "missing" };
  return {
    status: "ready",
    idColumn: headerVerdict.idColumn,
    fieldColumns: headerVerdict.fieldColumns,
    rowIndex,
  };
}

/**
 * Pure postcondition check for a MULTI-FIELD direct human write, comparing
 * the pre-write and post-write snapshots BY VALIDATED IDENTITY. Requires
 * exactly one intended identity row before and after, that row to display
 * EVERY requested field value, and — when `rowIndex` (the ORIGINAL write
 * coordinate) is supplied — that the post-read row at that coordinate does
 * not belong to a different nonblank identity while still displaying any
 * requested value (a proven collateral write to the wrong identity's row).
 * New/deleted unrelated rows may appear (async projection) and are never
 * compared by order. A blank or non-string identity in a non-empty row, or
 * a duplicated nonblank identity, fails closed. Only cell-shape
 * comparisons run here; no id, value, or payload is ever returned.
 *
 * @param {object} input the postcondition inputs.
 * @param {readonly unknown[][]} input.beforeRows pre-write snapshot rows.
 * @param {readonly unknown[][]} input.afterRows post-write snapshot rows.
 * @param {string} input.identity the intended identity value.
 * @param {readonly string[]} input.headerNames the target field headers.
 * @param {Record<string, unknown>} input.values the values the write intended to place.
 * @param {number} [input.rowIndex] the original write row coordinate.
 * @returns {{ status: "ok" } | { status: "identity_shifted" }}
 */
export function evaluateInputPostconditionMulti({
  beforeRows, afterRows, identity, headerNames, values, rowIndex,
}) {
  const before = validateInputHeadersMulti(beforeRows?.[0] ?? [], headerNames);
  const after = validateInputHeadersMulti(afterRows?.[0] ?? [], headerNames);
  if (before.status !== "ok" || after.status !== "ok") return { status: "identity_shifted" };
  const beforeById = indexByIdentities(beforeRows, before.idColumn);
  const afterById = indexByIdentities(afterRows, after.idColumn);
  if (beforeById === null || afterById === null) return { status: "identity_shifted" };
  if (!beforeById.has(identity) || !afterById.has(identity)) return { status: "identity_shifted" };
  for (const headerName of headerNames) {
    const fieldColumn = after.fieldColumns[headerName];
    const expected = String(values[headerName]);
    const actual = normalizeCell(afterRows.find((row, index) =>
      index > 0 && row[after.idColumn] === identity)?.[fieldColumn]);
    if (actual !== expected) return { status: "identity_shifted" };
  }
  if (Number.isSafeInteger(rowIndex) && rowIndex >= 0 && rowIndex < afterRows.length) {
    const writeRow = afterRows[rowIndex];
    const writeId = writeRow?.[after.idColumn];
    if (!isBlankCell(writeId) && writeId !== identity) {
      for (const headerName of headerNames) {
        const fieldColumn = after.fieldColumns[headerName];
        if (normalizeCell(writeRow?.[fieldColumn]) === String(values[headerName])) {
          return { status: "identity_shifted" };
        }
      }
    }
  }
  return { status: "ok" };
}

/**
 * Pure postcondition check for a direct human ROW INSERT: requires the
 * intended identity to exist exactly once in the post-write snapshot and
 * that identity's row to display every requested field value. A duplicated
 * identity, an absent identity, a blank or non-string identity in a
 * non-empty row, or any field that did not land on the intended identity
 * returns `identity_shifted`. Only cell-shape comparisons run here; no id,
 * value, or payload is ever returned.
 *
 * @param {object} input the postcondition inputs.
 * @param {readonly unknown[][]} input.afterRows post-write snapshot rows.
 * @param {string} input.identity the intended identity value.
 * @param {readonly string[]} input.headerNames the inserted field headers.
 * @param {Record<string, unknown>} input.values the field values inserted.
 * @returns {{ status: "ok" } | { status: "identity_shifted" }}
 */
export function evaluateInsertPostcondition({ afterRows, identity, headerNames, values }) {
  const after = validateInputHeadersMulti(afterRows?.[0] ?? [], headerNames);
  if (after.status !== "ok") return { status: "identity_shifted" };
  const afterById = indexByIdentities(afterRows, after.idColumn);
  if (afterById === null) return { status: "identity_shifted" };
  if (!afterById.has(identity)) return { status: "identity_shifted" };
  for (const headerName of headerNames) {
    const fieldColumn = after.fieldColumns[headerName];
    const expected = String(values[headerName]);
    const actual = normalizeCell(afterRows.find((row, index) =>
      index > 0 && row[after.idColumn] === identity)?.[fieldColumn]);
    if (actual !== expected) return { status: "identity_shifted" };
  }
  return { status: "ok" };
}

/**
 * Pure postcondition check for a direct human ROW DELETE: requires the
 * intended identity to exist exactly once in the pre-write snapshot and to
 * be ABSENT from the post-write snapshot. A duplicated identity, an absent
 * pre-write identity, a still-present post-write identity (a row shift
 * placed the delete on the wrong row), or a blank or non-string identity
 * in a non-empty row returns `identity_shifted`. Only cell-shape
 * comparisons run here; no id, value, or payload is ever returned.
 *
 * @param {object} input the postcondition inputs.
 * @param {readonly unknown[][]} input.beforeRows pre-write snapshot rows.
 * @param {readonly unknown[][]} input.afterRows post-write snapshot rows.
 * @param {string} input.identity the intended identity value.
 * @param {number} input.idColumn the id column index.
 * @returns {{ status: "ok" } | { status: "identity_shifted" }}
 */
export function evaluateDeletePostcondition({ beforeRows, afterRows, identity, idColumn }) {
  const before = validateInputHeadersMulti(beforeRows?.[0] ?? [], []);
  const after = validateInputHeadersMulti(afterRows?.[0] ?? [], []);
  if (before.status !== "ok" || after.status !== "ok") return { status: "identity_shifted" };
  const beforeById = indexByIdentities(beforeRows, before.idColumn);
  const afterById = indexByIdentities(afterRows, after.idColumn);
  if (beforeById === null || afterById === null) return { status: "identity_shifted" };
  if (!beforeById.has(identity)) return { status: "identity_shifted" };
  if (afterById.has(identity)) return { status: "identity_shifted" };
  return { status: "ok" };
}

/**
 * Extracts the `sheets` array from an untrusted SDK response, throwing the
 * stable non-retryable `malformed_reply` status when a FULFILLED payload's
 * `data.sheets` is present but not an array. A malformed payload must never
 * surface a raw TypeError (from `.find`/`.map`/`for...of` on a non-array)
 * or leak a raw payload; only the fixed redacted status class escapes.
 *
 * @param {unknown} response a fulfilled SDK response object.
 * @returns {unknown[]} the sheets array.
 */
function requireSheetsArray(response) {
  const sheetsEntries = response?.data?.sheets;
  if (!Array.isArray(sheetsEntries)) {
    throw new DirectSheetsError("malformed sheets reply", "malformed_reply");
  }
  return sheetsEntries;
}

/** Numeric HTTP statuses a convergence read may safely retry. */
const RETRYABLE_HTTP_STATUSES = new Set([408, 429]);

/** gaxios/node timeout and deadline codes (classified, never retained). */
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "timeout",
  "deadline",
  "DEADLINE_EXCEEDED",
  // Real gaxios timeout: the wrapped DOMException's `name` becomes the
  // GaxiosError's top-level `code` (see gaxios common.js GaxiosError).
  "TimeoutError",
]);

/** Known node/gaxios network codes (classified, never retained). */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ECONNABORTED",
  "EADDRNOTAVAIL",
  "EADDRINUSE",
  "ENETDOWN",
  "ENETRESET",
  "EHOSTDOWN",
  "EAGAIN",
  "EALREADY",
  "EINPROGRESS",
  "EISCONN",
  "ENOTCONN",
  // Legacy gaxios code aliased to the canonical `network` class: a
  // `network_or_unknown` SDK input is retryable network, never a distinct
  // class the NEW classifier emits. The legacy ARTIFACT vocabulary stays
  // accepted only for resume compatibility (see redact.mjs).
  "network_or_unknown",
]);

/**
 * Pure runtime classifier for one direct-client SDK failure.
 *
 * Maps an untrusted SDK rejection to a stable `statusClass` and a
 * `retryable` flag using EXACT allowlists only. Numeric HTTP statuses
 * come from `response.status`, a top-level `status`, or a numeric `code`;
 * timeout/deadline and known network codes are classified by their exact
 * code strings. A strictly bounded cause chain (the top-level error plus
 * up to two nested causes) is inspected for string `code` candidates so a
 * native-fetch network failure wrapped by gaxios can surface its
 * allowlisted code (e.g. `ECONNRESET`) at `error.cause.cause.code`.
 * Everything else falls back to `unknown`. The raw message, code, body,
 * URL, id, and cell data are never retained — only the stable class and
 * retryability survive.
 *
 * @param {unknown} error a rejected promise's reason.
 * @returns {{ statusClass: string, retryable: boolean }}
 */
export function classifyDirectError(error) {
  // MEDIUM: pick the FIRST candidate among response.status, top-level
  // status, and code that is ITSELF an integer HTTP status. A malformed
  // higher-priority candidate (a string, non-integer, or out-of-range
  // value) must never suppress a later valid numeric value, and strings
  // are never coerced into statuses.
  for (const candidate of [error?.response?.status, error?.status, error?.code]) {
    if (typeof candidate === "number" && Number.isInteger(candidate) &&
        candidate >= 100 && candidate <= 599) {
      return {
        statusClass: `http_${candidate}`,
        retryable: RETRYABLE_HTTP_STATUSES.has(candidate) || candidate >= 500,
      };
    }
  }
  // Walk a strictly bounded cause chain (the top-level error plus up to
  // two nested causes) reading ONLY string `code` candidates, and classify
  // only existing allowlisted timeout/network codes. A native-fetch network
  // failure wrapped by gaxios can surface its allowlisted code (e.g.
  // `ECONNRESET`) at `error.cause.cause.code`; the raw code, message, and
  // object are never retained — only the stable class and retryability.
  let node = error;
  for (let depth = 0; depth <= 2 && node != null; depth++) {
    const code = typeof node?.code === "string" ? node.code : undefined;
    if (code !== undefined && TIMEOUT_CODES.has(code)) {
      return { statusClass: "timeout", retryable: true };
    }
    if (code !== undefined && NETWORK_CODES.has(code)) {
      return { statusClass: "network", retryable: true };
    }
    node = node?.cause;
  }
  if (error?.name === "TimeoutError") {
    return { statusClass: "timeout", retryable: true };
  }
  // A real gaxios timeout can surface as a generic `name:'Error'` with no
  // top-level code, an `AbortError` cause, and a `TimeoutError` signal
  // reason. Recognize ONLY that exact combination — an arbitrary
  // `AbortError` cause (no matching timeout signal reason) is never a
  // timeout and falls through to unknown.
  if (error?.cause?.name === "AbortError" &&
      error?.config?.signal?.reason?.name === "TimeoutError") {
    return { statusClass: "timeout", retryable: true };
  }
  return { statusClass: "unknown", retryable: false };
}

/** Harness error carrying a stable class and retryability only. */
export class DirectSheetsError extends Error {
  constructor(message, statusClass, retryable = false) {
    super(message);
    this.name = "DirectSheetsError";
    this.statusClass = statusClass;
    this.retryable = retryable;
  }
}

/**
 * Maps SDK failures to status-class-only harness errors.
 *
 * The message carries the stable status class and NOTHING else: raw
 * provider messages, API error reasons, response bodies, spreadsheet IDs,
 * and URLs never enter the error, its message, or any artifact. The
 * `retryable` flag is set only for classes a convergence read may safely
 * retry (timeout, network, HTTP 408/429/5xx).
 */
function toStatusError(error) {
  const { statusClass, retryable } = classifyDirectError(error);
  throw new DirectSheetsError(
    `direct sheets request failed: ${statusClass}`,
    statusClass,
    retryable,
  );
}

/** Quotes a tab name for A1 notation. */
function quoteTabName(tabName) {
  return `'${tabName.replace(/'/g, "''")}'`;
}
