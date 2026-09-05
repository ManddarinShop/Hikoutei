/**
 * Offline tests for the `localHumanWriteRace` soak scenario, driven against
 * fake public seams (a fake direct-Sheet client and a fake EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the bounded observation polls shortened so the settle/rejection
 * logic runs fast and deterministically. Only the `localHumanWriteRace`
 * scenario module is imported; the other attack-scenario modules are
 * deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as localHumanWriteRace from "../scripts/ci/local-soak/scenarios/localHumanWriteRace.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { SYSTEM_WINS_RESOLVE_SUFFIX } from "../scripts/ci/local-soak/errors.mjs";
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
const scenario = localHumanWriteRace;

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
  race: "update" | "delete";
  humanValue: string;
  target: { entityName: string; field: string; targetId: string };
}

/** A deterministic plan over the string `name` field of SoakCustomer. */
function racePlan(race: "update" | "delete"): PlanLike {
  return {
    tag: "local-vs-human-race",
    jitterMs: 1,
    race,
    humanValue: "human-race-c1-0",
    target: { entityName: "SoakCustomer", field: "name", targetId: "local-race-cust-c1-0" },
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

describe("localHumanWriteRace scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("local-human-write-race");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("local-human-write-race");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("local-vs-human-race");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("local-vs-human-race");
    expect(plan.race === "update" || plan.race === "delete").toBe(true);
    // The target is a real entity and the field a non-primary STRING field
    // (the editable field the plan is allowed to race).
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    const spec = SOAK_FIELD_PLANS[plan.target.entityName]?.[plan.target.field];
    expect(spec).toBeDefined();
    expect(spec!.primary).not.toBe(true);
    expect(spec!.type).toBe("string");
    expect(plan.target.targetId).toMatch(/^local-race-/);
    expect(plan.humanValue).toMatch(/^human-race-/);
    expect(plan.jitterMs).toBeGreaterThan(0);
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = racePlan("update");
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

  it("verifies a local update race winner when the local write commits (ok)", async () => {
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    // The local mutation committed to the authority and no duplicate/silent
    // loss was observed -> a verified ok, not a skip.
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    // The human edit was attempted on the dedicated row exactly once.
    const calls = client.mutateCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(1);
    expect(calls[0]!.value).toBe(plan.humanValue);
    // Guaranteed cleanup removes the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("verifies a human winner is never silently lost when the authority observes it (ok)", async () => {
    // Core hypothesis: a local write raced with a human edit must never
    // silently lose the human value. When the authority (public reads) shows
    // the human value after the race, the scenario must report a verified ok
    // and NOT lose the human value.
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The authority observes the human value on the raced row (the human edit
    // landed after the local transition), across the settle-threshold polls.
    em.findOneOverride = (id) => {
      const row = em.store.get(id);
      return row ? { ...row, [plan.target.field]: plan.humanValue } : null;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    // The human edit was attempted and cleaned up.
    const calls = client.mutateCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(1);
    expect(calls[0]!.value).toBe(plan.humanValue);
    expect(em.rows()).toEqual([]);
  });

  it("verifies a delete race winner when our delete provably committed (ok)", async () => {
    const plan = racePlan("delete");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    // The dedicated row is removed in cleanup.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-stale local rejection as a real failure (scenario-error)", async () => {
    // A rejected local write is an expected stale conflict ONLY on exact
    // CAS/stale evidence. A non-stale (validation/transport) rejection is a
    // real failure.
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The 2nd flush is the local mutation's commit; it rejects with a
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
    // The stable diagnostic kind names WHICH invariant fired (no raw text).
    expect(result.failureKinds).toEqual(["local-rejection-non-stale"]);
    // Guaranteed cleanup still removed the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("treats an exact stale-write conflict as not a failure and truthfully skips when the winner is unobserved", async () => {
    // On a delete race, a rejected local delete is EXPECTED when the error
    // carries an exact CAS/stale/hash-mismatch code. It is not a failure; the
    // unprovable winner is a truthful skip (never a premature delete winner).
    const plan = racePlan("delete");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The 2nd flush (the local delete) rejects with a stale guard-mismatch.
    em.flushBehavior = (index) => {
      if (index === 2) {
        throw Object.assign(new Error("stale delete guard"), {
          code: "invalid_deletion_guard",
        });
      }
    };
    const result = await scenario.execute({
      plan,
      context: liveContext(plan, client, em, Date.now() + 120),
    });
    // The stale-coded rejection is NOT counted as a failure.
    expect(result.failures).toBe(0);
    // No proven winner within the bounded observation -> truthful skip.
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("winner-not-verified");
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-stale human-write rejection on an update race as a failure", async () => {
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The single human direct-write call rejects with a non-stale transport
    // code -> a real direct-write failure on an update race.
    client.throwOnMutateCall = { index: 1, code: "google_sheets_api_timeout" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    expect(result.failureKinds).toEqual(["human-write-rejected"]);
    expect(em.rows()).toEqual([]);
  });

  it("records an identity-shifted human-write rejection as a transient skip, not a failure", async () => {
    // The direct client's identity-shift guard rejects the human write with
    // the stable `identity_shifted` class when a CONCURRENT actor shifted
    // the tab mid-write. The seam proved no silent success, so this is an
    // EXPECTED TRANSIENT of the adversarial multi-writer environment: a
    // truthful skip (never a failure, never fed to max-consecutive-
    // failures). The duplicate-row invariant still judges real duplication
    // separately.
    const plan = racePlan("update");
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
    const plan = racePlan("update");
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

  it("accepts an OPEN sync_conflict as conflict-recorded when the winner never settles (ok)", async () => {
    // Core harness fix: neither candidate value settles in the authority
    // within the bound (the outbox-gated poll skips the row), but the human
    // value was ingested as an OPEN sync_conflict — recorded, not lost.
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The authority never settles on either candidate value: after the local
    // update commits, reads observe a foreign value (neither candidate).
    em.flushBehavior = (index) => {
      if (index === 2) {
        em.store.get(plan.target.targetId)![plan.target.field] = "foreign-value";
      }
    };
    // The conflict record clears once the cleanup's system-wins advance
    // lands (the stored value carries the resolve suffix), modeling the
    // worker applying the acknowledge_system resolution.
    const oracleMutations: unknown[] = [];
    const context = {
      ...liveContext(plan, client, em, Date.now() + 300),
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
    expect(result.failureKinds).toBeUndefined();
    // The resolve-then-delete cleanup removed the dedicated row and mirrored
    // the delete into the oracle (never deleted through the OPEN conflict).
    expect(em.rows()).toEqual([]);
    expect(oracleMutations).toContainEqual({
      op: "delete",
      entity: plan.target.entityName,
      id: plan.target.targetId,
    });
  });

  it("records cleanup-unresolved-conflict and keeps the row when the conflict never clears", async () => {
    // The resolve-then-delete cleanup advances the conflicted field, but the
    // conflict record never leaves the blocking state within the bound (a
    // deferred acknowledge stuck behind an unsettled predecessor). The row
    // must be KEPT — never deleted through a blocking conflict — and the
    // distinct stable kind recorded as a real failure.
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    em.flushBehavior = (index) => {
      if (index === 2) {
        em.store.get(plan.target.targetId)![plan.target.field] = "foreign-value";
      }
    };
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
    // The row is kept (never tombstoned under the blocking conflict), and
    // the resolve attempt advanced the conflicted field through the EM.
    expect(em.rows().length).toBe(1);
    const kept = em.store.get(plan.target.targetId)?.[plan.target.field];
    expect(typeof kept === "string" && kept.endsWith(SYSTEM_WINS_RESOLVE_SUFFIX)).toBe(true);
  });

  it("waits for the binding outbox to drain, then deletes after a verified winner (ok)", async () => {
    // Live-evidence regression: a `race-winner-verified` row with NO
    // conflict still fails closed when candidate effects for its binding
    // are in flight. The cleanup must wait (bounded) for them to drain and
    // only then delete — never fail the run over a transiently busy outbox.
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The binding effect is in flight for the first polls, then drains
    // (the worker's delivery completes mid-cleanup).
    let polls = 0;
    const context = {
      ...liveContext(plan, client, em),
      queryOutboxInflightCount: async () => {
        polls += 1;
        return polls <= 2 ? 1 : 0;
      },
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    expect(result.cleanupFailures).toBe(0);
    expect(polls).toBeGreaterThan(2);
    // The delete ran only after the drain: the dedicated row is gone.
    expect(em.rows()).toEqual([]);
  });

  it("records cleanup-outbox-busy and keeps the row when the binding outbox never drains", async () => {
    // The binding effect is stuck in flight past the bounded wait (a wedged
    // candidate cycle). The row must be KEPT — never deleted through a
    // blocked outbox — and the distinct stable kind recorded as a real
    // failure (not a skip).
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const context = {
      ...liveContext(plan, client, em, Date.now() + 60),
      queryOutboxInflightCount: async () => 1,
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(1);
    expect(result.cleanupFailures).toBe(1);
    expect(result.failureKinds).toEqual(["cleanup-outbox-busy"]);
    // The row is kept (never tombstoned under the blocked outbox).
    expect(em.rows().length).toBe(1);
  });

  it("still skips winner-not-verified when the winner never settles and no conflict is recorded", async () => {
    // The negative control: an unobserved winner with NO conflict record is
    // still a truthful skip, never an unobserved ok.
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    em.findOneOverride = (id) => {
      const row = em.store.get(id);
      return row ? { ...row, [plan.target.field]: "foreign-value" } : null;
    };
    const context = {
      ...liveContext(plan, client, em, Date.now() + 120),
      queryConflictRows: async () => [],
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("winner-not-verified");
    expect(result.failures).toBe(0);
    expect(em.rows()).toEqual([]);
  });
});
