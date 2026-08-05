/**
 * Credential-free unit coverage for the Direct Sheets API batch-write
 * benchmark helpers (scripts/bench/direct-sheets-api-batch-update-common.mjs).
 *
 * These tests exercise tab-distribution planning, row serialization, both
 * payload forms (UpdateCellsRequest vs ValueRange), payload size and
 * throughput math, response classification, and optional env parsing only.
 * They never make network calls and never require Google credentials; live
 * API execution is opt-in via
 * scripts/bench/direct-sheets-api-batch-update.mjs and is intentionally not
 * part of the default test suite.
 */
import { describe, expect, it } from "vitest";
import {
  BATCH_WRITE_APIS,
  BENCH_COLUMNS,
  DATA_FIRST_ROW_INDEX,
  DEFAULT_SCENARIO_SEED,
  DEFAULT_TAB_COUNTS,
  TOTAL_RECORDS,
  buildTabRows,
  buildUpdateCellsRequests,
  buildValueRanges,
  classifyAttemptOutcome,
  classifyUpdateCellsReplies,
  classifyValuesBatchUpdateResponse,
  computeThroughput,
  createSeededShuffle,
  evaluateVerifiedTabs,
  measurePayloadBytes,
  parseOptionalTabCounts,
  parsePositiveIntEnv,
  parseSeedEnv,
  planScenarioOrder,
  planTabDistribution,
} from "../scripts/bench/direct-sheets-api-batch-update-common.mjs";

const TAB_COUNTS = [1, 2, 4, 10, 20];

/** Asserts the distribution is valid and returns its tabs. */
function requireValidDistribution(tabCount: number, totalRows = TOTAL_RECORDS) {
  const result = planTabDistribution({ tabCount, totalRows });
  expect(result.status).toBe("valid");
  if (result.status !== "valid") throw new Error("unreachable");
  return result;
}

/** Builds rows for every tab of a distribution, flattened. */
function rowsForDistribution(tabCount: number, runId = "run-1", attemptMarker = "r0") {
  const distribution = requireValidDistribution(tabCount);
  return {
    distribution,
    rowsByTab: distribution.tabs.map((tab) =>
      buildTabRows({
        runId,
        attemptMarker,
        tabIndex: tab.tabIndex,
        rowCount: tab.rowCount,
        startSeq: tab.startSeq,
      })
    ),
  };
}

describe("planTabDistribution", () => {
  it("splits 10,000 records evenly across 1/2/4/10/20 tabs", () => {
    for (const tabCount of TAB_COUNTS) {
      const distribution = requireValidDistribution(tabCount);
      expect(distribution.tabCount).toBe(tabCount);
      expect(distribution.totalRows).toBe(TOTAL_RECORDS);
      expect(distribution.rowsPerTab).toBe(TOTAL_RECORDS / tabCount);
      expect(distribution.tabs).toHaveLength(tabCount);
      expect(distribution.tabs.map((tab) => tab.tabIndex)).toEqual(
        Array.from({ length: tabCount }, (_, index) => index)
      );
      const rowTotal = distribution.tabs.reduce((sum, tab) => sum + tab.rowCount, 0);
      expect(rowTotal).toBe(TOTAL_RECORDS);
      // Cumulative startSeq keeps the global sequence contiguous.
      for (const tab of distribution.tabs) {
        expect(tab.startSeq).toBe(tab.tabIndex * distribution.rowsPerTab);
      }
    }
  });

  it("uses the default total of 10,000 when totalRows is omitted", () => {
    expect(planTabDistribution({ tabCount: 4 }).status).toBe("valid");
  });

  it("rejects non-positive or non-integer tab counts", () => {
    for (const tabCount of [0, -1, 3.5, Number.NaN]) {
      const result = planTabDistribution({ tabCount });
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.reason).toContain("tabCount");
    }
  });

  it("rejects row totals that do not divide evenly", () => {
    for (const totalRows of [0, -100, 3.5, Number.NaN]) {
      expect(planTabDistribution({ tabCount: 4, totalRows }).status).toBe("invalid");
    }
    const uneven = planTabDistribution({ tabCount: 3, totalRows: TOTAL_RECORDS });
    expect(uneven.status).toBe("invalid");
    if (uneven.status !== "invalid") return;
    expect(uneven.reason).toContain("divisible");
  });

  it("rejects unsafe integer tab counts and row totals", () => {
    // 2^53 and anything above Number.MAX_SAFE_INTEGER must never reach
    // Array.from({ length }) or sequence math.
    expect(planTabDistribution({ tabCount: 9007199254740992 }).status).toBe("invalid");
    expect(planTabDistribution({ tabCount: 4, totalRows: 9007199254740992 }).status).toBe("invalid");
  });
});

describe("buildTabRows", () => {
  it("produces 10,000 unique deterministic keys across a 20-tab split", () => {
    const { rowsByTab } = rowsForDistribution(20);
    const flattened = rowsByTab.flat();
    expect(flattened).toHaveLength(TOTAL_RECORDS);
    const keys = new Set(flattened.map((row) => row[0]));
    expect(keys.size).toBe(TOTAL_RECORDS);
    for (const row of flattened) {
      expect(row).toHaveLength(3);
      expect(row.every((cell) => typeof cell === "string")).toBe(true);
    }
  });

  it("is deterministic and keeps the global sequence contiguous", () => {
    const first = rowsForDistribution(4, "run-x");
    const second = rowsForDistribution(4, "run-x");
    expect(JSON.stringify(first.rowsByTab)).toBe(JSON.stringify(second.rowsByTab));
    const flattened = first.rowsByTab.flat();
    expect(flattened[0]?.[1]).toBe("000000");
    expect(flattened[flattened.length - 1]?.[1]).toBe("009999");
  });

  it("derives tab identity from the tabIndex cellId", () => {
    const { rowsByTab } = rowsForDistribution(2);
    expect(rowsByTab[0]?.[0]?.[0]).toContain("-tab0-");
    expect(rowsByTab[1]?.[0]?.[0]).toContain("-tab1-");
  });

  it("gives every attempt its own disjoint deterministic key set", () => {
    // Stale-data protection: warm-up w0, measured r0 and r1 must all write
    // DIFFERENT keys into the same ranges, so verification against the
    // current attempt's keys can never be satisfied by an earlier attempt's
    // leftover data.
    const { rowsByTab: w0 } = rowsForDistribution(2, "run-a", "w0");
    const { rowsByTab: r0 } = rowsForDistribution(2, "run-a", "r0");
    const { rowsByTab: r1 } = rowsForDistribution(2, "run-a", "r1");
    const keys = (rows: (readonly string[])[][]) => new Set(rows.flat().map((row) => row[0]));
    const w0Keys = keys(w0);
    const r0Keys = keys(r0);
    const r1Keys = keys(r1);
    expect(w0Keys.size).toBe(TOTAL_RECORDS);
    expect(r0Keys.size).toBe(TOTAL_RECORDS);
    expect(r1Keys.size).toBe(TOTAL_RECORDS);
    expect([...w0Keys].some((key) => r0Keys.has(key))).toBe(false);
    expect([...r0Keys].some((key) => r1Keys.has(key))).toBe(false);
    // The same attempt marker is deterministic.
    expect(JSON.stringify(r0)).toBe(JSON.stringify(rowsForDistribution(2, "run-a", "r0").rowsByTab));
    expect(r0[0]?.[0]?.[0]).toContain("-ar0-");
  });
});

describe("both payload forms describe the same dataset", () => {
  it("matches flattened UpdateCellsRequest values to the source rows", () => {
    for (const tabCount of TAB_COUNTS) {
      const { distribution, rowsByTab } = rowsForDistribution(tabCount);
      const requests = buildUpdateCellsRequests({
        tabs: distribution.tabs.map((tab, index) => ({
          sheetId: 100 + tab.tabIndex,
          rows: rowsByTab[index]!,
        })),
      });
      expect(requests).toHaveLength(tabCount);
      const flattened = requests.flatMap((request) =>
        request.updateCells.rows.map((row) =>
          row.values.map((cell) => cell.userEnteredValue.stringValue)
        )
      );
      expect(flattened).toEqual(rowsByTab.flat());
    }
  });

  it("matches flattened ValueRange values to the source rows", () => {
    for (const tabCount of TAB_COUNTS) {
      const { distribution, rowsByTab } = rowsForDistribution(tabCount);
      const ranges = buildValueRanges({
        tabs: distribution.tabs.map((tab, index) => ({
          title: `Tab${tab.tabIndex}`,
          rows: rowsByTab[index]!,
        })),
      });
      expect(ranges).toHaveLength(tabCount);
      expect(ranges.flatMap((range) => range.values)).toEqual(rowsByTab.flat());
    }
  });

  it("produces identical cell totals in both forms", () => {
    for (const tabCount of TAB_COUNTS) {
      const { distribution, rowsByTab } = rowsForDistribution(tabCount);
      const requests = buildUpdateCellsRequests({
        tabs: distribution.tabs.map((tab, index) => ({
          sheetId: 100 + tab.tabIndex,
          rows: rowsByTab[index]!,
        })),
      });
      const ranges = buildValueRanges({
        tabs: distribution.tabs.map((tab, index) => ({
          title: `Tab${tab.tabIndex}`,
          rows: rowsByTab[index]!,
        })),
      });
      const cellsInRequests = requests.reduce(
        (sum, request) => sum + request.updateCells.rows.length * BENCH_COLUMNS,
        0
      );
      const cellsInRanges = ranges.reduce(
        (sum, range) => sum + range.values.length * BENCH_COLUMNS,
        0
      );
      expect(cellsInRequests).toBe(TOTAL_RECORDS * BENCH_COLUMNS);
      expect(cellsInRanges).toBe(TOTAL_RECORDS * BENCH_COLUMNS);
    }
  });

  it("writes only userEnteredValue.stringValue with a minimal fields mask", () => {
    const { distribution, rowsByTab } = rowsForDistribution(1);
    const requests = buildUpdateCellsRequests({
      tabs: distribution.tabs.map((tab, index) => ({
        sheetId: 42,
        rows: rowsByTab[index]!,
      })),
    });
    const request = requests[0]!;
    expect(request.updateCells.fields).toBe("userEnteredValue");
    expect(request.updateCells.start).toEqual({
      sheetId: 42,
      rowIndex: DATA_FIRST_ROW_INDEX,
      columnIndex: 0,
    });
    for (const row of request.updateCells.rows) {
      for (const cell of row.values) {
        expect(Object.keys(cell)).toEqual(["userEnteredValue"]);
        expect(Object.keys(cell.userEnteredValue)).toEqual(["stringValue"]);
      }
    }
  });

  it("rejects tabs without a string title", () => {
    expect(() =>
      buildValueRanges({ tabs: [{ title: null as unknown as string, rows: [] }] })
    ).toThrow(/non-empty string title/);
    expect(() =>
      buildValueRanges({ tabs: [{ title: "", rows: [] }] })
    ).toThrow(/non-empty string title/);
  });

  it("produces ranges and row counts that match the payload", () => {
    const { distribution, rowsByTab } = rowsForDistribution(4);
    const ranges = buildValueRanges({
      tabs: distribution.tabs.map((tab, index) => ({
        title: `Tab${tab.tabIndex}`,
        rows: rowsByTab[index]!,
      })),
    });
    ranges.forEach((range, index) => {
      expect(range.range).toBe(`Tab${index}!A2:C${distribution.rowsPerTab + 1}`);
      expect(range.values).toHaveLength(distribution.rowsPerTab);
      expect(range.values[0]).toHaveLength(BENCH_COLUMNS);
    });
  });
});

describe("single-write-request construction", () => {
  it("builds exactly one request entry per tab for both paths", () => {
    for (const tabCount of TAB_COUNTS) {
      const { distribution, rowsByTab } = rowsForDistribution(tabCount);
      const requests = buildUpdateCellsRequests({
        tabs: distribution.tabs.map((tab, index) => ({
          sheetId: 100 + tab.tabIndex,
          rows: rowsByTab[index]!,
        })),
      });
      const ranges = buildValueRanges({
        tabs: distribution.tabs.map((tab, index) => ({
          title: `Tab${tab.tabIndex}`,
          rows: rowsByTab[index]!,
        })),
      });
      // One HTTP request body per scenario: a single `requests` array for
      // spreadsheets.batchUpdate and a single `data` array for
      // spreadsheets.values.batchUpdate, each with one entry per tab.
      expect(requests).toHaveLength(tabCount);
      expect(ranges).toHaveLength(tabCount);
    }
  });

  it("keeps the two API identifiers stable", () => {
    expect(BATCH_WRITE_APIS).toEqual(["updateCells", "valuesBatchUpdate"]);
  });
});

describe("measurePayloadBytes", () => {
  it("counts ASCII bytes exactly", () => {
    expect(measurePayloadBytes({ a: "b" })).toBe(9); // {"a":"b"}
    expect(measurePayloadBytes([])).toBe(2); // []
  });

  it("counts UTF-8 bytes, not characters", () => {
    // {"a":"가"} is 9 characters but 11 UTF-8 bytes (가 is 3 bytes).
    expect(measurePayloadBytes({ a: "가" })).toBe(11);
  });

  it("scales with dataset size", () => {
    const { rowsByTab } = rowsForDistribution(1);
    const body = {
      requests: buildUpdateCellsRequests({ tabs: [{ sheetId: 1, rows: rowsByTab[0]! }] }),
    };
    const bytes = measurePayloadBytes(body);
    expect(bytes).toBeGreaterThan(TOTAL_RECORDS * 20); // ~20+ bytes per row
  });
});

describe("computeThroughput", () => {
  it("computes rows/s and cells/s from duration", () => {
    expect(computeThroughput({ rows: TOTAL_RECORDS, durationMs: 10_000 })).toEqual({
      rowsPerSecond: 1000,
      cellsPerSecond: 3000,
    });
    expect(computeThroughput({ rows: TOTAL_RECORDS, durationMs: 2_000 })).toEqual({
      rowsPerSecond: 5000,
      cellsPerSecond: 15_000,
    });
  });

  it("yields zeros for empty or non-positive input", () => {
    expect(computeThroughput({ rows: 0, durationMs: 1000 })).toEqual({
      rowsPerSecond: 0,
      cellsPerSecond: 0,
    });
    expect(computeThroughput({ rows: TOTAL_RECORDS, durationMs: 0 })).toEqual({
      rowsPerSecond: 0,
      cellsPerSecond: 0,
    });
    expect(computeThroughput({ rows: -5, durationMs: -1 })).toEqual({
      rowsPerSecond: 0,
      cellsPerSecond: 0,
    });
  });
});

describe("classifyValuesBatchUpdateResponse", () => {
  it("accepts integer counts matching the payload", () => {
    expect(classifyValuesBatchUpdateResponse(TOTAL_RECORDS, TOTAL_RECORDS * BENCH_COLUMNS, TOTAL_RECORDS)).toEqual({
      status: "ok",
      rowsUpdated: TOTAL_RECORDS,
      cellsUpdated: TOTAL_RECORDS * BENCH_COLUMNS,
    });
  });

  it("flags missing totalUpdatedRows as a response-format anomaly", () => {
    expect(classifyValuesBatchUpdateResponse(undefined, undefined, TOTAL_RECORDS)).toMatchObject({
      status: "anomaly",
      class: "response_format",
      code: "missing_totalUpdatedRows",
      rowsUpdated: 0,
    });
    expect(classifyValuesBatchUpdateResponse(null, 30_000, TOTAL_RECORDS)).toMatchObject({
      status: "anomaly",
      code: "missing_totalUpdatedRows",
    });
  });

  it("flags non-integer counts as response-format anomalies", () => {
    expect(classifyValuesBatchUpdateResponse("10000", 30_000, TOTAL_RECORDS)).toMatchObject({
      status: "anomaly",
      code: "non_integer_totalUpdatedRows",
    });
    expect(classifyValuesBatchUpdateResponse(TOTAL_RECORDS, 30_000.5, TOTAL_RECORDS)).toMatchObject({
      status: "anomaly",
      code: "non_integer_totalUpdatedCells",
    });
  });

  it("flags wrong integer counts as response-format anomalies", () => {
    expect(classifyValuesBatchUpdateResponse(9999, 29_997, TOTAL_RECORDS)).toMatchObject({
      status: "anomaly",
      code: "wrong_totalUpdatedRows",
    });
    expect(classifyValuesBatchUpdateResponse(TOTAL_RECORDS, 29_999, TOTAL_RECORDS)).toMatchObject({
      status: "anomaly",
      code: "wrong_totalUpdatedCells",
    });
  });
});

describe("classifyUpdateCellsReplies", () => {
  it("accepts a 1:1 reply mapping", () => {
    expect(classifyUpdateCellsReplies([{}, {}, {}], 3)).toEqual({ status: "ok", requestCount: 3 });
  });

  it("flags a missing replies array", () => {
    expect(classifyUpdateCellsReplies(undefined, 3)).toMatchObject({
      status: "anomaly",
      class: "response_format",
      code: "missing_replies",
      requestCount: 0,
    });
  });

  it("flags a wrong reply count", () => {
    expect(classifyUpdateCellsReplies([{}], 3)).toMatchObject({
      status: "anomaly",
      code: "wrong_replies_count",
      requestCount: 1,
    });
  });

  it("flags malformed reply entries", () => {
    expect(classifyUpdateCellsReplies([null, {}], 2)).toMatchObject({
      status: "anomaly",
      code: "malformed_replies",
      requestCount: 2,
    });
  });
});

describe("parsePositiveIntEnv", () => {
  it("falls back when the variable is absent or blank", () => {
    expect(parsePositiveIntEnv({}, "DIRECT_BATCH_WARMUP", 1)).toEqual({ status: "valid", value: 1 });
    expect(parsePositiveIntEnv({ DIRECT_BATCH_WARMUP: "   " }, "DIRECT_BATCH_WARMUP", 1)).toEqual({
      status: "valid",
      value: 1,
    });
  });

  it("parses valid integers", () => {
    expect(parsePositiveIntEnv({ K: "5" }, "K", 1)).toEqual({ status: "valid", value: 5 });
    expect(parsePositiveIntEnv({ K: "0" }, "K", 1)).toEqual({ status: "valid", value: 0 });
  });

  it("classifies non-integer values clearly", () => {
    for (const raw of ["abc", "1.5", "-1", "1,2"]) {
      const result = parsePositiveIntEnv({ K: raw }, "K", 1);
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.key).toBe("K");
      expect(result.code).toBe("non_integer");
    }
  });

  it("enforces the minimum", () => {
    const result = parsePositiveIntEnv({ K: "0" }, "K", 3, { min: 1 });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.code).toBe("below_minimum");
  });

  it("rejects values above Number.MAX_SAFE_INTEGER as unsafe", () => {
    // 9007199254740993 rounds to 2^53, which is not a safe integer.
    const unsafe = parsePositiveIntEnv({ K: "9007199254740993" }, "K", 1);
    expect(unsafe.status).toBe("invalid");
    if (unsafe.status !== "invalid") return;
    expect(unsafe.key).toBe("K");
    expect(unsafe.code).toBe("unsafe_integer");
    // The exact maximum is still accepted.
    expect(parsePositiveIntEnv({ K: "9007199254740991" }, "K", 1)).toEqual({
      status: "valid",
      value: 9007199254740991,
    });
  });
});

describe("parseOptionalTabCounts", () => {
  it("defaults to the 1/2/4/10/20 matrix when absent", () => {
    expect(parseOptionalTabCounts(undefined)).toEqual({
      status: "valid",
      tabCounts: DEFAULT_TAB_COUNTS,
    });
    expect(DEFAULT_TAB_COUNTS).toEqual([1, 2, 4, 10, 20]);
  });

  it("parses a valid subset", () => {
    expect(parseOptionalTabCounts("1, 10, 20")).toEqual({
      status: "valid",
      tabCounts: [1, 10, 20],
    });
  });

  it("rejects an empty list", () => {
    expect(parseOptionalTabCounts("")).toMatchObject({ status: "invalid", code: "empty" });
    expect(parseOptionalTabCounts(" , ")).toMatchObject({ status: "invalid", code: "empty" });
  });

  it("rejects non-integer, non-positive, and uneven counts", () => {
    expect(parseOptionalTabCounts("1,abc")).toMatchObject({
      status: "invalid",
      code: "non_integer",
    });
    expect(parseOptionalTabCounts("1,3")).toMatchObject({
      status: "invalid",
      code: "rows_not_divisible",
    });
    expect(parseOptionalTabCounts("0")).toMatchObject({
      status: "invalid",
      code: "non_positive",
    });
    expect(parseOptionalTabCounts("1.5")).toMatchObject({
      status: "invalid",
      code: "non_integer",
    });
  });

  it("validates against a custom totalRows", () => {
    expect(parseOptionalTabCounts("5", 5000)).toEqual({ status: "valid", tabCounts: [5] });
    expect(parseOptionalTabCounts("3", 5000)).toMatchObject({
      status: "invalid",
      code: "rows_not_divisible",
    });
  });

  it("rejects counts above Number.MAX_SAFE_INTEGER as unsafe", () => {
    expect(parseOptionalTabCounts("9007199254740993")).toMatchObject({
      status: "invalid",
      code: "unsafe_integer",
    });
    expect(parseOptionalTabCounts("1,9007199254740993")).toMatchObject({
      status: "invalid",
      code: "unsafe_integer",
    });
  });
});

describe("evaluateVerifiedTabs", () => {
  it("passes when every expected row is present exactly once", () => {
    const { rowsByTab } = rowsForDistribution(2, "run-1", "r0");
    const result = evaluateVerifiedTabs({
      expectedRowsByTab: rowsByTab,
      actualRowsByTab: rowsByTab.map((rows) => [...rows]),
    });
    expect(result.ok).toBe(true);
    expect(result.tabs).toHaveLength(2);
    for (const tab of result.tabs) {
      expect(tab.ok).toBe(true);
      expect(tab.matched).toBe(TOTAL_RECORDS / 2);
      expect(tab.missing).toBe(0);
      expect(tab.extra).toBe(0);
      expect(tab.duplicates).toBe(0);
    }
  });

  it("fails when stale data from an earlier attempt is still in the ranges", () => {
    // The critical stale-data case: attempt r1's write did not apply (no-op
    // or partial), so the ranges still hold attempt r0's keys. Verification
    // against r1's expected rows must fail with missing + extra — leftover
    // data can never pass the expected-row comparison.
    const { rowsByTab: r0 } = rowsForDistribution(2, "run-1", "r0");
    const { rowsByTab: r1 } = rowsForDistribution(2, "run-1", "r1");
    const result = evaluateVerifiedTabs({
      expectedRowsByTab: r1,
      actualRowsByTab: r0.map((rows) => [...rows]),
    });
    expect(result.ok).toBe(false);
    for (const tab of result.tabs) {
      expect(tab.ok).toBe(false);
      expect(tab.matched).toBe(0);
      expect(tab.missing).toBe(TOTAL_RECORDS / 2);
      expect(tab.extra).toBe(TOTAL_RECORDS / 2);
      expect(tab.duplicates).toBe(0);
    }
  });

  it("fails when an expected key is duplicated in the read-back data", () => {
    const { rowsByTab } = rowsForDistribution(1, "run-1", "r0");
    const duplicated = [...rowsByTab[0]!, rowsByTab[0]![0]!];
    const result = evaluateVerifiedTabs({
      expectedRowsByTab: rowsByTab,
      actualRowsByTab: [duplicated],
    });
    expect(result.ok).toBe(false);
    expect(result.tabs[0]?.duplicates).toBe(1);
    expect(result.tabs[0]?.extra).toBe(1);
  });

  it("fails when a tab read is missing entirely", () => {
    const { rowsByTab } = rowsForDistribution(2, "run-1", "r0");
    const result = evaluateVerifiedTabs({
      expectedRowsByTab: rowsByTab,
      actualRowsByTab: [rowsByTab[0]!],
    });
    expect(result.ok).toBe(false);
    expect(result.tabs[1]?.ok).toBe(false);
    expect(result.tabs[1]?.missing).toBe(TOTAL_RECORDS / 2);
  });
});

describe("classifyAttemptOutcome", () => {
  it("counts a repetition as a success only when response AND verification both pass", () => {
    expect(classifyAttemptOutcome({ responseOk: true, verified: true })).toEqual({
      status: "success",
    });
  });

  it("preserves failed-response-but-verified evidence without calling it a success", () => {
    // A lost-response write that actually applied: the data is proven, but
    // the response was not valid, so it is never a successful benchmark
    // write.
    expect(classifyAttemptOutcome({ responseOk: false, verified: true })).toEqual({
      status: "write_response_failed_but_data_verified",
    });
  });

  it("classifies a valid response with failing verification separately", () => {
    expect(classifyAttemptOutcome({ responseOk: true, verified: false })).toEqual({
      status: "verification_failed",
    });
  });

  it("classifies a failed response with failing verification as write_failed", () => {
    expect(classifyAttemptOutcome({ responseOk: false, verified: false })).toEqual({
      status: "write_failed",
    });
  });
});

describe("scenario order (seeded shuffle)", () => {
  const TAB_COUNTS_FOR_ORDER = [1, 2, 4, 10, 20];

  it("is a deterministic permutation of every (tabCount, api) pair", () => {
    const first = planScenarioOrder({ tabCounts: TAB_COUNTS_FOR_ORDER, seed: DEFAULT_SCENARIO_SEED });
    const second = planScenarioOrder({ tabCounts: TAB_COUNTS_FOR_ORDER, seed: DEFAULT_SCENARIO_SEED });
    expect(first.seed).toBe(DEFAULT_SCENARIO_SEED);
    expect(JSON.stringify(first.order)).toBe(JSON.stringify(second.order));
    expect(first.order).toHaveLength(10);
    const expected = new Set(
      TAB_COUNTS_FOR_ORDER.flatMap((tabCount) =>
        BATCH_WRITE_APIS.map((api) => `${api}@${tabCount}`)
      )
    );
    const actual = new Set(first.order.map((entry) => `${entry.api}@${entry.tabCount}`));
    expect(actual.size).toBe(10);
    expect([...expected].every((key) => actual.has(key))).toBe(true);
  });

  it("changes the order when the seed changes (no fixed-order bias)", () => {
    const defaultSeed = planScenarioOrder({ tabCounts: TAB_COUNTS_FOR_ORDER, seed: DEFAULT_SCENARIO_SEED });
    const otherSeed = planScenarioOrder({ tabCounts: TAB_COUNTS_FOR_ORDER, seed: 1 });
    expect(JSON.stringify(defaultSeed.order)).not.toBe(JSON.stringify(otherSeed.order));
    // Neither order may systematically start with the same api/tabCount.
    expect(defaultSeed.order[0]).not.toEqual(otherSeed.order[0]);
  });

  it("uses the default seed when none is given", () => {
    expect(planScenarioOrder({ tabCounts: TAB_COUNTS_FOR_ORDER }).seed).toBe(DEFAULT_SCENARIO_SEED);
  });

  it("createSeededShuffle never mutates its input", () => {
    const shuffle = createSeededShuffle(42);
    const input = [1, 2, 3, 4, 5];
    const output = shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...output].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("parseSeedEnv", () => {
  it("falls back when the variable is absent or blank", () => {
    expect(parseSeedEnv({}, "DIRECT_BATCH_SEED", 7)).toEqual({ status: "valid", value: 7 });
    expect(parseSeedEnv({ DIRECT_BATCH_SEED: " " }, "DIRECT_BATCH_SEED", 7)).toEqual({
      status: "valid",
      value: 7,
    });
  });

  it("parses a valid 32-bit seed", () => {
    expect(parseSeedEnv({ DIRECT_BATCH_SEED: "20260804" }, "DIRECT_BATCH_SEED", 7)).toEqual({
      status: "valid",
      value: 20260804,
    });
    expect(parseSeedEnv({ DIRECT_BATCH_SEED: "4294967295" }, "DIRECT_BATCH_SEED", 7)).toEqual({
      status: "valid",
      value: 4294967295,
    });
  });

  it("rejects non-integer and out-of-range seeds", () => {
    for (const raw of ["abc", "1.5", "-1"]) {
      const result = parseSeedEnv({ DIRECT_BATCH_SEED: raw }, "DIRECT_BATCH_SEED", 7);
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.code).toBe("non_integer");
    }
    for (const raw of ["4294967296", "9007199254740993"]) {
      const result = parseSeedEnv({ DIRECT_BATCH_SEED: raw }, "DIRECT_BATCH_SEED", 7);
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") return;
      expect(result.code).toBe("unsafe_integer");
    }
  });
});
