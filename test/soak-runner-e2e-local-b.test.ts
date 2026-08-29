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

describeLongSoak("soak runner end to end (local, short budget)", () => {

  it(
    "fails the summary with a stable replacement-cleanup reason when a failed reopen leaves an unclosable replacement",
    { timeout: 90_000 },
    async () => {
      // Regression for the replacement-close ownership hole: a replacement
      // that opened before the reopen handoff failed must never be dropped
      // or have its close error swallowed. The runner keeps it tracked,
      // gives the close a final second attempt, and a persistent close
      // failure is a stable cleanup failure that forces the summary to
      // failed — never a silent leak and never a swallowed pass.
      const runDir = path.join(requireDir(), "run-reopen-close-fail");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        __testFailReopenOnCycle: 60,
        __testFailReplacementClose: true,
      }));
      expect(summary.status).toBe("failed");
      expect(summary.stopReason).toBe("reopen-failed");
      expect(summary.replacementCleanup).toEqual({
        status: "failed",
        reason: "replacement-close-failed",
        errorClass: "Error",
      });
      // The persistent replacement close failure counts toward the
      // failure totals (abort + cleanup failure) and is persisted.
      expect(summary.operations.failures).toBeGreaterThanOrEqual(2);
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.cumulative.failures).toBe(summary.operations.failures);
      // Every finalization artifact still lands, and the injected close
      // failure message never reaches any artifact.
      for (const name of ["cycles.jsonl", "state.json", "summary.json", "summary.md", "collected-log.txt"]) {
        expect(await readdir(runDir)).toContain(name);
      }
      for (const name of await readdir(runDir)) {
        if (!name.endsWith(".jsonl") && name !== "summary.md" && name !== "collected-log.txt") continue;
        const content = await readFile(path.join(runDir, name), "utf8");
        expect(content).not.toContain("soak-test-injected-close-failure");
      }
    },
  );

  it(
    "fails the summary with a stable finalization reason when a final artifact step fails",
    { timeout: 60_000 },
    async () => {
      // A final summary/markdown/log-collection/state failure must produce
      // a FAILED summary and a stable redacted finalization section — never
      // a swallowed pass — while the remaining artifacts still land and the
      // summary is still emitted (nothing throws before it).
      const runDir = path.join(requireDir(), "run-final-artifact-fail");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        __testFailFinalArtifactStep: "log",
      }));
      expect(summary.status).toBe("failed");
      expect(summary.finalization).toEqual({
        status: "failed",
        reason: "artifact-write-failed",
        step: "log",
        errorClass: "Error",
      });
      // The corrected summary on disk reports the same failed
      // finalization (best-effort re-persist after the failure).
      const onDisk = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"));
      expect(onDisk.status).toBe("failed");
      expect(onDisk.finalization).toEqual(summary.finalization);
      const markdown = await readFile(path.join(runDir, "summary.md"), "utf8");
      expect(markdown).toContain("Status: **failed**");
      expect(markdown).toContain("Finalization: failed");
      // Every artifact still lands (the failure never blocks the others)
      // and the raw injected message never reaches any artifact.
      for (const name of ["cycles.jsonl", "state.json", "summary.json", "summary.md", "collected-log.txt"]) {
        expect(await readdir(runDir)).toContain(name);
      }
      for (const name of await readdir(runDir)) {
        if (!name.endsWith(".jsonl") && name !== "summary.md" && name !== "collected-log.txt") continue;
        const content = await readFile(path.join(runDir, name), "utf8");
        expect(content).not.toContain("soak-test-injected-final-artifact-failure");
      }
    },
  );

  it(
    "resume round-trips fractional duration/interval values without coercion",
    { timeout: 90_000 },
    async () => {
      // CLI parity: --interval-seconds accepts fractional values and the
      // stored state keeps them verbatim; resume validation must accept
      // the same finite numeric forms a CLI run can legitimately produce
      // (never reject, never round, never silently change the values).
      const runDir = path.join(requireDir(), "run-fractional");
      const first = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runDir, durationHours: 0.001, intervalSeconds: 0.5 }),
      );
      expect(first.status).toBe("passed");
      let state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.params.intervalSeconds).toBe(0.5);
      expect(state.params.durationMs).toBe(0.001 * 3_600_000);

      const second = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runDir, durationHours: 0.001, intervalSeconds: 0.5, resume: true }),
      );
      expect(second.status).toBe("passed");
      // The stored fractional interval is preserved verbatim on resume —
      // never rounded, truncated, or coerced to an integer.
      state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.params.intervalSeconds).toBe(0.5);
    },
  );

  it(
    "resume preserves the prior JSONL history and continues the cycle numbering",
    { timeout: 90_000 },
    async () => {
      const runDir = path.join(requireDir(), "run-history");
      const first = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runDir, durationHours: 0.001 }),
      );
      const before = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).length;
      expect(before).toBe(first.cyclesCompleted);

      const second = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runDir, durationHours: 0.001, resume: true }),
      );
      const after = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      // No reset: cycle 1 is still the first record and the stream is
      // continuous through the resumed run.
      expect(after[0]?.cycle).toBe(1);
      expect(after.length).toBe(second.cyclesCompleted);
      for (let index = 1; index < after.length; index += 1) {
        expect(after[index]!.cycle).toBe(after[index - 1]!.cycle + 1);
      }
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.cumulative.failures).toBe(0);
    },
  );

  it(
    "recovers an interruption at the DB-before-state boundary without duplicates",
    { timeout: 120_000 },
    async () => {
      // HIGH 2: the cycle's SQLite work and cycle record land, then the
      // process dies before the state checkpoint. Resume must advance from
      // the recorded cycle (no SQLite replay, no duplicate rows, no
      // duplicate JSONL, counters exactly consistent with the history).
      const runDir = path.join(requireDir(), "run-interrupt-resume");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptAfterCycleRecord: 5,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("artifact-write-failed");
      // The interruption landed between the cycle record and the state
      // advance: the summary reports 4 checkpointed cycles while the JSONL
      // already holds the record for cycle 5.
      expect(first.cyclesCompleted).toBe(4);
      const firstCycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(firstCycles.map((record) => record.cycle)).toEqual([1, 2, 3, 4, 5]);
      // The state checkpoint lagged behind SQLite: state.json still records
      // cycle 4 while cycles.jsonl has 5 records and the marker is
      // in-flight for cycle 5.
      let state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.lastCompletedCycle).toBe(4);
      const checkpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(checkpoint).toEqual({ version: 1, runId: state.runId, cycle: 5, status: "in-flight" });

      const second = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        resume: true,
      }));
      expect(second.status).toBe("passed");
      expect(second.operations.failures).toBe(0); // no duplicate rows/ids
      expect(second.cyclesCompleted).toBeGreaterThan(first.cyclesCompleted);
      // The redacted recovery reason is persisted in state and summary.
      state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.recovery).toEqual({ cycle: 5, reason: "completed-cycle-checkpoint" });
      expect(second.recovery).toEqual({
        status: "recovered",
        cycle: 5,
        reason: "completed-cycle-checkpoint",
      });
      // No duplicate cycle records: every cycle appears exactly once and
      // the stream stays contiguous through the resumed run.
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cycles.map((record) => record.cycle)).toEqual(
        [...Array(second.cyclesCompleted).keys()].map((index) => index + 1),
      );
      expect(new Set(cycles.map((record) => record.cycle)).size).toBe(cycles.length);
      // Consistent counters: the resumed totals continue from the executed
      // totals with exactly 32 ops per continued cycle — cycle 5 is never
      // double-counted.
      const opsPerCycle = 32;
      expect(second.operations.total).toBe(
        first.operations.total +
          (second.cyclesCompleted - first.cyclesCompleted) * opsPerCycle,
      );
      expect(state.cumulative.operations).toBe(second.operations.total);
      expect(state.cumulative.failures).toBe(0);
      // The marker advanced to completed for the final cycle.
      const finalCheckpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(finalCheckpoint).toEqual({
        version: 1,
        runId: state.runId,
        cycle: second.cyclesCompleted,
        status: "completed",
      });
      // The summary markdown surfaces the redacted recovery line.
      const markdown = await readFile(path.join(runDir, "summary.md"), "utf8");
      expect(markdown).toContain("Status: **passed**");
      expect(markdown).toContain("Recovery: recovered (completed-cycle-checkpoint, cycle 5)");
    },
  );

  it(
    "reconciles an interruption before the cycle record without duplicates",
    { timeout: 120_000 },
    async () => {
      // HIGH 2: the cycle's prologue SQLite work committed but the process
      // died before ANY record landed (no cycle record, no state advance,
      // marker left in-flight). Resume must re-run the interrupted cycle
      // ONCE with reconciliation: the oracle is rebuilt from SQLite (the
      // authority), already-committed deterministic rows are accepted only
      // when their content matches, and totals stay consistent — never a
      // duplicate row, duplicate record, or double-counted cycle.
      const runDir = path.join(requireDir(), "run-interrupt-midcycle");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: 5,
      }));
      // The simulated interruption is a failed run that stops before cycle
      // 5 was ever recorded.
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("simulated-interruption");
      expect(first.cyclesCompleted).toBe(4);
      const firstCycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      // No cycle record for the interrupted cycle: exactly the four fully
      // checkpointed cycles are on disk.
      expect(firstCycles.map((record) => record.cycle)).toEqual([1, 2, 3, 4]);
      let state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.lastCompletedCycle).toBe(4);
      const checkpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(checkpoint).toEqual({ version: 1, runId: state.runId, cycle: 5, status: "in-flight" });

      const second = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        resume: true,
      }));
      expect(second.status).toBe("passed");
      // Reconciliation: the re-run accepted the committed prologue rows —
      // no duplicates, no content mismatches, no failures.
      expect(second.operations.failures).toBe(0);
      expect(second.cyclesCompleted).toBeGreaterThan(first.cyclesCompleted);
      state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.recovery).toEqual({ cycle: 5, reason: "interrupted-cycle-reconciled" });
      expect(second.recovery).toEqual({
        status: "recovered",
        cycle: 5,
        reason: "interrupted-cycle-reconciled",
      });
      // The interrupted cycle was re-run exactly once: the JSONL stream is
      // contiguous from 1 with no duplicate cycle records.
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cycles.map((record) => record.cycle)).toEqual(
        [...Array(second.cyclesCompleted).keys()].map((index) => index + 1),
      );
      expect(new Set(cycles.map((record) => record.cycle)).size).toBe(cycles.length);
      // Counters: cycle 5 is counted exactly once (by the re-run) and the
      // resumed totals continue at exactly 32 ops per cycle.
      const opsPerCycle = 32;
      expect(second.operations.total).toBe(
        first.operations.total +
          (second.cyclesCompleted - first.cyclesCompleted) * opsPerCycle,
      );
      expect(state.cumulative.operations).toBe(second.operations.total);
      expect(state.cumulative.failures).toBe(0);
      // The marker advanced to completed for the final cycle.
      const finalCheckpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(finalCheckpoint).toEqual({
        version: 1,
        runId: state.runId,
        cycle: second.cyclesCompleted,
        status: "completed",
      });
      const markdown = await readFile(path.join(runDir, "summary.md"), "utf8");
      expect(markdown).toContain("Status: **passed**");
      expect(markdown).toContain("Recovery: recovered (interrupted-cycle-reconciled, cycle 5)");
    },
  );

  it(
    "reconciles an interruption during the FIRST cycle from the pure replay plan (lastCompletedCycle 0)",
    { timeout: 120_000 },
    async () => {
      // HIGH 2: a run interrupted during its FIRST cycle leaves a
      // zero-cycle state (lastCompletedCycle 0, empty tableRows, in-flight
      // marker at 1) with PARTIAL SQLite rows (cycle-1 prologue rows). The
      // recovery must (a) accept that state (the empty tableRows set is
      // the legitimate initial state), (b) derive the reconciled cycle's
      // plan from the PURE deterministic replay of the stored seed/params
      // — never from the partial SQLite rows — and (c) reconcile without
      // failures or duplicates.
      const runDir = path.join(requireDir(), "run-interrupt-first-cycle");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: 1,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("simulated-interruption");
      expect(first.cyclesCompleted).toBe(0);
      let state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.lastCompletedCycle).toBe(0);
      expect(state.tableRows).toEqual({});
      const checkpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(checkpoint).toEqual({ version: 1, runId: state.runId, cycle: 1, status: "in-flight" });
      // PARTIAL rows committed by the interrupted run exist in SQLite
      // before the resume plans anything.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const partialDb = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        const partial = partialDb.prepare(
          "select count(*) as count from soak_tasks where id like '%-main-c1'",
        ).get();
        expect(partial?.count).toBe(1);
      } finally {
        partialDb.close();
      }

      const second = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        resume: true,
      }));
      expect(second.status).toBe("passed");
      expect(second.operations.failures).toBe(0);
      expect(second.cyclesCompleted).toBeGreaterThan(0);
      state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.recovery).toEqual({ cycle: 1, reason: "interrupted-cycle-reconciled" });
      // No duplicates: the stream starts at cycle 1 with exactly one record
      // per cycle.
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cycles[0]?.cycle).toBe(1);
      expect(cycles.length).toBe(second.cyclesCompleted);
      expect(new Set(cycles.map((record) => record.cycle)).size).toBe(cycles.length);

      // The reconciled cycle-1 plan is EXACTLY the deterministic plan: a
      // reference run with the same seed, uninterrupted, must produce the
      // same operation kinds and tables for every (actor, index) of cycle
      // 1. Pre-fix, planning ran against the partial-SQLite oracle and
      // could produce a different kind pool/filters.
      const referenceDir = path.join(requireDir(), "run-interrupt-first-cycle-ref");
      const reference = await runLocalMultiTableSoak(shortOptions({
        outputDir: referenceDir,
        durationHours: 0.0015,
      }));
      expect(reference.status).toBe("passed");
      const readPlans = async (dir: string) => {
        const lines = (await readFile(path.join(dir, "operations.jsonl"), "utf8"))
          .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
        return lines
          .filter((record) => record.cycle === 1)
          .map((record) => ({
            actor: record.actor,
            index: record.index,
            kind: record.kind,
            table: record.table,
          }));
      };
      expect(await readPlans(runDir)).toEqual(await readPlans(referenceDir));
    },
  );

  it(
    "repairs a stale in-flight marker when the state checkpoint landed before the completed marker",
    { timeout: 120_000 },
    async () => {
      // HIGH 2: the cycle record AND the atomic state checkpoint landed
      // but the process died before the completed marker. Resume repairs
      // the stale in-flight marker (re-persists state, backfills the
      // resource sample, advances the marker) and continues from the
      // checkpointed cycle — no SQLite replay, no duplicate rows, no
      // double-counted counters.
      const runDir = path.join(requireDir(), "run-interrupt-after-state");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptAfterState: 5,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("artifact-write-failed");
      expect(first.cyclesCompleted).toBe(5);
      // The state checkpoint for cycle 5 landed (atomic write) but the
      // marker still says in-flight.
      let state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.lastCompletedCycle).toBe(5);
      const checkpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(checkpoint).toEqual({ version: 1, runId: state.runId, cycle: 5, status: "in-flight" });

      const second = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        resume: true,
      }));
      expect(second.status).toBe("passed");
      expect(second.operations.failures).toBe(0);
      expect(second.cyclesCompleted).toBeGreaterThan(first.cyclesCompleted);
      state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.recovery).toEqual({ cycle: 5, reason: "stale-in-flight-marker" });
      expect(second.recovery).toEqual({
        status: "recovered",
        cycle: 5,
        reason: "stale-in-flight-marker",
      });
      // No duplicate cycle records and the stream stays contiguous.
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cycles.map((record) => record.cycle)).toEqual(
        [...Array(second.cyclesCompleted).keys()].map((index) => index + 1),
      );
      expect(new Set(cycles.map((record) => record.cycle)).size).toBe(cycles.length);
      // The resource sample for cycle 5 was backfilled by the repair:
      // every checkpointed cycle has exactly one resource record.
      const resources = (await readFile(path.join(runDir, "resources.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(new Set(resources.map((record) => record.cycle))).toEqual(
        new Set(cycles.map((record) => record.cycle)),
      );
      // Counters continue exactly: cycle 5 is never double-counted.
      const opsPerCycle = 32;
      expect(second.operations.total).toBe(
        first.operations.total +
          (second.cyclesCompleted - first.cyclesCompleted) * opsPerCycle,
      );
      expect(state.cumulative.operations).toBe(second.operations.total);
      expect(state.cumulative.failures).toBe(0);
      const finalCheckpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(finalCheckpoint).toEqual({
        version: 1,
        runId: state.runId,
        cycle: second.cyclesCompleted,
        status: "completed",
      });
      const markdown = await readFile(path.join(runDir, "summary.md"), "utf8");
      expect(markdown).toContain("Status: **passed**");
      expect(markdown).toContain("Recovery: recovered (stale-in-flight-marker, cycle 5)");
    },
  );

  it(
    "rejects a resume when the previous run's finalization failed",
    { timeout: 60_000 },
    async () => {
      // MEDIUM 5: a failed final artifact step persists a redacted
      // finalization-failed marker in state; a later --resume must REJECT
      // the state instead of silently overwriting the failed finalization
      // with a passed run.
      const runDir = path.join(requireDir(), "run-finalization-marker");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        __testFailFinalArtifactStep: "log",
      }));
      expect(first.status).toBe("failed");
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.finalization).toEqual({
        status: "failed",
        reason: "artifact-write-failed",
        step: "log",
      });
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/finalization marks the previous run as failed/);
    },
  );

  it(
    "--tables scopes the runtime, workload, verification, and artifacts to the subset",
    { timeout: 60_000 },
    async () => {
      const runDir = path.join(requireDir(), "run-subset");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        tables: ["soak_tasks"],
      }));
      expect(summary.status).toBe("passed");
      expect(Object.keys(summary.tableRows)).toEqual(["soak_tasks"]);
      // The SQLite authority must contain ONLY the selected table; a subset
      // run must not provision the other five.
      // The SQLite authority must contain ONLY the selected table; a subset
      // run must not provision the other five. node:sqlite is loaded through
      // process.getBuiltinModule (same pattern as the ikisaki kernel tests)
      // because vitest 1.6's module graph does not resolve node:sqlite.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        const tables = db.prepare(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
        ).all().map((row) => row.name);
        expect(tables).toEqual(["soak_tasks"]);
      } finally {
        db.close();
      }
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      for (const record of cycles) {
        expect(record.tablesTouched).toEqual(["soak_tasks", "SoakTask"].sort());
      }
    },
  );
});
