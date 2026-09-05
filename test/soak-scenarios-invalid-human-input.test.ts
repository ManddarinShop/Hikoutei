/**
 * Offline tests for the `invalidHumanInput` soak scenario, driven against
 * fake public seams (a fake direct-Sheet client and a fake EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the bounded observation polls shortened so the settle/rejection
 * logic runs fast and deterministically. Only the PR2 scenario module is
 * imported; the other attack-scenario modules are deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as invalidHumanInput from "../scripts/ci/local-soak/scenarios/invalidHumanInput.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { FakeEm, liveContext } from "./support/soakScenarioFixtures.js";

// Shorten the scenario's bounded observation sleeps so the poll/settle loops
// terminate quickly and deterministically (a real poll would be ~1s each).
vi.mock("../scripts/ci/local-soak/timing.mjs", () => ({
  boundedSleep: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  },
}));

/** The one scenario module under test. */
const scenarioInput = invalidHumanInput;

/** Builds a deterministic plan targeting an entity in the active subset. */
function buildPlan(seed: number, cycle = 1, order = 0): PlanLike {
  const input: Record<string, unknown> = {
    cycle,
    order,
    rng: new SeededRandom(seed),
    activeEntities: SOAK_ENTITY_ORDER,
  };
  return scenarioInput.plan(input as Parameters<typeof scenarioInput.plan>[0]) as unknown as PlanLike;
}

interface PlanLike {
  tag: string;
  invalid: string;
  restore: string;
  target: { entityName: string; field: string; targetId: string };
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------


/** A fake direct-Sheet client backed by in-memory tab state. */
class FakeClient {
  private tabs = new Map<string, { headers: string[]; rows: Map<string, unknown[]> }>();
  mutateCalls: { identity: string; headerName: string; value: string }[] = [];
  /** When set, the 1-based mutate call at this index throws. */
  throwOnMutateCall: number | undefined;
  /** Stable code attached to the thrown mutate error (when set). */
  throwOnMutateCode: string | undefined;
  /** When set, every readTabRows call throws this error (a read failure). */
  throwOnRead: Error | undefined;
  /** When true, mutateInputCell records but does not write the cell. */
  noOpMutate = false;

  ensureTab(tabName: string, headers: string[]): void {
    this.tabs.set(tabName, { headers, rows: new Map() });
  }

  setCell(tabName: string, identity: string, values: Record<string, string>): void {
    const tab = this.tabs.get(tabName);
    if (tab === undefined) throw new Error(`no tab ${tabName}`);
    tab.rows.set(identity, tab.headers.map((header) => values[header]));
  }

  async readTabRows(_spreadsheetId: string, tabName: string): Promise<unknown[][]> {
    if (this.throwOnRead !== undefined) throw this.throwOnRead;
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
    if (this.throwOnMutateCall !== undefined && this.mutateCalls.length === this.throwOnMutateCall) {
      throw this.throwOnMutateCode === undefined
        ? new Error("fake mutate failure")
        : Object.assign(new Error("fake mutate failure"), { code: this.throwOnMutateCode });
    }
    if (this.noOpMutate) return { rowNumber: 1 };
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { rowNumber: 1 };
    const index = tab.headers.indexOf(input.headerName);
    const row = tab.rows.get(input.identity);
    if (row !== undefined && index >= 0) row[index] = input.value;
    return { rowNumber: 1 };
  }
}


/** Registers the dedicated row in a fake _Input tab at a projected value. */
function projectRow(
  client: FakeClient,
  plan: { target: { entityName: string; field: string; targetId: string } },
): void {
  const tabName = `${plan.target.entityName}_Input`;
  client.ensureTab(tabName, ["id", plan.target.field]);
  client.setCell(tabName, plan.target.targetId, {
    id: plan.target.targetId,
    [plan.target.field]: "projected-cell",
  });
}

/** Mirrors the scenario's `toCellString` so the fake cell holds the exact
 * cell-string the authority row would project to the Sheet. */
function toCellStringForTest(value: unknown, spec: { type: string }): string {
  if (value === null || value === undefined) return "";
  if (spec.type === "date") return value instanceof Date ? value.toISOString() : String(value);
  if (spec.type === "boolean") return value === true ? "true" : "false";
  return String(value);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("invalidHumanInput scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((scenario) => scenario.id);
    expect(ids).toContain("invalid-human-input");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenarioInput.id).toBe("invalid-human-input");
    expect(scenarioInput.kind).toBe("data");
    expect(Array.isArray(scenarioInput.allowedPhases)).toBe(true);
    expect(scenarioInput.TAG).toBe("invalid-required-input");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("invalid-required-input");
    // The target is a real entity, the field a non-primary candidate field.
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    const spec = SOAK_FIELD_PLANS[plan.target.entityName]?.[plan.target.field];
    expect(spec).toBeDefined();
    expect(spec!.primary).not.toBe(true);
    expect(plan.target.targetId).toMatch(/^invalid-/);
    expect(typeof plan.invalid).toBe("string");
    expect(typeof plan.restore).toBe("string");
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = buildPlan(1);
    const context = {
      seed: 1,
      cycle: 1,
      activeEntities: [], // none active -> the entity is not expected
      tokenByEntity: new Map([[plan.target.entityName, { entity: plan.target.entityName }]]),
      em: new FakeEm(),
      live: { mode: "live", client: new FakeClient(), spreadsheetId: "spreadsheet-1" },
      deadlineAtMs: Date.now() + 5000,
    };
    const result = await scenarioInput.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("local-mode");
  });

it("classifies a provable rejection as ok with one expected error and cleans up", async () => {
    const plan = buildPlan(7);
    const client = new FakeClient();
    const em = new FakeEm();
    // Project the fake cell to the AUTHORITATIVE value the row will actually
    // carry (what the Sheet shows once the sync worker projects the row) —
    // not an arbitrary literal. The scenario persists its dedicated row
    // first and restores the cell to that row's pre-injection field value
    // (its "prior"), so the restore must return the cell to that exact
    // authoritative value. Hook persist to capture and project that value,
    // then assert the restored cell equals it exactly — not merely to
    // something that differs from the invalid value.
    const spec = (plan as unknown as { fieldSpec: { type: string } }).fieldSpec;
    let authoritativeValue: string | undefined;
    const originalPersist = em.persist.bind(em);
    em.persist = (entity: Record<string, unknown>) => {
      const projected = toCellStringForTest(entity[plan.target.field], spec);
      authoritativeValue = projected;
      client.ensureTab(`${plan.target.entityName}_Input`, ["id", plan.target.field]);
      client.setCell(`${plan.target.entityName}_Input`, plan.target.targetId, {
        id: plan.target.targetId,
        [plan.target.field]: projected,
      });
      originalPersist(entity);
    };
    const result = await scenarioInput.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.expectedErrors).toBe(1);
    expect(result.failures).toBe(0);
    // Guaranteed cleanup: the dedicated row is removed and the cell restored
    // to its exact pre-injection authoritative value.
    expect(em.rows()).toEqual([]);
    const calls = client.mutateCalls.filter((call) => call.identity === plan.target.targetId);
    expect(calls.length).toBe(2);
    expect(calls[0]!.value).toBe(plan.invalid);
    expect(authoritativeValue).toBeDefined();
    expect(calls[1]!.value).toBe(authoritativeValue);
    // The restored cell equals the exact pre-mutation original value AND the
    // final cell state.
    const cells = await client.readTabRows("spreadsheet-1", `${plan.target.entityName}_Input`);
    const headers = cells[0]!;
    const idColumn = headers.indexOf("id");
    const fieldColumn = headers.indexOf(plan.target.field);
    const projectedRow = cells.find((entry, index) => index > 0 && entry[idColumn] === plan.target.targetId);
    expect(projectedRow).toBeDefined();
    expect(projectedRow![fieldColumn]).toBe(authoritativeValue);
  });

  it("classifies a silently accepted invalid value as failed (corruption)", async () => {
    // A hand-built plan over a STRING field so `toCellString` round-trips the
    // injected invalid value exactly (a boolean field would always render as
    // true/false and never equal a foreign invalid literal).
    const plan = {
      tag: "invalid-required-input",
      jitterMs: 1,
      target: { entityName: "SoakCustomer", field: "tier", targetId: "invalid-cust-c1-0" },
      fieldSpec: { type: "string", primary: false, nullable: false },
      invalid: "",
      restore: "amber-1",
    };
    const client = new FakeClient();
    projectRow(client, plan as unknown as PlanLike);
    const em = new FakeEm();
    // The authority shows the invalid (empty) value: an accepted corruption
    // edit that reaches the authority.
    em.findOneOverride = (id) => {
      const row = em.store.get(id);
      return row ? { ...row, [plan.target.field]: plan.invalid } : null;
    };
    const result = await scenarioInput.execute({ plan, context: liveContext(plan as unknown as PlanLike, client, em) });
    expect(result.status).toBe("failed");
    expect(result.failures).toBe(1);
    expect(result.reason).toBe("invalid-accepted");
    expect(em.rows()).toEqual([]);
  });

  it("skips truthfully when the dedicated row's projection never appears (gating)", async () => {
    const plan = buildPlan(9);
    const client = new FakeClient();
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", plan.target.field]);
    const em = new FakeEm();
    const context = liveContext(plan, client, em, Date.now() + 60); // short gating window
    const result = await scenarioInput.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("projection-not-ready");
    // No invalid write was ever attempted.
    expect(client.mutateCalls).toEqual([]);
    // The dedicated row is still removed in cleanup.
    expect(em.rows()).toEqual([]);
  });

  it("skips when the invalid edit cannot be observed on the sheet (no evidence)", async () => {
    const plan = buildPlan(5);
    const client = new FakeClient();
    projectRow(client, plan);
    client.noOpMutate = true; // the sheet never reflects the invalid write
    const em = new FakeEm();
    const result = await scenarioInput.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("sheet-evidence-unavailable");
    // The invalid write was attempted, then the guaranteed cleanup restore.
    expect(client.mutateCalls.length).toBe(2);
    expect(client.mutateCalls[0]!.value).toBe(plan.invalid);
    expect(em.rows()).toEqual([]);
  });

  it("records an identity-shifted invalid-write rejection as a transient skip, not a failure", async () => {
    // The direct client's identity-shift guard rejects the invalid write
    // with the stable `identity_shifted` class when a CONCURRENT actor
    // shifted the tab mid-write. The seam proved no silent success, so the
    // scenario records a truthful transient skip (never a failure); the
    // guaranteed restore/cleanup still run.
    const plan = buildPlan(7);
    const client = new FakeClient();
    const em = new FakeEm();
    projectRow(client, plan);
    client.throwOnMutateCall = 1;
    client.throwOnMutateCode = "identity_shifted";
    const result = await scenarioInput.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity-shifted-transient");
    expect(result.failures).toBe(0);
    // The restore was still attempted (write was attempted) and the
    // dedicated authority row is removed in cleanup.
    expect(client.mutateCalls.length).toBe(2);
    expect(em.rows()).toEqual([]);
  });

  it("records a readTabRows rejection as failed, never a transient skip", async () => {
    // Narrowed transient scope: ONLY the direct `mutateInputCell`
    // rejection may classify as `identity-shifted-transient`. A read
    // rejection — even one duck-typed with `code: "identity_shifted"` —
    // rethrows to the normal failure path.
    const plan = buildPlan(7);
    const client = new FakeClient();
    const em = new FakeEm();
    projectRow(client, plan);
    client.throwOnRead = Object.assign(new Error("fake read failure"), {
      code: "identity_shifted",
    });
    const result = await scenarioInput.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // The dedicated authority row is still removed in cleanup.
    expect(em.rows()).toEqual([]);
  });

  it("guarantees independent cleanup: a failed cell restore still removes the row", async () => {
    const plan = buildPlan(3);
    const client = new FakeClient();
    projectRow(client, plan);
    // The 2nd mutate (the restore) throws; the 1st (the invalid write) lands.
    client.throwOnMutateCall = 2;
    const em = new FakeEm();
    const result = await scenarioInput.execute({ plan, context: liveContext(plan, client, em) });
    // The restore failure turns the (otherwise ok) result into a failed
    // record with one cleanup failure, but the row removal still ran.
    expect(result.status).toBe("failed");
    expect(result.cleanupFailures).toBe(1);
    expect(result.failures).toBe(1);
    expect(em.rows()).toEqual([]);
  });

  it("records cleanup-outbox-busy and keeps the row when the binding outbox never drains", async () => {
    // The invalid write is provably rejected (an ok verdict), but a
    // candidate effect for the binding is stuck in flight past the bounded
    // drain wait. The row must be KEPT — never deleted through a blocked
    // outbox — with the distinct stable kind as a real failure.
    const plan = buildPlan(7);
    const client = new FakeClient();
    const em = new FakeEm();
    // Mirror the provable-rejection ok test: persist projects the
    // authoritative value so the rejection observation settles.
    const spec = (plan as unknown as { fieldSpec: { type: string } }).fieldSpec;
    const originalPersist = em.persist.bind(em);
    em.persist = (entity: Record<string, unknown>) => {
      const projected = toCellStringForTest(entity[plan.target.field], spec);
      client.ensureTab(`${plan.target.entityName}_Input`, ["id", plan.target.field]);
      client.setCell(`${plan.target.entityName}_Input`, plan.target.targetId, {
        id: plan.target.targetId,
        [plan.target.field]: projected,
      });
      originalPersist(entity);
    };
    const context = {
      ...liveContext(plan, client, em, Date.now() + 400),
      queryOutboxInflightCount: async () => 1,
    };
    const result = await scenarioInput.execute({ plan, context });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("recovery-not-observed");
    expect(result.failures).toBe(1);
    expect(result.cleanupFailures).toBe(1);
    expect(result.failureKinds).toEqual(["cleanup-outbox-busy"]);
    expect(em.rows().length).toBe(1);
  });
});
