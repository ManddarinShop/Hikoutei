/**
 * Focused tests for the soak artifact redaction allowlists.
 *
 * Every `code`, `reason`, `errorClass`, `statusClass`, table name, and
 * count key/value that can reach JSONL, the summary, the collected log,
 * or stderr passes through these sanitizers. Unknown values collapse to
 * fixed safe categories; token/email/path/URL-like strings must never
 * survive into a record.
 */

import { describe, expect, it } from "vitest";
import {
  FAILURE_REASON_CODES,
  isKnownStatusClass,
  KNOWN_FAILURE_KINDS,
  KNOWN_REASON_CODES,
  KNOWN_STABLE_CLASSES,
  KNOWN_STABLE_CODES,
  KNOWN_TABLE_NAMES,
  sanitizeCounts,
  sanitizeErrorClass,
  sanitizeErrorTag,
  sanitizeFailureKind,
  sanitizeReason,
  sanitizeRecordFields,
  sanitizeStableCode,
  sanitizeStatusClass,
  sanitizeTableName,
} from "../scripts/ci/local-soak/redact.mjs";

/** Secret-like values that must never pass through any sanitizer. */
const SECRETS = [
  "ya29.jwt-abcdefghijklmnop",
  "service@project.iam.gserviceaccount.com",
  "https://docs.google.com/spreadsheets/d/1AbC/edit",
  "/Users/me/.config/gcloud/application_default_credentials.json",
  "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
];

describe("soak redaction: stable codes", () => {
  it("passes allowlisted codes and maps every secret-like value to unknown", () => {
    for (const code of KNOWN_STABLE_CODES) {
      expect(sanitizeStableCode(code)).toBe(code);
    }
    for (const secret of SECRETS) {
      expect(sanitizeStableCode(secret)).toBe("unknown");
    }
    expect(sanitizeStableCode(undefined)).toBe("unknown");
    expect(sanitizeStableCode(42)).toBe("unknown");
    expect(sanitizeStableCode("")).toBe("unknown");
  });
});

describe("soak redaction: error classes and status classes", () => {
  it("passes allowlisted classes and maps unknown names to unknown", () => {
    for (const errorClass of KNOWN_STABLE_CLASSES) {
      expect(sanitizeErrorClass(errorClass)).toBe(errorClass);
    }
    // The reopen-cleanup marker class is part of the stable vocabulary.
    expect(KNOWN_STABLE_CLASSES).toContain("SoakReopenCleanupError");
    expect(sanitizeErrorClass("SoakReopenCleanupError")).toBe("SoakReopenCleanupError");
    for (const secret of SECRETS) {
      expect(sanitizeErrorClass(secret)).toBe("unknown");
    }
    // Class names must never smuggle path-like text.
    expect(sanitizeErrorClass("Error: at /Users/secret/file.ts")).toBe("unknown");
  });

  it("classifies numeric HTTP statuses and known named classes only", () => {
    expect(sanitizeStatusClass(403)).toBe("unknown"); // non-string input
    expect(sanitizeStatusClass("http_403")).toBe("http_403");
    expect(sanitizeStatusClass("http_200")).toBe("http_200");
    expect(sanitizeStatusClass("network_or_unknown")).toBe("network_or_unknown");
    expect(sanitizeStatusClass("harness_error")).toBe("harness_error");
    expect(sanitizeStatusClass("missing_identity")).toBe("missing_identity");
    // The direct-write identity-shift guard is a stable named class.
    expect(sanitizeStatusClass("identity_shifted")).toBe("identity_shifted");
    expect(isKnownStatusClass("identity_shifted")).toBe(true);
    // The direct-write header and sheet-id guards are stable named classes.
    expect(sanitizeStatusClass("malformed_header")).toBe("malformed_header");
    expect(isKnownStatusClass("malformed_header")).toBe(true);
    expect(sanitizeStatusClass("malformed_sheet_id")).toBe("malformed_sheet_id");
    expect(isKnownStatusClass("malformed_sheet_id")).toBe(true);
    // A fulfilled-but-malformed SDK reply (non-array data.sheets) is a
    // stable non-retryable class, never a raw TypeError or raw payload.
    expect(sanitizeStatusClass("malformed_reply")).toBe("malformed_reply");
    expect(isKnownStatusClass("malformed_reply")).toBe(true);
    for (const secret of SECRETS) {
      expect(sanitizeStatusClass(secret)).toBe("unknown");
    }
    // A raw SDK code or payload fragment must not survive.
    expect(sanitizeStatusClass("RATE_LIMIT_EXCEEDED quota project 12345")).toBe("unknown");
  });
});

describe("soak redaction: reasons", () => {
  it("passes the stable reason vocabulary and maps everything else to unknown", () => {
    expect(KNOWN_REASON_CODES).toContain(FAILURE_REASON_CODES.QUERY_MISMATCH);
    expect(KNOWN_REASON_CODES).toContain("cycle-error");
    expect(KNOWN_REASON_CODES).toContain("reopen-cleanup-failed");
    expect(KNOWN_REASON_CODES).toContain("human-edit-not-accepted");
    // The identity-shifted transient skip reason (a direct human-write
    // rejection whose evidence is exactly the seam's fail-closed
    // `identity_shifted` guard) is an allowlisted skip reason.
    expect(KNOWN_REASON_CODES).toContain("identity-shifted-transient");
    for (const reason of KNOWN_REASON_CODES) {
      expect(sanitizeReason(reason)).toBe(reason);
    }
    for (const secret of SECRETS) {
      expect(sanitizeReason(secret)).toBe("unknown");
    }
  });
});

describe("soak redaction: table names", () => {
  it("passes the soak vocabulary and maps unknown names to unknown", () => {
    for (const table of KNOWN_TABLE_NAMES) {
      expect(sanitizeTableName(table)).toBe(table);
    }
    expect(sanitizeTableName("SoakTask")).toBe("SoakTask");
    for (const secret of SECRETS) {
      expect(sanitizeTableName(secret)).toBe("unknown");
    }
    // Identifier-shaped but unknown names still collapse to unknown so a
    // future entity rename cannot leak before review.
    expect(sanitizeTableName("soak_secret_table")).toBe("unknown");
  });
});

describe("soak redaction: scenario failure kinds and stable error tags", () => {
  it("passes the allowlisted failure kinds and maps everything else to unknown", () => {
    for (const kind of KNOWN_FAILURE_KINDS) {
      expect(sanitizeFailureKind(kind)).toBe(kind);
    }
    expect(sanitizeFailureKind("duplicate-rows")).toBe("duplicate-rows");
    expect(sanitizeFailureKind("not-a-real-kind")).toBe("unknown");
    for (const secret of SECRETS) {
      expect(sanitizeFailureKind(secret)).toBe("unknown");
    }
    expect(sanitizeFailureKind(undefined)).toBe("unknown");
    expect(sanitizeFailureKind(42)).toBe("unknown");
  });

  it("passes canonical stable error tags and collapses crafted ones", () => {
    expect(sanitizeErrorTag("Error")).toBe("Error");
    expect(sanitizeErrorTag("TypeError")).toBe("TypeError");
    expect(sanitizeErrorTag("unknown")).toBe("unknown");
    expect(sanitizeErrorTag("HikouteiError (invalid_scalar_value)")).toBe(
      "HikouteiError (invalid_scalar_value)",
    );
    expect(sanitizeErrorTag("Error (visible_guard_mismatch)")).toBe(
      "Error (visible_guard_mismatch)",
    );
    expect(sanitizeErrorTag("Error (deadline_expired)")).toBe("Error (deadline_expired)");
    // Unknown class, unknown inner stable, or malformed shape collapse.
    expect(sanitizeErrorTag("MyPathError")).toBe("unknown");
    expect(sanitizeErrorTag("Error (some-secret-token)")).toBe("unknown");
    expect(sanitizeErrorTag("Error (/home/me/credentials.json)")).toBe("unknown");
    expect(sanitizeErrorTag("")).toBe("unknown");
    expect(sanitizeErrorTag(undefined)).toBe("unknown");
    for (const secret of SECRETS) {
      expect(sanitizeErrorTag(secret)).toBe("unknown");
    }
  });

  it("the record walker keeps reasonTag/failureKinds and collapses injected text", () => {
    const sanitized = sanitizeRecordFields({
      status: "failed",
      failures: 1,
      reasonTag: "Error (candidate_guard_mismatch)",
      failureKinds: ["partial-landing", "bogus-kind", 7],
    }) as Record<string, unknown>;
    expect(sanitized.reasonTag).toBe("Error (candidate_guard_mismatch)");
    // Non-string entries drop; the unknown kind collapses to the fixed
    // category; the list stays deduplicated and sorted.
    expect(sanitized.failureKinds).toEqual(["partial-landing", "unknown"]);
    // A crafted free-text tag never survives the walker.
    const crafted = sanitizeRecordFields({
      reasonTag: "Error (https://docs.google.com/spreadsheets/d/1AbC/edit)",
    }) as Record<string, unknown>;
    expect(crafted.reasonTag).toBe("unknown");
  });
});

describe("soak redaction: counts", () => {
  it("keeps only identifier-shaped keys with finite numeric values", () => {
    expect(sanitizeCounts({ applied: 2, missing: 1 })).toEqual({ applied: 2, missing: 1 });
    expect(sanitizeCounts({ applied: 2, "bad key!": 1, secret: "ya29.token", n: NaN }))
      .toEqual({ applied: 2 });
    expect(sanitizeCounts(null)).toBeUndefined();
    expect(sanitizeCounts([1, 2])).toBeUndefined();
    expect(sanitizeCounts("ya29.jwt")).toBeUndefined();
    expect(sanitizeCounts({})).toBeUndefined();
  });
});

describe("soak redaction: record walker", () => {
  it("sanitizes every sensitive field of nested records", () => {
    const record = sanitizeRecordFields({
      status: "failed",
      reason: "https://secret.example/x",
      errorClass: "HackedError",
      statusClass: "ya29.jwt-token",
      code: "service@project.iam.gserviceaccount.com",
      table: "soak_secret_table",
      counts: { applied: 3, token: "ya29.jwt" },
      nested: {
        reason: "human-edit-not-accepted",
        errorClass: "DirectSheetsError",
        extraRows: 2,
      },
      numbers: 7,
      flag: true,
    });
    expect(record).toEqual({
      status: "failed",
      reason: "unknown",
      errorClass: "unknown",
      statusClass: "unknown",
      code: "unknown",
      table: "unknown",
      counts: { applied: 3 },
      nested: {
        reason: "human-edit-not-accepted",
        errorClass: "DirectSheetsError",
        extraRows: 2,
      },
      numbers: 7,
      flag: true,
    });
  });

  it("sanitizes arrays element-wise", () => {
    const result = sanitizeRecordFields([
      { code: "ya29.jwt" },
      "plain-string",
      42,
      null,
    ]);
    expect(result).toEqual([{ code: "unknown" }, 42]);
  });

  it("drops unknown/free-form keys and arbitrary strings (injection test)", () => {
    // MEDIUM 6: free-form keys (message, stack, payload, id, value, url,
    // path) and arbitrary nested strings must never survive the walker,
    // even inside arrays or deep nesting — only known allowlisted fields
    // and numeric/boolean counters pass.
    const record = sanitizeRecordFields({
      status: "failed",
      message: "leaked secret: ya29.jwt",
      stack: "at /Users/secret/path.js:1:1",
      payload: { raw: "https://docs.google.com/spreadsheets/d/abc123" },
      id: "soak_tasks-c5-main",
      value: "human-edit-c5",
      url: "https://docs.google.com/spreadsheets/d/abc123/edit",
      path: "/var/credentials/service-account.json",
      errorClass: "DirectSheetsError",
      nested: {
        arbitrary: "free text with id-c5 and @serviceaccount.com",
        counts: { applied: 2, "leak me": "token" },
        missingRows: 3,
      },
      array: ["secret-string", { reason: "query-mismatch" }, 7],
      reason: "query-mismatch",
      table: "soak_tasks",
      numbers: 42,
      flag: true,
    });
    expect(record).toEqual({
      status: "failed",
      errorClass: "DirectSheetsError",
      nested: {
        counts: { applied: 2 },
        missingRows: 3,
      },
      array: [{ reason: "query-mismatch" }, 7],
      reason: "query-mismatch",
      table: "soak_tasks",
      numbers: 42,
      flag: true,
    });
    expect(JSON.stringify(record)).not.toMatch(/ya29|docs\.google|service-account|human-edit/);
  });

  it("maps unknown status strings to the fixed unknown category", () => {
    expect(sanitizeRecordFields({ status: "https://evil.example" })).toEqual({
      status: "unknown",
    });
    expect(sanitizeRecordFields({ status: "ok" })).toEqual({ status: "ok" });
    expect(sanitizeRecordFields({ status: "expected_error" })).toEqual({
      status: "expected_error",
    });
  });

  it("drops non-identifier keys even when their values are numeric", () => {
    // Counts keys must be identifier-shaped: a crafted key like
    // "docs.google.com" must not survive even with a numeric value.
    expect(sanitizeRecordFields({
      "docs.google.com": 1,
      "bad key": 2,
      soak_tasks: 3,
    })).toEqual({ soak_tasks: 3 });
  });
});
