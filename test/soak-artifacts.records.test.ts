/**
 * Soak artifact record tests: OPERATION, CYCLE, RESOURCE/MARKDOWN, and the
 * LOG-LINE contract-mirror validation.
 *
 * Split from soak-artifacts.test.ts (records+contract-mirror describe groups).
 */
import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createArtifactWriter,
  cycleRecord,
  normalizeSoakLogFilePath,
  operationRecord,
  renderSummaryMarkdown,
  resourceRecord,
  uniqueStagingPath,
} from "../scripts/ci/local-soak/artifacts.mjs";
import {
  createHikouteiInternalLogger,
  HIKOUTEI_LOG_ENV_KEYS,
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_STABLE_CLASSES,
  HIKOUTEI_LOG_STABLE_CODES,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";
import {
  LOGGED_COMPONENT_NAMES,
  LOGGED_EVENT_NAMES,
  LOGGED_FIELD_NAMES,
  LOGGED_LEVELS,
  LOGGED_STABLE_CLASSES as LOGGED_CLASS_MIRROR,
  LOGGED_STABLE_CODES as LOGGED_CODE_MIRROR,
  sanitizeCollectedLogLine,
} from "../scripts/ci/local-soak/logLines.mjs";

/** One logger-shaped JSONL line for collection tests. */
function loggerLine(event: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event, ...extra })}\n`;
}

/**
 * True when the platform can create symlinks (used to skip the symlink
 * escape test with an explicit reason on filesystems that cannot).
 */
const SYMLINK_SUPPORTED = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), "soak-symlink-probe-"));
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

describe("soak artifacts: operation records", () => {
  it("records redacted failure metadata with stable reason codes", () => {
    const record = operationRecord(
      7,
      0,
      { opIndex: 3, kind: "transactionalRollback", entityName: "SoakTask" },
      {
        status: "failed",
        reason: "rollback-verification",
        durationMs: 3,
      },
    );
    expect(record.status).toBe("failed");
    expect(record.reason).toBe("rollback-verification");
    expect(record.kind).toBe("transactionalRollback");
    expect(record.table).toBe("SoakTask");
    expect(record.durationMs).toBe(3);
    // Never any raw payload fields.
    expect(record).not.toHaveProperty("mutateId");
    expect(record).not.toHaveProperty("row");
    expect(record).not.toHaveProperty("message");
  });

  it("carries stable library codes but omits optional fields when absent", () => {
    const record = operationRecord(
      1,
      1,
      { opIndex: 0, kind: "count", entityName: "SoakOrder" },
      { status: "ok", counts: { count: 4 }, durationMs: 2 },
    );
    expect(record.code).toBeUndefined();
    expect(record.reason).toBeUndefined();
    expect(record.counts).toEqual({ count: 4 });
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("re-sanitizes secret-like code, reason, table, and counts at the boundary", () => {
    const secrets = [
      "ya29.jwt-abcdefghijklmnop",
      "service@project.iam.gserviceaccount.com",
      "https://docs.google.com/spreadsheets/d/1AbC/edit",
      "/Users/me/.config/gcloud/application_default_credentials.json",
    ];
    for (const secret of secrets) {
      const record = operationRecord(
        7,
        0,
        { opIndex: 1, kind: "count", entityName: secret },
        {
          status: "failed",
          code: secret,
          reason: secret,
          counts: { [secret]: 3, matched: "not-a-number" } as unknown as Record<string, number>,
          durationMs: 1,
        },
      );
      expect(record.table).toBe("unknown");
      expect(record.code).toBe("unknown");
      expect(record.reason).toBe("unknown");
      expect(record.counts).toBeUndefined();
      expect(JSON.stringify(record)).not.toContain(secret);
    }
    // Allowlisted values still pass through unchanged.
    const valid = operationRecord(
      7,
      0,
      { opIndex: 1, kind: "count", entityName: "SoakTask" },
      {
        status: "failed",
        code: "invalid_query",
        reason: "query-mismatch",
        counts: { matched: 1 },
        durationMs: 1,
      },
    );
    expect(valid.table).toBe("SoakTask");
    expect(valid.code).toBe("invalid_query");
    expect(valid.reason).toBe("query-mismatch");
    expect(valid.counts).toEqual({ matched: 1 });
  });
});

describe("soak artifacts: cycle records", () => {
  it("flattens the explicit operations summary shape into the JSONL record", () => {
    const record = cycleRecord(5, {
      durationMs: 40,
      tablesTouched: ["soak_tasks"],
      operations: { total: 32, ok: 30, expectedErrors: 1, failures: 1, retries: 2 },
    });
    expect(record.operations).toBe(32);
    expect(record.expectedErrors).toBe(1);
    expect(record.failures).toBe(1);
    expect(record.retries).toBe(2);
    expect(record.durationMs).toBe(40);
    expect(record.tablesTouched).toEqual(["soak_tasks"]);
  });

  it("includes optional probe/convergence/reopen sections only when present", () => {
    const withProbe = cycleRecord(10, {
      durationMs: 1,
      tablesTouched: [],
      operations: { total: 32, ok: 32, expectedErrors: 0, failures: 0, retries: 0 },
      probe: { status: "skipped", reason: "local-mode" },
    });
    expect(withProbe.probe).toEqual({ status: "skipped", reason: "local-mode" });
    expect(withProbe.convergence).toBeUndefined();

    const withReopen = cycleRecord(60, {
      durationMs: 1,
      tablesTouched: [],
      operations: { total: 32, ok: 32, expectedErrors: 0, failures: 0, retries: 0 },
      reopen: { status: "ok", soak_tasks: 9 },
    });
    expect(withReopen.reopen).toEqual({ status: "ok", soak_tasks: 9 });
  });

  it("re-sanitizes nested probe/abort sections at the boundary", () => {
    const secret = "ya29.jwt-token@example.com";
    const record = cycleRecord(10, {
      durationMs: 1,
      tablesTouched: [secret, "soak_tasks"],
      operations: { total: 32, ok: 31, expectedErrors: 0, failures: 1, retries: 0 },
      probe: {
        status: "failed",
        reason: secret,
        statusClass: secret,
        table: secret,
      },
      abort: {
        reason: "cycle-error",
        errorClass: `${secret} at /Users/secret/x`,
        code: secret,
      },
    });
    expect(record.tablesTouched).toEqual(["unknown", "soak_tasks"]);
    expect(record.probe).toEqual({
      status: "failed",
      reason: "unknown",
      statusClass: "unknown",
      table: "unknown",
    });
    expect(record.abort).toEqual({
      reason: "cycle-error",
      errorClass: "unknown",
      code: "unknown",
    });
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain("/Users/secret");
  });

  it("preserves an allowlisted abort statusClass and collapses arbitrary text", () => {
    const record = cycleRecord(11, {
      durationMs: 1,
      tablesTouched: [],
      operations: { total: 1, ok: 0, expectedErrors: 0, failures: 1, retries: 0 },
      abort: {
        reason: "cycle-error",
        errorClass: "DirectSheetsError",
        statusClass: "http_429",
      },
    });
    expect(record.abort).toEqual({
      reason: "cycle-error",
      errorClass: "DirectSheetsError",
      statusClass: "http_429",
    });
    // Arbitrary status text collapses to the fixed unknown category.
    const secret = "ya29.jwt-token";
    const redacted = cycleRecord(12, {
      durationMs: 1,
      tablesTouched: [],
      operations: { total: 1, ok: 0, expectedErrors: 0, failures: 1, retries: 0 },
      abort: {
        reason: "cycle-error",
        errorClass: "DirectSheetsError",
        statusClass: secret,
      },
    });
    expect(redacted.abort).toEqual({
      reason: "cycle-error",
      errorClass: "DirectSheetsError",
      statusClass: "unknown",
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });
});

describe("soak artifacts: resources and markdown summary", () => {
  it("samples numeric process resources without any path or env data", async () => {
    const record = await resourceRecord(3, 4096);
    expect(record.cycle).toBe(3);
    expect(record.dbBytes).toBe(4096);
    for (const key of ["rssKb", "heapUsedKb", "externalKb", "uptimeMs"]) {
      expect(typeof record[key]).toBe("number");
      expect(Number.isFinite(record[key])).toBe(true);
    }
    expect(JSON.stringify(record)).not.toMatch(/HIKOUTEI|GOOGLE|credential/i);
  });

  it("renders a redacted markdown summary from the explicit operations shape", () => {
    const markdown = renderSummaryMarkdown({
      scenario: "local-multitable-soak",
      scenarioVersion: 1,
      status: "passed",
      mode: "local",
      stopReason: "duration-budget-reached",
      seed: 20260814,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      elapsedMs: 60_000,
      durationBudgetMs: 60_000,
      cyclesCompleted: 2,
      operations: { total: 64, ok: 60, expectedErrors: 3, failures: 1, retries: 2 },
      probes: { total: 0, ok: 0, skipped: 0, failed: 0 },
      convergence: { checks: 0, failed: 0 },
      scenarios: { expectedErrors: 0, failures: 0 },
      tableRows: { soak_tasks: 8 },
    });
    expect(markdown).toContain("Status: **passed**");
    expect(markdown).toContain("Operations: 64 (ok 60, expected errors 3, failures 1, retries 2)");
    expect(markdown).toContain("Scenarios: 0 expected errors, 0 failures");
    expect(markdown).toContain("| soak_tasks | 8 |");
    expect(markdown).toContain("Stop reason: duration-budget-reached");
    // No ids, URLs, or raw values in the rendered summary.
    expect(markdown).not.toMatch(/docs\.google\.com|spreadsheets\/d\//);
  });

  it("renders a scenario totals line so a scenario-only failure stays visible", () => {
    const markdown = renderSummaryMarkdown({
      scenario: "local-multitable-soak",
      scenarioVersion: 1,
      status: "failed",
      mode: "local",
      stopReason: "max-consecutive-failures",
      seed: 20260814,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      elapsedMs: 60_000,
      durationBudgetMs: 60_000,
      cyclesCompleted: 2,
      // Scenario-only failure with ZERO operation failures must still be
      // visible in the markdown.
      operations: { total: 64, ok: 64, expectedErrors: 0, failures: 0, retries: 0 },
      probes: { total: 0, ok: 0, skipped: 0, failed: 0 },
      convergence: { checks: 0, failed: 0 },
      scenarios: { expectedErrors: 2, failures: 3 },
      tableRows: { soak_tasks: 8 },
    });
    expect(markdown).toContain("Scenarios: 2 expected errors, 3 failures");
    expect(markdown).toContain("Operations: 64 (ok 64, expected errors 0, failures 0, retries 0)");
    expect(markdown).toContain("Status: **failed**");
  });

  it("renders the recovery, cleanup, replacement-cleanup, and finalization sections", () => {
    const markdown = renderSummaryMarkdown({
      scenario: "local-multitable-soak",
      scenarioVersion: 1,
      status: "failed",
      mode: "local",
      stopReason: "duration-budget-reached",
      seed: 20260814,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      elapsedMs: 60_000,
      durationBudgetMs: 60_000,
      cyclesCompleted: 2,
      operations: { total: 64, ok: 60, expectedErrors: 3, failures: 1, retries: 2 },
      probes: { total: 0, ok: 0, skipped: 0, failed: 0 },
      convergence: { checks: 0, failed: 0 },
      scenarios: { expectedErrors: 0, failures: 0 },
      tableRows: { soak_tasks: 8 },
      recovery: { status: "recovered", cycle: 5, reason: "completed-cycle-checkpoint" },
      cleanup: { status: "failed", reason: "runtime-close-failed", errorClass: "Error" },
      replacementCleanup: {
        status: "failed",
        reason: "replacement-close-failed",
        errorClass: "Error",
      },
      finalization: {
        status: "failed",
        reason: "artifact-write-failed",
        step: "log",
        errorClass: "Error",
      },
    });
    expect(markdown).toContain(
      "Recovery: recovered (completed-cycle-checkpoint, cycle 5)",
    );
    expect(markdown).toContain("Cleanup: failed (runtime-close-failed)");
    expect(markdown).toContain("Replacement cleanup: failed (replacement-close-failed)");
    expect(markdown).toContain("Finalization: failed (artifact-write-failed, step log)");
  });
});

describe("soak log collection: logger contract mirror", () => {
  it("mirrors the internal logger's serialization contract exactly", () => {
    // The collector runs under plain Node and cannot import src/** TS, so
    // it carries a deliberate mirror of the logger's contract. Any drift
    // (a new event/component/code/class or field) must fail here so a
    // future library line is never silently dropped or — worse — an
    // un-reviewed value admitted.
    expect(LOGGED_FIELD_NAMES).toEqual([
      "ts", "level", "event", "component", "code", "table", "errorClass",
      "retryable", "attempts", "durationMs", "counts",
    ]);
    expect(LOGGED_LEVELS).toEqual(["debug", "info", "warn", "error"]);
    expect([...LOGGED_EVENT_NAMES].sort()).toEqual(
      [...Object.values(HIKOUTEI_LOG_EVENTS)].sort(),
    );
    expect([...LOGGED_COMPONENT_NAMES].sort()).toEqual(
      [...Object.values(HIKOUTEI_LOG_COMPONENTS)].sort(),
    );
    expect([...LOGGED_CODE_MIRROR].sort()).toEqual([...HIKOUTEI_LOG_STABLE_CODES].sort());
    expect([...LOGGED_CLASS_MIRROR].sort()).toEqual([...HIKOUTEI_LOG_STABLE_CLASSES].sort());
  });

  it("validates single lines: pass allowlisted shapes, drop secrets", () => {
    const valid = sanitizeCollectedLogLine(
      JSON.stringify({
        ts: "2025-01-01T00:00:00.000Z",
        level: "error",
        event: HIKOUTEI_LOG_EVENTS.EM_QUERY_FAILED,
        component: HIKOUTEI_LOG_COMPONENTS.ENTITY_MANAGER,
        code: "invalid_query",
        errorClass: "HikouteiError",
        counts: { attempts: 2 },
      }),
    );
    expect(valid.status).toBe("valid");
    if (valid.status !== "valid") return;
    expect(JSON.parse(valid.line)).toMatchObject({
      ts: "2025-01-01T00:00:00.000Z",
      level: "error",
      event: "hikoutei.em.query_failed",
      code: "invalid_query",
    });

    const secrets = [
      "ya29.jwt-abcdefghijklmnop",
      "service@project.iam.gserviceaccount.com",
      "https://docs.google.com/spreadsheets/d/1AbC/edit",
      "/Users/me/.config/gcloud/application_default_credentials.json",
    ];
    const invalid = [
      "",
      "plain text line",
      "{not json",
      JSON.stringify([1, 2]),
      JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", message: secrets[0] }),
      JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", component: secrets[0] }),
      JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", code: secrets[0] }),
      JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", table: "docs.google.com/x" }),
      JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", errorClass: `Hacked at ${secrets[3]}` }),
      JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", counts: { secret: secrets[0] } }),
      JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.evil.event_name" }),
      JSON.stringify({ ts: "not-a-timestamp", level: "info", event: "hikoutei.runtime.opened" }),
    ];
    for (const line of invalid) {
      expect(sanitizeCollectedLogLine(line).status, line).toBe("invalid");
    }
  });
});
