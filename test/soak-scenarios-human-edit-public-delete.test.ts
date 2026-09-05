/**
 * Offline tests for the `humanEditPublicDelete` soak scenario, driven against
 * fake public seams (a fake direct-Sheet client and a fake EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the bounded observation polls shortened so the race/classification
 * logic runs fast and deterministically. Only the `humanEditPublicDelete`
 * scenario module is imported; the other attack-scenario modules are
 * deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as humanEditPublicDelete from "../scripts/ci/local-soak/scenarios/human-edit-public-delete.mjs";
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
const scenario = humanEditPublicDelete;

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
  target: { entityName: string; field: string; targetId: string };
}

/** A deterministic plan over the string `name` field of SoakCustomer. */
function racePlan(): PlanLike {
  return {
    tag: "human-edit-public-delete",
    jitterMs: 1,
    humanValue: "human-delete-c1-0",
    target: { entityName: "SoakCustomer", field: "name", targetId: "hd-cust-c1-0" },
  };
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------


/** A fake direct-Sheet client backed by in-memory tab state. */
class FakeClient {
  private tabs = new Map<string, { headers: string[]; rows: Map<string, unknown[]> }>();
  mutateCalls: { identity: string; headerName: string; value: string }[] = [];
  /** When set, the 1-based mutate call at this index throws with this code. */
  throwOnMutateCall: { index: number; code: string } | undefined;

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
    if (this.throwOnMutateCall !== undefined && this.mutateCalls.length === this.throwOnMutateCall.index) {
      const error = Object.assign(new Error("fake mutate failure"), {
        code: this.throwOnMutateCall.code,
      });
      throw error;
    }
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { rowNumber: 1 };
    const index = tab.headers.indexOf(input.headerName);
    const row = tab.rows.get(input.identity);
    if (row !== undefined && index >= 0) row[index] = input.value;
    return { rowNumber: 1 };
  }
}


// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("humanEditPublicDelete scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("human-edit-public-delete");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("human-edit-public-delete");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("human-edit-public-delete");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("human-edit-public-delete");
    // The target is a real entity and the field a non-primary STRING field
    // (the editable field the plan is allowed to race).
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    const spec = SOAK_FIELD_PLANS[plan.target.entityName]?.[plan.target.field];
    expect(spec).toBeDefined();
    expect(spec!.primary).not.toBe(true);
    expect(spec!.type).toBe("string");
    expect(plan.target.targetId).toMatch(/^hd-/);
    expect(plan.humanValue).toMatch(/^human-delete-/);
    expect(plan.jitterMs).toBeGreaterThan(0);
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

  it("verifies the delete wins and the row is absent (no resurrection) (ok)", async () => {
    // Core hypothesis: a human edit raced with a public-API delete must never
    // resurrect the deleted row. When the delete commits and the row is absent
    // from the authority afterward, the scenario reports a verified ok.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("projection-residue-deferred");
    expect(result.failures).toBe(0);
    expect(result.expectedErrors).toBe(0);
    expect(result.cleanupFailures).toBe(0);
    // The human edit was attempted on the dedicated row exactly once.
    const calls = client.mutateCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(1);
    expect(calls[0]!.value).toBe(plan.humanValue);
    // No-resurrection invariant: the row is absent after the delete wins.
    expect(em.rows()).toEqual([]);
  });

  it("fails when a late human edit resurrects the row after the delete won", async () => {
    // The sync worker applies the human edit asynchronously, so the deleted
    // row can be resurrected AFTER it first appears absent. The old code
    // reported ok on a single immediate read before the resurrection landed;
    // the bounded settled polling must detect the reappearance and fail
    // (never a verified ok).
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The delete removes the row from the authority; the bounded poll's FIRST
    // read sees it absent, then a late human edit resurrects it on every
    // subsequent read.
    let findCount = 0;
    em.findOverride = (id) => {
      findCount += 1;
      return findCount === 1
        ? []
        : [{ id, [plan.target.field]: plan.humanValue }];
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // The human edit was attempted once; the resurrection was detected, not
    // reported as ok.
    const calls = client.mutateCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(1);
    // Guaranteed cleanup still leaves the authority without the row.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-stale rejection as a real failure (scenario-error)", async () => {
    // A rejected delete is an expected stale conflict ONLY on exact
    // CAS/stale evidence. A non-stale (validation/transport) rejection is a
    // real failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The 2nd flush is the public delete's commit; it rejects with a non-stale
    // transport code.
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

  it("records an identity-shifted human-write rejection as a transient skip, not a failure", async () => {
    // The direct client's identity-shift guard rejects the human write with
    // the stable `identity_shifted` class when a CONCURRENT actor shifted
    // the tab mid-write. The seam proved no silent success, so this is an
    // EXPECTED TRANSIENT of the adversarial multi-writer environment: a
    // truthful skip (never a failure). The delete-winner invariant still
    // judges real resurrection separately.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnMutateCall = { index: 1, code: "identity_shifted" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity-shifted-transient");
    expect(result.failures).toBe(0);
    // Guaranteed cleanup still removed the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("skips truthfully when the dedicated row's projection never appears (gating)", async () => {
    const plan = racePlan();
    const client = new FakeClient();
    // The tab exists but the dedicated row is never projected into it.
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", plan.target.field]);
    const em = new FakeEm();
    const context = liveContext(plan, client, em, Date.now() + 80);
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("projection-not-ready");
    // No human write was ever attempted against a not-yet-projected row.
    expect(client.mutateCalls).toEqual([]);
    // The dedicated row is still removed in cleanup.
    expect(em.rows()).toEqual([]);
  });

  it("removes the dedicated row in the guaranteed finally even when the delete rejects", async () => {
    // The finally path removes the dedicated row and mirrors the delete even
    // when the public delete's flush rejects, so SQLite and the oracle stay
    // symmetric and the final state matches the deterministic replay.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The 2nd flush is the public delete's commit; it rejects with a non-stale
    // transport code, but the guaranteed cleanup still removes the row.
    em.flushBehavior = (index) => {
      if (index === 2) {
        throw Object.assign(new Error("fake transport failure"), {
          code: "google_sheets_api_network_error",
        });
      }
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    // Guaranteed cleanup removed the dedicated row despite the delete failure.
    expect(em.rows()).toEqual([]);
  });
});
