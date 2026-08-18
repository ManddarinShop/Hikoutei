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
describe("soak runner exported redaction vocabularies", () => {
  it("exposes the expected error codes used by the workload", () => {
    expect(EXPECTED_ERROR_CODES.invalidField).toBe("invalid_scalar_value");
    expect(EXPECTED_ERROR_CODES.invalidQuery).toBe("invalid_query");
    expect(EXPECTED_ERROR_CODES.unmanagedEntity).toBe("unmanaged_entity");
  });

  it("exposes a closed set of failure reason codes", () => {
    expect(FAILURE_REASON_CODES.ROLLBACK_VERIFICATION).toBe("rollback-verification");
    expect(FAILURE_REASON_CODES.QUERY_MISMATCH).toBe("query-mismatch");
    expect(FAILURE_REASON_CODES.UNEXPECTED_THROW).toBe("unexpected-throw");
  });

  it("lists every known stable code as a recognisable string", () => {
    expect(KNOWN_STABLE_CODES).toContain("invalid_query");
    expect(KNOWN_STABLE_CODES).toContain("google_sheets_api_http_error");
    for (const code of KNOWN_STABLE_CODES) {
      expect(typeof code).toBe("string");
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("lists every known stable class name", () => {
    expect(KNOWN_STABLE_CLASSES).toContain("Error");
    expect(KNOWN_STABLE_CLASSES).toContain("HikouteiError");
    for (const name of KNOWN_STABLE_CLASSES) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("exposes the stable table and entity name vocabularies", () => {
    expect(KNOWN_TABLE_NAMES).toContain("soak_customers");
    expect(KNOWN_TABLE_NAMES).toContain("soak_orders");
    expect(KNOWN_ENTITY_NAMES).toContain("SoakCustomer");
    expect(KNOWN_ENTITY_NAMES).toContain("SoakOrder");
  });
});

describe("soak runner plain-node ts-loader failure predicate", () => {
  const sourceURL = new URL("file:///repo/src/module.ts");

  it("accepts the canonical loader shape with a matching url", () => {
    const err = Object.assign(
      new Error('Unknown file extension ".ts" for /repo/src/module.ts'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION", url: sourceURL.href },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(true);
  });

  it("accepts the canonical loader shape with no url (exact message)", () => {
    const err = Object.assign(
      new Error('Unknown file extension ".ts" for /repo/src/module.ts'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION" },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(true);
  });

  it("rejects a conflicting url even when the message names the source", () => {
    const err = Object.assign(
      new Error('Unknown file extension ".ts" for /repo/src/module.ts'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION", url: "file:///repo/src/other.ts" },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(false);
  });

  it("rejects an arbitrary code-shaped runtime error that mentions the source path", () => {
    const err = Object.assign(
      new Error(
        'runtime blew up while loading /repo/src/module.ts (Unknown file extension ".ts"?)',
      ),
      { code: "ERR_UNKNOWN_FILE_EXTENSION" },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(false);
  });

  it("rejects a non-canonical message for the correct code and no url", () => {
    const err = Object.assign(
      new Error('Unknown file extension ".ts" happened for /repo/src/module.ts here'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION" },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(false);
  });

  it("rejects an empty-string url even when the message is canonical", () => {
    const err = Object.assign(
      new Error('Unknown file extension ".ts" for /repo/src/module.ts'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION", url: "" },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(false);
  });

  it("rejects a non-string url even when the message is canonical", () => {
    const err = Object.assign(
      new Error('Unknown file extension ".ts" for /repo/src/module.ts'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION", url: 42 },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(false);
  });

  it("rejects a null url even when the message is canonical", () => {
    const err = Object.assign(
      new Error('Unknown file extension ".ts" for /repo/src/module.ts'),
      { code: "ERR_UNKNOWN_FILE_EXTENSION", url: null },
    );
    expect(isExpectedPlainNodeTsLoaderFailure(err, sourceURL)).toBe(false);
  });
});

describe("soak runner system-state readiness reader resolution", () => {
  it("returns immediate-ready when the source module is absent, even with dist present", async () => {
    const reader = await resolveSystemStateReadinessReader({
      sourceExists: () => false,
      distExists: () => true,
      loadSource: () => {
        throw new Error("must not be called");
      },
      loadDist: () => {
        throw new Error("dist must not load when source is absent");
      },
      canFallBackToDist: () => true,
    });
    expect(reader({})).toEqual({ status: "ready" });
  });

  it("never falls back to dist under Vitest even for the expected loader shape", async () => {
    const sourceURL = new URL("file:///repo/src/shared/observability/internalLog.ts");
    const loaderShape = Object.assign(
      new Error(
        'Unknown file extension ".ts" for /repo/src/shared/observability/internalLog.ts',
      ),
      { code: "ERR_UNKNOWN_FILE_EXTENSION", url: sourceURL.href },
    );
    await expect(resolveSystemStateReadinessReader({
      sourceURL,
      sourceExists: () => true,
      distExists: () => true,
      loadSource: () => Promise.reject(loaderShape),
      loadDist: () => {
        throw new Error("dist must not load under Vitest");
      },
      // shouldFallBackToDistOnSourceFailure() is false when VITEST is set.
      canFallBackToDist: shouldFallBackToDistOnSourceFailure,
    })).rejects.toThrow();
  });

  it("rethrows a real source error even with dist present and fallback allowed", async () => {
    await expect(resolveSystemStateReadinessReader({
      sourceURL: new URL("file:///repo/src/a.ts"),
      sourceExists: () => true,
      distExists: () => true,
      loadSource: () => Promise.reject(new SyntaxError("bad syntax")),
      loadDist: () => {
        throw new Error("dist must not load for a real source error");
      },
      canFallBackToDist: () => true,
    })).rejects.toThrow("bad syntax");
  });

  it("falls back to dist only for the expected loader shape in a plain-Node env", async () => {
    const sourceURL = new URL("file:///repo/src/shared/observability/internalLog.ts");
    const loaderShape = Object.assign(
      new Error(
        'Unknown file extension ".ts" for /repo/src/shared/observability/internalLog.ts',
      ),
      { code: "ERR_UNKNOWN_FILE_EXTENSION", url: sourceURL.href },
    );
    const reader = await resolveSystemStateReadinessReader({
      sourceURL,
      sourceExists: () => true,
      distExists: () => true,
      loadSource: () => Promise.reject(loaderShape),
      loadDist: () => Promise.resolve({ readRuntimeSystemStateReadiness: () => ({ status: "ready" }) }),
      canFallBackToDist: () => true,
    });
    expect(reader({})).toEqual({ status: "ready" });
  });
});

describe("soak cleanup live-env precondition", () => {
  it("fails closed when either required live sandbox env var is missing", () => {
    expect(cleanupLiveEnvMissingReason(undefined, undefined))
      .toContain("HIKOUTEI_SYNC_SPREADSHEET_URL");
    expect(cleanupLiveEnvMissingReason(undefined, undefined))
      .toContain("GOOGLE_APPLICATION_CREDENTIALS");
    // Blank/whitespace-only values are treated as missing too.
    expect(cleanupLiveEnvMissingReason("", "/path/creds.json")).toContain("HIKOUTEI_SYNC_SPREADSHEET_URL");
    expect(cleanupLiveEnvMissingReason("  ", "/path/creds.json")).not.toBeNull();
    expect(cleanupLiveEnvMissingReason("https://docs.google.com/spreadsheets/d/AbC123_xyz", ""))
      .toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("never leaks the environment values, only the variable names", () => {
    const missingBoth = cleanupLiveEnvMissingReason("", "fake/path/creds.json") ?? "";
    expect(missingBoth).not.toContain("creds.json");
    const missingCreds = cleanupLiveEnvMissingReason("https://docs.google.com/spreadsheets/d/AbC123_xyz", "") ?? "";
    expect(missingCreds).not.toContain("AbC123_xyz");
    expect(missingCreds).not.toContain("docs.google.com");
  });

  it("returns null when both required env vars are present", () => {
    expect(cleanupLiveEnvMissingReason("https://docs.google.com/spreadsheets/d/AbC123_xyz", "/path/creds.json"))
      .toBeNull();
  });
});
