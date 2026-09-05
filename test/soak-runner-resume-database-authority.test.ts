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

describeLongSoak("soak runner resume database authority (HIGH 1)", () => {
  it(
    "rejects a missing soak.sqlite without recreating an empty authority",
    { timeout: 90_000 },
    async () => {
      const runDir = path.join(requireDir(), "high1-missing-db");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      // Delete the authority: resume must fail BEFORE opening a runtime
      // (opening would silently recreate an empty database) and must not
      // write any artifact.
      const { rm: removeFile } = await import("node:fs/promises");
      await removeFile(path.join(runDir, "soak.sqlite"));
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/does not exist; refusing to recreate an empty authority/);
      // The authority was NOT recreated and no new artifact was written.
      expect(await readdir(runDir)).not.toContain("soak.sqlite");
    },
  );

  it(
    "rejects an empty soak.sqlite instead of silently resetting the authority",
    { timeout: 90_000 },
    async () => {
      const runDir = path.join(requireDir(), "high1-empty-db");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      const { writeFile: write } = await import("node:fs/promises");
      await write(path.join(runDir, "soak.sqlite"), "", "utf8");
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/soak\.sqlite is empty/);
    },
  );

  it(
    "rejects a symlinked soak.sqlite before inspecting or opening the external database",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED, timeout: 90_000 },
    async () => {
      // Luna regression: resume validation must use lstat, so a symlinked
      // authority is rejected BEFORE the read-only schema inspection or
      // the runtime open — the runner can never inspect or mutate an
      // external database through the link.
      const runDir = path.join(requireDir(), "high1-symlinked-db");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      const { rm: removeFile } = await import("node:fs/promises");
      await removeFile(path.join(runDir, "soak.sqlite"));
      const externalDb = path.join(runDir, "external-target.db");
      const precious = "operator data that must never be inspected or mutated\n";
      await writeFile(externalDb, precious, "utf8");
      await symlink(externalDb, path.join(runDir, "soak.sqlite"));
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        /soak\.sqlite is a symbolic link; refusing to inspect or open an external database/,
      );
      // The external target was never opened, inspected, or mutated: it
      // is byte-identical, and the symlink is still in place.
      expect(await readFile(externalDb, "utf8")).toBe(precious);
      expect((await lstat(path.join(runDir, "soak.sqlite"))).isSymbolicLink()).toBe(true);
    },
  );

  it(
    "rejects a symlinked SQLite sidecar before any inspection or open",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED, timeout: 90_000 },
    async () => {
      // Luna regression: a symlinked -wal/-journal/-shm sidecar would let
      // SQLite read or write an external file during the schema inspection
      // or the runtime open. Resume validation rejects every symlinked
      // sidecar before anything touches it.
      const runDir = path.join(requireDir(), "high1-symlinked-wal");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      const externalWal = path.join(runDir, "external-target.wal");
      const precious = "operator wal data that must never be touched\n";
      await writeFile(externalWal, precious, "utf8");
      // A real -wal/-shm sidecar may survive the first run's close; clear
      // them so the planted symlink is the only entry at that name.
      const { rm: removeFile } = await import("node:fs/promises");
      await removeFile(path.join(runDir, "soak.sqlite-wal"), { force: true });
      await removeFile(path.join(runDir, "soak.sqlite-shm"), { force: true });
      await symlink(externalWal, path.join(runDir, "soak.sqlite-wal"));
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        /soak\.sqlite-wal is a symbolic link; refusing to inspect or open an external database sidecar/,
      );
      expect(await readFile(externalWal, "utf8")).toBe(precious);
      expect((await lstat(path.join(runDir, "soak.sqlite-wal"))).isSymbolicLink()).toBe(true);
    },
  );

  it(
    "a fresh run unlinks runner-owned SQLite symlinks without touching their targets",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED, timeout: 90_000 },
    async () => {
      // Luna regression: a fresh run's cleanup must unlink ONLY the
      // in-directory runner-owned names (the authority plus sidecars) by
      // removing the LINK itself — the external targets stay
      // byte-identical and the run proceeds with a real authority.
      const runDir = path.join(requireDir(), "high1-fresh-symlink-cleanup");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "external-target.db"), "precious-db\n", "utf8");
      await writeFile(path.join(runDir, "external-target.wal"), "precious-wal\n", "utf8");
      await symlink(path.join(runDir, "external-target.db"), path.join(runDir, "soak.sqlite"));
      await symlink(path.join(runDir, "external-target.wal"), path.join(runDir, "soak.sqlite-wal"));
      const summary = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(summary.status).toBe("passed");
      // The symlinks were unlinked (link only) and replaced by a real
      // authority; the external targets are byte-identical.
      expect((await lstat(path.join(runDir, "soak.sqlite"))).isSymbolicLink()).toBe(false);
      expect(await readFile(path.join(runDir, "external-target.db"), "utf8")).toBe("precious-db\n");
      expect(await readFile(path.join(runDir, "external-target.wal"), "utf8")).toBe("precious-wal\n");
    },
  );

  it(
    "rejects a row-count mismatch against state.tableRows before mutating",
    { timeout: 90_000 },
    async () => {
      const runDir = path.join(requireDir(), "high1-count-mismatch");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      // Bump one table's checkpointed count: the SQLite authority has the
      // real count, so resume must fail with a stable pre-mutation reason.
      const { writeFile: write } = await import("node:fs/promises");
      const statePath = path.join(runDir, "state.json");
      const state = JSON.parse(await readFile(statePath, "utf8"));
      const table = Object.keys(state.tableRows)[0]!;
      state.tableRows[table] += 1;
      await write(statePath, JSON.stringify(state), "utf8");
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/state\.tableRows for table .* contradicts the recorded history/);
    },
  );

  it(
    "rejects a drifted schema (dropped table) before any workload mutation",
    { timeout: 90_000 },
    async () => {
      const runDir = path.join(requireDir(), "high1-schema-drift");
      const first = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(first.status).toBe("passed");
      // Drop one entity table from the authority. MEDIUM 4: the read-only
      // schema inspection now rejects the drifted schema BEFORE the
      // runtime opens — the old path let the runtime's non-destructive
      // migration recreate the table and only then failed on the row
      // count. Either way the resume is a stable pre-mutation rejection,
      // never a silent reset or a run against a drifted authority.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        db.prepare("drop table soak_feature_flags").run();
      } finally {
        db.close();
      }
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        /--resume failed: soak\.sqlite schema is missing table\(s\) soak_feature_flags/,
      );
    },
  );

  it(
    "rejects a foreign row in the interrupted-cycle authority before any workload mutation",
    { timeout: 90_000 },
    async () => {
      // HIGH 1 regression: the old `actual >= expected` in-flight check
      // accepted ANY superset. The deterministic replay must reject a row
      // the run's stream can never produce, even when the counts still
      // look plausible against the interrupted cycle.
      const runDir = path.join(requireDir(), "high1-foreign-row");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: 5,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("simulated-interruption");
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        db.prepare(
          "insert into soak_tasks (id, title, priority, done, due_at, tag) " +
          "values ('stale-run-sentinel-id', 'stale', 0, 0, null, null)",
        ).run();
      } finally {
        db.close();
      }
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        /soak_tasks contains row stale-run-sentinel-id which no deterministic cycle/,
      );
    },
  );

  it(
    "rejects a same-count field mutation in the interrupted-cycle authority",
    { timeout: 90_000 },
    async () => {
      // HIGH 1 regression: mutating one field IN PLACE keeps the row count
      // identical, which the old count-based checks could never see. The
      // exact replay compares content, so the modified row is rejected
      // before any workload mutation.
      const runDir = path.join(requireDir(), "high1-same-count");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: 5,
      }));
      expect(first.status).toBe("failed");
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        db.prepare(
          "update soak_tasks set title = 'mutated-title' where id = 'task-main-c1'",
        ).run();
      } finally {
        db.close();
      }
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        /task-main-c1 in table soak_tasks has content that does not match the deterministic state/,
      );
    },
  );

  it(
    "accepts and reconciles a forkIsolation row caught between its two flushes (end-to-end resume)",
    { timeout: 120_000 },
    async () => {
      // Luna regression: a process crash between forkA.flush() and
      // forkB.flush() of a forkIsolation actor op leaves the deterministic
      // PRE-PATCH row committed in the authority. The resume must (a)
      // ACCEPT that row during the exact-content verification — it is the
      // valid interrupted stage of that exact op/cycle — and (b) reconcile
      // it to the deterministic post-patch row when the interrupted cycle
      // is re-run, without duplicates or failures. Completed-cycle proof
      // still demands post-patch content; only the explicitly interrupted
      // stage may carry the pre-patch candidate.
      const target = deterministicForkIsolationStage(parseSeed("0x5a0b"), 2, 4);
      const runDir = path.join(requireDir(), "high1-forkisolation-pre-patch");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: target.cycle,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("simulated-interruption");
      expect(first.cyclesCompleted).toBe(target.cycle - 1);
      // The crash landed after the op's create flush: plant the exact
      // deterministic pre-patch row through the PUBLIC EntityManager.
      await plantNewRow(
        runDir,
        { name: target.entityName, tableName: target.tableName },
        target.prePatchRow,
      );

      const second = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        resume: true,
      }));
      expect(second.status).toBe("passed");
      expect(second.operations.failures).toBe(0);
      const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
      expect(state.recovery).toEqual({ cycle: target.cycle, reason: "interrupted-cycle-reconciled" });
      expect(second.recovery).toEqual({
        status: "recovered",
        cycle: target.cycle,
        reason: "interrupted-cycle-reconciled",
      });

      // The reconciled op converged to the deterministic post-patch row:
      // exactly one row, never duplicated by the reconciliation.
      const { tokens } = buildSoakEntities();
      const runtime = await createTypedSheets({
        dbName: path.join(runDir, "soak.sqlite"),
        entities: [...tokens] as unknown as readonly HikouteiEntity[],
      });
      try {
        const em = runtime.em.fork();
        const entry = SOAK_ENTITY_ORDER.find((candidate) => candidate.name === target.entityName)!;
        const token = tokens[SOAK_ENTITY_ORDER.indexOf(entry)] as unknown as HikouteiEntity<{ id: string } & Record<string, unknown>>;
        const row = await em.findOne(token, { id: target.mutateId });
        expect(row).not.toBeNull();
        if (row !== null) {
          const postPatch = target.postPatchRow;
          for (const [field, value] of Object.entries(postPatch)) {
            const observed = (row as Record<string, unknown>)[field];
            if (field === "updatedAt") {
              expect(observed instanceof Date ? observed.getTime() : null)
                .toBe(value instanceof Date ? value.getTime() : null);
            } else {
              expect(observed).toBe(value);
            }
          }
        }
      } finally {
        await runtime.close();
      }
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        const count = db.prepare(
          `select count(*) as count from ${target.tableName} where id = ?`,
        ).get(target.mutateId) as { count?: number };
        expect(count?.count).toBe(1);
      } finally {
        db.close();
      }
      // The JSONL stream stays contiguous with no duplicate cycle records.
      const cycles = (await readFile(path.join(runDir, "cycles.jsonl"), "utf8"))
        .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(cycles.map((record) => record.cycle)).toEqual(
        [...Array(second.cyclesCompleted).keys()].map((index) => index + 1),
      );
      expect(new Set(cycles.map((record) => record.cycle)).size).toBe(cycles.length);
    },
  );

  it(
    "rejects a forkIsolation row whose content matches neither deterministic stage",
    { timeout: 120_000 },
    async () => {
      // Luna: the pre-patch acceptance is BOUND to the exact deterministic
      // stage of the interrupted forkIsolation op — a committed row with
      // arbitrary content (matching neither the pre-patch nor the
      // post-patch candidate) must fail the resume closed, never pass as a
      // plausible interrupted prefix.
      const target = deterministicForkIsolationStage(parseSeed("0x5a0b"), 2, 4);
      const runDir = path.join(requireDir(), "high1-forkisolation-arbitrary");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: target.cycle,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("simulated-interruption");
      // One field mutated to a value the deterministic generator can never
      // produce (the synthetic word pool has no such string): the row is
      // neither the pre-patch nor the post-patch stage.
      const arbitrary = { ...target.prePatchRow, warehouse: "arbitrary-fork-content" };
      await plantNewRow(
        runDir,
        { name: target.entityName, tableName: target.tableName },
        arbitrary,
      );
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        new RegExp(
          `${target.mutateId} in table ${target.tableName} has content that does ` +
          "not match the deterministic interrupted-cycle state",
        ),
      );
      // The authority was NOT mutated by the rejected resume.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        const row = db.prepare(
          `select warehouse from ${target.tableName} where id = ?`,
        ).get(target.mutateId) as { warehouse?: unknown };
        expect(row?.warehouse).toBe("arbitrary-fork-content");
      } finally {
        db.close();
      }
    },
  );

  it(
    "rejects a deleted actor row in a RECORDED cycle instead of passing as an interrupted prefix",
    { timeout: 90_000 },
    async () => {
      // HIGH 1: a cycle whose record landed (completed-cycle-checkpoint
      // recovery) claims COMPLETION — the authority must hold its full
      // deterministic row set. Pre-fix, the recorded in-flight cycle
      // verified as an interrupted PREFIX, so deleting one actor row looked
      // like a plausible earlier interruption cut and the resume advanced
      // state from incomplete SQLite. The exact replay now demands every
      // deterministic row of the recorded cycle.
      const runDir = path.join(requireDir(), "high1-recorded-missing");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptAfterCycleRecord: 5,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("artifact-write-failed");
      // The recorded cycle's actor rows exist in SQLite (the full cycle
      // executed); delete ONE of them.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      const deleted = await deleteOneCycleFiveActorRow(db);
      expect(deleted).toBe(true);
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/missing rows expected from state\.tableRows/);
    },
  );

  it(
    "rejects a tampered actor row in a RECORDED cycle (same-count mutation)",
    { timeout: 90_000 },
    async () => {
      // HIGH 1: tampering one field of a recorded cycle's row keeps every
      // count identical — the exact replay compares CONTENT, so the
      // modified row fails the resume closed instead of advancing state
      // from tampered SQLite.
      const runDir = path.join(requireDir(), "high1-recorded-tampered");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptAfterCycleRecord: 5,
      }));
      expect(first.status).toBe("failed");
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      const tampered = await tamperOneCycleFiveActorRow(db);
      expect(tampered).toBe(true);
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(/content that does not match the deterministic state/);
    },
  );
});

/**
 * Deletes one actor-scoped row of cycle 5 (any table) from the authority.
 *
 * Actor ids are deterministic (`<abbr>-a<actor>-c5-o<opIndex>`) but which
 * table/kinds create rows depends on the seed's plan, so the test locates
 * one through the real rows. Returns false when no such row exists (the
 * seed produced no creating op for cycle 5 — the test then fails loudly
 * instead of silently passing).
 */
async function deleteOneCycleFiveActorRow(db: import("node:sqlite").DatabaseSync): Promise<boolean> {
  const target = await findCycleFiveActorRow(db);
  if (target === undefined) return false;
  db.prepare(`delete from ${target.table} where id = ?`).run(target.id);
  return true;
}

/** Mutates one actor-scoped row of cycle 5 (any table) in place. */
async function tamperOneCycleFiveActorRow(db: import("node:sqlite").DatabaseSync): Promise<boolean> {
  const target = await findCycleFiveActorRow(db);
  if (target === undefined) return false;
  db.prepare(`update ${target.table} set ${target.mutableColumn} = 'tampered-recorded-cycle' where id = ?`)
    .run(target.id);
  return true;
}

/** Locates one actor-scoped row of cycle 5 across all six soak tables. */
async function findCycleFiveActorRow(db: import("node:sqlite").DatabaseSync): Promise<{ table: string; id: string; mutableColumn: string } | undefined> {
  const tables = [
    "soak_customers", "soak_orders", "soak_inventory_items",
    "soak_tasks", "soak_audit_events", "soak_feature_flags",
  ];
  for (const table of tables) {
    const rows = db.prepare(`select id from ${table} where id like '%-a%-c5-%' limit 1`).all();
    if (rows.length > 0 && rows[0]?.id !== undefined) {
      const entityName = {
        soak_customers: "SoakCustomer",
        soak_orders: "SoakOrder",
        soak_inventory_items: "SoakInventoryItem",
        soak_tasks: "SoakTask",
        soak_audit_events: "SoakAuditEvent",
        soak_feature_flags: "SoakFeatureFlag",
      }[table]!;
      const mutable = Object.keys(SOAK_FIELD_PLANS[entityName] ?? {}).find((field) => field !== "id");
      if (mutable === undefined) continue;
      return { table, id: String(rows[0].id), mutableColumn: expectedColumnName(mutable) };
    }
  }
  return undefined;
}


describeLongSoak("soak runner resume schema inspection (MEDIUM 4)", () => {
  it(
    "derives the expected soak columns from the REAL authority schema",
    { timeout: 60_000 },
    async () => {
      // Locks the snake_case column mirror against the real columns the
      // runtime creates, so a naming drift between the inspection and the
      // ORM fails loudly in CI.
      const runDir = path.join(requireDir(), "medium4-column-ground-truth");
      const summary = await runLocalMultiTableSoak(shortOptions({ outputDir: runDir, durationHours: 0.001 }));
      expect(summary.status).toBe("passed");
      const observed = inspectSqliteSchema(path.join(runDir, "soak.sqlite"));
      const expected = SOAK_ENTITY_ORDER.map((entry) => ({
        tableName: entry.tableName,
        columns: soakTableColumns(SOAK_FIELD_PLANS[entry.name] ?? {}),
      }));
      expect(missingSchemaEntries(observed, expected)).toEqual({ tables: [], columns: [] });
    },
  );

  it(
    "rejects a dropped table with zero expected rows before the runtime opens",
    { timeout: 90_000 },
    async () => {
      // MEDIUM 4: a zero-cycle interrupted run expects ZERO checkpointed
      // rows, so a dropped table that the runtime's non-destructive
      // migration recreates would pass every row/content check (the
      // interrupted cycle's stage-0 cut is legal for the last table). The
      // read-only schema inspection must fail the resume BEFORE the
      // runtime opens instead of silently healing the authority.
      const runDir = path.join(requireDir(), "medium4-dropped-table");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: 1,
      }));
      expect(first.status).toBe("failed");
      expect(first.stopReason).toBe("simulated-interruption");
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        db.prepare("drop table soak_feature_flags").run();
      } finally {
        db.close();
      }
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        /soak\.sqlite schema is missing table\(s\) soak_feature_flags/,
      );
      // The schema was NOT healed: the runtime never opened, so the table
      // is still absent.
      const after = inspectSqliteSchema(path.join(runDir, "soak.sqlite"));
      expect(after.soak_feature_flags).toBeUndefined();
    },
  );

  it(
    "rejects a dropped column with zero expected rows before the runtime opens",
    { timeout: 90_000 },
    async () => {
      // MEDIUM 4: same zero-row authority, but the last table keeps its
      // name while one column is dropped. With zero expected rows the
      // content checks cannot see the recreated column (its nulls never
      // get compared), so only the schema inspection can reject it —
      // before the runtime's migration re-adds it.
      const runDir = path.join(requireDir(), "medium4-dropped-column");
      const first = await runLocalMultiTableSoak(shortOptions({
        outputDir: runDir,
        durationHours: 0.0015,
        __testInterruptDuringCycle: 1,
      }));
      expect(first.status).toBe("failed");
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const db = new DatabaseSync(path.join(runDir, "soak.sqlite"));
      try {
        // Clear the table's rows too (simulating a zero-expected-row
        // authority) and drop one nullable column: `updated_at` on the
        // last table.
        db.prepare("delete from soak_feature_flags").run();
        db.prepare("alter table soak_feature_flags drop column updated_at").run();
      } finally {
        db.close();
      }
      await expect(
        runLocalMultiTableSoak(shortOptions({ outputDir: runDir, resume: true })),
      ).rejects.toThrow(
        /soak\.sqlite schema is missing column\(s\) soak_feature_flags\.updated_at/,
      );
      // The column was NOT recreated: the runtime never opened.
      const after = inspectSqliteSchema(path.join(runDir, "soak.sqlite"));
      expect(after.soak_feature_flags).not.toContain("updated_at");
    },
  );
});
