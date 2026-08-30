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
import { resetHikouteiInternalLoggerForTests } from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import { readRuntimeSystemStateReadiness } from "@hikoutei/sync-engine/sync/service/systemStateReadiness.js";
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

describeLongSoak("soak runner end to end (local, short budget)", () => {  it(
    "passes with a fully numeric operations summary and reopen records",
    { timeout: 60_000 },
    async () => {
      const summary = await runLocalMultiTableSoak(shortOptions());

      expect(summary.status).toBe("passed");
      expect(summary.stopReason).toBe("duration-budget-reached");
      expect(summary.mode).toBe("local");
      expect(summary.cyclesCompleted).toBeGreaterThanOrEqual(60);

      const operations = summary.operations;
      for (const key of ["total", "ok", "expectedErrors", "failures", "retries"] as const) {
        expect(typeof operations[key]).toBe("number");
        expect(Number.isFinite(operations[key])).toBe(true);
        expect(operations[key]).toBeGreaterThanOrEqual(0);
      }
      expect(operations.total).toBe(operations.ok + operations.expectedErrors + operations.failures);
      expect(operations.failures).toBe(0);
      // The cycle summary feeds the same shape (regression: this was NaN/null
      // when the per-cycle count was read as an object).
      const state = JSON.parse(
        await readFile(path.join(requireDir(), "run-1", "state.json"), "utf8"),
      );
      expect(state.cumulative.operations).toBe(operations.total);
      expect(state.cumulative.failures).toBe(0);
    },
  );

  it(
    "writes redacted JSONL artifacts with the reopen cadence exercised",
    { timeout: 60_000 },
    async () => {
      const summary = await runLocalMultiTableSoak(shortOptions({ outputDir: path.join(requireDir(), "run-2") }));

      const runDir = path.join(requireDir(), "run-2");
      const files = await readdir(runDir);
      for (const name of [
        "cycles.jsonl",
        "operations.jsonl",
        "resources.jsonl",
        "state.json",
        "summary.json",
        "summary.md",
        "collected-log.txt",
        "hikoutei-internal-log.txt",
      ]) {
        expect(files).toContain(name);
      }

      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      expect(cycles.length).toBe(summary.cyclesCompleted);
      expect(cycles.some((record) => record.reopen?.status === "ok")).toBe(true);
      for (const record of cycles) {
        expect(typeof record.operations).toBe("number");
        expect(typeof record.failures).toBe("number");
      }

      const operations = (await readFile(path.join(runDir, "operations.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      for (const record of operations) {
        expect(record).not.toHaveProperty("row");
        expect(record).not.toHaveProperty("mutateId");
        expect(record).not.toHaveProperty("message");
        expect(JSON.stringify(record)).not.toMatch(/-c\d+|docs\.google\.com|@/);
        if (record.status === "failed") {
          expect(record.reason).toBeDefined();
        }
      }
      expect(operations.length).toBeGreaterThan(0);

      const markdown = await readFile(path.join(runDir, "summary.md"), "utf8");
      expect(markdown).toContain("Status: **passed**");

      const summaryJson = JSON.parse(
        await readFile(path.join(runDir, "summary.json"), "utf8"),
      );
      expect(summaryJson).toEqual(summary);
    },
  );

  it(
    "resumes from the stored state with the stored seed and continuous totals",
    { timeout: 90_000 },
    async () => {
      const runDir = path.join(requireDir(), "run-3");
      const first = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runDir, durationHours: 0.001 }),
      );
      const second = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runDir, durationHours: 0.001, resume: true, seed: "0xdead" }),
      );
      expect(second.status).toBe("passed");
      expect(second.cyclesCompleted).toBeGreaterThan(first.cyclesCompleted);
      expect(second.seed).toBe(first.seed); // stored seed wins over the new --seed
      expect(second.operations.total).toBe(
        first.operations.total +
          (second.cyclesCompleted - first.cyclesCompleted) * 32,
      );
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.cumulative.operations).toBe(second.operations.total);
    },
  );

  it(
    "reproduces identical per-cycle and per-operation results from the same seed",
    { timeout: 120_000 },
    async () => {
      // Regression for scheduling-dependent false mismatches: planning runs
      // up front and every oracle-touching section is serialized, so the
      // same seed must produce the same operation stream and outcomes no
      // matter how the forked actors interleave.
      const runA = path.join(requireDir(), "det-a");
      const runB = path.join(requireDir(), "det-b");
      const first = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runA, seed: "20260814", durationHours: 0.001 }),
      );
      const second = await runLocalMultiTableSoak(
        shortOptions({ outputDir: runB, seed: "20260814", durationHours: 0.001 }),
      );
      expect(first.operations.failures).toBe(0);
      expect(second.operations.failures).toBe(0);

      const strip = (record: Record<string, unknown>) => {
        const { ts: _ts, durationMs: _durationMs, ...rest } = record;
        return rest;
      };
      const cyclesA = (await readFile(path.join(runA, "cycles.jsonl"), "utf8"))
        .trim().split("\n").map((line) => strip(JSON.parse(line)));
      const cyclesB = (await readFile(path.join(runB, "cycles.jsonl"), "utf8"))
        .trim().split("\n").map((line) => strip(JSON.parse(line)));
      const sharedCycles = Math.min(cyclesA.length, cyclesB.length);
      expect(sharedCycles).toBeGreaterThan(50);
      expect(cyclesA.slice(0, sharedCycles)).toEqual(cyclesB.slice(0, sharedCycles));

      const opsA = (await readFile(path.join(runA, "operations.jsonl"), "utf8"))
        .trim().split("\n").map((line) => strip(JSON.parse(line)));
      const opsB = (await readFile(path.join(runB, "operations.jsonl"), "utf8"))
        .trim().split("\n").map((line) => strip(JSON.parse(line)));
      // Operation records cover only the actor stream: 2 actors x 4 ops.
      const opsPerCycle = 8;
      expect(opsA.slice(0, sharedCycles * opsPerCycle)).toEqual(
        opsB.slice(0, sharedCycles * opsPerCycle));
    },
  );

  it(
    "converts an escaping cycle exception into a redacted abort failure on the budget",
    { timeout: 90_000 },
    async () => {
      const runDir = path.join(requireDir(), "run-abort");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        maxConsecutiveFailures: 5,
        __testFailOnCycle: 2,
      }));
      // The abort is a failure, never a silent skip: it increments the
      // budget and fails the run while every artifact still lands.
      expect(summary.status).toBe("failed");
      expect(summary.operations.failures).toBeGreaterThanOrEqual(1);
      expect(summary.cyclesCompleted).toBeGreaterThan(2);

      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const aborted = cycles.find((record) => record.cycle === 2);
      expect(aborted).toBeDefined();
      expect(aborted.abort).toEqual({ reason: "cycle-error", errorClass: "Error" });
      expect(aborted.failures).toBe(1);
      expect(aborted.operations).toBe(1); // one attempted-and-failed unit

      for (const name of ["cycles.jsonl", "operations.jsonl", "state.json", "summary.json", "summary.md", "collected-log.txt"]) {
        expect(await readdir(runDir)).toContain(name);
      }
      // The raw injected message never reaches any artifact.
      for (const name of await readdir(runDir)) {
        if (!name.endsWith(".jsonl") && name !== "summary.md" && name !== "collected-log.txt") continue;
        const content = await readFile(path.join(runDir, name), "utf8");
        expect(content).not.toContain("soak-test-injected-cycle-failure");
      }
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.cumulative.failures).toBe(summary.operations.failures);
    },
  );

  it(
    "stops with max-consecutive-failures when a cycle abort exhausts the budget",
    { timeout: 60_000 },
    async () => {
      const runDir = path.join(requireDir(), "run-abort-stop");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        maxConsecutiveFailures: 1,
        __testFailOnCycle: 1,
      }));
      expect(summary.stopReason).toBe("max-consecutive-failures");
      expect(summary.status).toBe("failed");
      expect(summary.cyclesCompleted).toBe(1);
      expect(JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf8"))).toEqual(summary);
      expect(await readdir(runDir)).toContain("collected-log.txt");
    },
  );

  it(
    "stops with a stable reopen-cleanup abort when the safe-handoff reopen fails",
    { timeout: 90_000 },
    async () => {
      // Regression for the live writer-lease handoff: the old runtime
      // closes BEFORE the replacement opens, so an injected failure right
      // after the replacement opens leaves NO runtime to continue with.
      // The run must record a stable abort/cleanup failure and stop with
      // `reopen-failed` — never continue against a closed runtime, never
      // hang, and never report success.
      const runDir = path.join(requireDir(), "run-reopen-abort");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        __testFailReopenOnCycle: 60,
      }));
      expect(summary.status).toBe("failed");
      expect(summary.stopReason).toBe("reopen-failed");
      expect(summary.cyclesCompleted).toBe(60);

      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const aborted = cycles.find((record) => record.cycle === 60);
      expect(aborted).toBeDefined();
      expect(aborted.abort).toEqual({
        reason: "reopen-cleanup-failed",
        errorClass: "SoakReopenCleanupError",
      });
      expect(aborted.failures).toBe(1);
      // No hang and no continuation on a closed runtime: the run stopped
      // right after the failed reopen and every artifact landed.
      expect(cycles.length).toBe(60);
      for (const name of ["cycles.jsonl", "state.json", "summary.json", "summary.md", "collected-log.txt"]) {
        expect(await readdir(runDir)).toContain(name);
      }
      // The injected reopen failure message never reaches any artifact.
      for (const name of await readdir(runDir)) {
        if (!name.endsWith(".jsonl") && name !== "summary.md" && name !== "collected-log.txt") continue;
        const content = await readFile(path.join(runDir, name), "utf8");
        expect(content).not.toContain("soak-test-injected-reopen-failure");
      }
    },
  );

  it(
    "recovers on the final close retry with a genuinely re-run provider cleanup",
    { timeout: 60_000 },
    async () => {
      // HIGH 1 regression: after a first close attempt fails, the runner's
      // final retry must genuinely re-invoke the runtime close (provider
      // cleanup) instead of no-oping — with a retryable Hikoutei close the
      // run then RECOVERS and passes, and the collected log proves the real
      // close (RUNTIME_CLOSED) ran during the retry.
      const runDir = path.join(requireDir(), "run-close-retry");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        __testCloseFail: true,
      }));
      expect(summary.status).toBe("passed");
      expect(summary.cleanup).toBeUndefined();
      expect(summary.operations.failures).toBe(0);
      // The retry genuinely ran the provider cleanup: the real close event
      // is on disk (the injected first attempt never reached the runtime).
      const collected = await readFile(path.join(runDir, "collected-log.txt"), "utf8");
      expect(collected).toContain("hikoutei.runtime.closed");
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.cumulative.failures).toBe(0);
    },
  );

  it(
    "fails the summary with a stable cleanup reason when the final close fails persistently",
    { timeout: 60_000 },
    async () => {
      // A persistent runtime close failure after the loop must never be
      // swallowed into a passed result: the run counts the failure, keeps
      // every artifact, and reports a stable redacted cleanup reason — even
      // though the retry genuinely re-ran the provider cleanup.
      const runDir = path.join(requireDir(), "run-close-fail");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        __testCloseFailPersistent: true,
      }));
      expect(summary.status).toBe("failed");
      expect(summary.cleanup).toEqual({
        status: "failed",
        reason: "runtime-close-failed",
        errorClass: "Error",
      });
      expect(summary.operations.failures).toBeGreaterThanOrEqual(1);
      // The failure increment is persisted so a resumed run keeps honest
      // totals even though the loop already ended.
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.cumulative.failures).toBe(summary.operations.failures);
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
    "collects the final runtime events in the collected log after close",
    { timeout: 60_000 },
    async () => {
      // The process logger queue must be drained before collection: the
      // RUNTIME_CLOSED event emitted inside close() has to be on disk when
      // collectInternalLog reads the file.
      const runDir = path.join(requireDir(), "run-final-events");
      await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      const collected = await readFile(path.join(runDir, "collected-log.txt"), "utf8");
      expect(collected).toContain("hikoutei.runtime.opened");
      expect(collected).toContain("hikoutei.runtime.closed");
      for (const line of collected.split("\n").filter((entry) => entry.trim() !== "")) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        // Collected log lines keep the redacted structured shape only.
        expect(Object.keys(parsed)).not.toContain("message");
        expect(Object.keys(parsed)).not.toContain("stack");
      }
    },
  );

  it(
    "--resume fails on a missing or invalid state instead of starting fresh",
    { timeout: 30_000 },
    async () => {
      const missingDir = path.join(requireDir(), "resume-missing");
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: missingDir, resume: true })),
      ).rejects.toThrow(/no state\.json exists/);

      const corruptDir = path.join(requireDir(), "resume-corrupt");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(corruptDir, { recursive: true });
      await writeFile(path.join(corruptDir, "state.json"), "{not json", "utf8");
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: corruptDir, resume: true })),
      ).rejects.toThrow(/not valid JSON/);

      // A PARTIAL/truncated state write (simulated by cutting a real
      // state document mid-write) must fail safely before any runtime
      // opens — never silently continue as a degraded or fresh run.
      const truncatedDir = path.join(requireDir(), "resume-truncated");
      await mkdir(truncatedDir, { recursive: true });
      await writeFile(
        path.join(truncatedDir, "state.json"),
        '{\n  "version": 1,\n  "runId": "soak-',
        "utf8",
      );
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: truncatedDir, resume: true })),
      ).rejects.toThrow(/not valid JSON/);
      // A rejected resume never opens a runtime or writes new artifacts.
      expect(await readdir(truncatedDir)).toEqual(["state.json"]);

      // A state.json that PARSES but is not an object is a corrupt/partial
      // write too: rejected with a stable reason, never defaulted.
      const arrayDir = path.join(requireDir(), "resume-array");
      await mkdir(arrayDir, { recursive: true });
      await writeFile(path.join(arrayDir, "state.json"), "[]", "utf8");
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: arrayDir, resume: true })),
      ).rejects.toThrow(/must contain a single JSON object/);

      const badVersionDir = path.join(requireDir(), "resume-version");
      await mkdir(badVersionDir, { recursive: true });
      await writeFile(path.join(badVersionDir, "state.json"), JSON.stringify({ version: 99 }), "utf8");
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: badVersionDir, resume: true })),
      ).rejects.toThrow(/version 99 is not supported/);
    },
  );

  it(
    "--resume validates checkpoint.json and fails safely on a corrupt or foreign marker",
    { timeout: 30_000 },
    async () => {
      // HIGH 2: resume validates BOTH files. A corrupt, foreign, or
      // inconsistent checkpoint marker means the recovery contract cannot
      // be trusted — resume fails with a stable reason BEFORE any runtime
      // opens, never silently continuing on a half-written marker.
      const { mkdir, writeFile } = await import("node:fs/promises");
      const base = validResumeStateFixture();
      const writeBoth = async (name: string, checkpoint: unknown) => {
        const dir = path.join(requireDir(), name);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "state.json"), JSON.stringify(base), "utf8");
        await writeFile(
          path.join(dir, "checkpoint.json"),
          typeof checkpoint === "string" ? checkpoint : JSON.stringify(checkpoint),
          "utf8",
        );
        return dir;
      };
      const rejectDir = async (dir: string, pattern: RegExp) => {
        await expect(
          runLocalMultiTableSoak(shortOptions({ outputDir: dir, resume: true })),
        ).rejects.toThrow(pattern);
        // A rejected resume never opens a runtime or writes new artifacts.
        expect(await readdir(dir).then((names) => names.sort())).toEqual([
          "checkpoint.json",
          "state.json",
        ]);
      };

      // Corrupt (unparseable) marker.
      await rejectDir(
        await writeBoth("resume-corrupt-checkpoint", "{corrupt"),
        /checkpoint\.json is not valid JSON/,
      );
      // Marker that parses but is not an object.
      await rejectDir(
        await writeBoth("resume-array-checkpoint", []),
        /checkpoint\.json must contain a single JSON object/,
      );
      // Marker from a different run than state.json (grammar-valid id so
      // the FOREIGN-identity check fires, not the run-id grammar check).
      await rejectDir(
        await writeBoth("resume-foreign-checkpoint", {
          version: 1,
          runId: "soak-zzzz",
          cycle: 3,
          status: "completed",
        }),
        /belongs to a different run/,
      );
      // A completed marker whose cycle disagrees with the state checkpoint
      // (the marker advanced past the state that backs it).
      await rejectDir(
        await writeBoth("resume-ahead-checkpoint", {
          version: 1,
          runId: base.runId,
          cycle: 4,
          status: "completed",
        }),
        /must equal state\.lastCompletedCycle/,
      );
      // An in-flight marker ahead of the state by more than one cycle.
      await rejectDir(
        await writeBoth("resume-ahead-inflight", {
          version: 1,
          runId: base.runId,
          cycle: 9,
          status: "in-flight",
        }),
        /cannot be ahead of state\.lastCompletedCycle \+ 1/,
      );
      // MEDIUM 6: an in-flight marker OLDER than the checkpointed state (a
      // leftover from an abandoned cycle) is rejected — arbitrary old
      // markers are never rewritten as completed, only the current
      // completed marker or exactly lastCompletedCycle + 1 in-flight is
      // accepted.
      await rejectDir(
        await writeBoth("resume-stale-inflight", {
          version: 1,
          runId: base.runId,
          cycle: 2,
          status: "in-flight",
        }),
        /older than state\.lastCompletedCycle for an in-flight checkpoint/,
      );
      // MEDIUM 7: a secret-like/corrupt marker run id fails the generated
      // grammar even when state.runId is valid.
      await rejectDir(
        await writeBoth("resume-bad-runid-checkpoint", {
          version: 1,
          runId: "sk-ya29.secret-token",
          cycle: 3,
          status: "completed",
        }),
        /checkpoint\.runId does not match the generated soak run id grammar/,
      );
    },
  );

  it(
    "--resume validates the complete state schema with stable local reasons",
    { timeout: 30_000 },
    async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const base = {
        version: 1,
        runId: "soak-abcd",
        seed: 20260814,
        mode: "local",
        startedAtMs: Date.now(),
        params: {
          seed: 20260814,
          durationMs: 7_200_000,
          intervalSeconds: 0,
          actors: 2,
          operationsPerActor: 4,
          resolvedTables: ["soak_tasks"],
          maxConsecutiveFailures: 5,
        },
        lastCompletedCycle: 3,
        cumulative: {
          operations: 96,
          expectedErrors: 0,
          failures: 0,
          retries: 0,
          probes: { total: 0, ok: 0, skipped: 0, failed: 0 },
          convergenceChecks: 0,
          convergenceFailed: 0,
        },
        tableRows: { soak_tasks: 4 },
      };
      const invalidStates = [
        { ...base, seed: "not-a-number" },
        { ...base, seed: 4294967296 }, // above the PRNG's 32-bit domain
        { ...base, seed: -1 },
        { ...base, seed: base.seed + 1 }, // top-level seed must equal params.seed
        { ...base, params: { ...base.params, seed: base.seed + 1 } },
        { ...base, mode: "cloud" },
        { ...base, mode: "live" }, // valid vocabulary but mismatches the detected local mode
        { ...base, startedAtMs: "now" },
        { ...base, lastCompletedCycle: -1 },
        { ...base, lastCompletedCycle: 100 }, // more cycles than operations
        { ...base, extraField: true },
        { ...base, params: { ...base.params, actors: 0 } },
        { ...base, params: { ...base.params, actors: 65 } }, // above the CLI ceiling
        { ...base, params: { ...base.params, operationsPerActor: 1001 } }, // above the CLI ceiling
        { ...base, params: { ...base.params, maxConsecutiveFailures: 1001 } }, // above the CLI ceiling
        { ...base, params: { ...base.params, durationMs: -5 } },
        { ...base, params: { ...base.params, durationMs: 0 } }, // not positive (CLI floor)
        { ...base, params: { ...base.params, durationMs: 25 * 3_600_000 } }, // above the 24h ceiling
        { ...base, params: { ...base.params, intervalSeconds: -0.5 } }, // negative fractional
        { ...base, params: { ...base.params, resolvedTables: [] } },
        { ...base, params: { ...base.params, resolvedTables: ["soak_unknown"] } },
        { ...base, params: { ...base.params, resolvedTables: ["soak_tasks", "soak_tasks"] } },
        { ...base, params: { ...base.params, extraParam: 1 } },
        // MEDIUM 4: timestamps must be safe finite epoch values that
        // `new Date(ms).toISOString()` can render.
        { ...base, startedAtMs: Number.POSITIVE_INFINITY },
        { ...base, startedAtMs: Number.NaN },
        { ...base, startedAtMs: 8_640_000_000_000_001 }, // beyond the ISO date range
        { ...base, startedAtMs: -8_640_000_000_000_001 },
        // HIGH 2: recovery section schema.
        { ...base, recovery: { cycle: 0, reason: "interrupted-cycle-reconciled" } },
        { ...base, recovery: { cycle: 1 } },
        { ...base, recovery: { reason: "interrupted-cycle-reconciled" } },
        { ...base, recovery: { cycle: 1, reason: "made-up-reason" } },
        { ...base, recovery: { cycle: 1, reason: "interrupted-cycle-reconciled", extra: true } },
        // MEDIUM 5: any finalization marker (even a well-formed failed one)
        // must reject resume — never silently overwrite a failed run.
        { ...base, finalization: { status: "passed" } },
        { ...base, finalization: { status: "failed" } },
        { ...base, finalization: { status: "failed", reason: "other", step: "log" } },
        { ...base, finalization: { status: "failed", reason: "artifact-write-failed", step: "" } },
        { ...base, finalization: { status: "failed", reason: "artifact-write-failed", step: "log" } },
        { ...base, finalization: { status: "failed", reason: "artifact-write-failed", step: "log", extra: 1 } },
        { ...base, cumulative: { ...base.cumulative, operations: -1 } },
        { ...base, cumulative: { ...base.cumulative, expectedErrors: 200 } }, // ok would be negative
        { ...base, cumulative: { ...base.cumulative, probes: { total: -1, ok: 0, skipped: 0, failed: 0 } } },
        { ...base, cumulative: { ...base.cumulative, probes: { total: 5, ok: 0, skipped: 0, failed: 0 } } }, // > cycles
        { ...base, cumulative: { ...base.cumulative, probes: { total: 1, ok: 0, skipped: 2, failed: 0 } } }, // sum != total
        { ...base, cumulative: { ...base.cumulative, probes: { total: 2, ok: 1, skipped: 0, failed: 0 } } }, // sum != total
        { ...base, cumulative: { ...base.cumulative, probes: { total: 1.5, ok: 0, skipped: 0, failed: 0 } } }, // non-integer total
        { ...base, cumulative: { ...base.cumulative, probes: { total: 1, ok: 0.5, skipped: 0, failed: 0 } } }, // non-integer subcount
        { ...base, cumulative: { ...base.cumulative, convergenceFailed: 1 } }, // > checks
        // MEDIUM 7: run ids must follow the generated `soak-<base36>`
        // grammar — secret-like, corrupt, or foreign ids are rejected.
        { ...base, runId: "" },
        { ...base, runId: "sk-ya29.secret-token" },
        { ...base, runId: "soak-ABC" }, // uppercase is not base36-lowercase
        { ...base, runId: "soak-ab" }, // below the minimum length
        { ...base, runId: "soak-abc-123" }, // extra hyphen: not generated shape
        { ...base, runId: "https://docs.google.com/spreadsheets/d/abc" },
        { ...base, tableRows: { soak_secret_table: 3 } },
        { ...base, tableRows: { soak_tasks: "many" } },
        { ...base, tableRows: { soak_tasks: 4, soak_orders: 2 } }, // not exactly resolvedTables
        { ...base, tableRows: {} }, // missing the resolved table
      ];
      for (let index = 0; index < invalidStates.length; index += 1) {
        const invalidDir = path.join(requireDir(), `resume-invalid-${index}`);
        await mkdir(invalidDir, { recursive: true });
        await writeFile(
          path.join(invalidDir, "state.json"),
          JSON.stringify(invalidStates[index]),
          "utf8",
        );
        await expect(
          runLocalMultiTableSoak(shortOptions({ outputDir: invalidDir, resume: true })),
        ).rejects.toThrow(/--resume failed/);
        // A rejected resume must never open a runtime or write new artifacts.
        expect(await readdir(invalidDir)).toEqual(["state.json"]);
      }
    },
  );
});
