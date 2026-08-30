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

  it(
    "rejects a probe-cadence cycle whose probe section was removed",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: every 10th cycle runs a probe and its record must carry
      // it — removing the section would let a tampered record pass as a
      // cycle that never probed.
      const runDir = await completedRunDir("med8-probe-missing", 0.0015);
      await rewriteCycleRecord(runDir, 10, (record) => {
        delete record.probe;
      });
      await rejectResume(runDir, /cycle 10 is on the probe cadence but has no probe section/);
    },
  );

  it(
    "rejects a local-mode probe that is not the documented skipped shape",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: a local run can only ever produce the documented skipped
      // probe (`skipped`/`local-mode`); an ok/failed probe is tampering.
      const runDir = await completedRunDir("med8-probe-shape", 0.0015);
      await rewriteCycleRecord(runDir, 10, (record) => {
        (record.probe as Record<string, unknown>).status = "ok";
      });
      await rejectResume(
        runDir,
        /cycle 10 carries a probe shape a local-mode run can never produce/,
      );
    },
  );

  it(
    "rejects a probe section on an off-cadence cycle",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: the runner never writes a probe outside the cadence, so a
      // forged section on cycle 2 is tampering, not history.
      const runDir = await completedRunDir("med8-probe-off-cadence", 0.0015);
      await rewriteCycleRecord(runDir, 2, (record) => {
        record.probe = { status: "skipped", reason: "local-mode" };
      });
      await rejectResume(runDir, /cycle 2 carries a probe section off the probe cadence/);
    },
  );

  it(
    "rejects a convergence section in a local-mode cycle",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: local cycles never run the Sheets convergence check; a
      // recorded convergence section means the record was forged.
      const runDir = await completedRunDir("med8-convergence-local");
      await rewriteCycleRecord(runDir, 1, (record) => {
        record.convergence = { status: "ok", cycle: 1 };
      });
      await rejectResume(runDir, /cycle 1 carries a convergence section in local mode/);
    },
  );

  it(
    "rejects a cycle whose tablesTouched does not match the active selected table set",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: every cycle touches every active table (prologue) and
      // every active entity (actor stream); the record's sorted deduped
      // set must equal that union exactly — a missing/extra entry is a
      // forged or tampered record.
      const runDir = await completedRunDir("med8-tables-touched");
      await rewriteCycleRecord(runDir, 1, (record) => {
        const touched = record.tablesTouched as string[];
        touched.pop(); // drop one table from the exact plan-derived union
      });
      await rejectResume(runDir, /tablesTouched does not match the deterministic plan-derived table set/);
    },
  );

  it(
    "rejects a reopen-cadence cycle whose reopen result was removed",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: every 60th cycle closes and reopens the runtime and its
      // record must carry the reopen result; only the exact abort shape
      // (the reopen itself failed) is exempt.
      const runDir = await completedRunDir("med8-reopen-missing", 0.003);
      await rewriteCycleRecord(runDir, 60, (record) => {
        delete record.reopen;
      });
      await rejectResume(runDir, /cycle 60 is on the reopen cadence but has no reopen result/);
    },
  );

  it(
    "accepts the abort shape as the reopen-cadence exception",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: a reopen-failed cycle 60 carries the exact abort record
      // (no reopen section) — the documented exception. The resume must
      // reach the NEXT integrity check (the deterministic op grid) instead
      // of rejecting the missing reopen section; the injected op gap below
      // proves the section check passed first.
      const runDir = path.join(requireDir(), "med8-reopen-abort-shape");
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
    "rejects a live-mode cycle whose convergence section was removed",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: in live mode EVERY cycle runs the Sheets convergence
      // check, so a record without the section cannot be trusted history.
      // The state is fabricated from a completed LOCAL run (mode flipped to
      // live, matching the fake live env) and the section validation runs
      // BEFORE any runtime opens — the resume must be rejected at the
      // convergence requirement, never reach the sync startup boundary.
      const runDir = await completedRunDir("med8-live-convergence");
      const { writeFile: write } = await import("node:fs/promises");
      const statePath = path.join(runDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      state.mode = "live";
      await write(statePath, JSON.stringify(state), "utf8");

      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive01/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "fake-credentials.json";
      try {
        // The recorded local cycles carry no convergence section: in live
        // mode that is a safe pre-mutation rejection.
        await rejectResume(
          runDir,
          /cycle 1 is a live-mode cycle but has no convergence section/,
        );
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

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
    "accepts live-shaped cycle records past the section gate",
    { timeout: 90_000 },
    async () => {
      // MEDIUM positive gate: when every recorded cycle carries its
      // convergence section, its live probe matches the deterministic
      // round-robin target, and the counters match, the mode/cadence
      // validation must NOT reject — the resume proceeds past the history
      // validation and only fails later at the sync startup boundary
      // (credentials validation), never at the section checks.
      const runDir = await liveFabricatedRunDir("med8-live-accept");

      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive02/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "fake-credentials.json";
      try {
        // The section gate passed: the failure is the sync startup's own
        // credentials boundary, never a convergence/probe-section rejection.
        await expect(
          runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
        ).rejects.toThrow(/Credentials file not found/);
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

  it(
    "rejects a convergence section whose cycle does not match the record's cycle",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: the ok convergence section carries the cycle it checked;
      // a cycle that differs from the record's own cycle is a forged or
      // moved section — rejected at the exact-shape pass, before any
      // mode/cadence or runtime check.
      const runDir = await completedRunDir("med8-convergence-cycle");
      await rewriteCycleRecord(runDir, 1, (record) => {
        record.convergence = { status: "ok", cycle: 2 }; // forged cycle
      });
      await rejectResume(runDir, /convergence\.cycle 2 does not match the record's cycle 1/);
    },
  );

  it(
    "rejects an ok convergence section carrying count fields",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: an ok check records ONLY { status, cycle }; a count field
      // on an ok section is a forged section (the runner writes counts
      // only on failed checks).
      const runDir = await completedRunDir("med8-convergence-ok-counts");
      await rewriteCycleRecord(runDir, 1, (record) => {
        record.convergence = { status: "ok", cycle: 1, missingRows: 3 };
      });
      await rejectResume(runDir, /convergence\.missingRows is not a field of an ok convergence section/);
    },
  );

  it(
    "rejects a local probe section carrying fields a local probe never has",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: the local probe is EXACTLY { status: "skipped", reason:
      // "local-mode" }; a table field (or any other extra field) means the
      // record was forged.
      const runDir = await completedRunDir("med8-probe-extra-field", 0.0015);
      await rewriteCycleRecord(runDir, 10, (record) => {
        (record.probe as Record<string, unknown>).table = "soak_tasks";
      });
      await rejectResume(runDir, /cycle 10 carries a probe shape a local-mode run can never produce/);
    },
  );

  it(
    "rejects a live probe whose table is not the deterministic round-robin target",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: in live mode the probe targets the deterministic
      // round-robin entity for its cycle (same rotation as the runner); a
      // vocabulary-valid but different table means the record was forged
      // or moved.
      const runDir = await liveFabricatedRunDir("med8-live-probe-target");
      await rewriteCycleRecord(runDir, 10, (record) => {
        const probe = record.probe as Record<string, unknown>;
        probe.table = "soak_customers"; // wrong target for cycle 10
      });
      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive03/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "fake-credentials.json";
      try {
        await rejectResume(
          runDir,
          /cycle 10 probe\.table does not match the deterministic round-robin target/,
        );
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

  it(
    "rejects a live probe failure reason outside the probe vocabulary",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: a failed live probe carries exactly { status, reason,
      // table } with a reason the runner can actually record in live mode;
      // a shape-valid but mode-impossible reason (no-string-field is a
      // skipped-probe reason, never a failure reason) proves the reason is
      // narrowed to the LIVE failure vocabulary.
      const runDir = await liveFabricatedRunDir("med8-live-probe-reason");
      await rewriteCycleRecord(runDir, 10, (record) => {
        record.probe = { status: "failed", reason: "no-string-field", table: "soak_orders" };
      });
      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive04/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "fake-credentials.json";
      try {
        await rejectResume(runDir, /cycle 10 probe failure reason is not one a live run can produce/);
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

  it(
    "accepts a failed live probe artifact carrying a statusClass past the proof",
    { timeout: 90_000 },
    async () => {
      // HIGH: a failed direct-Sheets probe now persists an OPTIONAL
      // statusClass, so the artifact is { status, reason, table,
      // statusClass }. The resume proof must accept that four-field shape
      // (and the legacy three-field form) as valid history — a valid run
      // whose probe hit a direct-Sheets error must survive --resume, not
      // be rejected for carrying the persisted status class. We fabricate
      // the live run with a failed probe that carries a known status class
      // and re-run resume: the proof must pass (only the sync startup
      // credentials boundary may fail).
      const runDir = await liveFabricatedRunDir("high8-failed-probe-statusclass");
      const { writeFile: write } = await import("node:fs/promises");
      const statePath = path.join(runDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const cyclesPath = path.join(runDir, "cycles.jsonl");
      const lines = (await readFile(cyclesPath, "utf8")).trim().split("\n");
      let failed = 0;
      const rewritten = lines.map((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        const probe = record.probe as Record<string, unknown> | undefined;
        if (probe !== undefined && probe.status === "ok") {
          // Reproduce the runner's failed direct-probe artifact: the
          // reason is always probe-error and the direct error's
          // allowlisted status class is persisted alongside
          // status/reason/table.
          record.probe = {
            status: "failed",
            reason: "probe-error",
            statusClass: "http_429",
            table: probe.table,
          };
          failed += 1;
        }
        return JSON.stringify(record);
      });
      await write(cyclesPath, `${rewritten.join("\n")}\n`, "utf8");
      state.cumulative.probes = {
        total: state.cumulative.probes.total,
        ok: state.cumulative.probes.total - failed,
        skipped: 0,
        failed,
      };
      await write(statePath, JSON.stringify(state), "utf8");

      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive05/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "fake-credentials.json";
      try {
        // The proof passed: the failure is the sync startup's credentials
        // boundary, never a failed-probe schema/field rejection.
        await expect(
          runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
        ).rejects.toThrow(/Credentials file not found/);
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

  it(
    "rejects a failed live probe whose statusClass is raw or unknown",
    { timeout: 90_000 },
    async () => {
      // HIGH: a failed probe may carry a statusClass ONLY through the
      // persisted status-class validator; a raw/arbitrary status value
      // never reaches an artifact unredacted and must be rejected on
      // resume (rejected at the exact-shape pass, before any field-count
      // or mode/cadence check).
      const runDir = await liveFabricatedRunDir("high8-failed-probe-raw-statusclass");
      await rewriteCycleRecord(runDir, 10, (record) => {
        record.probe = {
          status: "failed",
          reason: "probe-error",
          statusClass: "raw_provider_429",
          table: "soak_orders",
        };
      });
      process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
        "https://docs.google.com/spreadsheets/d/soaklive06/edit";
      process.env.GOOGLE_APPLICATION_CREDENTIALS = "fake-credentials.json";
      try {
        await rejectResume(runDir, /probe\.statusClass is not a known status class/);
      } finally {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      }
    },
  );

  it(
    "rejects a reopen section that omits an active table",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: the reopen section carries exactly one count per active
      // table; a missing table means the section was tampered.
      const runDir = await completedRunDir("med8-reopen-missing-table", 0.003);
      await rewriteCycleRecord(runDir, 60, (record) => {
        delete (record.reopen as Record<string, unknown>).soak_tasks;
      });
      await rejectResume(runDir, /reopen counts do not cover exactly the active tables/);
    },
  );

  it(
    "rejects a reopen count that contradicts the deterministic replay",
    { timeout: 90_000 },
    async () => {
      // MEDIUM: the post-reopen counts are a pure function of the stored
      // seed/params (the replay reproduces them exactly); a tampered count
      // is forged history.
      const runDir = await completedRunDir("med8-reopen-count-tamper", 0.003);
      await rewriteCycleRecord(runDir, 60, (record) => {
        const reopen = record.reopen as Record<string, unknown>;
        reopen.soak_tasks = (reopen.soak_tasks as number) + 1;
      });
      await rejectResume(
        runDir,
        /reopen count for soak_tasks \(\d+\) does not match the deterministic replay/,
      );
    },
  );

  it(
    "rejects a forged failed reopen status whose counts all match the deterministic replay",
    { timeout: 90_000 },
    async () => {
      // Luna: reopen.status is bound to evidence. The runner emits failed
      // only when the counts/scan evidence differed (or the reopen
      // cleanup/replacement failed, which is the abort shape — never a
      // reopen section). A forged failed status on a record whose counts
      // exactly match the successful replay is tampered history.
      const runDir = await completedRunDir("luna-reopen-forged-failed", 0.003);
      await rewriteCycleRecord(runDir, 60, (record) => {
        (record.reopen as Record<string, unknown>).status = "failed";
      });
      await rejectResume(
        runDir,
        /reports a failed reopen but the full-scan evidence is ok and every count matches/,
      );
    },
  );

  it(
    "accepts a failed reopen whose counts differ from the replay (evidence-differing counts)",
    { timeout: 90_000 },
    async () => {
      // Luna: a failed reopen records the OBSERVED counts, so at least one
      // table must differ from the replayed post-cycle counts. This
      // positive gate test proves a failed-with-evidence section PASSES
      // the reopen validation: the resume proceeds past the history gate
      // and fails only at the authority content proof (the evidence really
      // differed), never with a reopen-section rejection.
      const runDir = await completedRunDir("luna-reopen-failed-evidence", 0.003);
      await rewriteCycleRecord(runDir, 60, (record) => {
        const reopen = record.reopen as Record<string, unknown>;
        reopen.status = "failed";
        reopen.soak_tasks = (reopen.soak_tasks as number) + 1;
      });
      // Make the evidence genuinely differ: remove one deterministic row
      // from the authority through the public API, so the content proof
      // fails with the missing-rows reason — proving the reopen section
      // gate itself accepted the failed-with-evidence shape.
      const { tokens } = buildSoakEntities();
      const runtime = await createTypedSheets({
        dbName: path.join(runDir, "soak.sqlite"),
        entities: [...tokens] as unknown as readonly HikouteiEntity[],
      });
      try {
        const em = runtime.em.fork();
        const token = tokens[
          SOAK_ENTITY_ORDER.findIndex((entry) => entry.tableName === "soak_tasks")
        ] as unknown as HikouteiEntity;
        const rows = await em.find(token, {});
        expect(rows.length).toBeGreaterThan(0);
        em.remove(rows[0]!);
        await em.flush();
      } finally {
        await runtime.close();
      }
      await rejectResume(runDir, /missing rows expected from state\.tableRows/);
    },
  );
});
