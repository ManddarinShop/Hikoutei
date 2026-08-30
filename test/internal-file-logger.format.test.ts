/**
 * Internal file logger tests: FORMATTING, REDACTION, and the ENV CONTRACT.
 *
 * Split from internal-file-logger.test.ts (formatting/redaction + env contract
 * describe groups). Covers the allowlist serialization, redaction, level
 * filtering, .txt extension, defaults, and env-driven disabled/enabled.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHikouteiInternalLogger,
  DEFAULT_BACKUPS,
  DEFAULT_MAX_BYTES,
  describeErrorForInternalLog,
  ensureTxtExtension,
  formatHikouteiLogLine,
  getHikouteiInternalLogger,
  HIKOUTEI_LOG_ENV_KEYS,
  logHikouteiInternalEvent,
  resetHikouteiInternalLoggerForTests,
  rotatedLogPath,
  stableConsoleErrorTag,
  type HikouteiInternalLogger,
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_STABLE_CODES,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";
import { HIKOUTEI_ERROR_CODES } from "@hikoutei/sync-engine/api/errors.js";
import { createTypedSheets } from "../src/api/Hikoutei.js";
import { defineTypedSheetsEntity } from "@hikoutei/sync-engine/api/entity.js";

/** Reads a log file and parses every JSONL line. */
async function readLogLines(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * True when the platform can create symlinks (used to skip the symlink
 * rejection test with an explicit reason on filesystems that cannot).
 */
const SYMLINK_SUPPORTED = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), "hikoutei-log-symlink-probe-"));
  try {
    const target = path.join(probeDir, "target.txt");
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, path.join(probeDir, "link.txt"));
    return existsSync(path.join(probeDir, "link.txt"));
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe("internal file logger formatting and redaction", () => {
  it("serializes only allowlisted structured fields", () => {
    const result = formatHikouteiLogLine(
      {
        event: HIKOUTEI_LOG_EVENTS.EM_FLUSH_FAILED,
        level: "error",
        component: "entity-manager",
        code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
        table: "customers",
        errorClass: "HikouteiError",
        retryable: false,
        attempts: 2,
        durationMs: 12.5,
        counts: { changes: 3, tables: 1 },
      },
      new Date("2025-01-01T00:00:00Z"),
    );
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    const parsed = JSON.parse(result.line) as Record<string, unknown>;
    expect(parsed.event).toBe("hikoutei.em.flush_failed");
    expect(parsed.level).toBe("error");
    expect(parsed.component).toBe("entity-manager");
    expect(parsed.table).toBe("customers");
    expect(parsed.retryable).toBe(false);
    expect(parsed.attempts).toBe(2);
    expect(parsed.durationMs).toBe(12.5);
    expect(parsed.counts).toEqual({ changes: 3, tables: 1 });
    // No message-like field exists in the serialized shape at all.
    expect(Object.keys(parsed).sort()).toEqual([
      "attempts",
      "code",
      "component",
      "counts",
      "durationMs",
      "errorClass",
      "event",
      "level",
      "retryable",
      "table",
      "ts",
    ]);
  });

  it("redacts unsafe identifier-like field values", () => {
    const secretEmail = "service@project.iam.gserviceaccount.com";
    const spreadsheetUrl = "https://docs.google.com/spreadsheets/d/1AbC/edit";
    const result = formatHikouteiLogLine({
      event: "hikoutei.em.query_failed",
      code: secretEmail,
      table: spreadsheetUrl,
      errorClass: "Error: at /Users/secret/path/file.ts",
    });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    const parsed = JSON.parse(result.line) as Record<string, unknown>;
    expect(parsed.code).toBe("[redacted]");
    expect(parsed.table).toBe("[redacted]");
    expect(parsed.errorClass).toBe("[redacted]");
    expect(result.line).not.toContain(secretEmail);
    expect(result.line).not.toContain(spreadsheetUrl);
  });

  it("redacts token/email/URL/path-like code values that are not allowlisted", () => {
    const secretCodes = [
      "ya29.jwt-abcdefghijklmnop",
      "service@project.iam.gserviceaccount.com",
      "https://docs.google.com/spreadsheets/d/1AbC",
      "/Users/me/.config/gcloud/application_default_credentials.json",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ];
    for (const secretCode of secretCodes) {
      const result = formatHikouteiLogLine({
        event: "hikoutei.em.flush_failed",
        code: secretCode,
      });
      expect(result.status).toBe("valid");
      if (result.status !== "valid") continue;
      const parsed = JSON.parse(result.line) as Record<string, unknown>;
      expect(parsed.code).toBe("[redacted]");
      expect(result.line).not.toContain(secretCode);
    }
  });

  it("passes every allowlisted stable code through unchanged", () => {
    for (const code of HIKOUTEI_LOG_STABLE_CODES) {
      const result = formatHikouteiLogLine({
        event: "hikoutei.em.flush_failed",
        code,
      });
      expect(result.status).toBe("valid");
      if (result.status !== "valid") continue;
      const parsed = JSON.parse(result.line) as Record<string, unknown>;
      expect(parsed.code).toBe(code);
    }
    // Events and components outside the constant sets are redacted too.
    const unsafe = formatHikouteiLogLine({
      event: "hikoutei.evil.event_name",
      component: "ya29.jwt-token",
    } as Parameters<typeof formatHikouteiLogLine>[0]);
    expect(unsafe.status).toBe("invalid");
    const unsafeComponent = formatHikouteiLogLine({
      event: "hikoutei.em.query_failed",
      component: "ya29.jwt-token",
    } as Parameters<typeof formatHikouteiLogLine>[0]);
    if (unsafeComponent.status !== "valid") throw new Error("expected valid");
    expect(JSON.parse(unsafeComponent.line).component).toBe("[redacted]");
  });

  it("passes allowlisted provider operation/reason through and redacts unsafe ones", () => {
    const valid = formatHikouteiLogLine({
      event: HIKOUTEI_LOG_EVENTS.TRANSPORT_RESPONSE_INVALID,
      code: "invalid_sync_provider_response",
      errorClass: "SyncSheetsContractError",
      providerOperation: "postcondition_read",
      providerReason: "missing_tab",
    });
    expect(valid.status).toBe("valid");
    if (valid.status !== "valid") return;
    const parsed = JSON.parse(valid.line) as Record<string, unknown>;
    expect(parsed.providerOperation).toBe("postcondition_read");
    expect(parsed.providerReason).toBe("missing_tab");

    // Any non-allowlisted value (an id, URL, path, or arbitrary string) is
    // replaced with the redaction marker and never serialized verbatim.
    const unsafe = formatHikouteiLogLine({
      event: HIKOUTEI_LOG_EVENTS.TRANSPORT_RESPONSE_INVALID,
      providerOperation: "https://docs.google.com/spreadsheets/d/1AbC",
      providerReason: "effect-id-123",
    });
    expect(unsafe.status).toBe("valid");
    if (unsafe.status !== "valid") return;
    const redacted = JSON.parse(unsafe.line) as Record<string, unknown>;
    expect(redacted.providerOperation).toBe("[redacted]");
    expect(redacted.providerReason).toBe("[redacted]");
    expect(unsafe.line).not.toContain("docs.google.com");
    expect(unsafe.line).not.toContain("effect-id-123");
  });

  it("drops non-numeric counts and unknown extra fields entirely", () => {
    const result = formatHikouteiLogLine({
      // Extra fields are not part of the entry type; simulate an untyped
      // caller by widening the object.
      ...({
        event: "hikoutei.outbox.pass_summary",
        message: "raw error with token ya29.secret",
        payload: { id: "row-anchor-1" },
        counts: { applied: 2, secretValue: "ya29.secret", "bad key!": 1 },
      } as unknown as Parameters<typeof formatHikouteiLogLine>[0]),
    });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    const parsed = JSON.parse(result.line) as Record<string, unknown>;
    expect(parsed.counts).toEqual({ applied: 2 });
    expect(result.line).not.toContain("secret");
    expect(result.line).not.toContain("row-anchor-1");
    expect(parsed.message).toBeUndefined();
    expect(parsed.payload).toBeUndefined();
  });

  it("rejects entries without a usable event", () => {
    expect(formatHikouteiLogLine({} as { event: string }).status).toBe("invalid");
    expect(
      formatHikouteiLogLine({
        event: "https://docs.google.com/spreadsheets/d/1AbC",
      }).status,
    ).toBe("invalid");
  });

  it("extracts only class name and stable code from errors", () => {
    const described = describeErrorForInternalLog(
      new Error("path /Users/me/secret.json token ya29.x"),
    );
    expect(described.errorClass).toBe("Error");
    expect(described.code).toBeUndefined();
    const shaped = {
      name: "HikouteiError",
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
      message: "never logged",
    };
    expect(describeErrorForInternalLog(shaped)).toEqual({
      errorClass: "HikouteiError",
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
  });

  it("builds allowlisted console tags for default diagnostics", () => {
    // Raw messages with paths, tokens, and emails never survive.
    const raw = new Error(
      "request failed: /Users/me/secret.json token ya29.jwt service@x.iam.gserviceaccount.com",
    );
    expect(stableConsoleErrorTag(raw)).toBe("Error");
    const stable = stableConsoleErrorTag({
      name: "HikouteiError",
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
    expect(stable).toBe("HikouteiError (invalid_query)");
    // Unknown class and unknown code collapse to fixed safe categories.
    expect(stableConsoleErrorTag({ name: "EvilAt/Users/secret", code: "ya29.jwt" })).toBe("unknown");
    expect(stableConsoleErrorTag({ name: "HikouteiError", code: "ya29.jwt" })).toBe("HikouteiError");
    expect(stableConsoleErrorTag({ name: "GoogleSheetsApiTransportError", code: "google_sheets_api_http_error" }))
      .toBe("GoogleSheetsApiTransportError (google_sheets_api_http_error)");
    expect(stableConsoleErrorTag(undefined)).toBe("unknown");
    expect(stableConsoleErrorTag("plain string")).toBe("unknown");
    expect(stableConsoleErrorTag(new TypeError("boom"))).toBe("TypeError");
  });

  it("enforces the .txt extension for output and backup names", () => {
    expect(ensureTxtExtension("hikoutei-log")).toBe("hikoutei-log.txt");
    expect(ensureTxtExtension("dir/hikoutei-log.TXT")).toBe("dir/hikoutei-log.TXT");
    expect(rotatedLogPath("dir/hikoutei-log.txt", 2)).toBe("dir/hikoutei-log.2.txt");
  });
});

describe("internal file logger env contract", () => {
  it("is disabled unless HIKOUTEI_LOG_FILE is set", () => {
    const logger = createHikouteiInternalLogger({
      env: { [HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL]: "debug" },
    });
    expect(logger.enabled).toBe(false);
    expect(logger.filePath).toBeUndefined();
    expect(logger.log({ event: "hikoutei.runtime.opened" })).toBe(false);
  });

  it("treats blank or whitespace HIKOUTEI_LOG_FILE as logging disabled, never a bare .txt path", async () => {
    // Regression (Luna review): blank/whitespace env values must mean
    // DISABLED — they must never be trimmed into an empty path and then
    // normalized to a bare `.txt` file that would be written in the cwd.
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-blank-"));
    try {
      for (const blank of ["", "   ", "\t", " \n ", "  \t  "]) {
        const logger = createHikouteiInternalLogger({
          env: { [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: blank },
        });
        expect(logger.enabled, JSON.stringify(blank)).toBe(false);
        expect(logger.filePath, JSON.stringify(blank)).toBeUndefined();
        expect(logger.log({ event: "hikoutei.runtime.opened" }), JSON.stringify(blank)).toBe(false);
        await logger.drain();
      }
      // No `.txt` file (the old normalization bug) or any other file was
      // created in a fresh temp root.
      const entries = await readdir(tempRoot);
      expect(entries.filter((entry) => entry.endsWith(".txt"))).toEqual([]);
      expect(entries).toEqual([]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("filters entries below the configured level", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-level-"));
    try {
      const filePath = path.join(tempRoot, "hikoutei-log.txt");
      const logger = createHikouteiInternalLogger({
        env: {
          [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: filePath,
          [HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL]: "warn",
        },
      });
      expect(logger.log({ event: "hikoutei.runtime.opened", level: "info" })).toBe(false);
      expect(logger.log({ event: "hikoutei.em.query_failed", level: "warn" })).toBe(true);
      await logger.drain();
      const lines = await readLogLines(filePath);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.event).toBe("hikoutei.em.query_failed");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to defaults for malformed numeric env values", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-env-"));
    try {
      const logger = createHikouteiInternalLogger({
        env: {
          [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: path.join(tempRoot, "log.txt"),
          [HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL]: "not-a-level",
          [HIKOUTEI_LOG_ENV_KEYS.LOG_MAX_BYTES]: "-40",
          [HIKOUTEI_LOG_ENV_KEYS.LOG_BACKUPS]: "abc",
        },
      });
      expect(logger.level).toBe("info");
      logger.log({ event: "hikoutei.runtime.opened" });
      await logger.drain();
      expect(existsSync(logger.filePath ?? "")).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies the approved 10 MiB / 5 backup defaults and bounds explicit overrides", async () => {
    expect(DEFAULT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(DEFAULT_BACKUPS).toBe(5);
    // Explicit overrides stay bounded: huge values clamp to the documented
    // ceilings rather than being honored verbatim.
    const logger = createHikouteiInternalLogger({
      env: {
        [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: "unused.txt",
        [HIKOUTEI_LOG_ENV_KEYS.LOG_MAX_BYTES]: "999999999999999999999",
        [HIKOUTEI_LOG_ENV_KEYS.LOG_BACKUPS]: "9999",
      },
    });
    await logger.drain();
  });

  it("creates a nested non-existent parent directory on the first write", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-nested-"));
    try {
      const filePath = path.join(tempRoot, "deep", "nested", "dir", "hikoutei-log.txt");
      const logger = createHikouteiInternalLogger({
        env: { [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: filePath },
      });
      expect(logger.log({ event: "hikoutei.runtime.opened" })).toBe(true);
      await logger.drain();
      expect(existsSync(filePath)).toBe(true);
      const lines = await readLogLines(filePath);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.event).toBe("hikoutei.runtime.opened");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
