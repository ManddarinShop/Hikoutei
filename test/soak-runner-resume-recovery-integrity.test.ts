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

describeLongSoak("soak runner recovery record integrity (HIGH 2)", () => {
  /** Runs one completed short run and returns its artifact directory. */
  async function completedRunDir(name: string): Promise<string> {
    const runDir = path.join(requireDir(), name);
    const summary = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
    expect(summary.status).toBe("passed");
    return runDir;
  }

  async function rejectResume(runDir: string, pattern: RegExp): Promise<void> {
    await expect(
      runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
    ).rejects.toThrow(pattern);
  }

  it(
    "rejects a corrupt/partial cycles.jsonl line as untrusted completion proof",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-corrupt-line");
      const { appendFile } = await import("node:fs/promises");
      await appendFile(path.join(runDir, "cycles.jsonl"), '{"cycle": 999, "half-write', "utf8");
      await rejectResume(runDir, /cycles\.jsonl contains a corrupt or partial line/);
    },
  );

  it(
    "rejects a gap in the completed cycle history",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-cycle-gap");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      // Delete the record of a MIDDLE completed cycle: the state
      // checkpointed it, so the missing record is corruption.
      const middle = Math.floor(lines.length / 2);
      lines.splice(middle, 1);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /cycles\.jsonl is missing the record for completed cycle/);
    },
  );

  it(
    "rejects a duplicate cycle record",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-duplicate-cycle");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      lines.push(lines[0]!);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /cycles\.jsonl contains a duplicate record for cycle 1/);
    },
  );

  it(
    "rejects a malformed cycle record (unknown field)",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-malformed-cycle");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      first.message = "injected free text";
      lines[0] = JSON.stringify(first);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /cycles\.jsonl contains an invalid record: unknown cycle-record field/);
    },
  );

  it(
    "rejects an operation-record count mismatch against the deterministic actor stream",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-op-count");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      lines.splice(0, 1); // drop one actor record of cycle 1
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /operations\.jsonl has \d+ record\(s\) for cycle 1/);
    },
  );

  it(
    "rejects a duplicate operation identity",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-duplicate-op");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      lines.push(lines[0]!);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /operations\.jsonl contains a duplicate record/);
    },
  );

  it(
    "rejects a completed checkpoint whose resource sample is missing",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-missing-resource");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "resources.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      lines.pop(); // remove the final cycle's sample
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /resources\.jsonl is missing the sample for completed cycle/);
    },
  );

  it(
    "rejects state cumulative counters that contradict the recorded cycle history",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-cumulative-mismatch");
      const { writeFile: write } = await import("node:fs/promises");
      const statePath = path.join(runDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.cumulative.operations += 1;
      await write(statePath, JSON.stringify(state), "utf8");
      await rejectResume(runDir, /state\.cumulative counters do not match the recorded cycle history/);
    },
  );

  it(
    "rejects an operation record whose actor/index identity lies outside the deterministic grid",
    { timeout: 90_000 },
    async () => {
      // HIGH 2: identity must bind to actors x operationsPerActor — a
      // forged actor beyond the stream is rejected even though the record
      // count and vocabulary are unchanged.
      const runDir = await completedRunDir("high2-identity-outside");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      first.actor = 99; // beyond the run's actor count
      lines[0] = JSON.stringify(first);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /outside the deterministic actor stream/);
    },
  );

  it(
    "rejects an operation record whose kind/table does not match the stored seed's plan",
    { timeout: 90_000 },
    async () => {
      // HIGH 2: every record must match the kind/table the stored seed
      // actually generates for its identity — a vocabulary-valid but
      // forged table is rejected before the runtime opens.
      const runDir = await completedRunDir("high2-kind-forged");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const first = JSON.parse(lines[0]!) as Record<string, unknown>;
      const recordedTable = first.table;
      const other = ["SoakCustomer", "SoakOrder", "SoakInventoryItem", "SoakTask", "SoakAuditEvent", "SoakFeatureFlag"]
        .find((name) => name !== recordedTable)!;
      first.table = other;
      lines[0] = JSON.stringify(first);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /records a kind\/table the stored seed does not generate/);
    },
  );

  it(
    "rejects operation records beyond the checkpointed cycle window",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-op-out-of-window");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      last.cycle = state.lastCompletedCycle + 2;
      lines.push(JSON.stringify(last));
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /ahead of the checkpointed state/);
    },
  );

  it(
    "rejects a resource sample beyond the checkpointed state",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-extra-resource");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "resources.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      last.cycle = state.lastCompletedCycle + 1;
      lines.push(JSON.stringify(last));
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /resources\.jsonl contains a sample for cycle .*, beyond the checkpointed state/);
    },
  );

  it(
    "rejects a cycle record beyond the checkpointed state",
    { timeout: 90_000 },
    async () => {
      const runDir = await completedRunDir("high2-cycle-out-of-window");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      last.cycle = state.lastCompletedCycle + 1;
      lines.push(JSON.stringify(last));
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /cycles\.jsonl records cycle .* but the checkpoint does not mark it in-flight/);
    },
  );

  it(
    "rejects a truncated operation stream for a provable reopen-abort cycle",
    { timeout: 90_000 },
    async () => {
      // HIGH 2: a reopen-cleanup/deadline abort only fires in the reopen
      // phase AFTER every actor record landed, so its operation records
      // must be the EXACT full actor grid — a hole (or a truncated
      // suffix) means forged or reordered history, rejected before the
      // runtime opens.
      const runDir = path.join(requireDir(), "high2-abort-gap");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        __testFailReopenOnCycle: 60,
      }));
      expect(summary.stopReason).toBe("reopen-failed");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const dropIndex = lines.findIndex((line) => JSON.parse(line).cycle === 60);
      expect(dropIndex).toBeGreaterThanOrEqual(0);
      lines.splice(dropIndex, 1);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /cycle 60 records \d+ of \d+ actor operations/);
    },
  );

  it(
    "rejects a truncated actor suffix on a provable reopen-abort cycle",
    { timeout: 90_000 },
    async () => {
      // HIGH 2 regression: deleting the FINAL records of a provable
      // reopen-abort cycle leaves a contiguous actor prefix, which the
      // old prefix rule tolerated. Such an abort can only follow the FULL
      // cycle (the reopen phase runs after every actor record landed), so
      // a missing suffix is forged history — resume must reject it before
      // advancing state.
      const runDir = path.join(requireDir(), "high2-abort-truncated-suffix");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        __testFailReopenOnCycle: 60,
      }));
      expect(summary.stopReason).toBe("reopen-failed");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const cycleIndexes = lines
        .map((line, index) => (JSON.parse(line).cycle === 60 ? index : -1))
        .filter((index) => index >= 0);
      expect(cycleIndexes.length).toBeGreaterThanOrEqual(2);
      // Remove the LAST two records of cycle 60: a contiguous suffix.
      lines.splice(cycleIndexes[cycleIndexes.length - 2]!, 2);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /cycle 60 records \d+ of \d+ actor operations/);
    },
  );

  it(
    "rejects an abort record that deviates from the runner's exact abort contract",
    { timeout: 90_000 },
    async () => {
      // HIGH 2: the ONLY expected abort shape is one attempted-and-failed
      // unit with no executed-work fields; a forged total is rejected.
      const runDir = path.join(requireDir(), "high2-abort-shape");
      await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        maxConsecutiveFailures: 5,
        __testFailOnCycle: 2,
      }));
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const index = lines.findIndex((line) => JSON.parse(line).abort !== undefined);
      expect(index).toBeGreaterThanOrEqual(0);
      const abortRecord = JSON.parse(lines[index]!) as Record<string, unknown>;
      abortRecord.operations = 2; // the abort unit is exactly one failed op
      lines[index] = JSON.stringify(abortRecord);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /abort record whose shape does not match/);
    },
  );

  it(
    "advances state from a recorded provable reopen-abort cycle via the completed-cycle recovery",
    { timeout: 120_000 },
    async () => {
      // HIGH 2: the completed-cycle-checkpoint recovery (completeRecordedCycle)
      // applies the SAME exactness proof as validateResumeHistory: a
      // PROVABLE reopen-cleanup abort claims the FULL cycle ran (the
      // reopen phase fires after every actor record landed), so the
      // recovery advances state only when the recorded abort cycle holds
      // its EXACT full actor grid and its full deterministic SQLite row
      // set — the identical proof the truncated-abort tests enforce on
      // the checkpointed path.
      const runDir = path.join(requireDir(), "high2-abort-recorded-recovery");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        __testFailReopenOnCycle: 60,
        __testInterruptAfterCycleRecord: 60,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("artifact-write-failed");
      // The abort record for cycle 60 landed, but the state checkpoint
      // never did: state still reports cycle 59 while cycles.jsonl holds
      // the cycle-60 abort record and the marker is in-flight for 60.
      let state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.lastCompletedCycle).toBe(59);
      const checkpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(checkpoint).toEqual({ version: 1, runId: state.runId, cycle: 60, status: "in-flight" });
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const abortRecord = cycles.find((record) => record.cycle === 60);
      expect(abortRecord?.abort?.reason).toBe("reopen-cleanup-failed");
      expect(abortRecord?.operations).toBe(1);
      expect(abortRecord?.failures).toBe(1);
      // The recovery advances the state from the RECORDED abort totals
      // (one attempted-and-failed unit), with the full grid intact. The
      // summary honestly reports failed: the recovered cycle carried one
      // real recorded failure (the reopen cleanup abort), and the resumed
      // run continues past cycle 60 without re-executing or duplicating it.
      const second = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        resume: true,
      }));
      expect(second.status).toBe("failed");
      expect(second.stopReason).toBe("duration-budget-reached");
      expect(second.recovery).toEqual({
        status: "recovered",
        cycle: 60,
        reason: "completed-cycle-checkpoint",
      });
      state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      // The recorded abort's single failure is part of the recovered
      // totals; the resumed run continues past cycle 60 without
      // re-executing or duplicating it.
      expect(state.lastCompletedCycle).toBeGreaterThan(60);
      expect(state.cumulative.failures).toBe(1);
      expect(second.operations.failures).toBe(1);
      expect(state.cumulative.operations).toBe(second.operations.total);
      const cyclesAfter = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cyclesAfter.find((record) => record.cycle === 60)?.abort?.reason)
        .toBe("reopen-cleanup-failed");
      expect(cyclesAfter.filter((record) => record.cycle === 60).length).toBe(1);
      // The in-flight marker advanced to completed for the recovered cycle.
      const finalCheckpoint = JSON.parse(
        await readFile(path.join(runDir, "checkpoint.json"), "utf8"),
      );
      expect(finalCheckpoint).toEqual({
        version: 1,
        runId: state.runId,
        cycle: state.lastCompletedCycle,
        status: "completed",
      });
    },
  );

  it(
    "rejects a truncated grid on a RECORDED provable reopen-abort cycle before state advance",
    { timeout: 120_000 },
    async () => {
      // HIGH 2 regression guard for the recovery path: when the recorded
      // in-flight cycle is a provable reopen abort, deleting its actor
      // suffix must fail the resume at validateResumeHistory (BEFORE any
      // recovery/state advance) — the recorded abort can only follow the
      // full cycle, so a missing suffix is forged history even on the
      // completed-cycle-checkpoint path.
      const runDir = path.join(requireDir(), "high2-abort-recorded-truncated");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        __testFailReopenOnCycle: 60,
        __testInterruptAfterCycleRecord: 60,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("artifact-write-failed");
      const { writeFile: write } = await import("node:fs/promises");
      const pathToFile = path.join(runDir, "operations.jsonl");
      const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
      const cycleIndexes = lines
        .map((line, index) => (JSON.parse(line).cycle === 60 ? index : -1))
        .filter((index) => index >= 0);
      expect(cycleIndexes.length).toBeGreaterThanOrEqual(2);
      // Remove the LAST two records of cycle 60: a contiguous suffix.
      lines.splice(cycleIndexes[cycleIndexes.length - 2]!, 2);
      await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
      await rejectResume(runDir, /cycle 60 records \d+ of \d+ actor operations/);
      // The state was NOT advanced: the stale documents still describe the
      // interrupted run.
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.lastCompletedCycle).toBe(59);
    },
  );
});


describeLongSoak("soak runner final state-write finalization (MEDIUM 4)", () => {
  it(
    "fails the summary when the final state write itself fails and never omits it",
    { timeout: 90_000 },
    async () => {
      // The state write is part of the finalization aggregation: an
      // injected failure of THAT write must appear in the emitted summary
      // (failed run with a stable finalization section) — never a passed
      // summary that silently omitted a state-write failure.
      const runDir = path.join(requireDir(), "medium4-state-fail");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        __testFailFinalArtifactStep: "state",
      }));
      expect(summary.status).toBe("failed");
      expect(summary.finalization).toEqual({
        status: "failed",
        reason: "artifact-write-failed",
        step: "state",
        errorClass: "Error",
      });
      // The corrected summary is re-persisted best effort and the raw
      // injected message never reaches any artifact.
      for (const name of await readdir(runDir)) {
        if (!name.endsWith(".jsonl") && name !== "summary.md" && name !== "collected-log.txt") continue;
        const content = await readFile(path.join(runDir, name), "utf8");
        expect(content).not.toContain("soak-test-injected-final-artifact-failure");
      }
    },
  );
});


describeLongSoak("soak runner late runtime open cleanup (HIGH 3)", () => {
  it(
    "closes a late initial open and fails with deadline_expired",
    { timeout: 60_000 },
    async () => {
      // HIGH 3: a runtime whose initial open resolves after the run
      // deadline must never be silently discarded: the deadline error
      // carries the handle and the runner closes it before rethrowing.
      const runDir = path.join(requireDir(), "high3-late-initial");
      await expect(
        runLocalMultiTableSoak(shortOptions({
          outputDir: runDir,
          durationHours: 0.001,
          __testDelayInitialOpenMs: 3_600_000,
        })),
      ).rejects.toMatchObject({
        name: "SoakDeadlineExpiredError",
        statusClass: "deadline_expired",
        reasonCode: "deadline-expired",
      });
      // The late-open runtime's REAL close ran: the library log carries
      // both the opened and the closed event of the rejected run.
      const collected = await readFile(path.join(runDir, "hikoutei-internal-log.txt"), "utf8");
      expect(collected).toContain("hikoutei.runtime.opened");
      expect(collected).toContain("hikoutei.runtime.closed");
    },
  );

  it(
    "reports a persistent close failure of the late initial open on the rethrown error",
    { timeout: 60_000 },
    async () => {
      // HIGH 3: when the deadline-gated close attempt fails persistently,
      // the runner still tracks the handle, closes it again with the final
      // retry, and chains the persistent failure onto the rethrown
      // deadline error — never a leaked lease, never a swallowed close.
      const runDir = path.join(requireDir(), "high3-late-close-fail");
      let error: unknown;
      try {
        await runLocalMultiTableSoak(shortOptions({
          outputDir: runDir,
          durationHours: 0.001,
          __testDelayInitialOpenMs: 3_600_000,
          __testCloseFailPersistent: true,
        }));
        throw new Error("expected the late open to reject");
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "SoakDeadlineExpiredError",
        statusClass: "deadline_expired",
      });
      const deadlineError = error as { lateCloseError?: unknown };
      expect(deadlineError.lateCloseError).toBeInstanceOf(Error);
    },
  );

  it(
    "tracks and closes a late replacement runtime from a failed reopen handoff",
    { timeout: 120_000 },
    async () => {
      // HIGH 3: a replacement whose open resolves after the deadline is
      // carried through the reopen cleanup error into the runner's tracked
      // replacement handle and closed by the finalizer with retry — the
      // run records the stable deadline-expired abort and stops, and the
      // late replacement never leaks.
      const runDir = path.join(requireDir(), "high3-late-replacement");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0025,
        maxConsecutiveFailures: 5,
        __testFailReopenOnCycle: 60,
        __testDelayReplacementOpenMs: 3_600_000,
      }));
      expect(summary.status).toBe("failed");
      expect(summary.stopReason).toBe("reopen-failed");
      expect(summary.cyclesCompleted).toBe(60);
      // The late replacement was closed by the finalizer without a
      // persistent failure: no replacementCleanup section, and the abort
      // record carries the stable deadline-expired reason.
      expect(summary.replacementCleanup).toBeUndefined();
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      const aborted = cycles.find((record) => record.cycle === 60);
      expect(aborted?.abort).toEqual({
        reason: "deadline-expired",
        errorClass: "SoakReopenCleanupError",
      });
    },
  );
});


describeLongSoak("soak runner final state marker on bookkeeping failure (HIGH 4)", () => {
  it(
    "persists close-failure markers even when an earlier bookkeeping failure stopped the run",
    { timeout: 90_000 },
    async () => {
      // HIGH 4 regression: a prior artifact-write/bookkeeping failure must
      // never suppress the final state write when later close failures
      // need persisting — the close-failure marker lands in state and
      // summary, and a later resume rejects the failed run instead of
      // silently continuing it.
      const runDir = path.join(requireDir(), "high4-bookkeeping-close");
      const summary = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptAfterCycleRecord: 5,
        __testCloseFailPersistent: true,
      }));
      expect(summary.status).toBe("failed");
      expect(summary.stopReason).toBe("artifact-write-failed");
      expect(summary.cleanup).toEqual({
        status: "failed",
        reason: "runtime-close-failed",
        errorClass: "Error",
      });
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.cleanup).toEqual({
        status: "failed",
        reason: "runtime-close-failed",
        errorClass: "Error",
      });
      // The bookkeeping failure increment AND the close-failure increment
      // are persisted (the old code skipped the write entirely).
      expect(state.cumulative.failures).toBeGreaterThanOrEqual(2);
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/cleanup marks the previous run as failed/);
    },
  );
});
