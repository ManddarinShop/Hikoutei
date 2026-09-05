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
import { SYSTEM_WINS_RESOLVE_SUFFIX } from "../scripts/ci/local-soak/errors.mjs";
import { FakeEm, liveContext, projectHumanFieldsRow as projectPersistedRow } from "./support/soakScenarioFixtures.js";

// Shorten the scenario's bounded observation sleeps so the poll/settle loops
// terminate quickly and deterministically (a real poll would be ~1s each).
// Poll/settle sleeps (1000 ms) are capped to keep loops fast; the barrier
// jitter sleep (small ms) respects the deadline so the deadline-expired path
// (the jitter sleep ending exactly at the run deadline) stays deterministic.
// The real timing helpers (including the clock-slop deadline check the
// scenario imports) are preserved; only boundedSleep is stubbed.
vi.mock("../scripts/ci/local-soak/timing.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripts/ci/local-soak/timing.mjs")>()),
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
    // Stable diagnostic kinds: the non-stale human rejection and the cleanup
    // settle-proof timeout that left the row in place.
    expect(result.failureKinds).toEqual(
      expect.arrayContaining(["human-rejection-non-stale", "cleanup-proof-timeout"]),
    );
    // The human write STARTED and rejected with a non-stale code, so its
    // remote outcome is uncertain (it may have mutated before rejecting). The
    // cleanup must NOT delete the row without complete landing proof; when the
    // proof times out the row is left in place and surfaced as a cleanup
    // failure (the #381 race).
    expect(em.rows().length).toBe(1);
    expect(result.cleanupFailures).toBeGreaterThan(0);
  });

  it("records an identity-shifted human multi-field rejection as a transient skip, not a failure", async () => {
    // The direct client's identity-shift guard rejects the human write with
    // the stable `identity_shifted` class when a CONCURRENT actor shifted
    // the tab mid-write. The seam proved no silent success, so this is an
    // EXPECTED TRANSIENT of the adversarial multi-writer environment: a
    // truthful skip (never a failure). The value itself landed late (the
    // worker applies it after the unprovable write), so the settle proof
    // succeeds and the guaranteed cleanup still removes the dedicated row.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnMutateCall = { index: 1, code: "identity_shifted" };
    // Simulate the delayed inbound application: the human fields land in
    // the authority on the local update's commit flush (the value was
    // written remotely but its landing on the intended identity could not
    // be proven by the seam's postcondition read).
    em.flushBehavior = (index) => {
      if (index === 2) {
        const row = em.store.get(plan.target.targetId);
        if (row !== undefined) Object.assign(row, plan.humanValues);
      }
    };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity-shifted-transient");
    expect(result.failures).toBe(0);
    // The landing proof completes, so the guaranteed cleanup removes the row.
    expect(em.rows()).toEqual([]);
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

  it("accepts OPEN sync_conflicts carrying the human values as conflict-recorded (ok)", async () => {
    // Core harness fix: when an outbox effect for the binding is in flight,
    // the poll gate deliberately skips the row and the human edit is
    // ingested only after the effect cycle completes — as OPEN conflicts.
    // A row-only observation would misclassify that as silent loss; the
    // conflict-recorded outcome is consistent (apply atomically OR record
    // as a conflict), so it must report ok with 0 failures.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // The authority NEVER shows the human values (the row is skipped while
    // the effect is in flight), but the ingestion completed as OPEN
    // sync_conflicts carrying the exact human values. Records clear per
    // field once the cleanup's system-wins advance lands on it, modeling
    // the worker applying each acknowledge_system resolution.
    const closesPerField = async () => plan.humanFields
      .filter((field) => {
        const value = em.store.get(plan.target.targetId)?.[field];
        return !(typeof value === "string" && value.endsWith(SYSTEM_WINS_RESOLVE_SUFFIX));
      })
      .map((field) => ({
        fieldName: field,
        userValue: plan.humanValues[field],
        status: "OPEN",
      }));
    const oracleMutations: unknown[] = [];
    const context = {
      ...liveContext(plan, client, em, Date.now() + 300),
      oracle: { applyMutation: (mutation: unknown) => oracleMutations.push(mutation) },
      queryConflictRows: closesPerField,
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("conflict-recorded");
    expect(result.failures).toBe(0);
    expect(result.expectedErrors).toBe(0);
    // The conflict-recorded outcome carries no failure kinds.
    expect(result.failureKinds).toBeUndefined();
    // The resolve-then-delete cleanup removed the dedicated row and mirrored
    // the delete into the oracle (never deleted through OPEN conflicts).
    expect(em.rows()).toEqual([]);
    expect(oracleMutations).toContainEqual({
      op: "delete",
      entity: plan.target.entityName,
      id: plan.target.targetId,
    });
  });

  it("accepts a mixed outcome: one field landed, the other conflict-recorded (ok)", async () => {
    // All human values accounted — one landed in the row, the other recorded
    // as an OPEN conflict — is the consistent outcome, never partial loss.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    // Only the first human field ever lands in the authority: seed it right
    // after the dedicated row is created, so every read observes the partial
    // landing through live refs (no findOne copy that would hide the
    // cleanup's resolve advance from the conflict stub).
    const landedField = plan.humanFields[0]!;
    const recordedField = plan.humanFields[1]!;
    em.flushBehavior = (index) => {
      if (index === 1) {
        em.store.get(plan.target.targetId)![landedField] = plan.humanValues[landedField];
      }
    };
    const context = {
      ...liveContext(plan, client, em, Date.now() + 300),
      queryConflictRows: async () => {
        const value = em.store.get(plan.target.targetId)?.[recordedField];
        const resolved = typeof value === "string" && value.endsWith(SYSTEM_WINS_RESOLVE_SUFFIX);
        return resolved ? [] : [{
          fieldName: recordedField,
          userValue: plan.humanValues[recordedField],
          status: "OPEN",
        }];
      },
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("ok");
    expect(result.reason).toBe("conflict-recorded");
    expect(result.failures).toBe(0);
    expect(em.rows()).toEqual([]);
  });

  it("records cleanup-unresolved-conflict and keeps the row when the conflicts never clear", async () => {
    // The resolve-then-delete cleanup advances every human field, but the
    // conflict records never leave the blocking state within the bound. The
    // row must be KEPT — never deleted through blocking conflicts — and the
    // distinct stable kind recorded as a real failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const context = {
      ...liveContext(plan, client, em, Date.now() + 60),
      queryConflictRows: async () => plan.humanFields.map((field) => ({
        fieldName: field,
        userValue: plan.humanValues[field],
        status: "OPEN",
      })),
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("conflict-recorded");
    expect(result.failures).toBe(1);
    expect(result.cleanupFailures).toBe(1);
    expect(result.failureKinds).toEqual(["cleanup-unresolved-conflict"]);
    // The row is kept (never tombstoned under the blocking conflicts), and
    // the resolve attempt advanced every human field through the EM.
    expect(em.rows().length).toBe(1);
    const kept = em.store.get(plan.target.targetId);
    for (const field of plan.humanFields) {
      const value = kept?.[field];
      expect(typeof value === "string" && value.endsWith(SYSTEM_WINS_RESOLVE_SUFFIX)).toBe(true);
    }
  });

  it("still reports silent-loss when the human value is neither landed nor conflict-recorded", async () => {
    // The negative control: an ACCEPTED human write whose value never lands
    // AND has no OPEN conflict record is genuinely lost — still a failure.
    const plan = racePlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const context = {
      ...liveContext(plan, client, em, Date.now() + 120),
      queryConflictRows: async () => [],
    };
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("failed");
    expect(result.failures).toBeGreaterThanOrEqual(1);
    expect(result.failureKinds).toEqual(expect.arrayContaining(["silent-loss"]));
    // No landing and no conflict record: the settle proof times out and the
    // row is left in place (never tombstoned under an unproven outcome).
    expect(em.rows().length).toBe(1);
  });
});
