/**
 * Offline tests for the `deleteRecreateHumanEdit` soak scenario, driven
 * against fake public seams (a fake direct-Sheet client and a fake
 * EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the bounded observation polls shortened so the settle/rejection
 * logic runs fast and deterministically. Only the `deleteRecreateHumanEdit`
 * scenario module is imported; the other attack-scenario modules are
 * deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as deleteRecreateHumanEdit from "../scripts/ci/local-soak/scenarios/deleteRecreateHumanEdit.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";

// Shorten the scenario's bounded observation sleeps so the poll/settle loops
// terminate quickly and deterministically (a real poll would be ~1s each).
vi.mock("../scripts/ci/local-soak/timing.mjs", () => ({
  boundedSleep: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  },
}));

/** The one scenario module under test. */
const scenario = deleteRecreateHumanEdit;

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
  iterations: number;
  target: { entityName: string; field: string; targetId: string };
}

/** A deterministic plan over the string `name` field of SoakCustomer. */
function racePlan(overrides: Partial<PlanLike> = {}): PlanLike {
  return {
    tag: "delete-recreate-human-edit",
    jitterMs: 1,
    humanValue: "human-dr-c1-0",
    iterations: 1,
    target: { entityName: "SoakCustomer", field: "name", targetId: "dr-customer-c1-0" },
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

/** A fake direct-Sheet client backed by in-memory tab state. */
class FakeClient {
  private tabs = new Map<string, { headers: string[]; rows: Map<string, unknown[]> }>();
  mutateCalls: { identity: string; headerName: string; value: string }[] = [];
  /** When set, the 1-based mutate call at this index throws with this code. */
  throwOnMutateCall: { index: number; code: string } | undefined;
  /**
   * When set, a successful mutateInputCell also commits the human value into
   * the fake authority (simulating the worker observing the human edit and
   * updating SQLite), so the final authority row carries the human value.
   */
  em: FakeEm | undefined;

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
    // Simulate the worker observing the human edit and committing it to the
    // authority, so the final authority row carries the human value.
    if (this.em !== undefined) {
      const entity = this.em.store.get(input.identity);
      if (entity !== undefined) entity[input.headerName] = input.value;
    }
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
 * Mirrors the localHumanWriteRace test's authoritative-value pattern: hook
 * the fake EntityManager's `persist` so the dedicated race row's field is
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

describe("deleteRecreateHumanEdit scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("delete-recreate-human-edit");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("delete-recreate-human-edit");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("delete-recreate-human-edit");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("delete-recreate-human-edit");
    expect(plan.jitterMs).toBeGreaterThan(0);
    // The target is a real entity and the field a non-primary STRING field
    // (the editable field the plan is allowed to race).
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    const spec = SOAK_FIELD_PLANS[plan.target.entityName]?.[plan.target.field];
    expect(spec).toBeDefined();
    expect(spec!.primary).not.toBe(true);
    expect(spec!.type).toBe("string");
    expect(plan.target.targetId).toMatch(/^dr-/);
    expect(plan.humanValue).toMatch(/^human-dr-/);
    expect(plan.iterations).toBeGreaterThanOrEqual(2);
    expect(plan.iterations).toBeLessThanOrEqual(3);
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

  it("verifies the reactivation invariant when the human edit lands on the recreated generation (ok)", async () => {
    // Core hypothesis: the public API deletes and recreates the same id while
    // a human edits a field of that id. When the human edit lands on the
    // recreated generation, exactly one final row remains AND the human value
    // is present in it (not silently lost) -> a verified ok.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The fake client commits the human edit into the authority (the worker
    // observing the Sheet edit and updating SQLite), so the final row carries
    // the human value on the recreated generation.
    client.em = em;
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    expect(result.expectedErrors).toBe(0);
    expect(result.cleanupFailures).toBe(0);
    // The human edit was attempted on the dedicated row exactly once.
    const calls = client.mutateCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(1);
    expect(calls[0]!.value).toBe(plan.humanValue);
    // Guaranteed cleanup removes the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-stale local rejection as a real failure (scenario-error)", async () => {
    // A rejected local write is an expected stale conflict ONLY on exact
    // CAS/stale evidence. A non-stale (validation/transport) rejection is a
    // real failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.em = em;
    // The 2nd flush is the delete+recreate loop's first commit; it rejects
    // with a non-stale transport code.
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

  it("cannot finish ok when the human edit targets the wrong generation (identity_shifted)", async () => {
    // The direct client's identity-shift guard rejects the human edit with
    // the stable `identity_shifted` class when the value landed on the wrong
    // identity (the tombstoned old generation). That is NOT stale-write/CAS
    // evidence, so the scenario must fail (never a verified ok) — a human edit
    // applied to the wrong lifecycle generation is never silently accepted.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnMutateCall = { index: 1, code: "identity_shifted" };
    const result = await scenario.execute({
      plan,
      context: liveContext(plan, client, em, Date.now() + 120),
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
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

  it("classifies duplicate final rows as a failed reactivation invariant", async () => {
    // The reactivation must leave EXACTLY one final row for the id. When the
    // authority shows MORE than one row (duplicate residue), the invariant is
    // violated and the scenario must classify it as a real failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    em.findResultsOverride = (id) => {
      if (id === plan.target.targetId) {
        return [{ id: plan.target.targetId }, { id: plan.target.targetId }]; // duplicate residue
      }
      return undefined;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Guaranteed cleanup removes every dedicated race row.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a missing final row as a failed reactivation invariant", async () => {
    // A MISSING row is as much a failure as a duplicate: the delete/recreate
    // must leave exactly one final row, and a lost row violates that too.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    em.findResultsOverride = (id) => {
      if (id === plan.target.targetId) return []; // row lost by the authority
      return undefined;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Cleanup can only remove rows the authority actually reports (it calls
    // the same `find`), so a row the authority no longer sees stays in the
    // store — the module removes only what it finds.
    expect(em.rows().length).toBe(1);
  });
});
