/**
 * Credential-free unit coverage for the Direct Sheets API benchmark helpers.
 *
 * These tests exercise environment validation, row serialization, latency
 * metrics, error classification, and comparison helpers only. They never
 * make network calls and never require Google credentials; live API execution
 * is opt-in via scripts/bench/direct-sheets-api-service-account.mjs and is
 * intentionally not part of the default test suite.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BENCH_HEADERS,
  aggregateErrorClasses,
  analyzeWindowRows,
  buildRows,
  classifyAppendResponse,
  classifyError,
  compareRows,
  countDuplicateKeys,
  percentile,
  summarizeLatencies,
  validateBenchmarkEnv,
} from "../scripts/bench/direct-sheets-api-common.mjs";

const ENV_KEYS = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_SHEETS_TEST_SPREADSHEET_ID"] as const;

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: "service_account",
  project_id: "bench-project",
  private_key_id: "key-id",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
  client_email: "bench@example.iam.gserviceaccount.com",
  client_id: "123456789",
});

let tempDir: string | null = null;

function makeCredentialsFile(contents: string): string {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "direct-sheets-api-bench-"));
  const filePath = path.join(tempDir, "service-account.json");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

afterEach(() => {
  if (tempDir !== null) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function envWith(overrides: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): Record<string, string | undefined> {
  return {
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/unused.json",
    GOOGLE_SHEETS_TEST_SPREADSHEET_ID: "abcDEF123-_xyz",
    ...overrides,
  };
}

describe("validateBenchmarkEnv", () => {
  it("reports missing env keys without reading files", () => {
    const result = validateBenchmarkEnv({});
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((error) => error.key).sort()).toEqual([...ENV_KEYS].sort());
    expect(result.errors.map((error) => error.code).sort()).toEqual(["missing", "missing"]);
  });

  it("rejects empty env values", () => {
    const result = validateBenchmarkEnv(envWith({ GOOGLE_SHEETS_TEST_SPREADSHEET_ID: "   " }));
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors).toEqual([
      { key: "GOOGLE_SHEETS_TEST_SPREADSHEET_ID", code: "empty", reason: expect.stringContaining("empty") },
    ]);
  });

  it("rejects an unreadable credentials path", () => {
    const result = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/creds.json" }));
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors[0]!).toMatchObject({
      key: "GOOGLE_APPLICATION_CREDENTIALS",
      code: "credentials_file_not_readable",
    });
  });

  it("rejects non-JSON credentials", () => {
    const filePath = makeCredentialsFile("not json {");
    const result = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: filePath }));
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors[0]?.code).toBe("credentials_invalid_json");
  });

  it("rejects credentials without client_email or private_key", () => {
    const noEmail = makeCredentialsFile(JSON.stringify({ type: "service_account", private_key: "x" }));
    const result = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: noEmail }));
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors[0]?.code).toBe("credentials_missing_client_email");

    const noKey = makeCredentialsFile(JSON.stringify({ type: "service_account", client_email: "a@b.c" }));
    const result2 = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: noKey }));
    expect(result2.status).toBe("invalid");
    if (result2.status !== "invalid") return;
    expect(result2.errors[0]?.code).toBe("credentials_missing_private_key");
  });

  it("rejects a non-service-account type", () => {
    const filePath = makeCredentialsFile(
      JSON.stringify({ type: "authorized_user", client_email: "a@b.c", private_key: "x" })
    );
    const result = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: filePath }));
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.errors[0]?.code).toBe("credentials_not_service_account");
  });

  it("rejects spreadsheet IDs that look like URLs or contain whitespace", () => {
    const filePath = makeCredentialsFile(SERVICE_ACCOUNT_JSON);
    const url = validateBenchmarkEnv(
      envWith({ GOOGLE_APPLICATION_CREDENTIALS: filePath, GOOGLE_SHEETS_TEST_SPREADSHEET_ID: "https://docs.google.com/spreadsheets/d/abc/edit" })
    );
    expect(url.status).toBe("invalid");
    if (url.status !== "invalid") return;
    expect(url.errors[0]?.code).toBe("spreadsheet_id_invalid");

    const spaced = validateBenchmarkEnv(
      envWith({ GOOGLE_APPLICATION_CREDENTIALS: filePath, GOOGLE_SHEETS_TEST_SPREADSHEET_ID: "abc def" })
    );
    expect(spaced.status).toBe("invalid");
  });

  it("returns a valid config without exposing credential contents", () => {
    const filePath = makeCredentialsFile(SERVICE_ACCOUNT_JSON);
    const result = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: filePath }));
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.config).toEqual({ credentialsPath: filePath, spreadsheetId: "abcDEF123-_xyz" });
    expect(Object.keys(result.config).sort()).toEqual(["credentialsPath", "spreadsheetId"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain("bench@example");
  });

  it("accepts files without an explicit type field", () => {
    const filePath = makeCredentialsFile(
      JSON.stringify({ client_email: "a@b.c", private_key: "-----BEGIN PRIVATE KEY-----" })
    );
    const result = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: filePath }));
    expect(result.status).toBe("valid");
  });

  it("reads real files through the default reader", () => {
    const filePath = makeCredentialsFile(SERVICE_ACCOUNT_JSON);
    const result = validateBenchmarkEnv(envWith({ GOOGLE_APPLICATION_CREDENTIALS: filePath }));
    expect(result.status).toBe("valid");
  });
});

describe("buildRows", () => {
  it("is deterministic and produces unique string cells", () => {
    const first = buildRows({ runId: "run-1", cellId: "r10_c2", startSeq: 0, count: 10 });
    const second = buildRows({ runId: "run-1", cellId: "r10_c2", startSeq: 0, count: 10 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toHaveLength(10);
    const keys = new Set(first.map((row) => row[0]));
    expect(keys.size).toBe(10);
    for (const row of first) {
      expect(row).toHaveLength(3);
      expect(row.every((cell) => typeof cell === "string")).toBe(true);
    }
    expect(first[0]).toEqual([expect.stringContaining("r10_c2"), "000000", "payload-000000"]);
    expect(first[9]).toEqual([expect.stringContaining("r10_c2"), "000009", "payload-000009"]);
  });

  it("supports non-zero start sequences without key collisions", () => {
    const rows = buildRows({ runId: "run-1", cellId: "c", startSeq: 20, count: 5 });
    expect(rows[0]?.[1]).toBe("000020");
    expect(rows[4]?.[1]).toBe("000024");
    const keys = new Set(rows.map((row) => row[0]));
    expect(keys.size).toBe(5);
  });

  it("produces no rows for count 0", () => {
    expect(buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 0 })).toEqual([]);
  });

  it("keeps header constants stable", () => {
    expect(BENCH_HEADERS).toEqual(["bench_key", "seq", "payload"]);
  });
});

describe("percentile and summarizeLatencies", () => {
  it("computes nearest-rank percentiles", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile([...samples].sort((a, b) => a - b), 50)).toBe(5);
    expect(percentile([...samples].sort((a, b) => a - b), 95)).toBe(10);
    expect(percentile([...samples].sort((a, b) => a - b), 99)).toBe(10);
    expect(percentile([], 95)).toBe(0);
  });

  it("summarizes known samples with p50/p95/p99/max", () => {
    const summary = summarizeLatencies([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(summary.count).toBe(10);
    expect(summary.meanMs).toBe(550);
    expect(summary.minMs).toBe(100);
    expect(summary.maxMs).toBe(1000);
    expect(summary.p50).toBe(500);
    expect(summary.p95).toBe(1000);
    expect(summary.p99).toBe(1000);
  });

  it("returns an all-zero summary for empty input", () => {
    expect(summarizeLatencies([])).toEqual({
      count: 0, sumMs: 0, meanMs: 0, minMs: 0, maxMs: 0, p50: 0, p95: 0, p99: 0,
    });
  });

  it("handles a single sample", () => {
    const summary = summarizeLatencies([42]);
    expect(summary.p50).toBe(42);
    expect(summary.p95).toBe(42);
    expect(summary.maxMs).toBe(42);
  });
});

describe("classifyError", () => {
  it("classifies HTTP status codes", () => {
    expect(classifyError({ code: 429 }).class).toBe("rate_limited");
    expect(classifyError({ response: { status: 429 } }).class).toBe("rate_limited");
    expect(classifyError({ response: { status: 401 } }).class).toBe("auth");
    expect(classifyError({ response: { status: 403 } }).class).toBe("permission");
    expect(classifyError({ response: { status: 500 } }).class).toBe("server_error");
    expect(classifyError({ response: { status: 503 } }).class).toBe("server_error");
    expect(classifyError({ response: { status: 400 } }).class).toBe("bad_request");
    expect(classifyError({ response: { status: 404 } }).class).toBe("not_found");
    expect(classifyError({ response: { status: 408 } }).class).toBe("timeout");
  });

  it("classifies timeout and network errors", () => {
    expect(classifyError({ code: "ETIMEDOUT" }).class).toBe("timeout");
    expect(classifyError({ message: "timeout of 60000ms exceeded" }).class).toBe("timeout");
    expect(classifyError({ message: "deadline exceeded" }).class).toBe("timeout");
    expect(classifyError({ code: "ECONNRESET" }).class).toBe("network");
    expect(classifyError({ message: "socket hang up" }).class).toBe("network");
    expect(classifyError({ message: "fetch failed" }).class).toBe("network");
  });

  it("classifies malformed response errors", () => {
    expect(classifyError({ message: "invalid json response body at https://sheets.googleapis.com" }).class).toBe("response_format");
    expect(classifyError({ message: "Unexpected token < in JSON" }).class).toBe("response_format");
  });

  it("keeps codes and falls back to other", () => {
    expect(classifyError({ response: { status: 429 } })).toEqual({ class: "rate_limited", code: "429" });
    expect(classifyError({ message: "boom" })).toEqual({ class: "other", code: null });
    expect(classifyError(null)).toEqual({ class: "other", code: null });
    expect(classifyError(undefined)).toEqual({ class: "other", code: null });
    expect(classifyError("string error")).toEqual({ class: "other", code: null });
  });
});

describe("countDuplicateKeys and compareRows", () => {
  it("counts duplicate keys after a replay", () => {
    const payload = buildRows({ runId: "r", cellId: "replay", startSeq: 0, count: 3 });
    const duplicated = [...payload, ...payload];
    const result = countDuplicateKeys(duplicated);
    expect(result).toEqual({ unique: 3, duplicates: 3, total: 6 });
    expect(countDuplicateKeys(payload)).toEqual({ unique: 3, duplicates: 0, total: 3 });
  });

  it("compares expected rows byte-exactly", () => {
    const expected = buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 3 });
    expect(compareRows(expected, expected)).toEqual({ compared: 3, matched: 3, mismatched: 0, missing: 0, extra: 0 });
  });

  it("detects mismatched, missing, and extra rows", () => {
    const expected = buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 3 });
    const first = expected[0]!;
    const second = expected[1]!;
    const actual = [
      [...first],
      [...second, "unexpected-cell"],
      ["dir-r-c-unknown", "999", "payload-999"],
    ];
    const result = compareRows(expected, actual);
    expect(result.matched).toBe(1);
    expect(result.mismatched).toBe(1);
    expect(result.extra).toBe(1);
    expect(result.missing).toBe(1);
  });

  it("treats numeric read-back cells as mismatches (strings expected)", () => {
    const expected = buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 1 });
    const key = expected[0]![0];
    const payload = expected[0]![2];
    const actual = [[key, 5, payload]];
    expect(compareRows(expected, actual).matched).toBe(0);
    expect(compareRows(expected, actual).mismatched).toBe(1);
  });
});

describe("classifyAppendResponse", () => {
  it("accepts an integer updatedRows equal to the payload count", () => {
    expect(classifyAppendResponse(5, 5)).toEqual({ status: "ok", rowsAppended: 5 });
  });

  it("flags missing updatedRows as a response-format anomaly, not an append", () => {
    expect(classifyAppendResponse(undefined, 5)).toEqual({
      status: "anomaly",
      class: "response_format",
      code: "missing_updatedRows",
      rowsAppended: 0,
    });
    expect(classifyAppendResponse(null, 5)).toMatchObject({ status: "anomaly", code: "missing_updatedRows" });
  });

  it("flags non-integer updatedRows as a response-format anomaly", () => {
    expect(classifyAppendResponse("5", 5)).toMatchObject({
      status: "anomaly",
      class: "response_format",
      code: "non_integer_updatedRows",
      rowsAppended: 0,
    });
    expect(classifyAppendResponse(5.5, 5)).toMatchObject({ status: "anomaly", code: "non_integer_updatedRows" });
  });

  it("flags a wrong integer updatedRows as a response-format anomaly", () => {
    expect(classifyAppendResponse(7, 5)).toEqual({
      status: "anomaly",
      class: "response_format",
      code: "wrong_updatedRows",
      rowsAppended: 7,
    });
  });
});

describe("analyzeWindowRows", () => {
  it("validates well-formed known rows regardless of physical order", () => {
    const expectedAll = buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 6 });
    const expectedWindow = expectedAll.slice(0, 3);
    // Concurrent appends may place a later request's rows physically first.
    const actual = [expectedAll[2]!, expectedAll[0]!, expectedAll[4]!, expectedAll[1]!];
    expect(analyzeWindowRows({ expectedAll, expectedWindow, actual })).toEqual({
      observed: 4,
      wellFormed: 4,
      malformed: 0,
      known: 4,
      unknownKeys: 0,
      extra: 1,
      missing: 0,
    });
  });

  it("records missing and extra keys as interleaving evidence, not failures", () => {
    const expectedAll = buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 6 });
    const expectedWindow = expectedAll.slice(0, 3);
    const actual = [expectedAll[4]!, expectedAll[2]!];
    const result = analyzeWindowRows({ expectedAll, expectedWindow, actual });
    expect(result.observed).toBe(2);
    expect(result.known).toBe(2);
    expect(result.extra).toBe(1);
    expect(result.missing).toBe(2);
  });

  it("flags malformed and unknown rows", () => {
    const expectedAll = buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 3 });
    const expectedWindow = expectedAll.slice(0, 2);
    const actual = [
      expectedAll[0]!,
      ["not-a-benchmark-key", "x", "y"],
      [expectedAll[1]![0]!, 5, "payload"],
    ];
    expect(analyzeWindowRows({ expectedAll, expectedWindow, actual })).toEqual({
      observed: 3,
      wellFormed: 2,
      malformed: 1,
      known: 1,
      unknownKeys: 1,
      extra: 0,
      missing: 1,
    });
  });

  it("treats a non-array read as empty evidence", () => {
    const expectedAll = buildRows({ runId: "r", cellId: "c", startSeq: 0, count: 3 });
    const result = analyzeWindowRows({ expectedAll, expectedWindow: expectedAll, actual: undefined });
    expect(result).toMatchObject({ observed: 0, wellFormed: 0, known: 0, missing: 3 });
  });
});

describe("aggregateErrorClasses", () => {
  it("counts per-class occurrences", () => {
    const result = aggregateErrorClasses([
      { class: "rate_limited", code: "429" },
      { class: "rate_limited", code: "429" },
      { class: "server_error", code: "500" },
      { class: "other", code: null },
    ]);
    expect(result).toEqual({ rate_limited: 2, server_error: 1, other: 1 });
    expect(aggregateErrorClasses([])).toEqual({});
  });
});
