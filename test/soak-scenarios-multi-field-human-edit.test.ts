/**
 * Offline tests for the `multiFieldHumanEdit` soak scenario, driven against
 * fake public seams (a fake direct-Sheet client and a fake EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the bounded observation polls shortened so the settle/rejection
 * logic runs fast and deterministically. Only the `multiFieldHumanEdit`
 * scenario module is imported; the other attack-scenario modules are
 * deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as multiFieldHumanEdit from "../scripts/ci/local-soak/scenarios/multi-field-human-edit.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";

// Shorten the scenario's bounded observation sleeps so the poll/settle loops
// terminate quickly and deterministically (a real poll would be ~1s each).
// Poll/settle sleeps (1000 ms) are capped to keep loops fast; the barrier
// jitter sleep (small ms) respects the deadline so the deadline-expired path
// (the jitter sleep ending exactly at the run deadline) stays deterministic.
vi.mock("../scripts/ci/local-soak/timing.mjs", () => ({
  boundedSleep: async (ms: number, deadline?: number) => {
    const remaining = deadline === undefined ? ms : Math.max(0, deadline - Date.now());
    const cap = ms >= 1000 ? 5 : ms;
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, remaining, cap)));
  },
}));

/** The one scenario module under test. */
const scenario = multiFieldHumanEdit;

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
  humanFields: string[];
  humanValues: Record<string, string>;
  target: { entityName: string; field: string; targetId: string };
}

/** A deterministic plan over the two string fields of SoakCustomer. */
function racePlan(overrides: Partial<PlanLike> = {}): PlanLike {
  return {
    tag: "multi-field-human-edit",
    jitterMs: 1,
    humanFields: ["name", "tier"],
    humanValues: { name: "human-multi-c1-0-name", tier: "human-multi-c1-0-tier" },
    target: { entityName: "SoakCustomer", field: "active", targetId: "multi-cust-c1-0" },
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
  mutateCalls: { identity: string; fields: Record<string, string> }[] = [];
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

  async mutateInputCells(input: {
    tabName: string;
    identity: string;
    fields: Record<string, string>;
  }): Promise<{ rowNumber: number }> {
    this.mutateCalls.push({ identity: input.identity, fields: input.fields });
    if (this.throwOnMutateCall !== undefined && this.mutateCalls.length === this.throwOnMutateCall.index) {
      const error = Object.assign(new Error("fake mutate failure"), {
        code: this.throwOnMutateCall.code,
      });
      throw error;
    }
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { rowNumber: 1 };
    const row = tab.rows.get(input.identity);
    if (row !== undefined) {
      for (const [header, value] of Object.entries(input.fields)) {
        const index = tab.headers.indexOf(header);
        if (index >= 0) row[index] = value;
      }
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
 * the fake EntityManager's `persist` so the dedicated race row's human
 * fields are projected into the fake _Input tab at the exact cell-strings
 * the row will carry once the sync worker projects it. `awaitInputProjection`
 * resolves on the first poll, so the race proceeds deterministically.
 */
function projectPersistedRow(em: FakeEm, client: FakeClient, plan: PlanLike): void {
  const originalPersist = em.persist.bind(em);
  em.persist = (entity: Record<string, unknown>) => {
    const headers = ["id", ...plan.humanFields];
    const values: Record<string, string> = { id: plan.target.targetId };
    for (const field of plan.humanFields) {
      const value = entity[field];
      values[field] = value === null || value === undefined ? "" : String(value);
    }
    client.ensureTab(`${plan.target.entityName}_Input`, headers);
    client.setCell(`${plan.target.entityName}_Input`, plan.target.targetId, values);
    originalPersist(entity);
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("multiFieldHumanEdit scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("multi-field-human-edit");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("multi-field-human-edit");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("multi-field-human-edit");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("multi-field-human-edit");
    expect(plan.jitterMs).toBeGreaterThan(0);
    // The target is a real entity.
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    // The human edits 2+ non-primary STRING fields.
    expect(plan.humanFields.length).toBeGreaterThanOrEqual(2);
    for (const field of plan.humanFields) {
      const spec = SOAK_FIELD_PLANS[plan.target.entityName]?.[field];
      expect(spec).toBeDefined();
      expect(spec!.primary).not.toBe(true);
      expect(spec!.type).toBe("string");
    }
    // The public field is a DISTINCT non-primary field (never one of the
    // human fields), so the race is a public update of one field against a
    // human multi-field edit of the others.
    expect(plan.humanFields).not.toContain(plan.target.field);
    const publicSpec = SOAK_FIELD_PLANS[plan.target.entityName]?.[plan.target.field];
    expect(publicSpec).toBeDefined();
    expect(publicSpec!.primary).not.toBe(true);
    // A deterministic human value set, one per human field.
    for (const field of plan.humanFields) {
      expect(plan.humanValues[field]).toMatch(/^human-multi-/);
    }
    expect(plan.target.targetId).toMatch(/^multi-/);
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

  it("never picks an inactive entity when the active subset has no eligible one", async () => {
    // SoakFeatureFlag has only ONE non-primary string field, so it cannot
    // host a multi-field edit. When the active subset is ONLY that entity,
    // the plan must NOT fall back to an inactive entity (SOAK_ENTITY_ORDER[0]
    // SoakCustomer); it keeps a deterministic plan over the active subset
    // marked ineligible and execute truthfully skips.
    const activeOnly = SOAK_ENTITY_ORDER.filter((entry) => entry.name === "SoakFeatureFlag");
    const input: Record<string, unknown> = {
      cycle: 1,
      order: 0,
      rng: new SeededRandom(7),
      activeEntities: activeOnly,
    };
    const plan = scenario.plan(input as Parameters<typeof scenario.plan>[0]) as unknown as PlanLike & {
      eligible?: boolean;
    };
    expect(plan.eligible).toBe(false);
    // The plan targets ONLY the active subset, never an inactive entity.
    expect(activeOnly.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    const client = new FakeClient();
    const em = new FakeEm();
    const context = {
      seed: 1,
      cycle: 1,
      activeEntities: activeOnly,
      tokenByEntity: new Map([[plan.target.entityName, { entity: plan.target.entityName }]]),
      em,
      live: { mode: "live", client, spreadsheetId: "spreadsheet-1" },
      deadlineAtMs: Date.now() + 5000,
    };
    const result = await scenario.execute({ plan: plan as PlanLike, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no-eligible-entity");
    expect(result.failures).toBe(0);
    // No direct write was ever attempted.
    expect(client.mutateCalls).toEqual([]);
  });

  it("verifies an atomic multi-field human edit when all fields land (ok)", async () => {
    // Core hypothesis: a human multi-field edit must be applied atomically —
    // never partially, never with a field silently lost. When the authority
    // observes ALL human fields landing after the race, the scenario must
    // report a verified ok.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The authority observes ALL human fields landing on the raced row (the
    // human edit applied atomically), across the settle-threshold polls.
    em.findOneOverride = (id) => {
      const row = em.store.get(id);
      return row ? { ...row, ...plan.humanValues } : null;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    // Multi-field atomicity: ALL human fields were written in ONE call.
    const calls = client.mutateCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(1);
    expect(Object.keys(calls[0]!.fields).sort()).toEqual([...plan.humanFields].sort());
    for (const field of plan.humanFields) {
      expect(calls[0]!.fields[field]).toBe(plan.humanValues[field]);
    }
    // Guaranteed cleanup removes the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("waits for a delayed observation to land before cleanup removes the accepted row", async () => {
    // A human multi-field write is ACCEPTED but the inbound observation lands
    // only after a few authority reads (the async worker is slower than the
    // race). The scenario must observe the delayed landing (not declare
    // silent loss prematurely) and only then clean up the dedicated row, so
    // the delete is ordered after the observation result is terminal.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The authority carries the base row for the first several reads (the
    // observation has not landed yet), then the human fields land.
    let reads = 0;
    em.findOneOverride = (id) => {
      reads += 1;
      const row = em.store.get(id);
      if (row === undefined) return null;
      return reads >= 4 ? { ...row, ...plan.humanValues } : row;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    // The delayed landing is observed (never declared silent loss), so the
    // scenario verifies the race winner.
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("race-winner-verified");
    expect(result.failures).toBe(0);
    // Cleanup removed the dedicated row only after the observation settled.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-stale human multi-field rejection as a real failure", async () => {
    // A rejected human multi-field write is an expected stale conflict ONLY
    // on exact CAS/stale evidence. A non-stale (transport) rejection is a
    // real failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnMutateCall = { index: 1, code: "google_sheets_api_timeout" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em, Date.now() + 30) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBeGreaterThanOrEqual(1);
    // The human write STARTED and rejected with a non-stale code, so its
    // remote outcome is uncertain (it may have mutated before rejecting). The
    // cleanup must NOT delete the row without complete landing proof; when the
    // proof times out the row is left in place and surfaced as a cleanup
    // failure (the #381 race).
    expect(em.rows().length).toBe(1);
    expect(result.cleanupFailures).toBeGreaterThan(0);
  });

  it("cannot finish ok when the human multi-field write detects an identity shift", async () => {
    // The direct client's identity-shift guard rejects the human write with
    // the stable `identity_shifted` class when a value landed on the wrong
    // identity. That is NOT stale-write/CAS evidence, so the scenario must
    // fail (never a verified race-winner ok) — a collateral write is never
    // silently accepted.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnMutateCall = { index: 1, code: "identity_shifted" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em, Date.now() + 30) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBeGreaterThanOrEqual(1);
    // The human write STARTED and rejected with `identity_shifted`, so its
    // remote outcome is uncertain (a value may have landed on the wrong
    // identity). The cleanup must NOT delete the row without complete landing
    // proof; when the proof times out the row is left in place and surfaced as
    // a cleanup failure (the #381 race).
    expect(em.rows().length).toBe(1);
    expect(result.cleanupFailures).toBeGreaterThan(0);
  });

  it("skips truthfully when the dedicated row's projection never appears (gating)", async () => {
    const plan = racePlan();
    const client = new FakeClient();
    // The tab exists but the dedicated row is never projected into it.
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", ...plan.humanFields]);
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

  it("leaves the accepted row in place when the settle proof times out (no tombstone race)", async () => {
    // The guaranteed finally removes the dedicated race row even when the
    // public-API update's commit rejects with a non-stale transport code
    // (a scenario-error). BUT an ACCEPTED human write whose observation is
    // never confirmed must NOT be deleted when the settle proof times out:
    // deleting would tombstone the binding under an in-flight inbound
    // observation (the #381 race). The leftover row is surfaced as a cleanup
    // failure instead of being silently removed.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The 2nd flush is the local update's commit; it rejects with a non-stale
    // transport code -> scenario-error (and makes observeHumanFields settle
    // quickly on "not-applied").
    em.flushBehavior = (index) => {
      if (index === 2) {
        throw Object.assign(new Error("fake transport failure"), {
          code: "google_sheets_api_network_error",
        });
      }
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em, Date.now() + 30) });
    expect(result.status).toBe("failed");
    expect(result.failures).toBeGreaterThanOrEqual(1);
    // The accepted human write was never confirmed landed, so the settle proof
    // times out and the row is NOT deleted; the leftover row is surfaced as a
    // cleanup failure.
    expect(em.rows().length).toBe(1);
    expect(result.cleanupFailures).toBeGreaterThan(0);
  });

  it("deletes the accepted row once the observation lands during the settle window", async () => {
    // The observation lands only AFTER observeHumanFields gave up (during the
    // settle window), so the cleanup delete is ordered after terminal landing
    // evidence. The accepted row is still removed once the settle window
    // produced durable/complete proof.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The local update's commit fails (alreadyFailed > 0), so observeHumanFields
    // settles on "not-applied" after a couple reads; the human write is
    // accepted but its observation lands only during the settle window.
    em.flushBehavior = (index) => {
      if (index === 2) {
        throw Object.assign(new Error("fake transport failure"), {
          code: "google_sheets_api_network_error",
        });
      }
    };
    let reads = 0;
    em.findOneOverride = (id) => {
      reads += 1;
      const row = em.store.get(id);
      if (row === undefined) return null;
      // The observation lands only after observeHumanFields gave up (during
      // the settle window), so the cleanup delete is ordered after terminal
      // landing evidence.
      return reads >= 4 ? { ...row, ...plan.humanValues } : row;
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em, Date.now() + 30) });
    // The scenario already failed (local update transport failure + silent-loss
    // classification), but the accepted row is still deleted once the settle
    // window produced terminal landing evidence.
    expect(result.status).toBe("failed");
    expect(em.rows()).toEqual([]);
  });

  it("leaves the row in place when a STARTED human write rejects after remote mutation (no tombstone race)", async () => {
    // A human write that STARTED but was rejected with stale/CAS evidence may
    // still have mutated the remote Sheet before rejecting. The remote outcome
    // is uncertain, so the cleanup must NOT delete the dedicated row without
    // complete consecutive landing proof; when the proof times out the row is
    // left in place and surfaced as a cleanup failure (the #381 race).
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The human write starts and rejects with EXACT stale-write/CAS evidence
    // (an expected conflict, not a failure), but the remote outcome is
    // uncertain: it may have mutated before rejecting.
    client.throwOnMutateCall = { index: 1, code: "visible_guard_mismatch" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em, Date.now() + 30) });
    // The rejection is expected stale evidence, so the scenario itself does
    // not fail; the winner is not verified. The cleanup failure is recorded
    // separately (cleanupFailures) and never masks the original outcome.
    expect(result.cleanupFailures).toBeGreaterThan(0);
    // The started-but-rejected write's remote outcome is uncertain, so the row
    // is NOT deleted when the settle proof times out; it is surfaced as a
    // cleanup failure.
    expect(em.rows().length).toBe(1);
  });

  it("leaves the row in place when a partial landing never completes (no tombstone race)", async () => {
    // A partial inbound state can precede later field landing: some human
    // fields landed but others have not yet. Deleting now would tombstone the
    // binding under an in-flight observation (the #381 race). The cleanup must
    // require complete consecutive landing proof; when the remaining fields
    // never land the row is left in place and surfaced as a cleanup failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // Only ONE of the two human fields ever lands (a partial application that
    // never completes).
    em.findOneOverride = (id) => {
      const row = em.store.get(id);
      if (row === undefined) return null;
      return { ...row, name: plan.humanValues.name };
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em, Date.now() + 30) });
    // A partial application is a failure.
    expect(result.status).toBe("failed");
    expect(result.failures).toBeGreaterThanOrEqual(1);
    // The partial landing never completed, so the row is NOT deleted and is
    // surfaced as a cleanup failure.
    expect(em.rows().length).toBe(1);
    expect(result.cleanupFailures).toBeGreaterThan(0);
  });

  it("rejects a projection read that resolves after the phase deadline (no write)", async () => {
    // The projection readiness read can resolve after the scenario/phase
    // deadline (a slow request that began just before it). A projection
    // observed only after the deadline is never actionable within the active
    // phase, so the scenario must NOT accept it and must never start the human
    // write (a truthful projection-not-ready skip).
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The projection read is slow: it resolves only after the phase deadline
    // with the row present.
    const originalRead = client.readTabRows.bind(client);
    client.readTabRows = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalRead(...args);
    };
    const context = liveContext(plan, client, em, Date.now() + 5);
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("projection-not-ready");
    // No human write was ever attempted against a post-deadline projection.
    expect(client.mutateCalls).toEqual([]);
    // The dedicated row is still removed in cleanup (the write never started).
    expect(em.rows()).toEqual([]);
  });

  it("reports a truthful deadline-expired skip, never silent loss, when the human write never starts", async () => {
    // The run deadline expires during the barrier jitter, so the direct human
    // write never starts. The scenario must NOT report silent loss for a write
    // that never ran; it reports a truthful deadline-expired skip. The jitter
    // is long enough that the projection readiness completes first, then the
    // bounded jitter sleep ends exactly at the deadline.
    const plan = racePlan({ jitterMs: 50 });
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em, Date.now() + 20) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("deadline-expired");
    expect(result.failures).toBe(0);
    // No human write was ever attempted against an expired budget.
    expect(client.mutateCalls).toEqual([]);
    // The dedicated row is still cleaned up (the local update ran; the human
    // write never started, so there is no in-flight observation to protect).
    expect(em.rows()).toEqual([]);
  });
});
