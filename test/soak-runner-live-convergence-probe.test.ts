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
import { DirectSheetsError } from "../scripts/ci/local-soak/sheetsDirect.mjs";
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

describe("soak runner replay oracle probe override (Luna)", () => {
  /**
   * Minimal live-mode replay fixture: a valid state plus one record per
   * cycle (only cycle 10 carries a probe section, configured by the
   * caller). The deterministic probe of cycle 10 targets SoakOrder and
   * picks `customerKey` (same rng/rotation as runHumanEditProbe), and
   * seed 5 makes the cycle-12 findFiltered op anchor its operand on the
   * cycle-10 main row's customerKey — the exact value the replay oracle
   * must (or must not) carry. `probeEvidence` mirrors the DB-backed
   * authority evidence set of the resume paths (absent = JSONL-only
   * structural grant).
   */
  function replayFixture(cycle10Probe: unknown, probeEvidence?: Set<string>) {
    const state = {
      seed: 5,
      mode: "live" as const,
      lastCompletedCycle: 15,
      params: {
        actors: 2,
        operationsPerActor: 4,
        resolvedTables: SOAK_ENTITY_ORDER.map((entry) => entry.tableName),
      },
    };
    const cycleByNumber = new Map<number, Record<string, unknown>>();
    for (let cycle = 1; cycle <= 15; cycle += 1) {
      cycleByNumber.set(cycle, {
        cycle,
        ...(cycle === 10 && cycle10Probe !== undefined ? { probe: cycle10Probe } : {}),
      });
    }
    return replayDeterministicHistory({
      state,
      activeEntities: SOAK_ENTITY_ORDER,
      cycleByNumber,
      ...(probeEvidence === undefined ? {} : { probeEvidence }),
    });
  }

  it(
    "applies a proven cycle-10 human edit to the replay oracle so a later cycle's plan anchors on the edited value",
    { timeout: 30_000 },
    () => {
      // Luna: the replay oracle must carry each PROVEN probe override at
      // the same point the live loop applied it (after that cycle's
      // deterministic prologue/actor state, before the NEXT cycle's
      // filters/plan are derived). Without it, a later cycle's planned
      // filter operands (anchored on live oracle row values) diverge
      // from the plan the live run executed against the edited
      // authority. On a DB-backed path the ok probe record at cycle 10
      // is the structural half of the evidence; the authority containing
      // the deterministic human-edit value (`10:soak_orders`) is the
      // other half — both together grant the replayed cycle-12
      // findFiltered op its anchor on the EDITED value.
      const replay = replayFixture({ status: "ok", table: "soak_orders" }, new Set(["10:soak_orders"]));
      expect(replay.ungrantedProbeOverrides).toEqual([]);
      const anchored = (replay.cyclePlans.get(12) ?? []).find((op) =>
        JSON.stringify(op).includes("human-edit-c10"));
      expect(anchored).toBeDefined();
      expect((anchored as { kind?: string }).kind).toBe("findFiltered");
      expect((anchored as { filter?: unknown }).filter).toEqual({
        customerKey: { ne: "human-edit-c10" },
      });
    },
  );

  it(
    "rejects failed, missing, and tampered probe evidence: the replay oracle is never mutated",
    { timeout: 30_000 },
    () => {
      // Luna negative controls: the override is granted ONLY by a
      // recorded ok probe naming the deterministic target. A failed
      // probe, a missing probe section, or an ok probe pointing at the
      // wrong table must all leave the replay oracle untouched — the
      // SAME deterministic op then anchors on the original generated
      // value, and the edited value never appears in any later plan.
      const failedReplay = replayFixture({ status: "failed", reason: "probe-error", table: "soak_orders" });
      const missingReplay = replayFixture(undefined);
      const tamperedReplay = replayFixture({ status: "ok", table: "soak_customers" });
      for (const replay of [failedReplay, missingReplay, tamperedReplay]) {
        // The cycle-12 findFiltered op (actor 1, index 3) keeps the
        // original deterministic anchor — never the edited value.
        const op = (replay.cyclePlans.get(12) ?? []).find((candidate) =>
          (candidate as { actor?: number }).actor === 1 &&
          (candidate as { opIndex?: number }).opIndex === 3 &&
          (candidate as { kind?: string }).kind === "findFiltered");
        expect(op).toBeDefined();
        expect((op as { filter?: unknown }).filter).toEqual({
          customerKey: { ne: "garnet-1456" },
        });
        // The edited value must not appear in ANY later cycle's plan.
        for (let cycle = 11; cycle <= 15; cycle += 1) {
          for (const planned of replay.cyclePlans.get(cycle) ?? []) {
            expect(JSON.stringify(planned)).not.toContain("human-edit-c10");
          }
        }
      }
    },
  );

  it(
    "denies the override without DB-backed evidence and reports the ok probe as ungranted",
    { timeout: 30_000 },
    () => {
      // Luna: on a DB-backed path a structurally valid same-target ok
      // probe with NO authority evidence (forged record with adjusted
      // counters, unchanged DB) must not mutate the replay oracle — the
      // later plan anchors on the original generated value — and must be
      // reported so the resume fails closed instead of passing the exact
      // proof.
      const replay = replayFixture({ status: "ok", table: "soak_orders" }, new Set());
      expect(replay.ungrantedProbeOverrides).toEqual([
        { cycle: 10, tableName: "soak_orders" },
      ]);
      const op = (replay.cyclePlans.get(12) ?? []).find((candidate) =>
        (candidate as { actor?: number }).actor === 1 &&
        (candidate as { opIndex?: number }).opIndex === 3 &&
        (candidate as { kind?: string }).kind === "findFiltered");
      expect(op).toBeDefined();
      expect((op as { filter?: unknown }).filter).toEqual({
        customerKey: { ne: "garnet-1456" },
      });
      // The edited value must not appear in ANY later cycle's plan.
      for (let cycle = 11; cycle <= 15; cycle += 1) {
        for (const planned of replay.cyclePlans.get(cycle) ?? []) {
          expect(JSON.stringify(planned)).not.toContain("human-edit-c10");
        }
      }
    },
  );

  it(
    "grants the override only when the authority contains the deterministic human-edit value",
    { timeout: 30_000 },
    () => {
      // Luna positive control for the DB-backed grant: with the evidence
      // key present (the authority main row carries `human-edit-c10` in
      // the deterministic field), the same ok probe mutates the replay
      // oracle exactly like the live loop did and nothing is reported
      // ungranted.
      const replay = replayFixture(
        { status: "ok", table: "soak_orders" },
        new Set(["10:soak_orders"]),
      );
      expect(replay.ungrantedProbeOverrides).toEqual([]);
      const anchored = (replay.cyclePlans.get(12) ?? []).find((op) =>
        JSON.stringify(op).includes("human-edit-c10"));
      expect(anchored).toBeDefined();
      expect((anchored as { kind?: string }).kind).toBe("findFiltered");
      expect((anchored as { filter?: unknown }).filter).toEqual({
        customerKey: { ne: "human-edit-c10" },
      });
    },
  );
});


describe("soak runner live convergence tombstone accounting", () => {
  it("converges when the projection holds durable tombstone rows", async () => {
    // System_State retains deleted entities as tombstone rows; they must
    // not count as extra ids, so the check succeeds against an oracle
    // that only knows the active ids.
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", "name", "__typed_sheets_deleted"],
      ["r1", "ada", "FALSE"],
      ["deleted-1", "old row", "TRUE"],
    ]);
    const result = await checkSheetsConvergence({
      cycle: 7,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabRows },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined);
    expect(result).toEqual({ status: "ok", cycle: 7 });
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("still fails with extra rows when a blank-id content row carries a tombstone display", async () => {
    // A tombstone without an id is malformed; the physical row with real
    // content must surface as an extra row, never be hidden.
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", "name", "__typed_sheets_deleted"],
      ["r1", "ada", "FALSE"],
      ["", "orphan", "TRUE"],
    ]);
    const result = await checkSheetsConvergence({
      cycle: 8,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabRows },
      },
      // Short phase budget: the failed check polls until the deadline,
      // so the budget bounds the test wall time.
      deadlineAtMs: Date.now() + 300,
    }, undefined);
    expect(result.status).toBe("failed");
    expect(result.extraRows).toBe(1);
  });
});


describe("soak runner live convergence batched reads", () => {
  it("uses ONE batched readTabsRows request per round when the client provides it", async () => {
    // The batch client reads every active System tab in a single call;
    // the runner must issue exactly one request per round and never fall
    // back to per-tab reads.
    const readTabsRows = vi.fn().mockResolvedValue({
      User_System: [
        ["id", "name", "__typed_sheets_deleted"],
        ["r1", "ada", "FALSE"],
        ["deleted-1", "old row", "TRUE"],
      ],
      Order_System: [
        ["id", "name"],
        ["o1", "book"],
      ],
    });
    const readTabRows = vi.fn();
    const result = await checkSheetsConvergence({
      cycle: 9,
      oracle: { ids: (entityName: string) => (entityName === "User" ? ["r1"] : ["o1"]) },
      activeEntities: [{ name: "User" }, { name: "Order" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined);
    expect(result).toEqual({ status: "ok", cycle: 9 });
    expect(readTabsRows).toHaveBeenCalledTimes(1);
    expect(readTabsRows).toHaveBeenCalledWith(
      "spreadsheet-id",
      ["User_System", "Order_System"],
      { deadlineAtMs: expect.any(Number) },
    );
    expect(readTabRows).not.toHaveBeenCalled();
  });

  it("falls back to one readTabRows call per entity when the batch method is absent", async () => {
    // A client that only implements the old per-tab method keeps the
    // previous per-entity request behavior unchanged.
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", "name"],
      ["r1", "ada"],
    ]);
    const result = await checkSheetsConvergence({
      cycle: 10,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }, { name: "Order" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabRows },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined);
    expect(result).toEqual({ status: "ok", cycle: 10 });
    expect(readTabRows).toHaveBeenCalledTimes(2);
    expect(readTabRows).toHaveBeenNthCalledWith(1, "spreadsheet-id", "User_System", {
      deadlineAtMs: expect.any(Number),
    });
    expect(readTabRows).toHaveBeenNthCalledWith(2, "spreadsheet-id", "Order_System", {
      deadlineAtMs: expect.any(Number),
    });
  });

  it("treats a missing batch key as an empty tab: fails the round cleanly, never crashes", async () => {
    // The batch response omits Order_System entirely: the runner must
    // treat it like an empty read (no header -> not converged) instead
    // of crashing on an undefined rows value.
    const readTabsRows = vi.fn().mockResolvedValue({
      User_System: [
        ["id", "name"],
        ["r1", "ada"],
      ],
    });
    const readTabRows = vi.fn();
    const result = await checkSheetsConvergence({
      cycle: 11,
      oracle: { ids: () => ["o1"] },
      activeEntities: [{ name: "User" }, { name: "Order" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows },
      },
      // Short phase budget: the failed check polls until the deadline,
      // so the budget bounds the test wall time.
      deadlineAtMs: Date.now() + 300,
    }, undefined);
    expect(result.status).toBe("failed");
    expect(readTabRows).not.toHaveBeenCalled();
  });

  it("still detects probe silent overwrites against batched reads", async () => {
    const readTabsRows = vi.fn().mockResolvedValue({
      User_System: [
        ["id", "name"],
        ["r1", "old-value"],
      ],
    });
    const readTabRows = vi.fn();
    const result = await checkSheetsConvergence({
      cycle: 12,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows },
      },
      deadlineAtMs: Date.now() + 300,
    }, {
      entityName: "User",
      field: "name",
      value: "human-edit",
      targetId: "r1",
    });
    expect(result.status).toBe("failed");
    expect(result.projectionMismatch).toBe(true);
  });

  it("accepts a probe value visible through batched reads", async () => {
    const readTabsRows = vi.fn().mockResolvedValue({
      User_System: [
        ["id", "name"],
        ["r1", "human-edit"],
      ],
    });
    const readTabRows = vi.fn();
    const result = await checkSheetsConvergence({
      cycle: 13,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, {
      entityName: "User",
      field: "name",
      value: "human-edit",
      targetId: "r1",
    });
    expect(result).toEqual({ status: "ok", cycle: 13 });
    expect(readTabsRows).toHaveBeenCalledTimes(1);
    expect(readTabRows).not.toHaveBeenCalled();
  });
});

describe("soak runner live convergence bounded read retry", () => {
  it("retries a transient GET once and succeeds on the second read", async () => {
    // A retryable DirectSheetsError (timeout) on the first convergence
    // read is retried once within the phase deadline; the second read
    // succeeds, so the check converges.
    const readTabsRows = vi.fn()
      .mockRejectedValueOnce(new DirectSheetsError("direct sheets request failed: timeout", "timeout", true))
      .mockResolvedValue({
        User_System: [
          ["id", "name"],
          ["r1", "ada"],
        ],
      });
    const result = await checkSheetsConvergence({
      cycle: 20,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows: vi.fn() },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined);
    expect(result).toEqual({ status: "ok", cycle: 20 });
    // Exactly one retry: two reads total.
    expect(readTabsRows).toHaveBeenCalledTimes(2);
  });

  it("bounds a second transient failure to one retry and propagates it", async () => {
    // Two consecutive retryable failures: the read is retried exactly
    // once, then the second failure propagates (the cycle aborts with the
    // stable status class) instead of retrying forever.
    const readTabsRows = vi.fn()
      .mockRejectedValueOnce(new DirectSheetsError("direct sheets request failed: network", "network", true))
      .mockRejectedValueOnce(new DirectSheetsError("direct sheets request failed: network", "network", true));
    await expect(checkSheetsConvergence({
      cycle: 21,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows: vi.fn() },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined)).rejects.toMatchObject({
      name: "DirectSheetsError",
      statusClass: "network",
      retryable: true,
    });
    // Bounded to one retry: two reads total, never more.
    expect(readTabsRows).toHaveBeenCalledTimes(2);
  });

  it("never retries a permanent (non-retryable) failure", async () => {
    // A non-retryable DirectSheetsError (permanent 4xx) propagates
    // immediately with no retry.
    const readTabsRows = vi.fn()
      .mockRejectedValue(new DirectSheetsError("direct sheets request failed: http_404", "http_404", false));
    await expect(checkSheetsConvergence({
      cycle: 22,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows: vi.fn() },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined)).rejects.toMatchObject({
      name: "DirectSheetsError",
      statusClass: "http_404",
      retryable: false,
    });
    expect(readTabsRows).toHaveBeenCalledTimes(1);
  });

  it("never retries a missing-tab/header/identity harness failure", async () => {
    // A deterministic missing state is a harness invariant, never
    // retryable: it propagates immediately.
    const readTabsRows = vi.fn()
      .mockRejectedValue(new DirectSheetsError("tab not found", "missing_tab", false));
    await expect(checkSheetsConvergence({
      cycle: 23,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows: vi.fn() },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined)).rejects.toMatchObject({
      name: "DirectSheetsError",
      statusClass: "missing_tab",
      retryable: false,
    });
    expect(readTabsRows).toHaveBeenCalledTimes(1);
  });

  it("never retries a deadline-expired failure", async () => {
    // A deadline-expired DirectSheetsError is a harness invariant, never
    // retryable: it propagates immediately with no retry.
    const readTabsRows = vi.fn()
      .mockRejectedValue(new DirectSheetsError("direct sheets request skipped: run deadline expired", "deadline_expired", false));
    await expect(checkSheetsConvergence({
      cycle: 24,
      oracle: { ids: () => ["r1"] },
      activeEntities: [{ name: "User" }],
      live: {
        spreadsheetId: "spreadsheet-id",
        client: { readTabsRows, readTabRows: vi.fn() },
      },
      deadlineAtMs: Date.now() + 30_000,
    }, undefined)).rejects.toMatchObject({
      name: "DirectSheetsError",
      statusClass: "deadline_expired",
      retryable: false,
    });
    expect(readTabsRows).toHaveBeenCalledTimes(1);
  });
});
