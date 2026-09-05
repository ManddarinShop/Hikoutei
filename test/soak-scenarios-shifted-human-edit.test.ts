/**
 * Offline tests for the `shiftedHumanEdit` soak scenario, driven against
 * fake public seams (a fake EntityManager and a fake direct-Sheet client).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the deterministic bounded sleeps shortened so the projection
 * polls run fast. The fail-closed `identity_shifted` classification is
 * unit-tested both directly (the pure classifier) and through `execute`
 * (a fake client throwing the stable guard class). Only the
 * `shiftedHumanEdit` scenario module is imported; the other attack-scenario
 * modules are deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as shiftedHumanEdit from "../scripts/ci/local-soak/scenarios/shiftedHumanEdit.mjs";
import { SOAK_ENTITY_ORDER } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { SYSTEM_WINS_RESOLVE_SUFFIX } from "../scripts/ci/local-soak/errors.mjs";
import { FakeEm, liveContext } from "./support/soakScenarioFixtures.js";

// Shorten the scenario's bounded sleeps so the projection polls terminate
// quickly and deterministically (a real poll would be ~1s each). The real
// module's `isDeadlineExpired` (and constants) flow through so the scenario's
// post-jitter expiry check uses the genuine clock-slop semantics.
vi.mock("../scripts/ci/local-soak/timing.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/ci/local-soak/timing.mjs")>()),
  boundedSleep: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  },
}));

/** The one scenario module under test. */
const scenario = shiftedHumanEdit;

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
  humanValue: string;
  target: { entityName: string; field: string; targetId: string; shifterId: string };
}

/** A deterministic plan over dedicated sh/race ids on SoakCustomer. */
function racePlan(overrides: Partial<PlanLike> = {}): PlanLike {
  return {
    tag: "shifted-human-edit",
    jitterMs: 1,
    humanValue: "shift-cust-c1-0-edit",
    target: {
      entityName: "SoakCustomer",
      field: "tier",
      targetId: "sh-cust-c1-0",
      shifterId: "sh-cust-c1-0-shift",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------


/** The stable fail-closed guard error the direct client throws. */
function shiftedError(): Error {
  return Object.assign(new Error("direct human write shifted identity"), {
    name: "DirectSheetsError",
    statusClass: "identity_shifted",
  });
}

/** A fake direct-Sheet client backed by in-memory tab state. */
class FakeClient {
  private tabs = new Map<string, { headers: string[]; rows: Map<string, string[]> }>();
  mutateCalls: { identity: string; headerName: string; value: string }[] = [];
  deleteCalls: { identity: string }[] = [];
  /** The 1-based mutate call at this index throws the fail-closed guard. */
  throwShiftedOnMutate: number | undefined;
  /** The 1-based mutate call at this index throws a non-guard error. */
  throwOtherOnMutate: number | undefined;
  /** The 1-based delete call at this index throws the fail-closed guard. */
  throwShiftedOnDelete: number | undefined;
  /** When true, mutate RESOLVES but writes the value to another identity's row. */
  misplaceMutate = false;

  hasTab(tabName: string): boolean {
    return this.tabs.has(tabName);
  }

  ensureTab(tabName: string, headers: string[]): void {
    this.tabs.set(tabName, { headers, rows: new Map() });
  }

  setCell(tabName: string, identity: string, values: Record<string, string>): void {
    const tab = this.tabs.get(tabName);
    if (tab === undefined) throw new Error(`no tab ${tabName}`);
    tab.rows.set(identity, tab.headers.map((header) => values[header] ?? ""));
  }

  async readTabRows(_spreadsheetId: string, tabName: string): Promise<unknown[][]> {
    const tab = this.tabs.get(tabName);
    if (tab === undefined) return [];
    return [tab.headers, ...[...tab.rows.values()].map((row) => [...row])];
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
    if (this.throwShiftedOnMutate !== undefined && this.mutateCalls.length === this.throwShiftedOnMutate) {
      throw shiftedError();
    }
    if (this.throwOtherOnMutate !== undefined && this.mutateCalls.length === this.throwOtherOnMutate) {
      throw new Error("fake transport failure");
    }
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { rowNumber: 1 };
    const column = tab.headers.indexOf(input.headerName);
    if (column < 0) return { rowNumber: 1 };
    if (this.misplaceMutate) {
      // The #364 bug: a resolved edit whose value lands on ANOTHER identity's
      // row (here the shifter row) instead of the intended identity.
      const otherId = [...tab.rows.keys()].find((id) => id !== input.identity);
      const row = otherId === undefined ? undefined : tab.rows.get(otherId);
      if (row !== undefined) row[column] = input.value;
    } else {
      const row = tab.rows.get(input.identity);
      if (row !== undefined) row[column] = input.value;
    }
    return { rowNumber: 1 };
  }

  async deleteInputRow(input: { tabName: string; identity: string }): Promise<{ rowNumber: number }> {
    this.deleteCalls.push({ identity: input.identity });
    if (this.throwShiftedOnDelete !== undefined && this.deleteCalls.length === this.throwShiftedOnDelete) {
      throw shiftedError();
    }
    this.tabs.get(input.tabName)?.rows.delete(input.identity);
    return { rowNumber: 1 };
  }
}


/**
 * Projects every entity the fake EM persists into the fake _Input tab
 * (mirrors the sync worker appending SQLite rows to the projection), so the
 * scenario's bounded projection readiness sees both dedicated rows.
 */
function wireProjection(em: FakeEm, client: FakeClient, plan: PlanLike): void {
  const tabName = `${plan.target.entityName}_Input`;
  const originalPersist = em.persist.bind(em);
  em.persist = (entity: Record<string, unknown>) => {
    // Create the tab only once: a later persist must APPEND its row, never
    // reset the tab and wipe earlier projected rows.
    if (!client.hasTab(tabName)) {
      client.ensureTab(tabName, ["id", plan.target.field]);
    }
    client.setCell(tabName, String(entity.id), {
      id: String(entity.id),
      [plan.target.field]: String(entity[plan.target.field] ?? ""),
    });
    originalPersist(entity);
  };
}

/** Pre-seeds both dedicated rows in the em and the fake tab (recover test). */
function seedBothRows(em: FakeEm, client: FakeClient, plan: PlanLike): void {
  const tabName = `${plan.target.entityName}_Input`;
  client.ensureTab(tabName, ["id", plan.target.field]);
  for (const id of [plan.target.targetId, plan.target.shifterId]) {
    em.store.set(id, { id, [plan.target.field]: "generated" });
    client.setCell(tabName, id, { id, [plan.target.field]: "generated" });
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("shiftedHumanEdit scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("shifted-human-edit");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("shifted-human-edit");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("shifted-human-edit");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("shifted-human-edit");
    expect(plan.jitterMs).toBeGreaterThan(0);
    // The target is a real entity from the active subset, on dedicated ids
    // outside the actor/prologue space.
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    expect(plan.target.targetId).toMatch(/^sh-/);
    expect(plan.target.shifterId).toMatch(/^sh-/);
    expect(plan.target.shifterId).not.toBe(plan.target.targetId);
    expect(plan.humanValue).toMatch(/^shift-/);
  });

  it("varies the plan across different seeds", () => {
    const a = buildPlan(777);
    const b = buildPlan(778);
    expect(b).not.toEqual(a);
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = racePlan();
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

  it("classifies a fail-closed identity_shifted rejection as expected, not a failure", async () => {
    // The pure classifier unit: only the stable `statusClass` guard evidence
    // (DirectSheetsError) counts; a plain error or a code-only error never
    // does.
    expect(scenario.isIdentityShiftedRejection(shiftedError())).toBe(true);
    expect(scenario.isIdentityShiftedRejection(new Error("boom"))).toBe(false);
    expect(scenario.isIdentityShiftedRejection(
      Object.assign(new Error("code only"), { code: "identity_shifted" }),
    )).toBe(false);
    // End to end: the fake client rejects the edit with the fail-closed
    // guard. That is the EXPECTED outcome of a shifted race: expectedErrors
    // 1, never a failure, and cleanup still removes both dedicated rows.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    client.throwShiftedOnMutate = 1;
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("guard-invariant-verified");
    expect(result.expectedErrors).toBe(1);
    expect(result.failures).toBe(0);
    expect(em.rows()).toEqual([]);
  });

  it("classifies a fail-closed identity_shifted shifter-delete rejection as expected", async () => {
    // The delete's own guard failed closed (it could not verify the intended
    // shifter identity): also expected, never a failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    client.throwShiftedOnDelete = 1;
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.expectedErrors).toBe(1);
    expect(result.failures).toBe(0);
    expect(em.rows()).toEqual([]);
  });

  it("classifies an edit that lands on the intended identity as ok and cleans up", async () => {
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("guard-invariant-verified");
    expect(result.expectedErrors).toBe(0);
    expect(result.failures).toBe(0);
    expect(result.cleanupFailures).toBe(0);
    // The human edit was actually issued against the dedicated race row.
    expect(client.mutateCalls).toEqual([{
      identity: plan.target.targetId,
      headerName: plan.target.field,
      value: plan.humanValue,
    }]);
    // The shifter delete was actually issued against the dedicated shifter row.
    expect(client.deleteCalls).toEqual([{ identity: plan.target.shifterId }]);
    // Guaranteed cleanup removed both dedicated rows.
    expect(em.rows()).toEqual([]);
  });

  it("asserts a resolved edit that wrote to the WRONG identity is a failure (#364 invariant)", async () => {
    // The core assertion: a resolved human edit whose value is NOT on the
    // intended identity row is the wrong-identity write the guard must never
    // produce. The fake simulates the #364 bug (value placed on another
    // identity's row while the call resolves); the scenario-level post-race
    // snapshot must catch it as failures=1 — never forgiven.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    client.misplaceMutate = true;
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Cleanup still removed both dedicated rows.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-shift edit rejection as a failure", async () => {
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    client.throwOtherOnMutate = 1; // transport-class rejection, never expected
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.failures).toBe(1);
    // The stable diagnostic kind names WHICH invariant fired.
    expect(result.failureKinds).toEqual(["edit-rejected-unexpected"]);
    expect(em.rows()).toEqual([]);
  });

  it("skips truthfully when the dedicated rows' projection never appears (gating)", async () => {
    const plan = racePlan();
    const client = new FakeClient();
    // No tab at all: neither dedicated row is ever projected.
    const em = new FakeEm();
    const context = liveContext(plan, client, em, Date.now() + 80); // short gating window
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("projection-not-ready");
    // No race was ever attempted.
    expect(client.mutateCalls).toEqual([]);
    expect(client.deleteCalls).toEqual([]);
    // The dedicated rows are still removed in cleanup.
    expect(em.rows()).toEqual([]);
  });

  it("recover is idempotent and removes both dedicated rows", async () => {
    const plan = racePlan();
    const em = new FakeEm();
    const client = new FakeClient();
    seedBothRows(em, client, plan);
    const context = {
      seed: 1,
      cycle: 1,
      activeEntities: SOAK_ENTITY_ORDER,
      tokenByEntity: new Map([[plan.target.entityName, { entity: plan.target.entityName }]]),
      em,
      live: { mode: "live", client, spreadsheetId: "spreadsheet-1" },
      deadlineAtMs: Date.now() + 5000,
    };
    const first = await scenario.recover({ plan, context });
    expect(first.removed).toBe(2);
    expect(em.rows()).toEqual([]);
    // Idempotent: a second recovery removes nothing.
    const second = await scenario.recover({ plan, context });
    expect(second.removed).toBe(0);
  });

  it("guarantees independent cleanup: both dedicated rows are removed even when the race failed", async () => {
    // A scenario-error path (the wrong-identity write) still runs the
    // guaranteed finally: both dedicated rows must be gone from the store.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    client.throwOtherOnMutate = 1;
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.failures).toBe(1);
    expect(em.rows()).toEqual([]);
  });

  it("accepts an OPEN sync_conflict as conflict-recorded when the resolved edit is not on the intended identity", async () => {
    // Core harness fix: the resolved edit's value is not observable on the
    // intended Sheet identity, but it was ingested as an OPEN sync_conflict
    // — recorded on the intended binding, not written to the wrong identity.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    client.misplaceMutate = true;
    // The conflict record clears once the cleanup's system-wins advance
    // lands (the stored value carries the resolve suffix), modeling the
    // worker applying the acknowledge_system resolution.
    const oracleMutations: unknown[] = [];
    const context = {
      ...liveContext(plan, client, em),
      oracle: { applyMutation: (mutation: unknown) => oracleMutations.push(mutation) },
      queryConflictRows: async () => {
        const value = em.store.get(plan.target.targetId)?.[plan.target.field];
        const resolved = typeof value === "string" && value.endsWith(SYSTEM_WINS_RESOLVE_SUFFIX);
        return resolved ? [] : [{
          fieldName: plan.target.field,
          userValue: plan.humanValue,
          status: "OPEN",
        }];
      },
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("conflict-recorded");
    expect(result.failures).toBe(0);
    // The resolve-then-delete cleanup removed both dedicated rows and
    // mirrored both deletes into the oracle.
    expect(em.rows()).toEqual([]);
    expect(oracleMutations).toContainEqual({
      op: "delete",
      entity: plan.target.entityName,
      id: plan.target.targetId,
    });
    expect(oracleMutations).toContainEqual({
      op: "delete",
      entity: plan.target.entityName,
      id: plan.target.shifterId,
    });
  });

  it("records cleanup-unresolved-conflict and keeps both rows when the conflict never clears", async () => {
    // The resolve-then-delete cleanup advances the race row's field, but the
    // conflict record never leaves the blocking state within the bound. Both
    // dedicated rows must be KEPT — never deleted through a blocking
    // conflict — and the distinct stable kind recorded as a real failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    wireProjection(em, client, plan);
    client.misplaceMutate = true;
    const context = {
      ...liveContext(plan, client, em, Date.now() + 60),
      queryConflictRows: async () => [{
        fieldName: plan.target.field,
        userValue: plan.humanValue,
        status: "OPEN",
      }],
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("conflict-recorded");
    expect(result.failures).toBe(1);
    expect(result.cleanupFailures).toBe(1);
    expect(result.failureKinds).toEqual(["cleanup-unresolved-conflict"]);
    // Both dedicated rows are kept, and the resolve attempt advanced the
    // race row's conflicted field through the EM.
    expect(em.rows().length).toBe(2);
    const kept = em.store.get(plan.target.targetId)?.[plan.target.field];
    expect(typeof kept === "string" && kept.endsWith(SYSTEM_WINS_RESOLVE_SUFFIX)).toBe(true);
  });
});
