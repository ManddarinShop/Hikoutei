/**
 * End-to-end soak runner test against the LOCAL source tree.
 *
 * Runs the real `runLocalMultiTableSoak` loop for a short deterministic
 * budget (the same shape as the documented 6h/24h executions, scaled down):
 * the explicit numeric operations summary, the reopen cadence (every 60th
 * cycle the runtime closes and reopens), the resume path, and the redaction
 * of every artifact line. No credentials and no live Sheets are involved.
 */


import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeOptions } from "../scripts/ci/local-soak/args.mjs";
import { createArtifactWriter } from "../scripts/ci/local-soak/artifacts.mjs";
import { buildSoakEntities, SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom, deriveSeed, parseSeed } from "../scripts/ci/local-soak/prng.mjs";
import {
  generatePatch,
  generateRow,
  planActorOperation,
  sharedEntityId,
} from "../scripts/ci/local-soak/operations.mjs";
import { SoakOracle } from "../scripts/ci/local-soak/oracle.mjs";
import type { OracleFieldSpec } from "../scripts/ci/local-soak/oracle.d.mts";
import {
  expectedColumnName,
  inspectSqliteSchema,
  missingSchemaEntries,
  soakTableColumns,
} from "../scripts/ci/local-soak/schemaInspect.mjs";
import { createTypedSheets, type HikouteiEntity } from "../src/index.js";
import { defineTypedSheetsEntity } from "../src/index.js";
import {
  boundedSleep,
  checkSheetsConvergence,
  closeRuntimeWithFinalRetry,
  deadlineRemainingMs,
  extractProjectionIds,
  isSafeEpochTimestampMs,
  openRuntimeWithinDeadline,
  planResumeRecovery,
  RECOVERY_REASONS,
  replayDeterministicHistory,
  runLocalMultiTableSoak,
  stableErrorTag,
  SYSTEM_STATE_READINESS_POLL_MS,
  waitForRuntimeSystemStateReadiness,
} from "../scripts/ci/local-soak/runner.mjs";
import { describeSoakFailure } from "../scripts/ci/run-local-multitable-soak.mjs";
import { resetHikouteiInternalLoggerForTests } from "../src/shared/observability/internalLog.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "../src/application/sync/service/SyncServiceBootstrap.js";
import { readRuntimeSystemStateReadiness } from "../src/application/sync/service/systemStateReadiness.js";
import {
  StubSpreadsheet,
  StubSheetsTransport,
} from "./support/StubSheetsTransport.js";

import {
  SYMLINK_SUPPORTED,
  describeLongSoak,
  SHORT_DURATION_HOURS,
  soakTestBeforeAll,
  soakTestBeforeEach,
  soakTestAfterEach,
  soakTestAfterAll,
  requireDir,
  shortOptions,
  validResumeStateFixture,
  writeSoakCredentialsFile,
  plantSqliteValue,
  plantSqliteValues,
  plantedProbeEvidence,
  plantNewRow,
  deterministicForkIsolationStage,
  applyPlannedFinalState,
  deterministicProbeField,
} from "./support/soakRunnerShared.js";

vi.mock("@googleapis/sheets", async () => {
  const { liveSoakSheetsClient } = await import("./support/soakRunnerShared.js");
  return { sheets: () => liveSoakSheetsClient };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: class {} }));

beforeAll(soakTestBeforeAll);
beforeEach(soakTestBeforeEach);
afterEach(soakTestAfterEach);
afterAll(soakTestAfterAll);

describe("soak runner deadline clock", () => {
  it("treats a future epoch deadline as not immediately expired", () => {
    const now = Date.now();
    expect(deadlineRemainingMs(now + 5_000, now)).toBe(5_000);
    expect(deadlineRemainingMs(now + 250, now)).toBe(250);
    // An already-past deadline has zero remaining budget, never negative.
    expect(deadlineRemainingMs(now - 1, now)).toBe(0);
    expect(deadlineRemainingMs(now, now)).toBe(0);
  });

  it("bounded wait honors the deadline instead of the full poll interval", async () => {
    const startedAt = Date.now();
    // Poll interval far beyond the deadline: the sleep must end at the
    // deadline, not after the full poll.
    await boundedSleep(5_000, startedAt + 120, startedAt);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(110);
    expect(elapsed).toBeLessThan(1_000);
    // An already-expired deadline resolves immediately.
    await boundedSleep(5_000, startedAt - 1, startedAt);
  });
});


describe("soak runner stable error tags and CLI diagnostics", () => {
  it("sanitizes custom error class names in progress diagnostics", () => {
    // A custom error class name can embed a path, URL, or id-like token;
    // progress tags must pass the stable class allowlist.
    const raw = new Error("boom");
    raw.name = "EvilAt/Users/secret/ya29.jwt";
    expect(stableErrorTag(raw)).toBe("unknown");
    expect(stableErrorTag(new Error("plain"))).toBe("Error");
    expect(stableErrorTag({ name: "SoakReopenCleanupError" })).toBe("SoakReopenCleanupError");
    expect(stableErrorTag({ name: "HikouteiError", code: "sync_startup_failed" }))
      .toBe("HikouteiError (sync_startup_failed)");
    // Unknown codes collapse to the class only, never to the raw code.
    expect(stableErrorTag({ name: "HikouteiError", code: "ya29.jwt-token" })).toBe("HikouteiError");
    expect(stableErrorTag(undefined)).toBe("unknown");
  });

  it("prints only allowlisted class/code/status-class text in CLI diagnostics", () => {
    const raw = new Error("boom");
    raw.name = "Error: at /Users/secret/file.ts";
    expect(describeSoakFailure(raw)).toBe("unknown");
    expect(describeSoakFailure(new Error("plain"))).toBe("Error");
    expect(describeSoakFailure({
      name: "HikouteiError",
      code: "sync_startup_failed",
    })).toBe("HikouteiError (sync_startup_failed)");
    expect(describeSoakFailure({
      name: "DirectSheetsError",
      statusClass: "http_403",
    })).toBe("DirectSheetsError (http_403)");
    // An unknown status class collapses to the class name only, never
    // the raw text.
    expect(describeSoakFailure({
      name: "DirectSheetsError",
      statusClass: "ya29.jwt-token",
    })).toBe("DirectSheetsError");
    expect(describeSoakFailure(undefined)).toBe("unknown");
  });
});


describe("soak runner final close retry", () => {
  it("retries a genuine first close failure and recovers by re-invoking close", async () => {    let calls = 0;
    const runtime = {
      async close() {
        calls += 1;
        if (calls === 1) throw new Error("provider-down");
      },
    };
    const error = await closeRuntimeWithFinalRetry(runtime);
    expect(error).toBeUndefined();
    // The retry GENUINELY re-invoked the runtime close (provider cleanup).
    expect(calls).toBe(2);
  });

  it("returns the persistent close error after two genuine attempts", async () => {
    let calls = 0;
    const runtime = {
      async close() {
        calls += 1;
        throw new Error("provider-down");
      },
    };
    const error = await closeRuntimeWithFinalRetry(runtime);
    expect(error?.message).toBe("provider-down");
    expect(calls).toBe(2);
  });

  it("closes once on immediate success", async () => {
    let calls = 0;
    const runtime = { async close() { calls += 1; } };
    const error = await closeRuntimeWithFinalRetry(runtime);
    expect(error).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("failClose injects a first-attempt failure and the retry delegates to the real close", async () => {
    let calls = 0;
    const runtime = { async close() { calls += 1; } };
    const error = await closeRuntimeWithFinalRetry(runtime, { failClose: true });
    expect(error).toBeUndefined();
    // Attempt 1 was injected; attempt 2 ran the REAL runtime close once.
    expect(calls).toBe(1);
  });

  it("failClosePersistent fails both attempts while the retry still runs the real close", async () => {
    let calls = 0;
    const runtime = { async close() { calls += 1; } };
    const error = await closeRuntimeWithFinalRetry(runtime, { failClosePersistent: true });
    expect(error?.message).toBe("soak-test-injected-close-failure");
    // The retry genuinely invoked the provider cleanup before failing.
    expect(calls).toBe(1);
  });

  it("treats a close that throws undefined as a failed close (never a silent pass)", async () => {
    // MEDIUM 3: boolean failure tracking, never `error !== undefined` — a
    // runtime whose close rejects with `undefined` (a hook or provider
    // that throws a non-Error value) must report a FAILED close so the
    // run records a stable cleanup failure instead of a masked pass.
    let calls = 0;
    const runtime = {
      async close() {
        calls += 1;
        throw undefined;
      },
    };
    const error = await closeRuntimeWithFinalRetry(runtime);
    expect(calls).toBe(2); // both attempts genuinely ran the close
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/non-Error/);
  });
});


describe("soak runner deadline-gated startup", () => {
  it("returns the runtime unchanged when the open finishes inside the deadline", async () => {
    let closeCalls = 0;
    const runtime = {
      async close() {
        closeCalls += 1;
      },
    };
    const opened = await openRuntimeWithinDeadline(async () => runtime, Date.now() + 60_000);
    expect(opened).toBe(runtime);
    expect(closeCalls).toBe(0);
  });

  it("closes a runtime whose open returned after the deadline and fails with deadline_expired", async () => {
    // MEDIUM 5: sync startup that returns after the run budget expired
    // must never be claimed as a within-budget run: the runtime is closed
    // (best effort) and the stable deadline_expired failure is raised.
    let closeCalls = 0;
    const runtime = {
      async close() {
        closeCalls += 1;
      },
    };
    await expect(
      openRuntimeWithinDeadline(async () => runtime, Date.now() - 1),
    ).rejects.toMatchObject({
      name: "SoakDeadlineExpiredError",
      statusClass: "deadline_expired",
      reasonCode: "deadline-expired",
    });
    expect(closeCalls).toBe(1);
  });

  it("still fails with deadline_expired when the post-deadline close also fails", async () => {
    // The deadline failure dominates: an unclosable late runtime cannot
    // mask the deadline_expired outcome.
    const runtime = {
      async close() {
        throw new Error("late runtime close failed");
      },
    };
    await expect(
      openRuntimeWithinDeadline(async () => runtime, Date.now() - 1),
    ).rejects.toMatchObject({
      name: "SoakDeadlineExpiredError",
      statusClass: "deadline_expired",
    });
  });
});


describe("soak runner recovery planner and safe timestamps", () => {
  const state = { lastCompletedCycle: 7 };

  it("plans no recovery for a missing or completed checkpoint", () => {
    expect(planResumeRecovery(undefined, state, new Map())).toBeUndefined();
    expect(planResumeRecovery(
      { version: 1, runId: "r", cycle: 7, status: "completed" },
      state,
      new Map(),
    )).toBeUndefined();
  });

  it("plans a stale-marker repair when state already checkpointed the cycle", () => {
    expect(planResumeRecovery(
      { version: 1, runId: "r", cycle: 7, status: "in-flight" },
      state,
      new Map(),
    )).toEqual({ cycle: 7, reason: RECOVERY_REASONS.STALE_IN_FLIGHT_MARKER });
  });

  it("plans a bookkeeping-only advance when the cycle record already landed", () => {
    expect(planResumeRecovery(
      { version: 1, runId: "r", cycle: 8, status: "in-flight" },
      state,
      new Map([[8, { cycle: 8 }]]),
    )).toEqual({ cycle: 8, reason: RECOVERY_REASONS.COMPLETED_CYCLE_CHECKPOINT });
  });

  it("plans a full SQLite reconciliation when the interrupted cycle has no record", () => {
    expect(planResumeRecovery(
      { version: 1, runId: "r", cycle: 8, status: "in-flight" },
      state,
      new Map(),
    )).toEqual({ cycle: 8, reason: RECOVERY_REASONS.INTERRUPTED_CYCLE_RECONCILED });
  });

  it("isSafeEpochTimestampMs accepts only finite timestamps in the ISO date range", () => {
    expect(isSafeEpochTimestampMs(Date.now())).toBe(true);
    expect(isSafeEpochTimestampMs(0)).toBe(true);
    expect(isSafeEpochTimestampMs(-8_640_000_000_000_000)).toBe(true);
    expect(isSafeEpochTimestampMs(8_640_000_000_000_000)).toBe(true);
    expect(isSafeEpochTimestampMs(8_640_000_000_000_001)).toBe(false);
    expect(isSafeEpochTimestampMs(-8_640_000_000_000_001)).toBe(false);
    expect(isSafeEpochTimestampMs(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isSafeEpochTimestampMs(Number.NaN)).toBe(false);
    expect(isSafeEpochTimestampMs("now")).toBe(false);
    expect(isSafeEpochTimestampMs(null)).toBe(false);
    expect(isSafeEpochTimestampMs(undefined)).toBe(false);
  });
});
