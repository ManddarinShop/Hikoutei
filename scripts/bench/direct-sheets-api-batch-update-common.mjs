/**
 * Pure helpers for the Direct Sheets API batch-write benchmark
 * (scripts/bench/direct-sheets-api-batch-update.mjs).
 *
 * This module has no network side effects and never touches live credentials.
 * It is imported by:
 *   - scripts/bench/direct-sheets-api-batch-update.mjs (the live benchmark)
 *   - test/direct-sheets-api-batch-update-common.test.ts (credential-free tests)
 *
 * Both raw write paths are modeled as pure data over the same dataset:
 * totalRows records of 3 string cells (bench_key, seq, payload — see
 * BENCH_HEADERS in direct-sheets-api-common.mjs) distributed evenly across
 * tabCount tabs, header row on row 1 and data starting on row 2:
 *
 *   1. spreadsheets.batchUpdate: one UpdateCellsRequest per tab writing
 *      userEnteredValue.stringValue with fields "userEnteredValue".
 *   2. spreadsheets.values.batchUpdate: one ValueRange per tab with
 *      valueInputOption RAW.
 *
 * Safety contract: no helper here ever returns, prints, or serializes
 * credential values or the spreadsheet ID.
 */
import {
  buildRows,
  compareRows,
  countDuplicateKeys,
} from "./direct-sheets-api-common.mjs";

/** Total benchmark records written per scenario (runner default). */
export const TOTAL_RECORDS = 10_000;

/** Default tab-count matrix: 1/2/4/10/20 tabs. */
export const DEFAULT_TAB_COUNTS = Object.freeze([1, 2, 4, 10, 20]);

/** Data cells per record (bench_key, seq, payload). */
export const BENCH_COLUMNS = 3;

/** 0-based row index of the first data row (row 0 is the header row). */
export const DATA_FIRST_ROW_INDEX = 1;

/** API path identifiers used by the benchmark and its artifact. */
export const BATCH_WRITE_APIS = Object.freeze(["updateCells", "valuesBatchUpdate"]);

/**
 * Default seed for the deterministic scenario-order shuffle.
 *
 * A fixed default keeps reruns reproducible (same seed, same order) while
 * DIRECT_BATCH_SEED can change the order without introducing uncontrolled
 * randomness.
 */
export const DEFAULT_SCENARIO_SEED = 20260804;

/**
 * Plans the even distribution of `totalRows` records across `tabCount` tabs.
 *
 * Every tab receives the same number of rows, with a cumulative `startSeq`
 * so the global sequence stays 0..totalRows-1. A plan is valid only when the
 * row count divides evenly; otherwise the two write paths could not describe
 * the same dataset.
 *
 * @param options tabCount (positive integer), totalRows (default TOTAL_RECORDS)
 * @returns `{ status: "valid", totalRows, tabCount, rowsPerTab, tabs }` or
 *   `{ status: "invalid", reason }`
 */
export function planTabDistribution({ tabCount, totalRows = TOTAL_RECORDS }) {
  if (!Number.isSafeInteger(tabCount) || tabCount <= 0) {
    return { status: "invalid", reason: "tabCount must be a positive safe integer" };
  }
  if (!Number.isSafeInteger(totalRows) || totalRows <= 0) {
    return { status: "invalid", reason: "totalRows must be a positive safe integer" };
  }
  if (totalRows % tabCount !== 0) {
    return {
      status: "invalid",
      reason: `totalRows (${totalRows}) must be divisible by tabCount (${tabCount})`,
    };
  }
  const rowsPerTab = totalRows / tabCount;
  // Defense in depth: an unsafe row count would corrupt Array.from lengths
  // and sequence padding downstream.
  if (!Number.isSafeInteger(rowsPerTab)) {
    return { status: "invalid", reason: "rowsPerTab is not a safe integer" };
  }
  const tabs = Array.from({ length: tabCount }, (_, tabIndex) => ({
    tabIndex,
    rowCount: rowsPerTab,
    startSeq: tabIndex * rowsPerTab,
  }));
  return { status: "valid", totalRows, tabCount, rowsPerTab, tabs };
}

/**
 * Builds the deterministic benchmark rows for one tab of a distribution and
 * one write attempt.
 *
 * Reuses the shared `buildRows` helper with `cellId = tab<tabIndex>`, so keys
 * are unique across tabs (different cellId) and across the global sequence
 * (cumulative startSeq). The `attemptMarker` (e.g. `r0`, `r1` for measured
 * repetitions, `w0` for warm-ups) is folded into the run identity so every
 * warm-up and every measured repetition writes a DIFFERENT deterministic key
 * set into the same fixed ranges. A later no-op or partial write therefore
 * cannot pass verification against leftover data from an earlier attempt:
 * verification compares against the current attempt's own expected keys, so
 * stale keys surface as `missing` + `extra`.
 *
 * Every cell is a string so RAW round-trips are byte-stable.
 *
 * @param options runId, attemptMarker, tabIndex, rowCount, startSeq
 *   (from planTabDistribution)
 * @returns rows of `[bench_key, seq, payload]`
 */
export function buildTabRows({ runId, attemptMarker, tabIndex, rowCount, startSeq }) {
  return buildRows({
    runId: `${runId}-a${attemptMarker}`,
    cellId: `tab${tabIndex}`,
    startSeq,
    count: rowCount,
  });
}

/**
 * Builds the `requests` array for spreadsheets.batchUpdate (updateCells path):
 * exactly one UpdateCellsRequest per tab, writing only
 * `userEnteredValue.stringValue` with `fields: "userEnteredValue"` starting at
 * DATA_FIRST_ROW_INDEX (below the header row).
 *
 * @param options tabs of `{ sheetId, rows }` (numeric sheetId from addSheet)
 * @returns one updateCells request per tab, in the given order
 */
export function buildUpdateCellsRequests({ tabs }) {
  return tabs.map(({ sheetId, rows }) => ({
    updateCells: {
      start: { sheetId, rowIndex: DATA_FIRST_ROW_INDEX, columnIndex: 0 },
      rows: rows.map((row) => ({
        values: row.map((cell) => ({ userEnteredValue: { stringValue: cell } })),
      })),
      fields: "userEnteredValue",
    },
  }));
}

/**
 * Builds the `data` array for spreadsheets.values.batchUpdate (values path):
 * exactly one ValueRange per tab covering rows 2..rows.length+1 of the tab.
 *
 * @param options tabs of `{ title, rows }`
 * @returns one `{ range, values }` entry per tab, in the given order
 */
export function buildValueRanges({ tabs }) {
  return tabs.map(({ title, rows }) => {
    if (typeof title !== "string" || title === "") {
      throw new TypeError("buildValueRanges: every tab needs a non-empty string title");
    }
    return {
      range: `${title}!A${DATA_FIRST_ROW_INDEX + 1}:C${rows.length + DATA_FIRST_ROW_INDEX}`,
      values: rows,
    };
  });
}

/**
 * Evaluates one post-write verification read against the expected rows of a
 * single attempt.
 *
 * `expectedRowsByTab` must be the CURRENT attempt's rows; anything left from
 * an earlier attempt (stale data after a no-op/partial write) or any other
 * unexpected content makes that tab fail through `missing`/`extra`/
 * `mismatched`/duplicate counts. This is the pure comparison behind the
 * runner's values.batchGet verification and is what makes stale data unable
 * to pass the expected-row comparison.
 *
 * @param options expectedRowsByTab (per-tab expected rows for this attempt),
 *   actualRowsByTab (per-tab rows read back)
 * @returns `{ ok, tabs }` where each tab entry carries the comparison and
 *   duplicate-key evidence
 */
export function evaluateVerifiedTabs({ expectedRowsByTab, actualRowsByTab }) {
  const tabs = [];
  let ok = true;
  expectedRowsByTab.forEach((expected, index) => {
    const actual = Array.isArray(actualRowsByTab[index]) ? actualRowsByTab[index] : [];
    const comparison = compareRows(expected, actual);
    const keys = countDuplicateKeys(actual);
    const tabOk =
      comparison.matched === expected.length &&
      comparison.mismatched === 0 &&
      comparison.missing === 0 &&
      comparison.extra === 0 &&
      keys.duplicates === 0;
    ok = ok && tabOk;
    tabs.push({
      ok: tabOk,
      expectedRows: expected.length,
      actualRows: actual.length,
      ...keys,
      ...comparison,
    });
  });
  return { ok, tabs };
}

/**
 * Combines the independent write-response and post-write verification
 * outcomes of one measured repetition into one stable outcome tag.
 *
 * A repetition is a successful benchmark write only when BOTH the response
 * is valid AND its own verification passes. A failed/uncertain response
 * whose data was nevertheless verified is preserved as evidence
 * (`write_response_failed_but_data_verified`) but is never called a
 * successful write.
 */
export function classifyAttemptOutcome({ responseOk, verified }) {
  if (responseOk && verified) {
    return { status: "success" };
  }
  if (!responseOk && verified) {
    return { status: "write_response_failed_but_data_verified" };
  }
  if (responseOk && !verified) {
    return { status: "verification_failed" };
  }
  return { status: "write_failed" };
}

/**
 * Measures the exact JSON request-body size in bytes (UTF-8), so payload size
 * is comparable across the two write paths and is independent of locale.
 */
export function measurePayloadBytes(body) {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/**
 * Computes steady-state throughput from rows and total elapsed milliseconds.
 * Cells per second use BENCH_COLUMNS cells per record. Non-positive rows or
 * duration yield all-zero throughput rather than a misleading infinity.
 */
export function computeThroughput({ rows, durationMs }) {
  if (!Number.isFinite(rows) || rows <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { rowsPerSecond: 0, cellsPerSecond: 0 };
  }
  const rowsPerSecond = rows / (durationMs / 1000);
  return { rowsPerSecond, cellsPerSecond: rowsPerSecond * BENCH_COLUMNS };
}

/**
 * Classifies a values.batchUpdate response's `totalUpdatedRows` /
 * `totalUpdatedCells` against the payload counts. A 2xx response is not a
 * successful write unless both counts are integers matching the payload;
 * missing, non-integer, or wrong values are response-format anomalies with a
 * stable code and never count as successful writes.
 *
 * @param totalUpdatedRows raw `totalUpdatedRows` from the API response
 * @param totalUpdatedCells raw `totalUpdatedCells` from the API response
 * @param expectedRows rows sent in the payload
 * @returns `{ status: "ok", rowsUpdated, cellsUpdated }` or
 *   `{ status: "anomaly", class, code, rowsUpdated, cellsUpdated }`
 */
export function classifyValuesBatchUpdateResponse(totalUpdatedRows, totalUpdatedCells, expectedRows) {
  const missingRows = totalUpdatedRows === undefined || totalUpdatedRows === null;
  const missingCells = totalUpdatedCells === undefined || totalUpdatedCells === null;
  if (!Number.isInteger(totalUpdatedRows)) {
    return {
      status: "anomaly",
      class: "response_format",
      code: missingRows ? "missing_totalUpdatedRows" : "non_integer_totalUpdatedRows",
      rowsUpdated: 0,
      cellsUpdated: Number.isInteger(totalUpdatedCells) ? totalUpdatedCells : 0,
    };
  }
  if (!Number.isInteger(totalUpdatedCells)) {
    return {
      status: "anomaly",
      class: "response_format",
      code: missingCells ? "missing_totalUpdatedCells" : "non_integer_totalUpdatedCells",
      rowsUpdated: totalUpdatedRows,
      cellsUpdated: 0,
    };
  }
  if (totalUpdatedRows !== expectedRows) {
    return {
      status: "anomaly",
      class: "response_format",
      code: "wrong_totalUpdatedRows",
      rowsUpdated: totalUpdatedRows,
      cellsUpdated: totalUpdatedCells,
    };
  }
  if (totalUpdatedCells !== expectedRows * BENCH_COLUMNS) {
    return {
      status: "anomaly",
      class: "response_format",
      code: "wrong_totalUpdatedCells",
      rowsUpdated: totalUpdatedRows,
      cellsUpdated: totalUpdatedCells,
    };
  }
  return { status: "ok", rowsUpdated: totalUpdatedRows, cellsUpdated: totalUpdatedCells };
}

/**
 * Classifies a spreadsheets.batchUpdate response for the updateCells path.
 *
 * The updateCells reply carries no row/cell counts (unlike values.batchUpdate),
 * so the only checkable signal is the 1:1 reply mapping: an array of exactly
 * `expectedRequestCount` object entries. Full data verification is delegated to
 * the separate post-write batchGet in the benchmark runner.
 *
 * @param replies raw `replies` array from the API response
 * @param expectedRequestCount number of updateCells requests sent
 * @returns `{ status: "ok", requestCount }` or
 *   `{ status: "anomaly", class, code, requestCount }`
 */
export function classifyUpdateCellsReplies(replies, expectedRequestCount) {
  if (!Array.isArray(replies)) {
    return { status: "anomaly", class: "response_format", code: "missing_replies", requestCount: 0 };
  }
  if (replies.length !== expectedRequestCount) {
    return {
      status: "anomaly",
      class: "response_format",
      code: "wrong_replies_count",
      requestCount: replies.length,
    };
  }
  if (!replies.every((reply) => reply !== null && typeof reply === "object")) {
    return {
      status: "anomaly",
      class: "response_format",
      code: "malformed_replies",
      requestCount: replies.length,
    };
  }
  return { status: "ok", requestCount: replies.length };
}

/**
 * Parses an optional non-negative integer environment variable.
 *
 * Absent/blank values fall back to `fallback`; present values must be an
 * integer >= `min` (default 0) and a safe integer (Number.isSafeInteger), so
 * a value above Number.MAX_SAFE_INTEGER is a clear `unsafe_integer` error
 * instead of a silently rounded loop count. Used for DIRECT_BATCH_WARMUP and
 * DIRECT_BATCH_REPETITIONS so a typo is a clear configuration error instead
 * of a silent loop count.
 *
 * @returns `{ status: "valid", value }` or
 *   `{ status: "invalid", key, code, reason }`
 */
export function parsePositiveIntEnv(env, key, fallback, { min = 0 } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { status: "valid", value: fallback };
  }
  const token = raw.trim();
  if (!/^\d+$/.test(token)) {
    return {
      status: "invalid",
      key,
      code: "non_integer",
      reason: `${key} must be a non-negative integer (got '${token}')`,
    };
  }
  const value = Number(token);
  // Number() rounds digit strings above 2^53; a rounded value is never a
  // safe integer, so this rejects values above Number.MAX_SAFE_INTEGER even
  // when the rounded double happens to be exactly representable.
  if (!Number.isSafeInteger(value)) {
    return {
      status: "invalid",
      key,
      code: "unsafe_integer",
      reason: `${key} must be a safe integer <= Number.MAX_SAFE_INTEGER (got '${token}')`,
    };
  }
  if (value < min) {
    return {
      status: "invalid",
      key,
      code: "below_minimum",
      reason: `${key} must be >= ${min} (got ${value})`,
    };
  }
  return { status: "valid", value };
}

/**
 * Parses the optional comma-separated tab-count list
 * (DIRECT_BATCH_TAB_COUNTS).
 *
 * Absent values yield the DEFAULT_TAB_COUNTS matrix. Present values must be
 * positive integers and every count must divide `totalRows` evenly, so each
 * scenario can be expressed by both write paths with identical row counts.
 *
 * @param raw env string (or undefined)
 * @param totalRows total records per scenario (default TOTAL_RECORDS)
 * @returns `{ status: "valid", tabCounts }` or
 *   `{ status: "invalid", code, reason }`
 */
export function parseOptionalTabCounts(raw, totalRows = TOTAL_RECORDS) {
  if (raw === undefined || raw === null) {
    return { status: "valid", tabCounts: [...DEFAULT_TAB_COUNTS] };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      status: "invalid",
      code: "empty",
      reason: "DIRECT_BATCH_TAB_COUNTS must be a comma-separated list of positive integers",
    };
  }
  const tokens = trimmed.split(",").map((part) => part.trim()).filter((token) => token !== "");
  if (tokens.length === 0) {
    return {
      status: "invalid",
      code: "empty",
      reason: "DIRECT_BATCH_TAB_COUNTS must be a comma-separated list of positive integers",
    };
  }
  const values = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      return {
        status: "invalid",
        code: "non_integer",
        reason: `tab count '${token}' is not a positive integer`,
      };
    }
    const value = Number(token);
    // A rounded value above 2^53 is never a safe integer, so this rejects
    // counts above Number.MAX_SAFE_INTEGER before any distribution planning.
    if (!Number.isSafeInteger(value)) {
      return {
        status: "invalid",
        code: "unsafe_integer",
        reason: `tab count '${token}' must be a safe integer <= Number.MAX_SAFE_INTEGER`,
      };
    }
    if (value <= 0) {
      return {
        status: "invalid",
        code: "non_positive",
        reason: `tab count '${token}' must be positive`,
      };
    }
    if (totalRows % value !== 0) {
      return {
        status: "invalid",
        code: "rows_not_divisible",
        reason: `${totalRows} records cannot be split evenly across ${value} tabs`,
      };
    }
    values.push(value);
  }
  return { status: "valid", tabCounts: values };
}

/**
 * Creates a deterministic seeded PRNG (mulberry32) and a Fisher–Yates
 * shuffle built on it.
 *
 * The same seed always produces the same permutation, so the benchmark's
 * scenario order is reproducible without using uncontrolled randomness.
 *
 * @param seed unsigned 32-bit integer
 * @returns `(items) => shuffled copy`
 */
export function createSeededShuffle(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (items) => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
}

/**
 * Plans the scenario execution order as a deterministic seeded permutation
 * of every (tabCount, api) pair.
 *
 * A fixed ascending tab-count order would systematically put every
 * `updateCells` scenario before every `valuesBatchUpdate` scenario (and
 * small tab counts before large ones), which can bias the comparison through
 * quota drift and backend warm-up. The seeded shuffle removes that
 * fixed-order bias while staying fully reproducible: the seed and the exact
 * order are recorded in the artifact. Request concurrency stays 1 — this
 * changes only the sequence, never parallelism.
 *
 * @param options tabCounts (validated positive integers), seed (default
 *   DEFAULT_SCENARIO_SEED)
 * @returns `{ seed, order }` where order is `{ api, tabCount }` pairs
 */
export function planScenarioOrder({ tabCounts, seed = DEFAULT_SCENARIO_SEED }) {
  const shuffle = createSeededShuffle(seed);
  const scenarios = [];
  for (const tabCount of tabCounts) {
    for (const api of BATCH_WRITE_APIS) {
      scenarios.push({ api, tabCount });
    }
  }
  return { seed, order: shuffle(scenarios) };
}

/**
 * Parses the optional DIRECT_BATCH_SEED environment variable as an unsigned
 * 32-bit integer (the mulberry32 state space).
 *
 * Absent/blank values fall back to `fallback`; present values must be
 * decimal digits, a safe integer, and <= 0xffffffff. Values outside the
 * 32-bit state space or above Number.MAX_SAFE_INTEGER are clear
 * configuration errors instead of a silently wrapped seed.
 *
 * @returns `{ status: "valid", value }` or
 *   `{ status: "invalid", key, code, reason }`
 */
export function parseSeedEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { status: "valid", value: fallback };
  }
  const token = raw.trim();
  if (!/^\d+$/.test(token)) {
    return {
      status: "invalid",
      key,
      code: "non_integer",
      reason: `${key} must be a non-negative integer (got '${token}')`,
    };
  }
  const value = Number(token);
  if (!Number.isSafeInteger(value) || value > 0xffffffff) {
    return {
      status: "invalid",
      key,
      code: "unsafe_integer",
      reason: `${key} must be a safe integer <= 4294967295 (got '${token}')`,
    };
  }
  return { status: "valid", value };
}
