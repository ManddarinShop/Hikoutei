/**
 * Pure helpers for the Direct Sheets API service-account benchmark.
 *
 * This module has no network side effects and never touches live credentials
 * beyond reading the service-account JSON file during environment validation.
 * It is imported by:
 *   - scripts/bench/direct-sheets-api-service-account.mjs (the live benchmark)
 *   - test/direct-sheets-api-bench-common.test.ts (credential-free unit tests)
 *
 * Safety contract: no helper here ever returns, prints, or serializes
 * credential values (client_email, private_key, tokens) or the spreadsheet ID.
 * Validation results carry only status codes and generic reasons.
 */
import { readFileSync as nodeReadFileSync } from "node:fs";

/** Environment keys required by the benchmark command. */
export const BENCH_ENV_KEYS = Object.freeze([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_SHEETS_TEST_SPREADSHEET_ID",
]);

/** Column header row written once per generated tab. */
export const BENCH_HEADERS = Object.freeze(["bench_key", "seq", "payload"]);

/** Spreadsheet IDs are base64url-ish tokens; URLs and whitespace are rejected. */
const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{4,200}$/;

/**
 * Validates the benchmark environment without logging any secret values.
 *
 * Checks that both env keys are present and non-empty, that the credentials
 * file exists, parses as JSON, and looks like a service-account key file
 * (client_email and private_key present), and that the spreadsheet ID has a
 * plausible ID shape. The returned config carries only the credentials path
 * and the spreadsheet ID; parsed credential contents are discarded.
 *
 * @param env process environment (string values)
 * @param readFileSync injected file reader for tests (defaults to node:fs)
 * @returns `{ status: "valid", config }` or `{ status: "invalid", errors }`
 */
export function validateBenchmarkEnv(env, readFileSync = (path) => nodeReadFileSync(path, "utf8")) {
  const errors = [];
  for (const key of BENCH_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || value === null) {
      errors.push({ key, code: "missing", reason: `${key} is not set` });
    } else if (value.trim() === "") {
      errors.push({ key, code: "empty", reason: `${key} is empty` });
    }
  }
  if (errors.length > 0) {
    return { status: "invalid", errors };
  }

  const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS;
  const spreadsheetId = env.GOOGLE_SHEETS_TEST_SPREADSHEET_ID;

  let raw;
  try {
    raw = readFileSync(credentialsPath);
  } catch (error) {
    return {
      status: "invalid",
      errors: [
        ...errors,
        {
          key: "GOOGLE_APPLICATION_CREDENTIALS",
          code: "credentials_file_not_readable",
          reason: `credentials file cannot be read (${error?.code ?? "unknown error"})`,
        },
      ],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      status: "invalid",
      errors: [
        ...errors,
        {
          key: "GOOGLE_APPLICATION_CREDENTIALS",
          code: "credentials_invalid_json",
          reason: "credentials file is not valid JSON",
        },
      ],
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "invalid",
      errors: [
        ...errors,
        {
          key: "GOOGLE_APPLICATION_CREDENTIALS",
          code: "credentials_invalid_json",
          reason: "credentials file JSON root must be an object",
        },
      ],
    };
  }
  if (parsed.type !== undefined && parsed.type !== "service_account") {
    return {
      status: "invalid",
      errors: [
        ...errors,
        {
          key: "GOOGLE_APPLICATION_CREDENTIALS",
          code: "credentials_not_service_account",
          reason: "credentials file type is not service_account",
        },
      ],
    };
  }
  if (typeof parsed.client_email !== "string" || parsed.client_email === "") {
    return {
      status: "invalid",
      errors: [
        ...errors,
        {
          key: "GOOGLE_APPLICATION_CREDENTIALS",
          code: "credentials_missing_client_email",
          reason: "credentials file has no client_email",
        },
      ],
    };
  }
  if (typeof parsed.private_key !== "string" || parsed.private_key === "") {
    return {
      status: "invalid",
      errors: [
        ...errors,
        {
          key: "GOOGLE_APPLICATION_CREDENTIALS",
          code: "credentials_missing_private_key",
          reason: "credentials file has no private_key",
        },
      ],
    };
  }
  if (!SPREADSHEET_ID_PATTERN.test(spreadsheetId)) {
    return {
      status: "invalid",
      errors: [
        ...errors,
        {
          key: "GOOGLE_SHEETS_TEST_SPREADSHEET_ID",
          code: "spreadsheet_id_invalid",
          reason: "spreadsheet ID must be a plain ID token (no URL, no whitespace)",
        },
      ],
    };
  }

  return { status: "valid", config: { credentialsPath, spreadsheetId } };
}

/**
 * Builds a deterministic batch of benchmark rows for a run/cell.
 *
 * Every cell value is a string so RAW round-trips through the Sheets API are
 * byte-stable. Keys are unique per (runId, cellId, seq) and sorted by seq.
 *
 * @param options runId, cellId, startSeq (inclusive), count of rows
 * @returns rows of `[bench_key, seq, payload]`
 */
export function buildRows({ runId, cellId, startSeq, count }) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const seq = startSeq + i;
    const padded = String(seq).padStart(6, "0");
    rows.push([`dir-${runId}-${cellId}-${padded}`, padded, `payload-${padded}`]);
  }
  return rows;
}

/**
 * Nearest-rank percentile over an ascending-sorted sample array.
 * Returns 0 for empty samples; clamps the rank to the array bounds.
 */
export function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.max(0, Math.min(sortedAscending.length - 1, Math.ceil((p / 100) * sortedAscending.length) - 1));
  return sortedAscending[rank];
}

/**
 * Summarizes request latencies in milliseconds: p50/p95/p99, max, mean, min.
 * Empty input yields an all-zero summary (count 0).
 */
export function summarizeLatencies(samples) {
  const count = samples.length;
  if (count === 0) {
    return { count: 0, sumMs: 0, meanMs: 0, minMs: 0, maxMs: 0, p50: 0, p95: 0, p99: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sumMs = samples.reduce((acc, sample) => acc + sample, 0);
  return {
    count,
    sumMs,
    meanMs: sumMs / count,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/**
 * Classifies an unknown error into a stable machine-readable class.
 *
 * Handles GaxiosError-like shapes ({ code, response: { status } }) and
 * Node network/timeout error codes. Only the class and a short code are ever
 * derived; error messages and request configs are never returned or logged.
 */
export function classifyError(error) {
  if (error === null || error === undefined || typeof error !== "object") {
    return { class: "other", code: null };
  }
  const err = error;
  const code =
    typeof err.code === "number" || typeof err.code === "string" ? String(err.code) : null;
  const responseStatus =
    err.response !== null && typeof err.response === "object"
      ? Number(err.response.status)
      : Number.NaN;
  const httpStatus = Number.isInteger(responseStatus)
    ? responseStatus
    : code !== null && /^\d{3}$/.test(code)
      ? Number(code)
      : null;
  const message = typeof err.message === "string" ? err.message : "";

  if (httpStatus !== null) {
    if (httpStatus === 429) return { class: "rate_limited", code: String(httpStatus) };
    if (httpStatus === 401) return { class: "auth", code: String(httpStatus) };
    if (httpStatus === 403) return { class: "permission", code: String(httpStatus) };
    if (httpStatus === 408) return { class: "timeout", code: String(httpStatus) };
    if (httpStatus >= 500) return { class: "server_error", code: String(httpStatus) };
    if (httpStatus === 400) return { class: "bad_request", code: String(httpStatus) };
    if (httpStatus === 404) return { class: "not_found", code: String(httpStatus) };
    return { class: "other", code: String(httpStatus) };
  }

  const upperCode = (code ?? "").toUpperCase();
  if (/TIMEOUT|TIMEDOUT|DEADLINE|ABORTED/.test(upperCode) || /timeout|timed out|deadline exceeded/i.test(message)) {
    return { class: "timeout", code };
  }
  if (
    /^(ECONNRESET|ENETUNREACH|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EPIPE|UND_ERR)/.test(upperCode) ||
    /socket hang up|network|fetch failed|self-signed|certificate/i.test(message)
  ) {
    return { class: "network", code };
  }
  if (/invalid json response|unexpected token|unexpected end of json|malformed/i.test(message)) {
    return { class: "response_format", code };
  }
  return { class: "other", code };
}

/**
 * Counts rows whose leading cell (bench_key) appears more than once.
 * Used for Stage 4 duplicate evidence after a replayed append.
 */
export function countDuplicateKeys(rows) {
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows) {
    const key = String(Array.isArray(row) ? row[0] : row);
    if (seen.has(key)) {
      duplicates += 1;
    } else {
      seen.add(key);
    }
  }
  return { unique: seen.size, duplicates, total: rows.length };
}

/**
 * Byte-exact comparison of read-back rows against expected benchmark rows.
 * Keys are the first cell; a row counts as matched only if every cell is
 * string-equal. `compared` counts actual rows examined (matched + mismatched
 * + extra); `missing` counts expected keys that were never found.
 */
export function compareRows(expected, actual) {
  const remainingExpected = new Map(expected.map((row) => [row[0], row]));
  let matched = 0;
  let mismatched = 0;
  let extra = 0;
  const actualRows = Array.isArray(actual) ? actual : [];
  for (const row of actualRows) {
    if (!Array.isArray(row) || row.length < 1) {
      mismatched += 1;
      continue;
    }
    const key = String(row[0]);
    const expectedRow = remainingExpected.get(key);
    if (expectedRow === undefined) {
      extra += 1;
      continue;
    }
    const same =
      expectedRow.length === row.length &&
      expectedRow.every((cell, index) => String(row[index]) === cell);
    remainingExpected.delete(key);
    if (same) {
      matched += 1;
    } else {
      mismatched += 1;
    }
  }
  return {
    compared: matched + mismatched + extra,
    matched,
    mismatched,
    missing: remainingExpected.size,
    extra,
  };
}

/**
 * Classifies a values.append response's `updates.updatedRows` against the
 * payload row count. A 2xx response is not a successful append unless
 * updatedRows is an integer equal to the expected count; missing,
 * non-integer, or wrong values are response-format anomalies with a stable
 * code and never count as successful appends.
 *
 * @param updatedRows raw `updates.updatedRows` from the API response
 * @param expectedRows rows sent in the payload
 * @returns `{ status: "ok", rowsAppended }` or
 *   `{ status: "anomaly", class, code, rowsAppended }` where rowsAppended
 *   carries the validated integer count when one was reported
 */
export function classifyAppendResponse(updatedRows, expectedRows) {
  if (!Number.isInteger(updatedRows)) {
    return {
      status: "anomaly",
      class: "response_format",
      code: updatedRows === undefined || updatedRows === null ? "missing_updatedRows" : "non_integer_updatedRows",
      rowsAppended: 0,
    };
  }
  if (updatedRows !== expectedRows) {
    return { status: "anomaly", class: "response_format", code: "wrong_updatedRows", rowsAppended: updatedRows };
  }
  return { status: "ok", rowsAppended: updatedRows };
}

/**
 * Evidence analysis for a partial key-range read under concurrent appends.
 *
 * Physical row order is not guaranteed while values.append calls overlap, so
 * this never assumes the first rows belong to the first request indices.
 * Observed rows are validated only as well-formed (3 string cells) and known
 * (key present in expectedAll); `missing` counts expected-window keys that
 * were not observed, and `extra` counts known rows whose keys fall outside
 * the expected window — both are interleaving evidence, not failures.
 *
 * @param options expectedAll (all expected rows for the cell), expectedWindow
 *   (rows expected inside the read window), actual (rows read back)
 * @returns observed/wellFormed/malformed/known/unknownKeys/extra/missing counts
 */
export function analyzeWindowRows({ expectedAll, expectedWindow, actual }) {
  const knownKeys = new Set(expectedAll.map((row) => row[0]));
  const windowKeys = new Set(expectedWindow.map((row) => row[0]));
  const observedRows = Array.isArray(actual) ? actual : [];
  const observedWindowKeys = new Set();
  let wellFormed = 0;
  let malformed = 0;
  let known = 0;
  let unknownKeys = 0;
  let extra = 0;
  for (const row of observedRows) {
    if (!Array.isArray(row) || row.length !== 3 || !row.every((cell) => typeof cell === "string")) {
      malformed += 1;
      continue;
    }
    wellFormed += 1;
    const key = String(row[0]);
    if (!knownKeys.has(key)) {
      unknownKeys += 1;
      continue;
    }
    known += 1;
    if (windowKeys.has(key)) {
      observedWindowKeys.add(key);
    } else {
      extra += 1;
    }
  }
  return {
    observed: observedRows.length,
    wellFormed,
    malformed,
    known,
    unknownKeys,
    extra,
    missing: windowKeys.size - observedWindowKeys.size,
  };
}

/**
 * Aggregates classified error entries into per-class counts.
 */
export function aggregateErrorClasses(classified) {
  const counts = {};
  for (const entry of classified) {
    const key = entry.class;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
