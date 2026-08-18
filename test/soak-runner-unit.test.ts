/**
 * Focused unit tests for the soak-runner's exported pure/helper behavior.
 *
 * This file is the NON-FEATURE companion to `soak-runner.test.ts`. The
 * original end-to-end soak test exercises the full runtime loop (sync
 * bootstrap, System_State readiness, live convergence, resume replay), so
 * it lives apart and is feature/stack dependent. This file intentionally
 * tests ONLY exported pure and helper functions that are deterministic
 * functions of their arguments or that use local fakes only. It never
 * imports `SyncServiceBootstrap`, `systemStateReadiness`,
 * `StubSheetsTransport`, any provider API, or `createTypedSheets`, so the
 * non-feature PR stack stays clean.
 *
 * Covered surface: the deadline clock, safe-epoch validation, spreadsheet
 * URL id parsing, projection id extraction (including durable tombstone
 * accounting), the resume recovery planner, stable error tags, redacted CLI
 * diagnostics, and the redaction allowlist walkers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundedSleep,
  deadlineRemainingMs,
  extractProjectionIds,
  isExpectedPlainNodeTsLoaderFailure,
  isSafeEpochTimestampMs,
  parseSpreadsheetIdFromUrl,
  planResumeRecovery,
  RECOVERY_REASONS,
  resolveSystemStateReadinessReader,
  shouldFallBackToDistOnSourceFailure,
  stableErrorTag,
} from "../scripts/ci/local-soak/runner.mjs";
import {
  cleanupLiveEnvMissingReason,
  describeSoakFailure,
} from "../scripts/ci/run-local-multitable-soak.mjs";
import {
  EXPECTED_ERROR_CODES,
  FAILURE_REASON_CODES,
  KNOWN_ENTITY_NAMES,
  KNOWN_STABLE_CLASSES,
  KNOWN_STABLE_CODES,
  KNOWN_TABLE_NAMES,
  sanitizeCounts,
  sanitizeErrorClass,
  sanitizeReason,
  sanitizeRecordFields,
  sanitizeStableCode,
  sanitizeStatusClass,
  sanitizeTableName,
} from "../scripts/ci/local-soak/redact.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("soak runner deadline clock", () => {
  it("deadlineRemainingMs clamps at zero once the deadline has passed", () => {
    const now = 1_000_000;
    expect(deadlineRemainingMs(now + 5_000, now)).toBe(5_000);
    expect(deadlineRemainingMs(now + 250, now)).toBe(250);
    expect(deadlineRemainingMs(now, now)).toBe(0);
    expect(deadlineRemainingMs(now - 1, now)).toBe(0);
    expect(deadlineRemainingMs(now - 10_000, now)).toBe(0);
  });

  it("deadlineRemainingMs falls back to the real clock when nowMs is omitted", () => {
    const before = Date.now();
    const remaining = deadlineRemainingMs(Date.now() + 60_000);
    const after = Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60_000);
    // The result must be consistent with a wall-clock around [before, after].
    expect(remaining).toBeGreaterThanOrEqual(0);
    void before;
    void after;
  });

  it("boundedSleep resolves at the deadline when the poll outlives the budget", async () => {
    const startedAt = Date.now();
    await boundedSleep(5_000, startedAt + 120, startedAt);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(110);
    expect(elapsed).toBeLessThan(1_000); // far under the 5s poll
  });

  it("boundedSleep resolves immediately once the deadline is already passed", async () => {
    const startedAt = Date.now();
    await boundedSleep(5_000, startedAt - 1, startedAt);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThan(200);
  });
});

describe("soak runner safe epoch timestamps", () => {
  it("accepts only finite timestamps inside the ISO date range", () => {
    expect(isSafeEpochTimestampMs(Date.now())).toBe(true);
    expect(isSafeEpochTimestampMs(0)).toBe(true);
    expect(isSafeEpochTimestampMs(-8_640_000_000_000_000)).toBe(true);
    expect(isSafeEpochTimestampMs(8_640_000_000_000_000)).toBe(true);
  });

  it("rejects timestamps outside the ISO renderable range", () => {
    expect(isSafeEpochTimestampMs(8_640_000_000_000_001)).toBe(false);
    expect(isSafeEpochTimestampMs(-8_640_000_000_000_001)).toBe(false);
  });

  it("rejects non-finite and non-number values", () => {
    expect(isSafeEpochTimestampMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeEpochTimestampMs(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isSafeEpochTimestampMs(Number.NaN)).toBe(false);
    expect(isSafeEpochTimestampMs("now")).toBe(false);
    expect(isSafeEpochTimestampMs(null)).toBe(false);
    expect(isSafeEpochTimestampMs(undefined)).toBe(false);
    expect(isSafeEpochTimestampMs({})).toBe(false);
  });

  it("renders every accepted boundary with toISOString without throwing", () => {
    for (const value of [0, 8_640_000_000_000_000, -8_640_000_000_000_000, Date.now()]) {
      expect(() => new Date(value).toISOString()).not.toThrow();
      expect(isSafeEpochTimestampMs(value)).toBe(true);
    }
  });
});

describe("soak runner spreadsheet URL id parsing", () => {
  it("extracts an id from the documented google docs layout", () => {
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/AbC123_xyz/edit",
    )).toBe("AbC123_xyz");
    expect(parseSpreadsheetIdFromUrl(
      "docs.google.com/spreadsheets/d/AbC123_xyz",
    )).toBe("AbC123_xyz");
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/AbC123_xyz/edit/",
    )).toBe("AbC123_xyz");
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/AbC123_xyz/",
    )).toBe("AbC123_xyz");
  });

  it("accepts only the top-level /d/<ID> fallback layout on the documented host", () => {
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/d/AbC_123")).toBe("AbC_123");
  });

  it("strips query and fragment before parsing", () => {
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/AbC123_xyz/edit?tab=t.0#gid=5",
    )).toBe("AbC123_xyz");
  });

  it("rejects foreign hosts, schemes, and malformed ids", () => {
    expect(parseSpreadsheetIdFromUrl("https://evil.example/d/AbC123_xyz")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("http://docs.google.com/spreadsheets/d/AbC")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("ftp://docs.google.com/d/AbC")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("javascript://docs.google.com/d/AbC")).toBeUndefined();
    // Prefix segments and extra suffix segments are refused, not scanned.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/foo/spreadsheets/d/AbC",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/AbC/extra",
    )).toBeUndefined();
    // Invalid spreadsheet-id characters are refused.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/AbC+12/=/edit",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("not-a-url")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(undefined as unknown as string)).toBeUndefined();
  });
});

describe("soak runner projection id extraction", () => {
  it("extracts ids and counts non-empty blank-id rows as extra rows", () => {
    const rows = [
      ["r1", "a"],
      ["", "content-without-id"],
      ["r2", "b"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r1", "r2"]);
    expect(blankIdRows).toBe(1);
  });

  it("ignores fully empty trailing padding rows", () => {
    const rows = [
      ["r1", "a"],
      ["", ""],
      [],
      [null],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r1"]);
    expect(blankIdRows).toBe(0);
  });

  it("treats null and undefined id cells with content as blank-id rows", () => {
    const rows = [
      [null, "x"],
      [undefined, "y"],
      ["r3", "z"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r3"]);
    expect(blankIdRows).toBe(2);
  });

  it("excludes durable tombstone rows from the active id set", () => {
    const rows = [
      ["r1", "a", "FALSE"],
      ["deleted-2", "old", "TRUE"],
      ["r3", "c", "FALSE"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0, 2);
    expect(ids).toEqual(["r1", "r3"]);
    expect(blankIdRows).toBe(0);
  });

  it("treats tombstone displays conservatively: TRUE case-insensitive and boolean true only", () => {
    const rows = [
      ["r1", "a", "true"],
      ["r2", "b", "TRUE"],
      ["r3", "c", true],
      ["r4", "d", "False"],
      ["r5", "e", "yes"],
      ["r6", "f", "1"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0, 2);
    expect(ids).toEqual(["r4", "r5", "r6"]);
    expect(blankIdRows).toBe(0);
  });

  it("counts blank-id content rows as extra even when the tombstone looks set", () => {
    const rows = [
      ["r1", "a", "FALSE"],
      ["", "orphan-content", "TRUE"],
      ["r2", "b", "FALSE"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0, 2);
    expect(ids).toEqual(["r1", "r2"]);
    expect(blankIdRows).toBe(1);
  });

  it("keeps the two-argument behavior when no tombstone column is given", () => {
    const rows = [
      ["r1", "a", "TRUE"],
      ["r2", "b", "FALSE"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r1", "r2"]);
    expect(blankIdRows).toBe(0);
  });
});

describe("soak runner resume recovery planner", () => {
  it("returns undefined when there is no checkpoint or the cycle completed", () => {
    expect(planResumeRecovery(undefined, { lastCompletedCycle: 3 }, new Map())).toBeUndefined();
    expect(planResumeRecovery(
      { version: 1, runId: "r", status: "completed", cycle: 3 },
      { lastCompletedCycle: 3 },
      new Map(),
    )).toBeUndefined();
  });

  it("flags a stale in-flight marker when state already checkpoints the cycle", () => {
    const result = planResumeRecovery(
      { version: 1, runId: "r", status: "in-flight", cycle: 7 },
      { lastCompletedCycle: 7 },
      new Map(),
    );
    expect(result).toEqual({ cycle: 7, reason: RECOVERY_REASONS.STALE_IN_FLIGHT_MARKER });
  });

  it("treats a present cycle record as a completed but uncheckpointed cycle", () => {
    const cycleRecords = new Map([[8, { cycle: 8 }]]);
    const result = planResumeRecovery(
      { version: 1, runId: "r", status: "in-flight", cycle: 8 },
      { lastCompletedCycle: 7 },
      cycleRecords,
    );
    expect(result).toEqual({
      cycle: 8,
      reason: RECOVERY_REASONS.COMPLETED_CYCLE_CHECKPOINT,
    });
  });

  it("reconciles an interrupted cycle with no cycle record", () => {
    const result = planResumeRecovery(
      { version: 1, runId: "r", status: "in-flight", cycle: 8 },
      { lastCompletedCycle: 7 },
      new Map(),
    );
    expect(result).toEqual({
      cycle: 8,
      reason: RECOVERY_REASONS.INTERRUPTED_CYCLE_RECONCILED,
    });
  });

  it("exposes a frozen vocabulary of recovery reasons", () => {
    expect(Object.isFrozen(RECOVERY_REASONS)).toBe(true);
    expect(Object.values(RECOVERY_REASONS)).toEqual([
      "interrupted-cycle-reconciled",
      "completed-cycle-checkpoint",
      "stale-in-flight-marker",
    ]);
  });
});

describe("soak runner stable error tags", () => {
  it("maps raw non-object input to the stable unknown category", () => {
    expect(stableErrorTag(undefined)).toBe("unknown");
    expect(stableErrorTag(null)).toBe("unknown");
    expect(stableErrorTag("boom")).toBe("unknown");
    expect(stableErrorTag(42)).toBe("unknown");
  });

  it("sanitizes custom error class names in progress diagnostics", () => {
    const raw = new Error("boom");
    raw.name = "EvilAt/Users/secret/ya29.jwt";
    expect(stableErrorTag(raw)).toBe("unknown");
    expect(stableErrorTag(new Error("plain"))).toBe("Error");
    expect(stableErrorTag({ name: "SoakReopenCleanupError" })).toBe("SoakReopenCleanupError");
  });

  it("combines an allowlisted code with the class name", () => {
    expect(stableErrorTag({ name: "HikouteiError", code: "sync_startup_failed" }))
      .toBe("HikouteiError (sync_startup_failed)");
    expect(stableErrorTag({ name: "DirectSheetsError", code: "invalid_sync_provisioning" }))
      .toBe("DirectSheetsError (invalid_sync_provisioning)");
  });

  it("collapses an unknown code to the class name only", () => {
    expect(stableErrorTag({ name: "HikouteiError", code: "ya29.jwt-token" }))
      .toBe("HikouteiError");
  });
});

describe("soak runner redacted CLI diagnostics", () => {
  it("maps non-object input to the stable unknown category", () => {
    expect(describeSoakFailure(undefined)).toBe("unknown");
    expect(describeSoakFailure(null)).toBe("unknown");
    expect(describeSoakFailure("boom")).toBe("unknown");
  });

  it("sanitizes custom class names in CLI diagnostics", () => {
    const raw = new Error("boom");
    raw.name = "Error: at /Users/secret/file.ts";
    expect(describeSoakFailure(raw)).toBe("unknown");
    expect(describeSoakFailure(new Error("plain"))).toBe("Error");
  });

  it("prints only allowlisted code or status-class text", () => {
    expect(describeSoakFailure({
      name: "HikouteiError",
      code: "sync_startup_failed",
    })).toBe("HikouteiError (sync_startup_failed)");
    expect(describeSoakFailure({
      name: "DirectSheetsError",
      statusClass: "http_403",
    })).toBe("DirectSheetsError (http_403)");
    expect(describeSoakFailure({
      name: "HikouteiError",
      code: "invalid_query",
    })).toBe("HikouteiError (invalid_query)");
  });

  it("collapses unknown codes and status classes to the class name only", () => {
    expect(describeSoakFailure({
      name: "DirectSheetsError",
      statusClass: "ya29.jwt-token",
    })).toBe("DirectSheetsError");
    expect(describeSoakFailure({
      name: "HikouteiError",
      code: "Bearer eyJhbGciOi",
    })).toBe("HikouteiError");
  });
});

describe("soak runner redaction allowlists", () => {
  it("sanitizeStableCode keeps only known stable codes", () => {
    expect(sanitizeStableCode("invalid_query")).toBe("invalid_query");
    expect(sanitizeStableCode("sync_startup_failed")).toBe("sync_startup_failed");
    expect(sanitizeStableCode("ya29.jwt-token")).toBe("unknown");
    expect(sanitizeStableCode(42)).toBe("unknown");
    expect(sanitizeStableCode(undefined)).toBe("unknown");
  });

  it("sanitizeErrorClass keeps only allowlisted class names", () => {
    expect(sanitizeErrorClass("Error")).toBe("Error");
    expect(sanitizeErrorClass("HikouteiError")).toBe("HikouteiError");
    expect(sanitizeErrorClass("DirectSheetsError")).toBe("DirectSheetsError");
    expect(sanitizeErrorClass("EvilAt/Users/secret")).toBe("unknown");
    expect(sanitizeErrorClass(undefined)).toBe("unknown");
  });

  it("sanitizeStatusClass normalizes http statuses and keeps named classes", () => {
    expect(sanitizeStatusClass("http_403")).toBe("http_403");
    expect(sanitizeStatusClass("http_200")).toBe("http_200");
    expect(sanitizeStatusClass("http_599")).toBe("http_599");
    expect(sanitizeStatusClass("deadline_expired")).toBe("deadline_expired");
    expect(sanitizeStatusClass("network_or_unknown")).toBe("network_or_unknown");
    expect(sanitizeStatusClass("ya29.jwt")).toBe("unknown");
    expect(sanitizeStatusClass("http_99")).toBe("unknown");
    expect(sanitizeStatusClass(undefined)).toBe("unknown");
  });

  it("sanitizeReason keeps only the stable reason vocabulary", () => {
    expect(sanitizeReason("query-mismatch")).toBe("query-mismatch");
    expect(sanitizeReason("unexpected-throw")).toBe("unexpected-throw");
    expect(sanitizeReason("interrupted-cycle-reconciled")).toBe("interrupted-cycle-reconciled");
    expect(sanitizeReason("deadline-expired")).toBe("deadline-expired");
    expect(sanitizeReason("some random reason")).toBe("unknown");
    expect(sanitizeReason(undefined)).toBe("unknown");
  });

  it("sanitizeTableName keeps only soak table and entity names", () => {
    expect(sanitizeTableName("soak_customers")).toBe("soak_customers");
    expect(sanitizeTableName("SoakCustomer")).toBe("SoakCustomer");
    expect(sanitizeTableName("users")).toBe("unknown");
    expect(sanitizeTableName("soak_secret_table")).toBe("unknown");
    expect(sanitizeTableName(undefined)).toBe("unknown");
  });

  it("sanitizeCounts keeps only finite numeric identifier-shaped pairs", () => {
    expect(sanitizeCounts({ added: 3, updated: 0, deleted: 1 }))
      .toEqual({ added: 3, updated: 0, deleted: 1 });
    expect(sanitizeCounts({ total: Number.NaN, extra: "four" })).toBeUndefined();
    expect(sanitizeCounts({ "bad key": 1, x: 2 })).toEqual({ x: 2 });
    expect(sanitizeCounts(null)).toBeUndefined();
    expect(sanitizeCounts([])).toBeUndefined();
    expect(sanitizeCounts({ added: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("sanitizeRecordFields strips free-form text and keeps safe scalars", () => {
    const input = {
      cycle: 7,
      status: "failed",
      code: "invalid_query",
      reason: "query-mismatch",
      table: "soak_customers",
      errorClass: "HikouteiError",
      counts: { added: 3, message: "secret" },
      message: "boom at /Users/secret",
      payload: { secret: "ya29.jwt", nested: { free: "text" } },
      flags: { ok: true },
    };
    const result = sanitizeRecordFields(input);
    expect(result).toEqual({
      cycle: 7,
      status: "failed",
      code: "invalid_query",
      reason: "query-mismatch",
      table: "soak_customers",
      errorClass: "HikouteiError",
      counts: { added: 3 },
      flags: { ok: true },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("boom");
    expect(JSON.stringify(result)).not.toContain("ya29");
  });

  it("sanitizeRecordFields walks arrays and drops unsafe elements", () => {
    const input = {
      history: [
        { cycle: 1, status: "ok" },
        { message: "drop me", id: "AbC-secret" },
        42,
        "free string",
        null,
      ],
    };
    const result = sanitizeRecordFields(input);
    // Array elements that sanitize to an empty object survive as an empty
    // shell (unlike object keys, which drop their empty key); free-form
    // strings and null are removed outright.
    expect(result).toEqual({ history: [{ cycle: 1, status: "ok" }, {}, 42] });
    expect(JSON.stringify(result)).not.toContain("drop me");
    expect(JSON.stringify(result)).not.toContain("AbC-secret");
  });

  it("sanitizeRecordFields drops unknown statuses and table names", () => {
    const result = sanitizeRecordFields({
      status: "provider-RANDOM",
      table: "users",
      scan: "weird-scan",
      counts: { users: 3 },
    });
    expect(result).toEqual({
      status: "unknown",
      table: "unknown",
      scan: "unknown",
      counts: { users: 3 },
    });
  });
});

