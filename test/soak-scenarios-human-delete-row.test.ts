/**
 * Offline tests for the `humanDeleteRow` soak scenario, driven against fake
 * public seams (a fake direct-Sheet client and a fake EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the bounded observation polls shortened so the settle/rejection
 * logic runs fast and deterministically. Only the `humanDeleteRow` scenario
 * module is imported; the other attack-scenario modules are deliberately not
 * touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as humanDeleteRow from "../scripts/ci/local-soak/scenarios/human-delete-row.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { FakeEm, liveContext, projectPersistedRow } from "./support/soakScenarioFixtures.js";

// Shorten the scenario's bounded observation sleeps so the poll/settle loops
// terminate quickly and deterministically (a real poll would be ~1s each).
// Keep the real timing helpers (including the clock-slop deadline check the
// scenarios import); only the bounded sleeps are stubbed so the poll/settle
// loops run fast and deterministically.
vi.mock("../scripts/ci/local-soak/timing.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/ci/local-soak/timing.mjs")>()),
  boundedSleep: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  },
}));

/** The one scenario module under test. */
const scenario = humanDeleteRow;

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
  updateValue: string;
  target: { entityName: string; field: string; targetId: string };
}

/** A deterministic plan over the string `name` field of SoakCustomer. */
function deletePlan(): PlanLike {
  return {
    tag: "human-delete-row",
    jitterMs: 1,
    updateValue: "hdel-update-c1-0",
    target: { entityName: "SoakCustomer", field: "name", targetId: "hdel-cust-c1-0" },
  };
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------


/**
 * A fake direct-Sheet client backed by in-memory tab state.
 *
 * `deleteInputRow` removes the identity row from the tab AND, when wired to
 * an `em`, removes it from the authority too — simulating the sync worker
 * applying the observed User_Input delete to SQLite. When configured, it
 * rejects with the stable `identity_shifted` code (the direct client's
 * fail-closed guard for a missing identity or collateral loss).
 */
class FakeClient {
  private tabs = new Map<string, { headers: string[]; rows: Map<string, unknown[]> }>();
  deleteCalls: { identity: string }[] = [];
  /** When set, the 1-based delete call at this index throws with this code. */
  throwOnDeleteCall: { index: number; code: string } | undefined;
  ensureTab(tabName: string, headers: string[]): void {
    this.tabs.set(tabName, { headers, rows: new Map() });
  }

  setCell(tabName: string, identity: string, values: Record<string, string>): void {
    const tab = this.tabs.get(tabName);
    if (tab === undefined) throw new Error(`no tab ${tabName}`);
    tab.rows.set(identity, tab.headers.map((header) => values[header]));
  }

  async readTabRows(_spreadsheetId: string, tabName: string): Promise<unknown[][]> {
    const tab = this.tabs.get(tabName);
    if (tab === undefined) return [];
    return [tab.headers, ...[...tab.rows.values()].map((row) => [...row])];
  }

  async deleteInputRow(input: {
    tabName: string;
    identity: string;
  }): Promise<{ rowNumber: number }> {
    this.deleteCalls.push({ identity: input.identity });
    if (this.throwOnDeleteCall !== undefined && this.deleteCalls.length === this.throwOnDeleteCall.index) {
      const error = Object.assign(new Error("fake delete failure"), {
        code: this.throwOnDeleteCall.code,
      });
      throw error;
    }
    const tab = this.tabs.get(input.tabName);
    if (tab !== undefined) tab.rows.delete(input.identity);
    // SQLite is the authority: the human sheet delete removes the projection
    // row from the tab but MUST NOT erase the SQLite row.
    return { rowNumber: 1 };
  }
}


// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("humanDeleteRow scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("human-delete-row");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("human-delete-row");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("human-delete-row");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("human-delete-row");
    // The target is a real entity and the field a non-primary STRING field
    // (the editable field the plan is allowed to update).
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    const spec = SOAK_FIELD_PLANS[plan.target.entityName]?.[plan.target.field];
    expect(spec).toBeDefined();
    expect(spec!.primary).not.toBe(true);
    expect(spec!.type).toBe("string");
    expect(plan.target.targetId).toMatch(/^hdel-/);
    expect(plan.updateValue).toMatch(/^hdel-update-/);
    expect(plan.jitterMs).toBeGreaterThan(0);
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = deletePlan();
    const context = {
      seed: 1,
      cycle: 1,
      activeEntities: [], // none active -> the entity is not expected
      tokenByEntity: new Map([[plan.target.entityName, { entity: plan.target.entityName }]]),
      em: new FakeEm(),
      live: { mode: "live", client: new FakeClient(), spreadsheetId: "spreadsheet-1" },
      deadlineAtMs: Date.now() + 5000,
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("local-mode");
    expect(result.failures).toBe(0);
  });

  it("retains the authority row and applies the public update (ok)", async () => {
    // Core hypothesis: SQLite is the authority, so a human sheet delete must
    // NOT erase the SQLite row. The row is retained in the authority and the
    // public update value is reflected; the scenario reports a verified ok.
    const plan = deletePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    // The human delete was attempted on the dedicated row exactly once.
    const calls = client.deleteCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(1);
    // A verified ok is only reported when the authority-retention check
    // observed the row present in SQLite with the public update value
    // reflected, so the sheet delete did NOT erase the authority row.
    // Guaranteed cleanup then removes the dedicated row and leaves the
    // authority empty.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-stale public-update rejection as a real failure (scenario-error)", async () => {
    // A rejected public update is an expected stale conflict ONLY on exact
    // CAS/stale evidence. A non-stale (validation/transport) rejection is a
    // real failure.
    const plan = deletePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The 2nd flush is the public update's commit; it rejects with a
    // non-stale transport code.
    em.flushBehavior = (index) => {
      if (index === 2) {
        throw Object.assign(new Error("fake transport failure"), {
          code: "google_sheets_api_network_error",
        });
      }
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Guaranteed cleanup still removed the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("records an identity-shifted human-delete rejection as a transient skip, not a failure", async () => {
    // The direct client's identity-shift guard rejects the human delete with
    // the stable `identity_shifted` class when a concurrent actor shifted
    // the tab mid-delete. The seam proved no silent success, so this is an
    // EXPECTED TRANSIENT of the adversarial multi-writer environment: a
    // truthful skip (never a failure). The authority-retention invariant
    // still judges real data loss separately.
    const plan = deletePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnDeleteCall = { index: 1, code: "identity_shifted" };
    const result = await scenario.execute({
      plan,
      context: liveContext(plan, client, em, Date.now() + 120),
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity-shifted-transient");
    expect(result.failures).toBe(0);
    // Guaranteed cleanup still removed the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("skips truthfully when the dedicated row's projection never appears (gating)", async () => {
    const plan = deletePlan();
    const client = new FakeClient();
    // The tab exists but the dedicated row is never projected into it.
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", plan.target.field]);
    const em = new FakeEm();
    const context = liveContext(plan, client, em, Date.now() + 80);
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("projection-not-ready");
    // No human delete was ever attempted against a not-yet-projected row.
    expect(client.deleteCalls).toEqual([]);
    // The dedicated row is still removed in cleanup.
    expect(em.rows()).toEqual([]);
  });
});
