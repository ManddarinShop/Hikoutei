/**
 * Offline tests for the `deleteRecreateRace` soak scenario, driven against
 * fake public seams (a fake EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the deterministic inter-iteration `sleep` shortened so the
 * delete/recreate cycles run fast and deterministically. The scenario's
 * projection observation is the DIRECT authority seam (`em.find`), so the
 * fake EntityManager doubles as both the mutation seam and the authority
 * read. Only the `deleteRecreateRace` scenario module is imported; the other
 * attack-scenario modules are deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as deleteRecreateRace from "../scripts/ci/local-soak/scenarios/deleteRecreateRace.mjs";
import { SOAK_ENTITY_ORDER } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";

// Shorten the scenario's deterministic inter-iteration `sleep` so the
// delete/recreate loops terminate quickly (a real pause is up to ~50ms each).
vi.mock("../scripts/ci/local-soak/timing.mjs", () => ({
  sleep: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  },
}));

/** The one scenario module under test. */
const scenario = deleteRecreateRace;

/** Builds a deterministic plan targeting an entity in the active subset. */
function buildPlan(seed: number, cycle = 1, order = 0): PlanLike {
  const input: Record<string, unknown> = {
    cycle,
    order,
    rng: new SeededRandom(seed),
    activeEntities: SOAK_ENTITY_ORDER,
  };
  return scenario.plan(input as Parameters<typeof scenario.plan>[0]) as unknown as PlanLike;
}

interface PlanLike {
  tag: string;
  jitterMs: number;
  raceId: string;
  iterations: number;
  entityName: string;
}

/** A deterministic plan over a dedicated race id on SoakCustomer. */
function racePlan(overrides: Partial<PlanLike> = {}): PlanLike {
  return {
    tag: "delete-recreate-race",
    jitterMs: 1,
    raceId: "race-cust-c1-0",
    iterations: 1,
    entityName: "SoakCustomer",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------

/** A fake EntityManager over an in-memory id-keyed store. */
class FakeEm {
  store = new Map<string, Record<string, unknown>>();
  findOneOverride: ((id: string) => Record<string, unknown> | null | undefined) | undefined;
  findResultsOverride: ((id: string) => Record<string, unknown>[] | undefined) | undefined;
  /** Throws on the flush whose 1-based call index matches. */
  flushBehavior: ((flushIndex: number) => void) | undefined;
  #flushIndex = 0;

  fork(): FakeEm {
    return this;
  }
  create(_token: unknown, row: Record<string, unknown>): Record<string, unknown> {
    return row;
  }
  persist(entity: Record<string, unknown>): void {
    if (entity !== null && typeof entity === "object" && typeof entity.id === "string") {
      this.store.set(entity.id, entity);
    }
  }
  async flush(): Promise<void> {
    this.#flushIndex += 1;
    if (this.flushBehavior !== undefined) this.flushBehavior(this.#flushIndex);
  }
  async find(_token: unknown, filter: { id: string }): Promise<Record<string, unknown>[]> {
    if (this.findResultsOverride !== undefined) {
      const overridden = this.findResultsOverride(filter.id);
      if (overridden !== undefined) return overridden;
    }
    const row = this.store.get(filter.id);
    return row === undefined ? [] : [row];
  }
  async findOne(_token: unknown, filter: { id: string }): Promise<Record<string, unknown> | null> {
    if (this.findOneOverride !== undefined) {
      const overridden = this.findOneOverride(filter.id);
      if (overridden !== null && overridden !== undefined) return overridden;
    }
    const row = this.store.get(filter.id);
    return row === undefined ? null : row;
  }
  remove(row: Record<string, unknown>): void {
    if (row !== null && typeof row === "object" && typeof row.id === "string") {
      this.store.delete(row.id);
    }
  }
  rows(): Record<string, unknown>[] {
    return [...this.store.values()];
  }
}

/** Builds a live execution context wired to the fake seams. */
function liveContext(plan: PlanLike, em: FakeEm): Record<string, unknown> {
  return {
    seed: 1,
    cycle: 1,
    activeEntities: SOAK_ENTITY_ORDER,
    tokenByEntity: new Map([[plan.entityName, { entity: plan.entityName }]]),
    em,
    live: { mode: "live", client: {}, spreadsheetId: "spreadsheet-1" },
    deadlineAtMs: Date.now() + 5000,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("deleteRecreateRace scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("delete-recreate-race");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("delete-recreate-race");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("delete-recreate-race");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("delete-recreate-race");
    expect(plan.jitterMs).toBeGreaterThan(0);
    // A dedicated race id outside the actor/prologue space, on a real entity.
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.entityName)).toBe(true);
    expect(plan.raceId).toMatch(/^race-/);
    expect(plan.iterations).toBeGreaterThanOrEqual(2);
    expect(plan.iterations).toBeLessThanOrEqual(3);
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = racePlan();
    const context = {
      seed: 1,
      cycle: 1,
      activeEntities: [], // none active -> the entity is not expected
      tokenByEntity: new Map([[plan.entityName, { entity: plan.entityName }]]),
      em: new FakeEm(),
      live: { mode: "live", client: {}, spreadsheetId: "spreadsheet-1" },
      deadlineAtMs: Date.now() + 5000,
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("local-mode");
    expect(result.failures).toBe(0);
  });

  it("delete-then-recreate leaves exactly one final row and cleans up (ok)", async () => {
    // Core hypothesis: rapidly deleting and recreating the same id must leave
    // exactly one final row in the authority — no tombstone residue or
    // duplicate. The deferred projection-residue check reads the authority
    // and sees the single recreated row.
    const plan = racePlan({ iterations: 3 });
    const em = new FakeEm();
    const result = await scenario.execute({ plan, context: liveContext(plan, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("projection-residue-deferred");
    expect(result.failures).toBe(0);
    expect(result.expectedErrors).toBe(0);
    expect(result.cleanupFailures).toBe(0);
    // Each iteration delete-then-recreates; the guaranteed finally removes
    // the dedicated race row so final SQLite state matches the replay.
    expect(em.rows()).toEqual([]);
  });

  it("classifies the known delete->recreate projection residue (duplicate rows) as failed", async () => {
    // The library's known sync-enable delete->recreate bug leaves stale /
    // extra projection rows for the recreated id. When the authority shows
    // MORE than one row for the id (duplicate residue), the observable
    // authority invariant is violated and the scenario must classify it as a
    // real failure, not a skip.
    const plan = racePlan();
    const em = new FakeEm();
    em.findResultsOverride = (id) => {
      if (id === plan.raceId) {
        return [{ id: plan.raceId }, { id: plan.raceId }]; // duplicate residue
      }
      return undefined;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("projection-residue-deferred");
    expect(result.failures).toBe(1);
    // Guaranteed cleanup still removes every dedicated race row.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a missing authority row (delete lost the row) as failed", async () => {
    // A MISSING row is as much a failure as a duplicate: the delete/recreate
    // must leave exactly one final row, and a lost row violates that too.
    const plan = racePlan();
    const em = new FakeEm();
    em.findResultsOverride = (id) => {
      if (id === plan.raceId) return []; // row lost by the authority
      return undefined;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("projection-residue-deferred");
    expect(result.failures).toBe(1);
    // Cleanup can only remove rows the authority actually reports (it calls
    // the same `find`), so a row the authority no longer sees stays in the
    // store — the module removes only what it finds.
    expect(em.rows().length).toBe(1);
  });

  it("classifies a mutation/authority exception during the delete-recreate loop as a failure", async () => {
    // There is no CAS/stale special-casing in this scenario's loop: ANY
    // exception during the delete/recreate flushes is a real
    // scenario-error, never silently forgiven, and cleanup still runs.
    const plan = racePlan();
    const em = new FakeEm();
    // The 1st flush is the create commit; it throws -> scenario-error.
    em.flushBehavior = (index) => {
      if (index === 1) throw new Error("flush failure");
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Guaranteed cleanup removes the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("guarantees independent cleanup: a failed cleanup flush still removes the row", async () => {
    // The finally path removes the race row before its own flush, so even
    // when the cleanup flush fails the row is gone from the store and the
    // failure is recorded separately (never masking the original outcome).
    const plan = racePlan();
    const em = new FakeEm();
    // Iteration 1 flush (#1) commits; the cleanup flush (#2) throws.
    em.flushBehavior = (index) => {
      if (index === 2) throw new Error("cleanup flush failure");
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, em) });
    expect(result.status).toBe("failed");
    expect(result.cleanupFailures).toBe(1);
    expect(result.failures).toBe(1);
    // The row was removed before the failing cleanup flush.
    expect(em.rows()).toEqual([]);
  });
});
