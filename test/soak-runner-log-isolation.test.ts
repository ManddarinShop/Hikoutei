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

describeLongSoak("soak runner fresh-run log isolation (MEDIUM 7)", () => {
  it(
    "a fresh run in a reused output dir never retains stale SQLite rows or log backups",
    { timeout: 120_000 },
    async () => {
      const runDir = path.join(requireDir(), "medium7-fresh-isolation");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      const firstState = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(firstState.runId).toMatch(/^soak-[0-9a-z]{4,32}$/);

      // Seed the logger-owned files with content that LOOKS like a prior
      // run: one valid logger line (copied from the first run's collection)
      // and one arbitrary raw line, in the current file AND a rotated
      // backup. A fresh run must clear/isolate these before opening.
      const { writeFile: write } = await import("node:fs/promises");
      const collected = await readFile(path.join(runDir, "collected-log.txt"), "utf8");
      const priorValidLine = collected.split("\n").find((line) => line.trim() !== "") ?? "";
      expect(priorValidLine).not.toBe("");
      const seededCurrent = `${priorValidLine}\n{\"raw\":\"pre-existing-secret-7f3a\"}\n`;
      await write(path.join(runDir, "hikoutei-internal-log.txt"), seededCurrent, "utf8");
      await write(path.join(runDir, "hikoutei-internal-log.1.txt"), seededCurrent, "utf8");

      // Inject a stale ROW directly into the SQLite authority (a row the
      // oracle never planned, with a non-generated id). A reused output
      // directory must never let it survive into the fresh run.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const staleDb = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        staleDb.prepare(
          "insert into soak_tasks (id, title, priority, done, due_at, tag) " +
          "values ('stale-run-sentinel-id', 'stale', 0, 0, null, null)",
        ).run();
      } finally {
        staleDb.close();
      }

      const second = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(second.status).toBe("passed");
      const secondState = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(secondState.runId).not.toBe(firstState.runId); // truly a NEW run identity
      // The rotated backup was cleared and the fresh collected log contains
      // only the NEW run's events — neither the prior valid line nor the
      // seeded raw secret.
      expect(await readdir(runDir)).not.toContain("hikoutei-internal-log.1.txt");
      const freshCollected = await readFile(path.join(runDir, "collected-log.txt"), "utf8");
      expect(freshCollected).not.toContain(priorValidLine.trim());
      expect(freshCollected).not.toContain("pre-existing-secret-7f3a");
      const currentLog = await readFile(path.join(runDir, "hikoutei-internal-log.txt"), "utf8");
      expect(currentLog).not.toContain(priorValidLine.trim());
      expect(currentLog).not.toContain("pre-existing-secret-7f3a");

      // The stale SQLite row is gone: the fresh run recreated the authority
      // from scratch and holds only its own rows (the workload's `soak_tasks`
      // rows exist, and the run passed against them).
      const checkDb = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        const stale = checkDb.prepare(
          "select count(*) as count from soak_tasks where id = 'stale-run-sentinel-id'",
        ).get();
        expect(stale?.count).toBe(0);
        const live = checkDb.prepare("select count(*) as count from soak_tasks").get();
        expect(live?.count).toBeGreaterThan(0);
      } finally {
        checkDb.close();
      }

      // Resume history behavior remains intact: the fresh run left a
      // coherent state/checkpoint/history trio, so a --resume validates and
      // continues the NEW run (not the first one) with continuous totals.
      const resumed = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        resume: true,
        seed: "0xdead",
      }));
      expect(resumed.status).toBe("passed");
      const resumedState = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(resumedState.runId).toBe(secondState.runId); // stored run identity wins
      expect(resumed.seed).toBe(second.seed); // stored seed wins over --seed
      expect(resumed.cyclesCompleted).toBeGreaterThan(second.cyclesCompleted);
      const state = resumedState;
      expect(state.cumulative.operations).toBe(resumed.operations.total);
      // The JSONL stream stays contiguous from the fresh run's cycle 1 with
      // no duplicate cycle records.
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cycles[0]?.cycle).toBe(1);
      expect(cycles.length).toBe(resumed.cyclesCompleted);
      for (let index = 1; index < cycles.length; index += 1) {
        expect(cycles[index]!.cycle).toBe(cycles[index - 1]!.cycle + 1);
      }
      expect(state.cumulative.failures).toBe(0);
    },
  );

  it(
    "a fresh-run crash window never resumes the previous run identity (state/checkpoint removed before the DB opens)",
    { timeout: 120_000 },
    async () => {
      // HIGH 3: a fresh run removes state.json/checkpoint.json (with the
      // other runner-owned artifacts) BEFORE opening the new DB/runtime.
      // A crash AFTER the new DB opens but BEFORE the first state write
      // therefore leaves NO resume documents, and a later --resume fails
      // cleanly instead of accepting the previous run identity or a
      // zero-cycle stale state.
      //
      // The most dangerous stale state is a zero-cycle interrupted run
      // (lastCompletedCycle 0, empty tableRows, in-flight marker at 1):
      // with the HIGH 2 relaxation it validates, so only the fresh-run
      // removal of state/checkpoint keeps the crash window safe.
      const runDir = path.join(requireDir(), "high3-crash-window");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: 1,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("simulated-interruption");
      let state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.lastCompletedCycle).toBe(0);
      expect(await readdir(runDir)).toContain("checkpoint.json");
      const staleRunId = state.runId;

      // Simulate the fresh-run start through the crash: the real fresh-run
      // reset removes the JSONL streams, the SQLite authority, AND the
      // atomic resume documents; then the new DB opens (public runtime),
      // and the process dies before the first state write.
      const writer = createArtifactWriter(runDir, () => {});
      await writer.resetRunArtifacts();
      await writer.resetLoggerFiles({ logFile: path.join(runDir, "hikoutei-internal-log.txt") });
      expect(await readdir(runDir)).not.toContain("state.json");
      expect(await readdir(runDir)).not.toContain("checkpoint.json");
      // The "new DB opened" step: an empty authority created by the public
      // runtime (exactly what a fresh run does after the reset).
      const { tokens } = buildSoakEntities();
      const fresh = await createTypedSheets({
        dbName: path.join(runDir, "soak.sqlite"),
        entities: [...tokens] as unknown as readonly HikouteiEntity[],
      });
      await fresh.close();

      // The crash-window resume must FAIL with the clean no-state reason —
      // never silently continue the previous run's identity/zero-cycle
      // state against the new empty authority.
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/no state\.json exists in the output dir/);
      // The stale identity is gone from the directory entirely.
      expect(await readdir(runDir)).not.toContain("state.json");
      void staleRunId;
    },
  );
});


describeLongSoak("soak runner same-process logger isolation", () => {
  it(
    "repeated runs in one Node process keep per-run logger env and log files",
    { timeout: 120_000 },
    async () => {
      // MEDIUM: the runner pins HIKOUTEI_LOG_FILE per run and restores the
      // pre-run env (and drops the cached process logger) when the run
      // ends. A second runLocalMultiTableSoak() call in the SAME process
      // must never retain the first run's log path, and each output dir's
      // current/collected log must contain only its own run's events.
      const linesOf = (content: string): string[] =>
        content.split("\n").filter((line) => line.trim() !== "");
      const countEvents = (content: string, event: string): number =>
        linesOf(content).filter((line) => JSON.parse(line).event === event).length;

      const firstDir = path.join(requireDir(), "iso-log-a");
      const secondDir = path.join(requireDir(), "iso-log-b");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: firstDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      // The first run restored the env it pinned (the test env never sets
      // the logger vars, so the key is gone again).
      expect(process.env.HIKOUTEI_LOG_FILE).toBeUndefined();

      const second = await runLocalMultiTableSoak(shortOptions({ outputDir: secondDir, durationHours: 0.001 }));
      expect(second.status).toBe("passed");
      expect(process.env.HIKOUTEI_LOG_FILE).toBeUndefined();

      const firstCurrent = await readFile(path.join(firstDir, "hikoutei-internal-log.txt"), "utf8");
      const firstCollected = await readFile(path.join(firstDir, "collected-log.txt"), "utf8");
      const secondCurrent = await readFile(path.join(secondDir, "hikoutei-internal-log.txt"), "utf8");
      const secondCollected = await readFile(path.join(secondDir, "collected-log.txt"), "utf8");

      // Every run opens and closes its runtime(s); a leaked cached logger
      // would have left the second run's current log MISSING (its events
      // would land in the first run's file instead).
      expect(countEvents(firstCollected, "hikoutei.runtime.opened"))
        .toBe(countEvents(firstCollected, "hikoutei.runtime.closed"));
      expect(countEvents(firstCollected, "hikoutei.runtime.opened")).toBeGreaterThanOrEqual(1);
      expect(countEvents(secondCollected, "hikoutei.runtime.opened"))
        .toBe(countEvents(secondCollected, "hikoutei.runtime.closed"));
      expect(countEvents(secondCollected, "hikoutei.runtime.opened")).toBeGreaterThanOrEqual(1);
      expect(countEvents(secondCurrent, "hikoutei.runtime.opened"))
        .toBe(countEvents(secondCollected, "hikoutei.runtime.opened"));
      // The current log content is what was collected (no rotation in a
      // short run), and neither run's lines appear in the other's files.
      const firstLines = linesOf(firstCurrent);
      const secondLines = linesOf(secondCurrent);
      expect(firstLines.length).toBe(linesOf(firstCollected).length);
      expect(secondLines.length).toBe(linesOf(secondCollected).length);
      for (const line of firstLines) {
        expect(secondCollected).not.toContain(line);
      }
      for (const line of secondLines) {
        expect(firstCollected).not.toContain(line);
      }

      // A caller-set HIKOUTEI_LOG_FILE is honored during the run (the
      // runner never overrides explicit env) and left untouched afterwards
      // — normal application env behavior is unchanged by the runner.
      const customLog = path.join(requireDir(), "iso-log-custom", "operator-log.txt");
      process.env.HIKOUTEI_LOG_FILE = customLog;
      try {
        const third = await runLocalMultiTableSoak(shortOptions({
          outputDir: path.join(requireDir(), "iso-log-c"),
          durationHours: 0.001,
        }));
        expect(third.status).toBe("passed");
        expect(process.env.HIKOUTEI_LOG_FILE).toBe(customLog);
        // The run's events went to the caller's custom path (the pinned
        // env wins over the artifact default) and the collection reflects
        // it — the custom path's log is outside the output dir and was
        // never reset or deleted.
        const thirdCollected = await readFile(
          path.join(requireDir(), "iso-log-c", "collected-log.txt"),
          "utf8",
        );
        expect(countEvents(thirdCollected, "hikoutei.runtime.opened")).toBeGreaterThanOrEqual(1);
        expect(await readdir(path.join(requireDir(), "iso-log-c"))).not.toContain(
          "hikoutei-internal-log.txt",
        );
      } finally {
        delete process.env.HIKOUTEI_LOG_FILE;
      }
    },
  );
});


describeLongSoak("soak runner fresh-run tmp staging isolation", () => {
  it(
    "a fresh run removes stale atomic-write staging files without touching arbitrary files",
    { timeout: 120_000 },
    async () => {
      // MEDIUM: the runner's atomic writes (temp file + rename) can leave
      // a `<doc>.tmp` staging file behind when the process dies between
      // the write and the rename. A fresh run must remove exactly its own
      // staging paths (state/checkpoint/summary .tmp) before opening the
      // new runtime — never a wildcard sweep of arbitrary .tmp files
      // inside or outside the output directory.
      const runDir = path.join(requireDir(), "stale-tmp-isolation");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      const firstState = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));

      const { writeFile: write, mkdir } = await import("node:fs/promises");
      await write(path.join(runDir, "state.json.tmp"), "{\"half-write\": true}\n", "utf8");
      await write(path.join(runDir, "checkpoint.json.tmp"), "{\"half-write", "utf8");
      await write(path.join(runDir, "summary.json.tmp"), "{}", "utf8");
      // An arbitrary .tmp file inside the output dir is NOT runner-owned
      // and must survive; so must a file outside the output dir.
      await write(path.join(runDir, "operator-notes.tmp"), "keep me", "utf8");
      const externalDir = path.join(requireDir(), "stale-tmp-external");
      await mkdir(externalDir, { recursive: true });
      const externalPath = path.join(externalDir, "external.tmp");
      await write(externalPath, "external content", "utf8");

      const second = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(second.status).toBe("passed");
      const names = await readdir(runDir);
      expect(names).not.toContain("state.json.tmp");
      expect(names).not.toContain("checkpoint.json.tmp");
      expect(names).not.toContain("summary.json.tmp");
      expect(names).toContain("operator-notes.tmp");
      expect(await readFile(externalPath, "utf8")).toBe("external content");
      // The fresh run's resume documents are the NEW run's real ones (the
      // stale staging files never leaked into the new run).
      const secondState = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(secondState.runId).not.toBe(firstState.runId);
      const resumed = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.001,
        resume: true,
      }));
      expect(resumed.status).toBe("passed");
      expect(resumed.cyclesCompleted).toBeGreaterThan(second.cyclesCompleted);
    },
  );
});
