/**
 * Issue #359: resume fixture seed consistency.
 *
 * Proves that the soak scenario scheduler's batch composition is a PURE
 * function of (seed, cycle, registry, active subset): the same inputs
 * recompose a byte-identical batch, a different active subset changes only
 * the plan targets (never id/phase/order), a different seed changes the
 * batch, and the resume replay paths bind any recorded batch to the seed's
 * own composition — a recorded batch that disagrees with the seed's
 * reconstruction fails closed instead of being replayed as-is.
 *
 * The suite is REGISTRY-CONTENT-AGNOSTIC like the other soak scenario
 * tests: every expectation derives from the actual registered scenarios
 * (0, 1, or many) and the derived scenario vocabulary, never from a
 * hardcoded fixture, so a fixture can never drift from the registry.
 *
 * No credentials, no live Sheets, no SQLite are involved — everything under
 * test is a pure function or the resume planner's pure decision logic.
 */
import { describe, expect, it } from "vitest";
import {
  SCENARIO_KINDS,
  SCENARIO_PHASE_VALUES,
  composeScenarioBatch,
} from "../scripts/ci/local-soak/scenarios/scheduler.mjs";
import {
  SCENARIO_REGISTRY,
} from "../scripts/ci/local-soak/scenarios/registry.mjs";
import {
  KNOWN_SCENARIO_IDS,
  KNOWN_SCENARIO_TAGS,
  SCENARIO_ID_PHASES,
  SCENARIO_ID_TAGS,
} from "../scripts/ci/local-soak/scenarios/scenarioVocabulary.mjs";
import {
  SOAK_ENTITY_ORDER,
  soakTableNameForEntity,
} from "../scripts/ci/local-soak/entities.mjs";
import {
  RECOVERY_REASONS,
  planResumeRecovery,
  replayDeterministicHistory,
} from "../scripts/ci/local-soak/runner.mjs";
import {
  validateCycleScenarioBatch,
  type ScenarioBatchRecord,
} from "../scripts/ci/local-soak/resumeHistoryProof.mjs";
import { validateCycleRecordShape } from "../scripts/ci/local-soak/resumeHistorySchema.mjs";

/** One entity active subset (single-table run). */
const ONE_TABLE_SUBSET = SOAK_ENTITY_ORDER.slice(0, 1);

/** The full registered entity set (full run). */
const FULL_SUBSET = SOAK_ENTITY_ORDER;

/** A seed pair and cycle window guaranteed (empirically) to differ. */
const SEED_A = 1234;
const SEED_B = 5678;
const CONTRAST_CYCLES = 40;

/**
 * Deterministic id/phase/order signature of a batch. Selection and phase
 * assignment are pure functions of (seed, cycle, registry) — they never
 * read the active subset — so this signature is what must survive a subset
 * change and must differ across seeds.
 */
function batchSignature(batch: { scenarios: Array<{ id: string; phase: string; order: number }> }): string {
  return JSON.stringify(batch.scenarios.map((entry) => [entry.id, entry.phase, entry.order]));
}

/** The target entity a composed plan selects, or undefined when it names none. */
function plannedEntityName(plan: Record<string, any>): string | undefined {
  const entityName = plan.target?.entityName ?? plan.entityName;
  return typeof entityName === "string" ? entityName : undefined;
}

describe("deterministic batch reconstruction from (seed, cycle, subset) — issue #359", () => {
  it("recomposes a byte-identical batch for the same (seed, cycle, subset)", () => {
    // Same inputs, twice: identical id/phase/order/TAG/plan, in the same
    // array order (JSON equality is byte-identical, so even ordering is
    // pinned — a nondeterministic sort would break it).
    for (const activeEntities of [FULL_SUBSET, ONE_TABLE_SUBSET]) {
      for (let cycle = 1; cycle <= 8; cycle += 1) {
        const batch = composeScenarioBatch({ seed: SEED_A, cycle, registry: SCENARIO_REGISTRY, activeEntities });
        const again = composeScenarioBatch({ seed: SEED_A, cycle, registry: SCENARIO_REGISTRY, activeEntities });
        expect(again).toEqual(batch);
        expect(JSON.stringify(again)).toBe(JSON.stringify(batch));
        expect(batch.cycle).toBe(cycle);
        // Orders are contiguous 0..count-1 in composition order.
        batch.scenarios.forEach((entry, index) => {
          expect(entry.order).toBe(index);
        });
      }
    }
  });

  it("keeps id/phase/order identical across different active subsets", () => {
    // The scheduler's selection/phase/order never read the active subset
    // (drawIds/assignPhase are pure functions of seed/cycle/registry), so
    // the composed scenario set must be subset-independent: the batch
    // signature is exactly the same whether one table or all six are
    // active. Only the plan targets may vary with the subset.
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      const full = composeScenarioBatch({ seed: SEED_A, cycle, registry: SCENARIO_REGISTRY, activeEntities: FULL_SUBSET });
      const single = composeScenarioBatch({ seed: SEED_A, cycle, registry: SCENARIO_REGISTRY, activeEntities: ONE_TABLE_SUBSET });
      expect(batchSignature(single)).toBe(batchSignature(full));
    }
  });

  it("selects every plan target from the active subset (and its soak table)", () => {
    for (const activeEntities of [FULL_SUBSET, ONE_TABLE_SUBSET]) {
      const names = new Set(activeEntities.map((entry) => entry.name));
      const tables = new Set(activeEntities.map((entry) => entry.tableName));
      for (let cycle = 1; cycle <= 12; cycle += 1) {
        const batch = composeScenarioBatch({ seed: SEED_A, cycle, registry: SCENARIO_REGISTRY, activeEntities });
        for (const entry of batch.scenarios) {
          const entityName = plannedEntityName(entry.plan);
          // A plan that names an entity must name one IN the subset — a
          // plan pointing at an inactive entity is the exact bug issue
          // #359 guards against.
          if (entityName !== undefined) {
            expect(names).toContain(entityName);
          }
          // The redacted target-table proof must be the soak table of an
          // active entity (never a table outside the subset).
          if (entityName !== undefined) {
            expect(tables).toContain(entry.targetTable);
            expect(soakTableNameForEntity(entityName)).toBe(entry.targetTable);
          }
        }
      }
    }
  });

  it("composes a different batch for a different seed (determinism contrast)", () => {
    // Determinism is the property under test; the contrast is a sanity
    // check that seeds actually drive composition. With an empty registry
    // every seed trivially composes an empty batch, so the assertion is
    // meaningful only when scenarios exist.
    if (SCENARIO_REGISTRY.length === 0) {
      expect(composeScenarioBatch({ seed: SEED_A, cycle: 1, registry: SCENARIO_REGISTRY }).scenarios).toEqual([]);
      return;
    }
    const differing = [];
    for (let cycle = 1; cycle <= CONTRAST_CYCLES; cycle += 1) {
      const a = batchSignature(composeScenarioBatch({ seed: SEED_A, cycle, registry: SCENARIO_REGISTRY }));
      const b = batchSignature(composeScenarioBatch({ seed: SEED_B, cycle, registry: SCENARIO_REGISTRY }));
      if (a !== b) differing.push(cycle);
    }
    expect(differing.length).toBeGreaterThan(0);
  });
});

describe("resume replay binds a recorded batch to the seed — issue #359", () => {
  it("planResumeRecovery returns the interrupted cycle for an incomplete checkpoint", () => {
    const state = { lastCompletedCycle: 5 };
    const checkpoint = (cycle: number, status: "in-flight" | "completed") =>
      ({ version: 1, runId: "soak-abcd", cycle, status });

    // No marker or a completed marker: clean handoff, no recovery.
    expect(planResumeRecovery(undefined, state, new Map())).toBeUndefined();
    expect(planResumeRecovery(checkpoint(5, "completed"), state, new Map())).toBeUndefined();
    // A stale in-flight marker behind the checkpointed state.
    expect(planResumeRecovery(checkpoint(5, "in-flight"), state, new Map())).toEqual({
      cycle: 5,
      reason: RECOVERY_REASONS.STALE_IN_FLIGHT_MARKER,
    });
    // The interrupted cycle (marker ahead, no cycle record): reconciliation
    // must recompose the cycle from the seed.
    expect(planResumeRecovery(checkpoint(6, "in-flight"), state, new Map())).toEqual({
      cycle: 6,
      reason: RECOVERY_REASONS.INTERRUPTED_CYCLE_RECONCILED,
    });
    // A recorded cycle record proves the cycle fully completed: only the
    // state checkpoint lagged.
    expect(planResumeRecovery(checkpoint(6, "in-flight"), state, new Map([[6, {}]]))).toEqual({
      cycle: 6,
      reason: RECOVERY_REASONS.COMPLETED_CYCLE_CHECKPOINT,
    });
  });

  it("replayDeterministicHistory reconstructs the identical workload plan from the seed alone", () => {
    // The deterministic history replay is a pure function of the stored
    // seed/params/active subset — never of any fixture. Running it twice
    // must produce the exact same per-cycle plans, and the plan grid must
    // cover every (actor, index) slot of the stored params.
    const state = {
      seed: 20260814,
      mode: "local",
      lastCompletedCycle: 3,
      params: { actors: 2, operationsPerActor: 4, resolvedTables: ["soak_tasks"] },
    } as const;
    const resolvedTables = new Set<string>(state.params.resolvedTables);
    const activeEntities = SOAK_ENTITY_ORDER.filter(
      (entry) => resolvedTables.has(entry.tableName),
    );
    const replay = replayDeterministicHistory({
      state,
      activeEntities,
      cycleByNumber: new Map(),
    });
    const again = replayDeterministicHistory({
      state,
      activeEntities,
      cycleByNumber: new Map(),
    });
    expect(again.cyclePlans).toEqual(replay.cyclePlans);
    expect(again.plans).toEqual(replay.plans);
    expect(replay.cyclePlans.size).toBe(state.lastCompletedCycle);
    for (const ops of replay.cyclePlans.values()) {
      expect(ops.length).toBe(state.params.actors * state.params.operationsPerActor);
    }
    expect(replay.plans.size).toBe(
      state.lastCompletedCycle * state.params.actors * state.params.operationsPerActor,
    );
  });

  it("a recorded scenario batch matches the seed reconstruction and fails closed when tampered", () => {
    const seed = 4242;
    const cycle = 1;
    const activeEntities = FULL_SUBSET;
    const batch = composeScenarioBatch({ seed, cycle, registry: SCENARIO_REGISTRY, activeEntities });
    // The recorded fixture is DERIVED from the composed batch, so the
    // reconstruction must accept it exactly.
    const record: ScenarioBatchRecord = {
      cycle,
      scenarios: batch.scenarios.map((entry) => ({
        id: entry.id,
        phase: entry.phase,
        order: entry.order,
        tag: entry.plan.tag,
        targetTable: entry.targetTable,
      })),
    };
    expect(validateCycleScenarioBatch(seed, cycle, record, activeEntities)).toBeUndefined();
    // Without the subset, the full-registry reconstruction is the same
    // batch (full run) — still accepted.
    expect(validateCycleScenarioBatch(seed, cycle, record)).toBeUndefined();

    if (batch.scenarios.length > 0) {
      const entry = batch.scenarios[0]!;
      const copy = (overrides: Record<string, unknown>): ScenarioBatchRecord => ({
        ...record,
        scenarios: [{
          id: entry.id,
          phase: entry.phase,
          order: entry.order,
          tag: entry.plan.tag,
          targetTable: entry.targetTable,
          ...overrides,
        }],
      });
      // A wrong tag for the same id is tampered history, not a replay.
      expect(validateCycleScenarioBatch(seed, cycle, copy({ tag: "not-the-registered-tag" })))
        .toMatch(/is not in the seed's batch/);
      // A scenario the seed never composed for this cycle is rejected.
      expect(validateCycleScenarioBatch(seed, cycle, copy({ id: "scenario-not-registered" })))
        .toMatch(/is not in the seed's batch/);
      // A wrong (but known) target table breaks the active-subset binding
      // even when id/phase/order/tag coincide.
      const wrongTable = SOAK_ENTITY_ORDER.find((e) => e.tableName !== entry.targetTable);
      if (wrongTable !== undefined) {
        expect(validateCycleScenarioBatch(seed, cycle, copy({ targetTable: wrongTable.tableName })))
          .toMatch(/does not bind to this subset/);
      }
      // A reordered batch (order no longer the array index) is forged.
      expect(validateCycleScenarioBatch(seed, cycle, {
        ...record,
        scenarios: [...record.scenarios!].reverse().map((s, index) => ({ ...s, order: index })),
      })).toMatch(/is not in the seed's batch/);
    }
  });
});

describe("fixture-registry consistency (no hardcoded drift) — issue #359", () => {
  it("derives the scenario vocabulary exactly from the registered modules", () => {
    // The resume schema validates recorded batches against this derived
    // vocabulary, so a vocabulary that drifts from the registry would let a
    // foreign fixture pass or reject a real one. Every registered module
    // must agree with every derived constant, and the registry must expose
    // the full scheduler contract.
    expect(KNOWN_SCENARIO_IDS).toEqual(SCENARIO_REGISTRY.map((scenario) => scenario.id));
    expect(KNOWN_SCENARIO_TAGS).toEqual(SCENARIO_REGISTRY.map((scenario) => scenario.TAG));
    for (const scenario of SCENARIO_REGISTRY) {
      expect(SCENARIO_ID_TAGS[scenario.id]).toBe(scenario.TAG);
      expect(SCENARIO_ID_PHASES[scenario.id]).toEqual([...scenario.allowedPhases]);
      expect([SCENARIO_KINDS.DATA, SCENARIO_KINDS.LIFECYCLE]).toContain(scenario.kind);
      expect(SCENARIO_PHASE_VALUES).toContain(scenario.allowedPhases[0]);
    }
  });

  it("a composed batch is itself a schema-valid recordable fixture", () => {
    // The fixture this suite records is always derived from the real
    // registry composition. Round-tripping it through the resume schema
    // (which validates against the registry-derived vocabulary) proves the
    // reconstruction path and the schema cannot drift apart: what the
    // seed composes is exactly what resume validation accepts.
    const seed = 4242;
    const cycle = 1;
    const batch = composeScenarioBatch({ seed, cycle, registry: SCENARIO_REGISTRY, activeEntities: FULL_SUBSET });
    const scenarios = batch.scenarios.map((entry, index) => ({
      id: entry.id,
      phase: entry.phase,
      order: index,
      tag: entry.plan.tag,
      status: "ok",
      expectedErrors: 0,
      failures: 0,
      cleanupFailures: 0,
      targetTable: entry.targetTable,
    }));
    const record = {
      ts: "2025-01-01T00:00:00.000Z",
      cycle,
      durationMs: 10,
      tablesTouched: ["soak_customers"],
      operations: 5,
      expectedErrors: 0,
      failures: 0,
      retries: 0,
      scenarios,
      scenarioTotals: { expectedErrors: 0, failures: 0 },
    };
    if (batch.scenarios.length > 0) {
      expect(validateCycleRecordShape(record)).toEqual({ ok: true });
      // And the seed-reconstruction proof accepts the same fixture.
      expect(validateCycleScenarioBatch(seed, cycle, { cycle, scenarios }, FULL_SUBSET))
        .toBeUndefined();
    } else {
      // Empty registry: the composed batch is empty and the schema-valid
      // fixture carries no scenario section (legacy shape).
      expect(scenarios).toEqual([]);
      expect(validateCycleRecordShape({ ...record, scenarios: undefined, scenarioTotals: undefined }))
        .toEqual({ ok: true });
    }
  });
});
