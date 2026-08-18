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

describeLongSoak("soak runner resume cycle sections (mode/cadence)", () => {
  /** Runs one completed short local run and returns its artifact directory. */
  async function completedRunDir(name: string, durationHours = 0.001): Promise<string> {
    const runDir = path.join(requireDir(), name);
    const summary = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours }));
    expect(summary.status).toBe("passed");
    return runDir;
  }

  async function rejectResume(runDir: string, pattern: RegExp): Promise<void> {
    await expect(
      runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
    ).rejects.toThrow(pattern);
  }

  /** Rewrites cycles.jsonl with one modified record for `cycle`. */
  async function rewriteCycleRecord(
    runDir: string,
    cycle: number,
    mutate: (record: Record<string, unknown>) => void,
  ): Promise<void> {
    const { writeFile: write } = await import("node:fs/promises");
    const pathToFile = path.join(runDir, "cycles.jsonl");
    const lines = (await readFile(pathToFile, "utf8")).trim().split("\n");
    const index = lines.findIndex((line) => JSON.parse(line).cycle === cycle);
    expect(index).toBeGreaterThanOrEqual(0);
    const record = JSON.parse(lines[index]!) as Record<string, unknown>;
    mutate(record);
    lines[index] = JSON.stringify(record);
    await write(pathToFile, `${lines.join("\n")}\n`, "utf8");
  }

  /**
   * Runs a completed LOCAL short run, then fabricates a fully live-valid
   * history from it: mode flipped to live, every non-abort record gets its
   * ok convergence section, every probe-cadence record gets the
   * deterministic round-robin live probe, and the cumulative counters are
   * rewritten to match. Used by the positive/negative live section tests
   * so the resume reaches the specific section check under test.
   */
  async function liveFabricatedRunDir(name: string): Promise<string> {
    const runDir = await completedRunDir(name, 0.0015);
    const { writeFile: write } = await import("node:fs/promises");
    const statePath = path.join(runDir, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.mode = "live";
    const cyclesPath = path.join(runDir, "cycles.jsonl");
    const lines = (await readFile(cyclesPath, "utf8")).trim().split("\n");
    let checks = 0;
    let probes = 0;
    const rewritten = lines.map((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.abort === undefined) {
        record.convergence = { status: "ok", cycle: record.cycle };
        checks += 1;
        const cycle = record.cycle as number;
        if (cycle % 10 === 0) {
          // The same round-robin rotation the runner's probe uses.
          const target = SOAK_ENTITY_ORDER[Math.floor(cycle / 10) % SOAK_ENTITY_ORDER.length]!;
          record.probe = { status: "ok", table: target.tableName };
          probes += 1;
        }
      }
      return JSON.stringify(record);
    });
    await write(cyclesPath, `${rewritten.join("\n")}\n`, "utf8");
    state.cumulative.convergenceChecks = checks;
    state.cumulative.convergenceFailed = 0;
    state.cumulative.probes = { total: probes, ok: probes, skipped: 0, failed: 0 };
    await write(statePath, JSON.stringify(state), "utf8");
    return runDir;
  }


  it(
    "rejects an ok reopen whose full-scan evidence is failed (a failed scan is never ok)",
    { timeout: 90_000 },
    async () => {
      // Luna: reopen.status is bound to the full-scan evidence too, not
      // only the replayed counts. Forging the scan evidence to failed on
      // an ok record (or deleting it, which the required scan field also
      // rejects) is tampered history — a failed scan must never be
      // accepted as ok, even when every count matches the replay.
      const runDir = await completedRunDir("luna-reopen-ok-failed-scan", 0.003);
      await rewriteCycleRecord(runDir, 60, (record) => {
        (record.reopen as Record<string, unknown>).scan = "failed";
      });
      await rejectResume(
        runDir,
        /reports an ok reopen but the full-scan evidence is failed/,
      );
    },
  );

  it(
    "records a same-count full-scan failure as failed reopen status and accepts the failed-scan record on resume",
    { timeout: 120_000 },
    async () => {
      // Luna: the reopen status must reflect fullScanCompare failures, not
      // just post-reopen table counts. The injected SAME-COUNT mutation
      // (one row removed, one foreign-id row added through the public
      // API) fails the full scan on row identity while every recorded
      // count still matches the deterministic replay — the runner must
      // record status failed + scan failed, and resume must ACCEPT that
      // failed-scan evidence (it fails later only at the authority
      // content proof, never at the reopen-section gate).
      const runDir = path.join(requireDir(), "luna-reopen-same-count-scan-fail");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.003,
        maxConsecutiveFailures: 5,
        __testSwapRowOnReopenCycle: 60,
      }));
      // The swap happened at cycle 60: the full scan fails there and the
      // run records the failure; later cycles keep failing intermittently
      // (offset/query mismatches against the diverged authority) until
      // the duration budget ends the run.
      expect(first.status).toBe("failed");
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const record60 = cycles.find((record) => record.cycle === 60);
      expect(record60?.reopen).toBeDefined();
      expect(record60.reopen.status).toBe("failed");
      expect(record60.reopen.scan).toBe("failed");
      // The recorded counts are the OBSERVED counts: the same-count swap
      // keeps them identical to the deterministic replay, which the
      // resume binding must accept for a failed scan (the failed-scan
      // evidence is the differing evidence). The resume then fails ONLY
      // at the authority content proof (the removed row is missing).
      await rejectResume(runDir, /missing rows expected from state\.tableRows/);
    },
  );

  it(
    "accepts the plan-derived tablesTouched union for a low-workload actor stream",
    { timeout: 120_000 },
    async () => {
      // Luna: with actors=1 and operationsPerActor=1 the single actor op
      // only touches ONE entity per cycle (the deterministic round-robin
      // slot), so tablesTouched is the prologue table names plus exactly
      // that one entity name — never every active entity. Resume must
      // derive the expectation from the stored operation plan and reject
      // only tampered names.
      const runDir = path.join(requireDir(), "luna-low-workload");
      const options = shortOptions({ outputDir: runDir, actors: 1, operationsPerActor: 1 });
      const summary = await runLocalMultiTableSoak(options);
      expect(summary.status).toBe("passed");
      const expected = [...SOAK_ENTITY_ORDER.map((entry) => entry.tableName), "SoakCustomer"].sort();
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cycles.length).toBeGreaterThan(0);
      for (const record of cycles) {
        expect(record.tablesTouched).toEqual(expected);
      }
      // A valid low-workload history resumes and continues deterministically.
      const resumed = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        resume: true,
        actors: 1,
        operationsPerActor: 1,
      }));
      expect(resumed.status).toBe("passed");
      expect(resumed.cyclesCompleted).toBeGreaterThan(summary.cyclesCompleted);
      // Only TAMPERED names are rejected: forge an extra entity name into
      // one completed record and the resume fails closed.
      await rewriteCycleRecord(runDir, 1, (record) => {
        (record.tablesTouched as string[]).push("SoakOrder");
      });
      await rejectResume(
        runDir,
        /tablesTouched does not match the deterministic plan-derived table set/,
      );
    },
  );

  it(
    "binds the human-edit replay override to a successful recorded probe (live exact DB proof)",
    // The live-mode positive and negative controls each open the real sync
    // service against the canned projection; with the quota-safe 2,500 ms
    // pacing their startup/shutdown spans several supervisor scans, so the
    // wall-clock budget must cover two live run cycles plus the resume
    // fabrication.
    { timeout: 420_000 },
    async () => {
      // Luna: the human-edit override is granted only while the recorded
      // probe is ok and names the deterministic target. With an ok probe,
      // planted human-edit content passes the exact DB proof (the resume
      // proceeds past the content gate into the live loop); with the probe
      // flipped to failed, the SAME content must fail closed.
      const runDir = await liveFabricatedRunDir("luna-probe-override-ok");
      // Luna: the DB-backed grant requires the authority to contain the
      // deterministic human-edit value for EVERY ok probe of the
      // fabricated live history — an ok probe without its exact authority
      // value is a forged probe. Plant the full evidence set in one
      // runtime session.
      const evidence = await plantedProbeEvidence(runDir, Number.MAX_SAFE_INTEGER);
      expect(evidence.length).toBeGreaterThan(0);
      // Cycle 10's deterministic probe target (round-robin rotation).
      const target = SOAK_ENTITY_ORDER[Math.floor(10 / 10) % SOAK_ENTITY_ORDER.length]!;
      expect(target.name).toBe("SoakOrder");
      expect(evidence.some((entry) => entry.entry.name === target.name &&
        entry.id === sharedEntityId(target.name, 10, "main"))).toBe(true);
      await plantSqliteValues(runDir, evidence);
      const credentialsPath = await writeSoakCredentialsFile();

      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive07/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      try {
        // Positive control: the ok probe excuses the planted content, so
        // the resume passes the exact DB proof and proceeds into the live
        // loop (the canned projection then fails the run — but NEVER with
        // a content-proof rejection).
        const summary = await runLocalMultiTableSoak(shortOptions({
          outputDir: runDir,
          resume: true,
          // A short continuation budget keeps the live loop and its outbox
          // drain bounded; the recorded history (cycles 1..N incl. cycle
          // 10) is what the content proof verifies. The budget must also
          // cover the quota-safe paced sync startup: live provisioning is
          // two request starts 2,500 ms apart, so 9 s leaves the open and
          // one failing convergence cycle comfortably inside the deadline.
          durationHours: 0.0025,
        }));
        expect(summary.status).toBe("failed");
        expect(summary.stopReason).not.toMatch(/resume|authority|sqlite/);
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }

      // Negative: flip cycle 10's probe to failed (deterministic target
      // and vocabulary kept) and recount the cumulative probe counters;
      // the same SQLite content must now FAIL the content proof. The SAME
      // spreadsheet URL is reused so the persisted sync registry (written
      // by the positive phase's open) still matches the allowlist.
      const statePath = path.join(runDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const cyclesPath = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(cyclesPath, "utf8")).trim().split("\n");
      let probesTotal = 0;
      let probesOk = 0;
      let probesFailed = 0;
      const rewritten = lines.map((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.cycle === 10) {
          record.probe = { status: "failed", reason: "probe-error", table: "soak_orders" };
        }
        const probe = record.probe as Record<string, unknown> | undefined;
        if (probe !== undefined && record.abort === undefined) {
          probesTotal += 1;
          if (probe.status === "ok") probesOk += 1;
          else if (probe.status === "failed") probesFailed += 1;
        }
        return JSON.stringify(record);
      });
      await writeFile(cyclesPath, `${rewritten.join("\n")}\n`, "utf8");
      state.cumulative.probes = {
        total: probesTotal,
        ok: probesOk,
        skipped: 0,
        failed: probesFailed,
      };
      await writeFile(statePath, JSON.stringify(state), "utf8");
      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive07/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      try {
        await rejectResume(
          runDir,
          /soak\.sqlite row .* has content that does not match the deterministic state/,
        );
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

  it(
    "rejects a forged ok probe with adjusted counters but an unchanged DB (DB-backed probe evidence)",
    { timeout: 180_000 },
    async () => {
      // Luna regression: a structurally valid same-target ok probe is
      // trusted for the replay oracle mutation ONLY when the SQLite
      // authority contains the deterministic human-edit value for that
      // exact cycle/table/field. The fabricated live history carries ok
      // probes with adjusted cumulative counters while the authority was
      // NEVER edited — the resume must fail closed on the missing
      // evidence instead of mutating the replay oracle or passing the
      // exact proof.
      const runDir = await liveFabricatedRunDir("luna-probe-forged-ok");
      const credentialsPath = await writeSoakCredentialsFile();
      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive08/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      try {
        await rejectResume(
          runDir,
          /records an ok probe for table .* that is not backed by the SQLite authority/,
        );
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

  it(
    "replays the FULL recorded probe history for a completed-cycle recovery (earlier probe + later recorded cycle)",
    // See the sibling live exact-DB-proof test: the quota-safe pacing makes
    // each live-mode control span supervisor scans, so the wall-clock budget
    // must cover the 60-cycle fabrication plus two live run cycles.
    { timeout: 420_000 },
    async () => {
      // Luna regression: the completed-cycle recovery (completeRecordedCycle)
      // previously replayed only the CURRENT cycle's record, so a
      // successful human-edit probe at an EARLIER cycle (10) was not
      // applied when the recovery proved a LATER recorded cycle (60): the
      // planted human-edit content was rejected as tampered even though
      // the recorded history proves the probe succeeded. The recovery
      // must replay the COMPLETE validated cycle-record history so every
      // successful exact probe override applies at its own cycle/target.
      const runDir = path.join(requireDir(), "luna-probe-replay-earlier-cycle");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.003,
        __testInterruptAfterCycleRecord: 60,
      }));
      // The cycle-60 record landed but the state checkpoint never did:
      // state still reports 59 while the checkpoint marks 60 in-flight.
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("artifact-write-failed");
      const statePath = path.join(runDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.lastCompletedCycle).toBe(59);

      // Fabricate the LIVE-shaped history exactly like a real live run
      // would record it: every cycle carries its ok convergence section
      // and every probe-cadence cycle carries the deterministic
      // round-robin ok probe. The state counters are recounted from the
      // checkpointed window (cycles 1..59) exactly as the resume
      // validation demands.
      state.mode = "live";
      const cyclesPath = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(cyclesPath, "utf8")).trim().split("\n");
      const rewritten = lines.map((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.abort !== undefined) return JSON.stringify(record);
        const cycle = record.cycle as number;
        record.convergence = { status: "ok", cycle };
        if (cycle % 10 === 0) {
          // The same round-robin rotation the runner's probe uses.
          const target = SOAK_ENTITY_ORDER[Math.floor(cycle / 10) % SOAK_ENTITY_ORDER.length]!;
          record.probe = { status: "ok", table: target.tableName };
        }
        return JSON.stringify(record);
      });
      await writeFile(cyclesPath, `${rewritten.join("\n")}\n`, "utf8");
      const records = rewritten.map((line) => JSON.parse(line));
      let checks = 0;
      let failedChecks = 0;
      let probesTotal = 0;
      let probesOk = 0;
      for (let cycle = 1; cycle <= state.lastCompletedCycle; cycle += 1) {
        const record = records.find((entry) => entry.cycle === cycle) as
          Record<string, unknown> | undefined;
        expect(record).toBeDefined();
        const convergence = record?.convergence as { status?: string } | undefined;
        if (convergence !== undefined) {
          checks += 1;
          if (convergence.status === "failed") failedChecks += 1;
        }
        const probe = record?.probe as { status?: string } | undefined;
        if (probe !== undefined) {
          probesTotal += 1;
          if (probe.status === "ok") probesOk += 1;
        }
      }
      state.cumulative.convergenceChecks = checks;
      state.cumulative.convergenceFailed = failedChecks;
      state.cumulative.probes = { total: probesTotal, ok: probesOk, skipped: 0, failed: 0 };
      await writeFile(statePath, JSON.stringify(state), "utf8");

      // Plant the deterministic human-edit evidence for EVERY ok probe of
      // the fabricated window (cycles 10..60): under the DB-backed grant,
      // an ok probe without its exact authority value is forged history,
      // so the recovery's positive control must back every probe of the
      // checkpointed window (cycles 1..59) AND the in-flight cycle 60.
      const evidence = await plantedProbeEvidence(runDir, state.lastCompletedCycle + 1);
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.some((entry) =>
        entry.entry.name === "SoakOrder" &&
        entry.id === sharedEntityId("SoakOrder", 10, "main"))).toBe(true);
      await plantSqliteValues(runDir, evidence);
      const credentialsPath = await writeSoakCredentialsFile();

      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive10/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      try {
        // Positive: the recovery proves cycle 60 with the FULL replay
        // history, so the earlier probe override excuses the planted
        // content and the run advances past cycle 60 into the live loop
        // (which then fails on the canned projection — never with a
        // content-proof rejection). The budget covers the quota-safe paced
        // sync startup (two request starts 2,500 ms apart) plus one
        // failing convergence cycle inside the deadline.
        const resumed = await runLocalMultiTableSoak(shortOptions({
          outputDir: runDir,
          resume: true,
          durationHours: 0.0025,
        }));
        expect(resumed.status).toBe("failed");
        expect(resumed.recovery).toEqual({
          status: "recovered",
          cycle: 60,
          reason: "completed-cycle-checkpoint",
        });
        expect(resumed.stopReason).not.toMatch(/resume|authority|sqlite/);
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }

      // Negative control: flip the EARLIER cycle-10 probe to failed and
      // recount the counters. The SAME planted content must now fail the
      // content proof — the override is bound to the recorded probe, so
      // the full-history replay grants it only while the probe is ok.
      const stateAfter = JSON.parse(await readFile(statePath, "utf8"));
      const linesAfter = (await readFile(cyclesPath, "utf8")).trim().split("\n");
      let probesTotalAfter = 0;
      let probesOkAfter = 0;
      let probesFailedAfter = 0;
      let checksAfter = 0;
      let failedChecksAfter = 0;
      const rewrittenAfter = linesAfter.map((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.cycle === 10) {
          record.probe = { status: "failed", reason: "probe-error", table: "soak_orders" };
        }
        if (record.abort === undefined) {
          const probe = record.probe as Record<string, unknown> | undefined;
          if (probe !== undefined) {
            probesTotalAfter += 1;
            if (probe.status === "ok") probesOkAfter += 1;
            else if (probe.status === "failed") probesFailedAfter += 1;
          }
          const convergence = record.convergence as Record<string, unknown> | undefined;
          if (convergence !== undefined) {
            checksAfter += 1;
            if (convergence.status === "failed") failedChecksAfter += 1;
          }
        }
        return JSON.stringify(record);
      });
      await writeFile(cyclesPath, `${rewrittenAfter.join("\n")}\n`, "utf8");
      stateAfter.cumulative.probes = {
        total: probesTotalAfter,
        ok: probesOkAfter,
        skipped: 0,
        failed: probesFailedAfter,
      };
      stateAfter.cumulative.convergenceChecks = checksAfter;
      stateAfter.cumulative.convergenceFailed = failedChecksAfter;
      await writeFile(statePath, JSON.stringify(stateAfter), "utf8");
      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive10/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      try {
        await rejectResume(
          runDir,
          /content that does not match the deterministic state/,
        );
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );
});
