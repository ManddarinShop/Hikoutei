/**
 * Offline tests for the `pendingDeliveryReopen` soak scenario, driven against
 * fake public seams (a fake EntityManager and a fake direct-Sheet client).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them. The scenario is a LIFECYCLE scenario whose close/reopen step needs a
 * runner-owned runtime-replacement seam that the harness does not expose in
 * scenario scope, so its `execute` is genuinely NON-MUTATING: it never
 * creates burst rows, never touches SQLite, the oracle, or any runtime
 * state, and always records a truthful `skipped` with the stable
 * `reopen-skipped` reason. Because the action never mutates, there is no
 * cleanup/restore path and no CAS/stale evidence gating to exercise — the
 * tests below assert the module's real non-mutating contract rather than
 * inventing mutation paths the module does not have. Only the
 * `pendingDeliveryReopen` scenario module is imported; the other
 * attack-scenario modules are deliberately not touched.
 */
import { describe, expect, it } from "vitest";
import * as pendingDeliveryReopen from "../scripts/ci/local-soak/scenarios/pendingDeliveryReopen.mjs";
import { SOAK_ENTITY_ORDER } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { FakeEm } from "./support/soakScenarioFixtures.js";

/** The one scenario module under test. */
const scenario = pendingDeliveryReopen;

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

/**
 * Builds a plan with an exact burst count by stubbing the plan's rng: the
 * module computes `burstCount: 8 + rng.int(9)`, so `int` returns `burst - 8`
 * for the burst draw and a fixed value for the entity draw.
 */
function planWithBurst(burstCount: number): PlanLike {
  const input: Record<string, unknown> = {
    cycle: 1,
    order: 0,
    rng: { int: (max: number) => (max === 9 ? burstCount - 8 : 0) },
    activeEntities: SOAK_ENTITY_ORDER,
  };
  return scenario.plan(input as Parameters<typeof scenario.plan>[0]) as unknown as PlanLike;
}

interface PlanLike {
  tag: string;
  jitterMs: number;
  burstCount: number;
  entityName: string;
  burstPrefix: string;
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------


/** A fake direct-Sheet client that records every mutation attempt. */
class FakeClient {
  mutateCalls: { identity: string; headerName: string; value: string }[] = [];

  async readTabRows(_spreadsheetId: string, _tabName: string): Promise<unknown[][]> {
    return [];
  }
  async mutateInputCell(input: {
    tabName: string;
    identity: string;
    headerName: string;
    value: string;
  }): Promise<{ rowNumber: number }> {
    this.mutateCalls.push({
      identity: input.identity,
      headerName: input.headerName,
      value: input.value,
    });
    return { rowNumber: 1 };
  }
}

/** Builds a live execution context wired to the fake seams. */
function liveContext(plan: PlanLike, em: FakeEm, client: FakeClient): Record<string, unknown> {
  return {
    seed: 1,
    cycle: 1,
    activeEntities: SOAK_ENTITY_ORDER,
    tokenByEntity: new Map([[plan.entityName, { entity: plan.entityName }]]),
    em,
    live: { mode: "live", client, spreadsheetId: "spreadsheet-1" },
    deadlineAtMs: Date.now() + 5000,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("pendingDeliveryReopen scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("pending-delivery-reopen");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("pending-delivery-reopen");
    expect(scenario.kind).toBe("lifecycle");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("pending-delivery-reopen");
    expect(typeof scenario.execute).toBe("function");
    // The scenario is non-mutating, so it exposes no recover hook.
    expect((scenario as { recover?: unknown }).recover).toBeUndefined();
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("pending-delivery-reopen");
    expect(plan.jitterMs).toBeGreaterThan(0);
    expect(plan.burstCount).toBeGreaterThanOrEqual(8);
    expect(plan.burstCount).toBeLessThanOrEqual(16);
    // The plan targets a real entity in the active subset.
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.entityName)).toBe(true);
    expect(plan.burstPrefix).toMatch(/^burst-c\d+-\d+$/);
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = buildPlan(777);
    const em = new FakeEm();
    const context = {
      seed: 1,
      cycle: 1,
      activeEntities: [], // none active -> the entity is not expected
      tokenByEntity: new Map([[plan.entityName, { entity: plan.entityName }]]),
      em,
      live: { mode: "live", client: new FakeClient(), spreadsheetId: "spreadsheet-1" },
      deadlineAtMs: Date.now() + 5000,
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("local-mode");
    expect(result.failures).toBe(0);
    expect(result.expectedErrors).toBe(0);
    // Non-mutating: no rows created, no flush, no client write.
    expect(em.rows()).toEqual([]);
    expect(em.flushCount()).toBe(0);
  });

  it("classifies the pending-delivery reopen as a truthful non-mutating skip (reopen-skipped)", async () => {
    // Core hypothesis: a pending-delivery burst followed by a close/reopen of
    // the SAME runtime needs a runner-owned runtime-replacement seam that the
    // harness does not expose in scenario scope. The module therefore records
    // a genuine `skipped` with the stable `reopen-skipped` reason and NEVER
    // creates burst rows or claims durability was verified.
    const plan = buildPlan(777);
    const em = new FakeEm();
    const client = new FakeClient();
    const result = await scenario.execute({ plan, context: liveContext(plan, em, client) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("reopen-skipped");
    expect(result.failures).toBe(0);
    expect(result.expectedErrors).toBe(0);
    // Non-mutating: no burst rows were created, no flush ran, and no Sheet
    // mutation was attempted — the scenario never touches runtime state.
    expect(em.rows()).toEqual([]);
    expect(em.flushCount()).toBe(0);
    expect(client.mutateCalls).toEqual([]);
  });

  it("never mutates regardless of the plan's burst size (non-mutating contract)", async () => {
    // Even a large burst plan must not create rows: the reopen step cannot
    // run, so the whole scenario is skipped before any write is attempted.
    // Derive the burst bounds from the module's real plan: `8 + rng.int(9)`
    // spans 8..16, so exercise the min, a middle value, and the max.
    const minBurst = 8;
    const maxBurst = 16;
    const burstSizes = [minBurst, Math.floor((minBurst + maxBurst) / 2), maxBurst];
    for (const burstCount of burstSizes) {
      const plan = planWithBurst(burstCount);
      const em = new FakeEm();
      const client = new FakeClient();
      const result = await scenario.execute({ plan, context: liveContext(plan, em, client) });
      expect(plan.burstCount).toBe(burstCount);
      expect(result.status).toBe("skipped");
      expect(result.reason).toBe("reopen-skipped");
      expect(em.rows()).toEqual([]);
      expect(em.flushCount()).toBe(0);
      expect(client.mutateCalls).toEqual([]);
    }
  });
});
