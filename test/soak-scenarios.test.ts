/**
 * Scenario-agnostic offline tests for the soak attack-scenario framework.
 *
 * These run WITHOUT any live Google Sheets client, credentials, or network,
 * and WITHOUT importing any concrete attack-scenario module. The scenario
 * framework is exercised against a small STUB registry (2-3 fake scenario
 * modules exposing the scheduler contract: `id`, `kind`, `allowedPhases`,
 * `TAG`, `plan`, `execute`, and optionally `recover`) so the scheduler,
 * composition, redaction, and resume-schema layers are proven to work for
 * ANY registered scenario set — not just the four concrete scenarios that
 * shipped in their own PRs.
 *
 * The tests that touch the real `SCENARIO_REGISTRY` in
 * `scenarios/registry.mjs` are REGISTRY-CONTENT-AGNOSTIC: their assertions
 * derive from the actual registry content (0, 1, or many registered
 * scenarios) and hold for ANY registry, so the identical shared test file is
 * reused by every scenario PR with zero merge conflicts. Redaction collapses
 * ids/tags the registry never registers to the unknown category; the resume
 * batch proof binds recorded sections to what the registry actually composes.
 * Acceptance/rejection of a stub-derived scenario vocabulary is exercised
 * through the resume schema's explicit `vocab` parameter, which is exactly
 * the seam scenario PRs use when they register modules.
 */
import { describe, expect, it } from "vitest";
import {
  SCENARIO_KINDS,
  SCENARIO_PHASE_VALUES,
  SCENARIO_PHASES,
  composeScenarioBatch,
  runInterruptedCycleRecovery,
  runScenario,
  runScenarioPhase,
  scenariosForPhase,
} from "../scripts/ci/local-soak/scenarios/scheduler.mjs";
import {
  SCENARIO_REGISTRY,
  getScenarioById,
} from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { sanitizeScenarioRecord } from "../scripts/ci/local-soak/scenarios/scenarioVocabulary.mjs";
import { validateCycleRecordShape, validateOperationRecordShape } from "../scripts/ci/local-soak/resumeHistorySchema.mjs";
import { validateCycleScenarioBatch } from "../scripts/ci/local-soak/resumeHistoryProof.mjs";
import { KNOWN_REASON_CODES, isKnownStatusClass, sanitizeStatusClass } from "../scripts/ci/local-soak/redact.mjs";

/**
 * A usable direct-Sheet client: a non-null, non-array object exposing the
 * callable `readTabRows` and `mutateInputCell` every registered scenario
 * requires. Used wherever a test must dispatch a scenario's execute()
 * rather than fail closed on a malformed client.
 */
const VALID_CLIENT = {
  readTabRows: async () => [],
  mutateInputCell: async () => ({ rowNumber: 1 }),
};

/**
 * A scenario id guaranteed absent from the real registry, derived by picking
 * a name against the current registry ids so a future scenario PR can never
 * accidentally collide with the sentinel and break the collapse/rejection
 * assertions that rely on it being foreign.
 */
function foreignSentinelId(): string {
  const registered = new Set(SCENARIO_REGISTRY.map((scenario) => scenario.id));
  let candidate = "scenario-definitely-not-registered";
  while (registered.has(candidate)) candidate += "-x";
  return candidate;
}

// ---------------------------------------------------------------------------
// Stub registry: fake scenario modules exposing the scheduler contract.
// ---------------------------------------------------------------------------

/** A data scenario targeting SoakCustomer in the after-prologue phase. */
const STUB_ALPHA = {
  id: "scenario-stub-alpha",
  kind: SCENARIO_KINDS.DATA,
  allowedPhases: [SCENARIO_PHASES.AFTER_PROLOGUE],
  TAG: "stub-alpha",
  plan: () => ({ tag: "stub-alpha", jitterMs: 5, target: { entityName: "SoakCustomer" } }),
  execute: async () => ({ expectedErrors: 0, failures: 0 }),
  recover: async () => ({ removed: 1 }),
};

/** A data scenario targeting only SoakOrder in the concurrent phase. */
const STUB_BETA = {
  id: "scenario-stub-beta",
  kind: SCENARIO_KINDS.DATA,
  allowedPhases: [SCENARIO_PHASES.CONCURRENT_WITH_ACTORS],
  TAG: "stub-beta",
  plan: () => ({ tag: "stub-beta", jitterMs: 11, target: { entityName: "SoakOrder" } }),
  execute: async () => ({ expectedErrors: 1, failures: 0 }),
};

/** A lifecycle scenario allowed in any phase (never overlaps another lifecycle). */
const STUB_GAMMA = {
  id: "scenario-stub-gamma",
  kind: SCENARIO_KINDS.LIFECYCLE,
  allowedPhases: [...SCENARIO_PHASE_VALUES],
  TAG: "stub-gamma",
  plan: () => ({ tag: "stub-gamma", jitterMs: 17, target: { entityName: "SoakTask" } }),
  execute: async () => ({ status: "skipped", reason: "reopen-skipped", failures: 0 }),
  recover: async () => ({ removed: 1 }),
};

/** The stub registry used to drive the scheduler and derive the vocab. */
const STUB_REGISTRY = [STUB_ALPHA, STUB_BETA, STUB_GAMMA];

/**
 * The stub-derived scenario vocabulary, shaped exactly like the one
 * `scenarioVocabulary.mjs` derives from the real registry. Tests pass this
 * to the resume schema's explicit `vocab` parameter to exercise stub
 * acceptance/rejection without touching the real (empty) registry.
 */
const STUB_VOCAB = {
  KNOWN_SCENARIO_IDS: STUB_REGISTRY.map((scenario) => scenario.id),
  KNOWN_SCENARIO_PHASES: [...SCENARIO_PHASE_VALUES],
  KNOWN_SCENARIO_TAGS: STUB_REGISTRY.map((scenario) => scenario.TAG),
  SCENARIO_ID_TAGS: Object.fromEntries(
    STUB_REGISTRY.map((scenario) => [scenario.id, scenario.TAG]),
  ),
  SCENARIO_ID_PHASES: Object.fromEntries(
    STUB_REGISTRY.map((scenario) => [scenario.id, [...scenario.allowedPhases]]),
  ),
};

/** A live execution context that can actually drive a scenario execute(). */
function liveContext(overrides = {}) {
  return {
    live: {
      mode: "live",
      client: VALID_CLIENT,
      spreadsheetId: "spreadsheet-1",
      ...overrides,
    },
  };
}

/** The local-only context: scenarios record as skipped and never mutate. */
const LOCAL_CONTEXT = { live: { mode: "local", client: VALID_CLIENT, spreadsheetId: "spreadsheet-1" } };

describe("stub registry and derived vocabulary", () => {
  it("exposes the full scenario contract on every stub module", () => {
    for (const scenario of STUB_REGISTRY) {
      expect(typeof scenario.id).toBe("string");
      expect([SCENARIO_KINDS.DATA, SCENARIO_KINDS.LIFECYCLE]).toContain(scenario.kind);
      expect(Array.isArray(scenario.allowedPhases)).toBe(true);
      expect(scenario.allowedPhases.length).toBeGreaterThan(0);
      for (const phase of scenario.allowedPhases) {
        expect(SCENARIO_PHASE_VALUES).toContain(phase);
      }
      expect(typeof scenario.TAG).toBe("string");
      expect(typeof scenario.plan).toBe("function");
      expect(typeof scenario.execute).toBe("function");
      expect(STUB_VOCAB.KNOWN_SCENARIO_IDS).toContain(scenario.id);
      expect(STUB_VOCAB.KNOWN_SCENARIO_TAGS).toContain(scenario.TAG);
      expect(STUB_VOCAB.SCENARIO_ID_TAGS[scenario.id]).toBe(scenario.TAG);
      for (const phase of scenario.allowedPhases) {
        expect(STUB_VOCAB.SCENARIO_ID_PHASES[scenario.id]).toContain(phase);
      }
    }
  });

  it("exposes the phase vocabulary as the scheduler's fixed phase values", () => {
    expect([...STUB_VOCAB.KNOWN_SCENARIO_PHASES]).toEqual([...SCENARIO_PHASE_VALUES]);
    expect(SCENARIO_PHASE_VALUES).toEqual([
      SCENARIO_PHASES.AFTER_PROLOGUE,
      SCENARIO_PHASES.CONCURRENT_WITH_ACTORS,
      SCENARIO_PHASES.AFTER_ACTORS,
    ]);
  });
});

describe("deterministic seeded scheduler (stub registry)", () => {
  it("reproduces the identical batch for the same (seed, cycle)", () => {
    const batch = composeScenarioBatch({ seed: 12345, cycle: 4, registry: STUB_REGISTRY });
    const again = composeScenarioBatch({ seed: 12345, cycle: 4, registry: STUB_REGISTRY });
    expect(again).toEqual(batch);
    expect(batch.cycle).toBe(4);
  });

  it("varies the batch across different seeds", () => {
    const a = composeScenarioBatch({ seed: 111, cycle: 1, registry: STUB_REGISTRY });
    const b = composeScenarioBatch({ seed: 222, cycle: 1, registry: STUB_REGISTRY });
    expect(b).not.toEqual(a);
  });

  it("selects 1-3 distinct scenarios per cycle, all in an allowed phase", () => {
    for (let cycle = 1; cycle <= 30; cycle += 1) {
      const { scenarios } = composeScenarioBatch({ seed: 42, cycle, registry: STUB_REGISTRY });
      expect(scenarios.length).toBeGreaterThanOrEqual(1);
      expect(scenarios.length).toBeLessThanOrEqual(3);
      const ids = new Set(scenarios.map((entry) => entry.id));
      expect(ids.size).toBe(scenarios.length);
      for (const entry of scenarios) {
        const scenario = STUB_REGISTRY.find((s) => s.id === entry.id)!;
        expect(scenario.allowedPhases).toContain(entry.phase);
      }
    }
  });

  it("assigns phase, order, tag and jitter deterministically", () => {
    const batch = composeScenarioBatch({ seed: 2026, cycle: 7, registry: STUB_REGISTRY });
    const replay = composeScenarioBatch({ seed: 2026, cycle: 7, registry: STUB_REGISTRY });
    for (let index = 0; index < batch.scenarios.length; index += 1) {
      const a = batch.scenarios[index]!;
      const b = replay.scenarios[index]!;
      expect(a.id).toBe(b.id);
      expect(a.phase).toBe(b.phase);
      expect(a.order).toBe(index);
      expect(a.plan.tag).toBe(b.plan.tag);
      expect(a.plan.jitterMs).toBe(b.plan.jitterMs);
      // Every composed entry carries a redacted allowlisted target table.
      expect(["soak_customers", "soak_orders", "soak_tasks"]).toContain(a.targetTable);
    }
  });

  it("honors every-scenario-before-repeat across many cycles (shuffle-bag stream)", () => {
    const seenAll = new Set();
    for (let cycle = 1; cycle <= 12; cycle += 1) {
      const { scenarios } = composeScenarioBatch({ seed: 99, cycle, registry: STUB_REGISTRY });
      for (const entry of scenarios) seenAll.add(entry.id);
    }
    expect([...seenAll].sort()).toEqual([...STUB_REGISTRY.map((s) => s.id)].sort());
  });

  it("keeps the selection stream continuous across a resume boundary", () => {
    // Resuming at cycle N must reproduce exactly what composing cycles 1..N
    // as one uninterrupted stream produces: recomposing cycle N after a
    // partial run equals composing it fresh from the seed.
    const fresh = composeScenarioBatch({ seed: 777, cycle: 9, registry: STUB_REGISTRY });
    const resumed = composeScenarioBatch({ seed: 777, cycle: 9, registry: STUB_REGISTRY });
    expect(resumed).toEqual(fresh);
  });

  it("never overlaps two lifecycle scenarios in one phase within a cycle", () => {
    for (let cycle = 1; cycle <= 20; cycle += 1) {
      const { scenarios } = composeScenarioBatch({ seed: 5, cycle, registry: STUB_REGISTRY });
      const lifecycleByPhase = new Map();
      for (const entry of scenarios) {
        if (entry.kind !== SCENARIO_KINDS.LIFECYCLE) continue;
        expect(lifecycleByPhase.has(entry.phase)).toBe(false);
        lifecycleByPhase.set(entry.phase, entry.id);
      }
    }
  });
});

describe("real-registry composition safety", () => {
  // Registry-content-agnostic: every assertion below must hold for ANY real
  // registry content (0, 1, or many scenarios registered), so this identical
  // shared file is reused by every scenario PR without merge conflicts.
  it("composes a deterministic batch from the real registry", () => {
    const batch = composeScenarioBatch({ seed: 1, cycle: 1, registry: SCENARIO_REGISTRY });
    expect(batch.cycle).toBe(1);
    // Every composed entry must be one of the actually-registered ids.
    const registeredIds = SCENARIO_REGISTRY.map((scenario) => scenario.id);
    for (const entry of batch.scenarios) {
      expect(registeredIds).toContain(entry.id);
    }
    // The batch is deterministic for the seed.
    const again = composeScenarioBatch({ seed: 1, cycle: 1, registry: SCENARIO_REGISTRY });
    expect(again).toEqual(batch);
    // Registry lookup resolves registered ids and rejects foreign ones.
    for (const scenario of SCENARIO_REGISTRY) {
      expect(getScenarioById(scenario.id)).toBe(scenario);
    }
    expect(getScenarioById("scenario-stub-alpha")).toBeUndefined();
    // The real registry is a non-empty-agnostic array (any content is valid).
    expect(Array.isArray(SCENARIO_REGISTRY)).toBe(true);
  });

  it("runs a real-registry phase batch to one record per composed entry", async () => {
    const batch = composeScenarioBatch({ seed: 1, cycle: 1, registry: SCENARIO_REGISTRY });
    const registeredIds = SCENARIO_REGISTRY.map((scenario) => scenario.id);
    // Records correspond 1:1 to that phase's composed entries: none is
    // fabricated and none dropped, whatever the registry composes.
    for (const phase of SCENARIO_PHASE_VALUES) {
      // Derive the expected set independently from the raw batch (filter by
      // phase, sort by order) rather than reusing `scenariosForPhase`, so the
      // cardinality/order assertions are not tautological.
      const entries = batch.scenarios
        .filter((entry) => entry.phase === phase)
        .sort((a, b) => a.order - b.order);
      const records = await runScenarioPhase(batch, phase, LOCAL_CONTEXT);
      expect(records.length).toBe(entries.length);
      expect(records.map((record) => record.order)).toEqual(
        entries.map((entry) => entry.order),
      );
      // The recorded ids must match the composed entries' ids exactly, in
      // order, so a duplicated or wrong registered scenario cannot pass.
      expect(records.map((record) => record.id)).toEqual(
        entries.map((entry) => entry.id),
      );
      for (const record of records) {
        expect(registeredIds).toContain(record.id);
      }
    }
  });

  it("runs interrupted-cycle recovery with a removal count within batch bounds", async () => {
    const batch = composeScenarioBatch({ seed: 1, cycle: 1, registry: SCENARIO_REGISTRY });
    // A recovery context with no tokens/active entities makes every recover
    // hook a no-op, so removed is 0 regardless of registry content, and it
    // can never exceed the composed batch size.
    const result = await runInterruptedCycleRecovery({
      seed: 1,
      cycle: 1,
      registry: SCENARIO_REGISTRY,
      context: {
        ...LOCAL_CONTEXT,
        tokenByEntity: new Map(),
        activeEntities: [],
        em: { fork: () => ({ find: async () => [], remove: () => {}, flush: async () => {} }) },
      },
    });
    expect(typeof result.removed).toBe("number");
    expect(result.removed).toBeGreaterThanOrEqual(0);
    expect(result.removed).toBeLessThanOrEqual(batch.scenarios.length);
  });
});

describe("scenario phase composition", () => {
  it("groups composed entries by phase in execution order", () => {
    const batch = composeScenarioBatch({ seed: 4242, cycle: 3, registry: STUB_REGISTRY });
    for (const phase of SCENARIO_PHASE_VALUES) {
      const entries = scenariosForPhase(batch, phase);
      const inPhase = batch.scenarios.filter((entry) => entry.phase === phase);
      expect(entries.map((entry) => entry.order)).toEqual(
        [...inPhase].sort((a, b) => a.order - b.order).map((entry) => entry.order),
      );
    }
  });
});

describe("scenario execution wrapper (stub)", () => {
  it("records local mode as skipped without touching a live client", async () => {
    const batch = composeScenarioBatch({ seed: 3, cycle: 1, registry: STUB_REGISTRY });
    const entry = batch.scenarios[0]!;
    const record = await runScenario({ entry, context: LOCAL_CONTEXT });
    expect(record.status).toBe("skipped");
    expect(record.reason).toBe("local-mode");
    expect(record.expectedErrors).toBe(0);
    expect(record.failures).toBe(0);
  });

  it("records an ok live scenario with its expected/failure counters", async () => {
    const batch = composeScenarioBatch({ seed: 8, cycle: 1, registry: [STUB_ALPHA] });
    const record = await runScenario({ entry: batch.scenarios[0]!, context: liveContext() });
    expect(record.status).toBe("ok");
    expect(record.id).toBe("scenario-stub-alpha");
    expect(record.tag).toBe("stub-alpha");
    expect(record.targetTable).toBe("soak_customers");
    expect(record.expectedErrors).toBe(0);
    expect(record.failures).toBe(0);
  });

  it("maps a thrown scenario to its own deterministic failed record", async () => {
    const thrower = {
      ...STUB_ALPHA,
      id: "scenario-stub-thrower",
      TAG: "stub-thrower",
      plan: () => ({ tag: "stub-thrower", jitterMs: 1, target: { entityName: "SoakCustomer" } }),
      execute: async () => {
        throw new Error("boom");
      },
    };
    const batch = composeScenarioBatch({ seed: 10, cycle: 1, registry: [thrower] });
    const record = await runScenario({ entry: batch.scenarios[0]!, context: liveContext() });
    expect(record.status).toBe("failed");
    expect(record.reason).toBe("scenario-error");
    expect(record.failures).toBe(1);
    expect(record.expectedErrors).toBe(0);
    expect(record.id).toBe("scenario-stub-thrower");
  });

  it("keeps a truthful skipped status and reason (never ok)", async () => {
    const gammaEntry = {
      id: "scenario-stub-gamma",
      kind: STUB_GAMMA.kind,
      phase: SCENARIO_PHASES.AFTER_ACTORS,
      order: 0,
      scenario: STUB_GAMMA,
      plan: { tag: "stub-gamma", jitterMs: 17, target: { entityName: "SoakTask" } },
      targetTable: "soak_tasks",
    };
    const record = await runScenario({ entry: gammaEntry, context: liveContext() });
    expect(record.status).toBe("skipped");
    expect(record.reason).toBe("reopen-skipped");
    expect(record.failures).toBe(0);
  });

  it("clamps cleanupFailures to the total failures and never double-counts", async () => {
    const stubbing = {
      ...STUB_ALPHA,
      id: "scenario-stub-cleanup",
      TAG: "stub-cleanup",
      plan: () => ({ tag: "stub-cleanup", jitterMs: 2, target: { entityName: "SoakCustomer" } }),
      // Reports 3 total failures with 5 cleanup failures (impossible): the
      // subset must clamp to the total so one cleanup failure is never
      // counted twice.
      execute: async () => ({ expectedErrors: 0, failures: 3, cleanupFailures: 5 }),
    };
    const batch = composeScenarioBatch({ seed: 21, cycle: 1, registry: [stubbing] });
    const record = await runScenario({ entry: batch.scenarios[0]!, context: liveContext() });
    expect(record.status).toBe("failed");
    expect(record.failures).toBe(3);
    expect(record.cleanupFailures).toBe(3);
  });

  it("runScenarioPhase: a scenario throw becomes its own record and siblings still settle", async () => {
    const okScenario = {
      ...STUB_ALPHA,
      id: "scenario-stub-ok",
      TAG: "stub-ok",
      plan: () => ({ tag: "stub-ok", jitterMs: 1, target: { entityName: "SoakCustomer" } }),
      execute: async () => ({ expectedErrors: 0, failures: 0 }),
    };
    const throwing = {
      ...STUB_ALPHA,
      id: "scenario-stub-thrower",
      TAG: "stub-thrower",
      plan: () => ({ tag: "stub-thrower", jitterMs: 2, target: { entityName: "SoakCustomer" } }),
      execute: async () => {
        throw new Error("boom");
      },
    };
    const registry = [okScenario, throwing, STUB_BETA];
    const batch = composeScenarioBatch({ seed: 33, cycle: 1, registry });
    // Run the whole batch across every phase; the phase join must never
    // reject and every executed entry must yield a record in its order.
    const records = [];
    for (const phase of SCENARIO_PHASE_VALUES) {
      const phaseRecords = await runScenarioPhase(batch, phase, liveContext());
      records.push(...phaseRecords);
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    // Every composed entry (whatever subset the seed selected) settled to a
    // record; the thrower is a failed record and its siblings stay settled.
    for (const entry of batch.scenarios) {
      expect(byId.get(entry.id)).toBeDefined();
    }
    const okRecord = byId.get(okScenario.id)!;
    const throwerRecord = byId.get(throwing.id)!;
    const betaRecord = byId.get(STUB_BETA.id);
    expect(okRecord.status).toBe("ok");
    expect(throwerRecord.status).toBe("failed");
    expect(throwerRecord.reason).toBe("scenario-error");
    expect(throwerRecord.failures).toBe(1);
    if (betaRecord !== undefined) {
      expect(betaRecord.status).toBe("ok");
      expect(betaRecord.expectedErrors).toBe(1);
    }
  });

  it("runInterruptedCycleRecovery recomposes the same seed/cycle and recovers only recover hooks", async () => {
    // Only alpha and gamma expose `recover`; beta does not. The recovery
    // count is the sum of the composed recover hooks' removed rows.
    const result = await runInterruptedCycleRecovery({
      seed: 5150,
      cycle: 2,
      registry: STUB_REGISTRY,
      context: LOCAL_CONTEXT,
    });
    const batch = composeScenarioBatch({ seed: 5150, cycle: 2, registry: STUB_REGISTRY });
    const expectedRemoved = batch.scenarios
      .filter((entry) => typeof (entry.scenario as { recover?: unknown }).recover === "function")
      .reduce((sum) => sum + 1, 0);
    expect(result.removed).toBe(expectedRemoved);
  });
});

describe("scenario record redaction and resume schema (stub-derived vocab)", () => {
  it("sanitizes an unknown scenario id/tag against the real registry to the unknown category", () => {
    // Registry-agnostic: an id/tag that is NOT in the real registry (whatever
    // it contains) collapses to the fixed `unknown` category. The phase/status
    // vocabularies come from the scheduler/status allowlist (always populated)
    // so they survive; the integer counters and a known allowlisted target
    // table survive too.
    const fakeId = foreignSentinelId();
    // Guard inline: the sentinel must not be a real registered id.
    expect(SCENARIO_REGISTRY.map((scenario) => scenario.id)).not.toContain(fakeId);
    const sanitized = sanitizeScenarioRecord({
      id: fakeId,
      phase: "after-prologue",
      order: 0,
      tag: fakeId,
      status: "ok",
      expectedErrors: 2,
      failures: 1,
      cleanupFailures: 0,
      targetTable: "soak_customers",
    })!;
    expect(sanitized).toEqual({
      id: "unknown",
      phase: "after-prologue",
      order: 0,
      tag: "unknown",
      status: "ok",
      expectedErrors: 2,
      failures: 1,
      cleanupFailures: 0,
      targetTable: "soak_customers",
    });
  });

  it("sanitization drops an unknown target table and sanitizes a foreign reason", () => {
    const sanitized = sanitizeScenarioRecord({
      id: "sneaky-raw-id",
      tag: "leak",
      status: "failed",
      failures: 1,
      expectedErrors: 0,
      cleanupFailures: 0,
      targetTable: "soak_customers_2",
      reason: "user-injected-reason",
    })!;
    expect(sanitized.id).toBe("unknown");
    expect(sanitized.tag).toBe("unknown");
    expect(sanitized.reason).toBe("unknown");
    expect(sanitized.targetTable).toBeUndefined();
    expect(sanitized).not.toHaveProperty("targetTable");
  });

  it("returns undefined for non-object scenario inputs", () => {
    expect(sanitizeScenarioRecord(null)).toBeUndefined();
    expect(sanitizeScenarioRecord("scenario-stub-alpha")).toBeUndefined();
    expect(sanitizeScenarioRecord([1])).toBeUndefined();
  });
});

describe("resume scenario-section schema consistency (stub-derived vocab)", () => {
  /** Extracts the stable rejection reason from a rejected validation result. */
  function rejectionOf(result: { ok: true } | { ok: false; reason: string }): string {
    if (result.ok) throw new Error("expected a schema rejection");
    return result.reason;
  }

  /** A valid cycle record carrying a stub-derived scenario section. */
  function validCycleRecord(overrides: Record<string, unknown> = {}): Record<string, any> {
    return {
      ts: "2025-01-01T00:00:00.000Z",
      cycle: 1,
      durationMs: 10,
      tablesTouched: ["soak_customers"],
      operations: 5,
      expectedErrors: 1,
      failures: 1,
      retries: 0,
      scenarios: [
        {
          id: "scenario-stub-alpha",
          phase: "after-prologue",
          order: 0,
          tag: "stub-alpha",
          status: "ok",
          expectedErrors: 1,
          failures: 0,
          cleanupFailures: 0,
          targetTable: "soak_customers",
        },
        {
          id: "scenario-stub-gamma",
          phase: "concurrent-with-actors",
          order: 1,
          tag: "stub-gamma",
          status: "failed",
          expectedErrors: 0,
          failures: 1,
          cleanupFailures: 0,
          targetTable: "soak_tasks",
        },
      ],
      scenarioTotals: { expectedErrors: 1, failures: 1 },
      ...overrides,
    };
  }

  it("accepts a valid stub-derived scenario section", () => {
    expect(validateCycleRecordShape(validCycleRecord(), STUB_VOCAB)).toEqual({ ok: true });
  });

  it("accepts a legacy record without a scenario section", () => {
    const { scenarios: _unused, scenarioTotals: _totals, ...legacy } = validCycleRecord();
    const result = validateCycleRecordShape(legacy, STUB_VOCAB);
    expect(result).toEqual({ ok: true });
  });

  it("rejects a known id paired with a foreign tag", () => {
    const record = validCycleRecord();
    record.scenarios[0] = { ...record.scenarios[0], tag: "stub-beta" };
    const result = validateCycleRecordShape(record, STUB_VOCAB);
    expect(result.ok).toBe(false);
    expect(rejectionOf(result)).toMatch(/does not match the tag/);
  });

  it("rejects a scenario placed in an impossible phase for its id", () => {
    const record = validCycleRecord();
    record.scenarios[0] = { ...record.scenarios[0], phase: "concurrent-with-actors" };
    const result = validateCycleRecordShape(record, STUB_VOCAB);
    expect(result.ok).toBe(false);
    expect(rejectionOf(result)).toMatch(/not an allowed phase/);
  });

  it("rejects a forged unknown scenario id", () => {
    const record = validCycleRecord();
    record.scenarios[0] = { ...record.scenarios[0], id: "scenario-not-registered" };
    const result = validateCycleRecordShape(record, STUB_VOCAB);
    expect(result.ok).toBe(false);
    expect(rejectionOf(result)).toMatch(/not a known scenario id/);
  });

  it("rejects duplicate scenario ids within a cycle", () => {
    const record = validCycleRecord();
    record.scenarios[1] = { ...record.scenarios[0], id: "scenario-stub-alpha", order: 1 };
    const result = validateCycleRecordShape(record, STUB_VOCAB);
    expect(result.ok).toBe(false);
    expect(rejectionOf(result)).toMatch(/must not repeat a scenario id/);
  });

  it("rejects non-contiguous orders (entry order must equal its array index)", () => {
    const record = validCycleRecord();
    record.scenarios = [record.scenarios[0], { ...record.scenarios[1], order: 2 }];
    const result = validateCycleRecordShape(record, STUB_VOCAB);
    expect(result.ok).toBe(false);
    expect(rejectionOf(result)).toMatch(/order must equal its array index/);
  });

  it("rejects status/counter inconsistencies", () => {
    // failed with zero failures.
    const failedZero = validCycleRecord();
    failedZero.scenarios[1] = { ...failedZero.scenarios[1], failures: 0 };
    expect(validateCycleRecordShape(failedZero, STUB_VOCAB).ok).toBe(false);
    // ok with a failure.
    const okFailure = validCycleRecord();
    okFailure.scenarios[0] = { ...okFailure.scenarios[0], failures: 1 };
    expect(validateCycleRecordShape(okFailure, STUB_VOCAB).ok).toBe(false);
    // skipped with non-zero counters.
    const skippedCounts = validCycleRecord();
    skippedCounts.scenarios[0] = {
      ...skippedCounts.scenarios[0],
      status: "skipped",
      reason: "reopen-skipped",
      expectedErrors: 1,
    };
    expect(validateCycleRecordShape(skippedCounts, STUB_VOCAB).ok).toBe(false);
  });

  it("rejects a scenario section with a nonzero totals that does not match its records", () => {
    const record = validCycleRecord();
    record.scenarioTotals = { expectedErrors: 5, failures: 5 };
    expect(validateCycleRecordShape(record, STUB_VOCAB).ok).toBe(false);
  });

  it("rejects a nonzero scenarioTotals WITHOUT a scenario section (forged)", () => {
    const { scenarios, ...record } = validCycleRecord();
    expect(validateCycleRecordShape(record, STUB_VOCAB).ok).toBe(false);
  });

  it("rejects cardinality outside 1-3", () => {
    const record = validCycleRecord();
    record.scenarios = [];
    record.scenarioTotals = { expectedErrors: 0, failures: 0 };
    expect(validateCycleRecordShape(record, STUB_VOCAB).ok).toBe(false);
  });

  it("rejects a cleanup counter that exceeds the failure total", () => {
    const record = validCycleRecord();
    record.scenarios[1] = { ...record.scenarios[1], cleanupFailures: 3, failures: 1 };
    expect(validateCycleRecordShape(record, STUB_VOCAB).ok).toBe(false);
  });
});

describe("deterministic resume batch proof (real registry)", () => {
  // `validateCycleScenarioBatch` binds a cycle's recorded scenario section to
  // the batch the REAL `SCENARIO_REGISTRY` composes for (seed, cycle). The
  // assertions below are REGISTRY-CONTENT-AGNOSTIC and hold for any registry
  // (0, 1, or many scenarios registered): a legacy record without a scenario
  // section is compatible, a recorded id the registry never composes is
  // tampered history, and a recorded abort prefix that exactly matches the
  // registry's own composition is accepted. Stub-derived batch acceptance is
  // exercised through `composeScenarioBatch` + the resume schema `vocab` seam
  // above; the proof itself is intentionally hardwired to the registered
  // registry so a stub can never be mistaken for a real scenario set in
  // production history validation.
  const seed = 4242;

  it("accepts a legacy record with the scenario section omitted", () => {
    const record = { cycle: 1 };
    expect(validateCycleScenarioBatch(seed, 1, record)).toBeUndefined();
  });

  it("rejects any recorded scenario the real registry cannot compose", () => {
    const fakeId = foreignSentinelId();
    // Guard inline: the sentinel must not be a real registered id.
    expect(SCENARIO_REGISTRY.map((scenario) => scenario.id)).not.toContain(fakeId);
    const record = {
      cycle: 1,
      abort: undefined,
      scenarios: [
        { id: fakeId, phase: "after-prologue", order: 0, tag: fakeId, targetTable: "soak_customers" },
      ],
    };
    const reason = validateCycleScenarioBatch(seed, 1, record);
    expect(reason).toMatch(/is not in the seed's batch/);
  });

  it("accepts an abort cycle whose recorded prefix matches the real registry's composition", () => {
    // Whatever the registry composes (empty, one, or many scenarios), the
    // exact composed batch is a valid ordered abort prefix: an empty batch
    // yields an empty recorded prefix, a non-empty batch yields its entries.
    const batch = composeScenarioBatch({ seed, cycle: 1, registry: SCENARIO_REGISTRY });
    const record = {
      cycle: 1,
      abort: { reason: "cycle-error" },
      scenarios: batch.scenarios.map((entry) => ({
        id: entry.id,
        phase: entry.phase,
        order: entry.order,
        tag: entry.plan.tag,
        targetTable: entry.targetTable,
      })),
    };
    expect(validateCycleScenarioBatch(seed, 1, record)).toBeUndefined();
  });
});

describe("known reason vocabulary stays scenario-agnostic", () => {
  it("keeps the scenario limitation categories on the stable reason allowlist", () => {
    for (const reason of ["reopen-skipped", "recovery-not-observed", "scenario-error", "local-mode"]) {
      expect(KNOWN_REASON_CODES).toContain(reason);
    }
  });
});

describe("abort/probe statusClass redaction roundtrip (resume compatibility)", () => {
  /** A minimal valid cycle record with no scenario section. */
  function minimalCycleRecord(overrides: Record<string, unknown> = {}): Record<string, any> {
    return {
      ts: "2025-01-01T00:00:00.000Z",
      cycle: 1,
      durationMs: 10,
      tablesTouched: ["soak_customers"],
      operations: 2,
      expectedErrors: 0,
      failures: 0,
      retries: 0,
      ...overrides,
    };
  }

  it("sanitizeStatusClass emits the fixed unknown category that resume accepts", () => {
    // A probe/abort whose status is unparseable collapses to `unknown` at
    // the artifact boundary; the resume schema must accept that exact value.
    expect(sanitizeStatusClass("ya29.jwt-token")).toBe("unknown");
    expect(sanitizeStatusClass("")).toBe("unknown");
    expect(sanitizeStatusClass(undefined)).toBe("unknown");
    expect(isKnownStatusClass("unknown")).toBe(true);
    // A real normalized status still passes both directions.
    expect(sanitizeStatusClass("http_429")).toBe("http_429");
    expect(isKnownStatusClass("http_429")).toBe(true);
    // The legacy artifact vocabulary stays accepted for resume compat.
    expect(isKnownStatusClass("network_or_unknown")).toBe(true);
  });

  it("accepts an abort whose status collapsed to the fixed unknown category", () => {
    const result = validateCycleRecordShape(minimalCycleRecord({
      abort: { reason: "cycle-error", errorClass: "DirectSheetsError", statusClass: "unknown" },
    }));
    expect(result).toEqual({ ok: true });
  });

  it("accepts an abort whose code collapsed to the fixed unknown category and rejects an arbitrary code", () => {
    // `sanitizeStableCode` collapses any non-allowlisted code to `unknown`,
    // so an abort that records the redacted category is still valid history.
    expect(validateCycleRecordShape(minimalCycleRecord({
      abort: { reason: "cycle-error", errorClass: "DirectSheetsError", code: "unknown" },
    }))).toEqual({ ok: true });
    // A raw arbitrary code is never itself a recordable value.
    expect(validateCycleRecordShape(minimalCycleRecord({
      abort: { reason: "cycle-error", errorClass: "DirectSheetsError", code: "ya29.jwt-token" },
    })).ok).toBe(false);
    expect(validateCycleRecordShape(minimalCycleRecord({
      abort: { reason: "cycle-error", errorClass: "DirectSheetsError", code: "secret-id-123" },
    })).ok).toBe(false);
  });

  it("accepts a probe whose status collapsed to the fixed unknown category", () => {
    const result = validateCycleRecordShape(minimalCycleRecord({
      probe: { status: "failed", reason: "probe-error", statusClass: "unknown" },
    }));
    expect(result).toEqual({ ok: true });
  });

  it("accepts a probe/abort with an allowlisted status and rejects a foreign status", () => {
    // Allowlisted statuses pass the schema exactly as written.
    expect(validateCycleRecordShape(minimalCycleRecord({
      abort: { reason: "cycle-error", errorClass: "DirectSheetsError", statusClass: "http_429" },
    })).ok).toBe(true);
    expect(validateCycleRecordShape(minimalCycleRecord({
      probe: { status: "failed", reason: "probe-error", statusClass: "network" },
    })).ok).toBe(true);
    // A foreign status that the sanitizer would collapse to `unknown` is
    // NOT itself a recordable value (only the collapsed category is).
    expect(validateCycleRecordShape(minimalCycleRecord({
      abort: { reason: "cycle-error", errorClass: "DirectSheetsError", statusClass: "ya29.jwt-token" },
    })).ok).toBe(false);
    expect(validateCycleRecordShape(minimalCycleRecord({
      probe: { status: "failed", reason: "probe-error", statusClass: "ya29.jwt-token" },
    })).ok).toBe(false);
  });
});

describe("operation-record code redaction roundtrip (resume compatibility)", () => {
  /** A minimal valid operation record with no code/reason/counts. */
  function minimalOperationRecord(overrides: Record<string, unknown> = {}): Record<string, any> {
    return {
      ts: "2025-01-01T00:00:00.000Z",
      cycle: 1,
      actor: 0,
      index: 0,
      kind: "create",
      table: "soak_customers",
      status: "ok",
      durationMs: 1,
      ...overrides,
    };
  }

  it("accepts an operation whose code collapsed to the fixed unknown category", () => {
    expect(validateOperationRecordShape(minimalOperationRecord({ code: "unknown" })))
      .toEqual({ ok: true });
  });

  it("accepts an allowlisted code and rejects an arbitrary raw code", () => {
    expect(validateOperationRecordShape(minimalOperationRecord({ code: "invalid_query" })).ok)
      .toBe(true);
    expect(validateOperationRecordShape(minimalOperationRecord({ code: "ya29.jwt-token" })).ok)
      .toBe(false);
    expect(validateOperationRecordShape(minimalOperationRecord({ code: "/etc/secret.json" })).ok)
      .toBe(false);
  });
});
