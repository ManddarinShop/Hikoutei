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

describe("soak runner projection id extraction", () => {
  it("extracts ids and counts non-empty blank-id rows as extra rows", () => {
    // A physical row with real content but a blank id cell is a row the
    // oracle never planned; it must surface as an extra row, never be
    // hidden by a truthiness filter.
    const rows = [
      ["r1", "a"],
      ["", "content-without-id"],
      ["r2", "b"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r1", "r2"]);
    expect(blankIdRows).toBe(1);
  });

  it("ignores fully empty trailing padding rows", () => {
    // The range read pads unused rows with empty cells; those are not
    // physical rows and must not count as extra rows.
    const rows = [
      ["r1", "a"],
      ["", ""],
      [],
      [null],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r1"]);
    expect(blankIdRows).toBe(0);
  });

  it("treats null and undefined id cells with content as blank-id rows", () => {
    const rows = [
      [null, "x"],
      [undefined, "y"],
      ["r3", "z"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r3"]);
    expect(blankIdRows).toBe(2);
  });

  it("excludes durable tombstone rows from the active id set", () => {
    // System_State intentionally RETAINS deleted entities as rows whose
    // __typed_sheets_deleted cell displays TRUE; those rows are durable
    // history, never active projections, and must not count as extra or
    // duplicate ids.
    const rows = [
      ["r1", "a", "FALSE"],
      ["deleted-2", "old", "TRUE"],
      ["r3", "c", "FALSE"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0, 2);
    expect(ids).toEqual(["r1", "r3"]);
    expect(blankIdRows).toBe(0);
  });

  it("treats tombstone displays conservatively: TRUE case-insensitive and boolean true only", () => {
    // Formatted booleans arrive as strings; only explicit boolean-true
    // displays mark a row as deleted history. Never a broad truthiness
    // check: "False", "yes", and "1" are NOT tombstone displays and the
    // rows stay active.
    const rows = [
      ["r1", "a", "true"],
      ["r2", "b", "TRUE"],
      ["r3", "c", true],
      ["r4", "d", "False"],
      ["r5", "e", "yes"],
      ["r6", "f", "1"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0, 2);
    expect(ids).toEqual(["r4", "r5", "r6"]);
    expect(blankIdRows).toBe(0);
  });

  it("counts blank-id content rows as extra even when the tombstone looks set", () => {
    // A tombstone without an id is malformed durable history; the row has
    // real content and must surface as extra instead of being hidden.
    const rows = [
      ["r1", "a", "FALSE"],
      ["", "orphan-content", "TRUE"],
      ["r2", "b", "FALSE"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0, 2);
    expect(ids).toEqual(["r1", "r2"]);
    expect(blankIdRows).toBe(1);
  });

  it("keeps the two-argument behavior when no tombstone column is given", () => {
    // Callers that do not pass a tombstone column index keep the original
    // contract: every non-blank id is active, tombstone displays included.
    const rows = [
      ["r1", "a", "TRUE"],
      ["r2", "b", "FALSE"],
    ];
    const { ids, blankIdRows } = extractProjectionIds(rows, 0);
    expect(ids).toEqual(["r1", "r2"]);
    expect(blankIdRows).toBe(0);
  });
});


describe("soak runner System_State readiness barrier", () => {
  const BarrierUser = defineTypedSheetsEntity({
    name: "SoakBarrierUser",
    tableName: "soak_barrier_users",
    properties: {
      id: { type: "string", primary: true },
      status: { type: "string" },
    },
  });

  const barrierProjections = {
    spreadsheetId: "barrier-spreadsheet",
    entities: {
      SoakBarrierUser: {
        systemState: { tabName: "SoakBarrierUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "SoakBarrierUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "SoakBarrierUsers_Input", registeredRange: "A:C" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  /** Opens a sync runtime and queues one pending System_State effect. */
  async function openWithPendingSystemStateEffect(): Promise<InternalSyncService> {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [BarrierUser],
      projections: barrierProjections,
      googleSheetsApi: { transport, rateLimitIntervalMs: 0 },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
      reconciliationIntervalMs: 3_600_000,
    });
    // Stop the supervisors so the flush's System_State effect stays queued:
    // the drain readiness then reports `draining` deterministically.
    await service.stop();
    const em = service.hikoutei.em.fork();
    em.persist(em.create(BarrierUser, { id: "u1", status: "pending" }));
    await em.flush();
    const readiness = await readRuntimeSystemStateReadiness(service.hikoutei);
    if (readiness.status !== "draining") {
      throw new Error("expected the runtime's System_State drain to be pending");
    }
    return service;
  }

  it("defers the batched convergence read while the runtime is draining and proceeds after readiness", async () => {
    const service = await openWithPendingSystemStateEffect();
    try {
      const readTabsRows = vi.fn().mockResolvedValue({
        SoakBarrierUser_System: [
          ["id", "status"],
          ["u1", "pending"],
        ],
      });
      const resultPromise = checkSheetsConvergence({
        cycle: 30,
        oracle: { ids: () => ["u1"] },
        activeEntities: [{ name: "SoakBarrierUser" }],
        live: {
          spreadsheetId: "barrier-spreadsheet",
          client: { readTabsRows, readTabRows: vi.fn() },
        },
        deadlineAtMs: Date.now() + 60_000,
        hikoutei: service.hikoutei,
      }, undefined);

      // Several barrier polls happen while the drain is pending; the batched
      // convergence read must not start.
      await new Promise((resolve) => setTimeout(resolve, 3 * SYSTEM_STATE_READINESS_POLL_MS));
      expect(readTabsRows).not.toHaveBeenCalled();

      // Release the queued effect: the next barrier poll sees readiness and
      // the convergence phase proceeds exactly like the pre-barrier behavior.
      await service.storage.transaction(({ sql }) =>
        sql.run(
          "UPDATE sheet_effect_outbox SET status = 'superseded' WHERE status = 'pending'",
          [],
        ));
      const result = await resultPromise;
      expect(result).toEqual({ status: "ok", cycle: 30 });
      expect(readTabsRows).toHaveBeenCalledTimes(1);
      expect(readTabsRows).toHaveBeenCalledWith(
        "barrier-spreadsheet",
        ["SoakBarrierUser_System"],
        { deadlineAtMs: expect.any(Number) },
      );
    } finally {
      await service.hikoutei.close().catch(() => undefined);
    }
  });

  it("reports ready immediately for runtimes without a registered sync service", async () => {
    const hikoutei = await createTypedSheets({
      dbName: ":memory:",
      entities: [BarrierUser],
    });
    try {
      await expect(waitForRuntimeSystemStateReadiness(
        { hikoutei },
        Date.now() + 30_000,
      )).resolves.toBeUndefined();

      const readTabsRows = vi.fn().mockResolvedValue({
        SoakBarrierUser_System: [["id"], ["u1"]],
      });
      const result = await checkSheetsConvergence({
        cycle: 31,
        oracle: { ids: () => ["u1"] },
        activeEntities: [{ name: "SoakBarrierUser" }],
        live: {
          spreadsheetId: "barrier-spreadsheet",
          client: { readTabsRows, readTabRows: vi.fn() },
        },
        deadlineAtMs: Date.now() + 30_000,
        hikoutei,
      }, undefined);
      expect(result).toEqual({ status: "ok", cycle: 31 });
      expect(readTabsRows).toHaveBeenCalledTimes(1);
    } finally {
      await hikoutei.close().catch(() => undefined);
    }
  });

  it("honors the phase deadline: an endless drain fails with a redacted zero-count check", async () => {
    const service = await openWithPendingSystemStateEffect();
    try {
      const readTabsRows = vi.fn();
      const result = await checkSheetsConvergence({
        cycle: 32,
        oracle: { ids: () => ["u1"] },
        activeEntities: [{ name: "SoakBarrierUser" }],
        live: {
          spreadsheetId: "barrier-spreadsheet",
          client: { readTabsRows, readTabRows: vi.fn() },
        },
        // Short phase budget: the barrier polls until the deadline and the
        // check then fails with the normal redacted shape — the budget
        // bounds the test wall time.
        deadlineAtMs: Date.now() + 3 * SYSTEM_STATE_READINESS_POLL_MS + 150,
        hikoutei: service.hikoutei,
      }, undefined);
      expect(result).toEqual({
        status: "failed",
        missingRows: 0,
        duplicateRows: 0,
      });
      expect(readTabsRows).not.toHaveBeenCalled();
    } finally {
      await service.hikoutei.close().catch(() => undefined);
    }
  });
});
