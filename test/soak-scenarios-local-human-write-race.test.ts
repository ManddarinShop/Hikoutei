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

/** A fake EntityManager over an in-memory id-keyed store. */
class FakeEm {
  store = new Map<string, Record<string, unknown>>();
  findOneOverride: ((id: string) => Record<string, unknown> | null | undefined) | undefined;
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

/** Builds a live execution context wired to the fake seams. */
function liveContext(
  plan: PlanLike,
  client: FakeClient,
  em: FakeEm,
  deadlineAtMs?: number,
): Record<string, unknown> {
  return {
    seed: 1,
    cycle: 1,
    activeEntities: SOAK_ENTITY_ORDER,
    tokenByEntity: new Map([[plan.target.entityName, { entity: plan.target.entityName }]]),
    em,
    live: { mode: "live", client, spreadsheetId: "spreadsheet-1" },
    deadlineAtMs: deadlineAtMs ?? Date.now() + 5000,
  };
}

/**
 * Mirrors the invalidHumanInput test's authoritative-value pattern: hook the
 * fake EntityManager's `persist` so the dedicated race row's field is
 * projected into the fake _Input tab at the exact cell-string the row will
 * carry once the sync worker projects it. `awaitInputProjection` resolves on
 * the first poll, so the race proceeds deterministically.
 */
function projectPersistedRow(em: FakeEm, client: FakeClient, plan: PlanLike): void {
  const originalPersist = em.persist.bind(em);
  em.persist = (entity: Record<string, unknown>) => {
    const value = entity[plan.target.field];
    const projected = value === null || value === undefined ? "" : String(value);
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", plan.target.field]);
    client.setCell(`${plan.target.entityName}_Input`, plan.target.targetId, {
      id: plan.target.targetId,
      [plan.target.field]: projected,
    });
    originalPersist(entity);
  };
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
    expect(em.rows()).toEqual([]);
  });

  it("cannot finish ok when the human-write postcondition detects an identity shift", async () => {
    // The direct client's identity-shift guard rejects the human write with
    // the stable `identity_shifted` class when the value landed on the wrong
    // identity. That is NOT stale-write/CAS evidence, so the scenario must
    // fail (never a verified race-winner ok) — a collateral write is never
    // silently accepted.
    const plan = racePlan("update");
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnMutateCall = { index: 1, code: "identity_shifted" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
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
});
