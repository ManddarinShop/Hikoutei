/**
 * Offline tests for the `sheetCorruptionDetection` soak scenario (#194),
 * driven against fake public seams (a fake direct-Sheet client and a fake
 * EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the deterministic `boundedSleep` shortened so the projection
 * wait and jitter run fast and deterministically. The scenario's pure
 * `detectCorruption` is asserted directly against hand-built corrupted
 * snapshots, and the execute detection-success path is driven through a
 * fake client whose raw injection seam produces the corrupted shapes.
 * Only the `sheetCorruptionDetection` scenario module is imported; the
 * other attack-scenario modules are deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as sheetCorruptionDetection from "../scripts/ci/local-soak/scenarios/sheetCorruptionDetection.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { FakeEm, liveContext } from "./support/soakScenarioFixtures.js";

// Shorten the scenario's bounded sleeps (projection wait polls, jitter) so
// the live action terminates quickly and deterministically (a real poll
// would be ~1s each).
vi.mock("../scripts/ci/local-soak/timing.mjs", () => ({
  boundedSleep: async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  },
}));

/** The one scenario module under test. */
const scenario = sheetCorruptionDetection;

// ---------------------------------------------------------------------------
// Plan helpers.
// ---------------------------------------------------------------------------

interface PlanLike {
  tag: string;
  jitterMs: number;
  corruptionKind: string;
  target: { entityName: string; dedicatedId: string; field: string };
}

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

/** A deterministic plan over a dedicated corruption id on SoakCustomer. */
function corruptPlan(kind: string, seed = 7): PlanLike {
  return { ...buildPlan(seed), corruptionKind: kind };
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------


/** A fake direct-Sheet client backed by in-memory tab state. */
class FakeClient {
  private tabs = new Map<string, string[][]>();
  mutateCalls: { identity: string; headerName: string; value: string }[] = [];
  /** When set, the 1-based deleteInputRowAt call at this index throws. */
  throwOnDeleteAtCall: number | undefined;
  /** When set, the 1-based mutate call at this index throws with this code. */
  throwOnMutateCall: { index: number; code: string } | undefined;
  /** When set, every readTabRows call throws this error (a read failure). */
  throwOnRead: Error | undefined;
  /** When true, reads after an injection stop surfacing the injected cells. */
  hideInjectionAfterFirstRead = false;
  private injectedWrites: { rowIndex: number; columnIndex: number; value: string }[] | null = null;
  private postInjectionReads = 0;

  ensureTab(tabName: string, headers: string[]): void {
    this.tabs.set(tabName, [headers]);
  }

  /** The identity cells of a tab's data rows (empty when the tab is absent). */
  idsOf(tabName: string): string[] {
    const rows = this.tabs.get(tabName) ?? [];
    return rows
      .slice(1)
      .map((row) => row[0])
      .filter((id): id is string => id !== undefined && id !== "");
  }

  /** Appends one projected row (headers + cells) to a tab. */
  setRow(tabName: string, cells: string[]): void {
    const tab = this.tabs.get(tabName);
    if (tab === undefined) throw new Error(`no tab ${tabName}`);
    tab.push([...cells]);
  }

  async readTabRows(_spreadsheetId: string, tabName: string): Promise<string[][]> {
    if (this.throwOnRead !== undefined) throw this.throwOnRead;
    const tab = this.tabs.get(tabName);
    if (tab === undefined) return [];
    if (this.hideInjectionAfterFirstRead && this.injectedWrites !== null) {
      this.postInjectionReads += 1;
      if (this.postInjectionReads > 1) {
        // The read seam fails to surface the injected corruption: return the
        // pre-injection view (the injected cells read back blank).
        const rows = tab.map((row) => [...row]);
        for (const write of this.injectedWrites) {
          while (rows.length <= write.rowIndex) rows.push([]);
          const row = [...(rows[write.rowIndex] ?? [])];
          while (row.length <= write.columnIndex) row.push("");
          row[write.columnIndex] = "";
          rows[write.rowIndex] = row;
        }
        return rows;
      }
    }
    return tab.map((row) => [...row]);
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
      throw Object.assign(new Error("fake mutate failure"), {
        code: this.throwOnMutateCall.code,
      });
    }
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { rowNumber: 1 };
    const headers = tab[0] ?? [];
    const idColumn = headers.indexOf("id");
    const fieldColumn = headers.indexOf(input.headerName);
    const index = tab.findIndex((row, i) => i > 0 && row[idColumn] === input.identity);
    if (index < 0) return { rowNumber: 1 };
    const row = [...(tab[index] ?? [])];
    while (row.length <= fieldColumn) row.push("");
    row[fieldColumn] = String(input.value);
    tab[index] = row;
    return { rowNumber: index + 1 };
  }

  async injectInputCells(input: {
    tabName: string;
    writes: { rowIndex: number; columnIndex: number; value: string }[];
  }): Promise<{ writes: number }> {
    this.injectedWrites = input.writes;
    this.postInjectionReads = 0;
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { writes: input.writes.length };
    for (const write of input.writes) {
      while (tab.length <= write.rowIndex) tab.push([]);
      const row = [...(tab[write.rowIndex] ?? [])];
      while (row.length <= write.columnIndex) row.push("");
      row[write.columnIndex] = String(write.value);
      tab[write.rowIndex] = row;
    }
    return { writes: input.writes.length };
  }

  async deleteInputRowAt(input: {
    tabName: string;
    rowIndex: number;
  }): Promise<{ rowNumber: number }> {
    if (this.throwOnDeleteAtCall !== undefined && this.throwOnDeleteAtCall === 1) {
      throw new Error("fake delete-at failure");
    }
    const tab = this.tabs.get(input.tabName);
    if (tab !== undefined && input.rowIndex > 0 && input.rowIndex < tab.length) {
      tab.splice(input.rowIndex, 1);
    }
    return { rowNumber: input.rowIndex + 1 };
  }

  async deleteInputRow(input: {
    tabName: string;
    identity: string;
  }): Promise<{ rowNumber: number }> {
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { rowNumber: 0 };
    const idColumn = (tab[0] ?? []).indexOf("id");
    const index = tab.findIndex((row, i) => i > 0 && row[idColumn] === input.identity);
    if (index < 0) {
      throw Object.assign(new Error("identity row not found"), { statusClass: "missing_identity" });
    }
    tab.splice(index, 1);
    return { rowNumber: index + 1 };
  }
}


/**
 * Hooks `em.persist` so every persisted row is immediately projected into
 * the fake client's _Input tab — the fake stands in for the async sync
 * worker that projects the dedicated row in a live run.
 */
function hookProjection(plan: PlanLike, client: FakeClient, em: FakeEm): void {
  const tabName = `${plan.target.entityName}_Input`;
  const headers = [
    "id",
    ...Object.keys(SOAK_FIELD_PLANS[plan.target.entityName] ?? {}).filter((field) => field !== "id"),
  ];
  client.ensureTab(tabName, headers);
  const originalPersist = em.persist.bind(em);
  em.persist = (entity: Record<string, unknown>) => {
    const id = entity.id;
    if (entity !== null && typeof entity === "object" && typeof id === "string") {
      const cells = headers.map((header) =>
        header === "id" ? id : String((entity as Record<string, unknown>)[header] ?? ""));
      client.setRow(tabName, cells);
    }
    originalPersist(entity);
  };
}

/** The ids present in a fake tab's data rows. */
function tabIds(client: FakeClient, plan: PlanLike): string[] {
  return client.idsOf(`${plan.target.entityName}_Input`);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("sheetCorruptionDetection scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("sheet-corruption-detection");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("sheet-corruption-detection");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("after-prologue");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("sheet-corruption-detection");
    expect(scenario.CORRUPTION_KINDS).toEqual([
      "duplicate-identity",
      "shifted-cell",
      "missing-field",
    ]);
    expect(typeof scenario.plan).toBe("function");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.detectCorruption).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("sheet-corruption-detection");
    expect(plan.jitterMs).toBeGreaterThan(0);
    // A dedicated corruption-target id outside the actor/prologue space, on
    // a real entity and a real non-primary non-nullable field.
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    expect(plan.target.dedicatedId).toMatch(/^corrupt-/);
    expect(scenario.CORRUPTION_KINDS).toContain(plan.corruptionKind);
    const spec = SOAK_FIELD_PLANS[plan.target.entityName]?.[plan.target.field];
    expect(spec).toBeDefined();
    expect(spec!.primary).not.toBe(true);
    expect(spec!.nullable).not.toBe(true);
  });

  it("varies the plan across different seeds", () => {
    const serialized = new Set<string>();
    for (let seed = 1; seed <= 8; seed += 1) {
      serialized.add(JSON.stringify(buildPlan(seed)));
    }
    expect(serialized.size).toBeGreaterThan(1);
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = corruptPlan("duplicate-identity");
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
});

describe("detectCorruption (pure tab-shape detector)", () => {
  const CLEAN = [
    ["id", "name", "tier", "active", "signupAt"],
    ["actor-1", "Ada", "gold", "true", "2024-01-01T00:00:00Z"],
    ["actor-2", "Bob", "silver", "false", "2024-02-01T00:00:00Z"],
  ];

  it("returns clean for a well-formed tab", () => {
    expect(scenario.detectCorruption(CLEAN)).toEqual({ status: "clean" });
    // A clean tab stays clean even with the dedicated-row scope.
    expect(
      scenario.detectCorruption(CLEAN, { identity: "actor-1", requiredFields: ["name"] }),
    ).toEqual({ status: "clean" });
  });

  it("detects a duplicate identity (kind duplicate-identity, never repaired)", () => {
    const rows = [
      ["id", "name", "tier", "active", "signupAt"],
      ["corrupt-cust-c1-0", "A", "gold", "true", "2024-01-01T00:00:00Z"],
      ["corrupt-cust-c1-0", "A", "gold", "true", "2024-01-01T00:00:00Z"],
    ];
    const verdict = scenario.detectCorruption(rows);
    expect(verdict).toEqual({
      status: "detected",
      kind: "duplicate-identity",
      detected: true,
      repaired: false,
    });
    // The verdict never returns ids or values.
    expect(JSON.stringify(verdict)).not.toContain("corrupt-");
  });

  it("detects a cell-shifted row (identity column pushed blank)", () => {
    const rows = [
      ["id", "name", "tier", "active", "signupAt"],
      ["actor-1", "Ada", "gold", "true", "2024-01-01T00:00:00Z"],
      ["", "corrupt-cust-c1-0", "A", "gold", "true", "2024-01-01T00:00:00Z"],
    ];
    const verdict = scenario.detectCorruption(rows);
    expect(verdict).toEqual({
      status: "detected",
      kind: "shifted-cell",
      detected: true,
      repaired: false,
    });
    expect(JSON.stringify(verdict)).not.toContain("corrupt-");
  });

  it("detects a missing required field on the anchored dedicated row", () => {
    const rows = [
      ["id", "name", "tier", "active", "signupAt"],
      ["corrupt-cust-c1-0", "", "gold", "true", "2024-01-01T00:00:00Z"],
    ];
    const verdict = scenario.detectCorruption(rows, {
      identity: "corrupt-cust-c1-0",
      requiredFields: ["name"],
    });
    expect(verdict).toEqual({
      status: "detected",
      kind: "missing-field",
      detected: true,
      repaired: false,
    });
    // Without the anchor scope the same snapshot is clean: the detector
    // never flags arbitrary rows (nullable fields are legitimately blank).
    expect(scenario.detectCorruption(rows)).toEqual({ status: "clean" });
  });

  it("detects missing and malformed header rows", () => {
    const missingId = [
      ["name", "tier", "active"],
      ["Ada", "gold", "true"],
    ];
    expect(scenario.detectCorruption(missingId)).toEqual({
      status: "detected",
      kind: "missing-header",
      detected: true,
      repaired: false,
    });
    const duplicateHeader = [
      ["id", "id", "name"],
      ["a", "b", "c"],
    ];
    expect(scenario.detectCorruption(duplicateHeader)).toEqual({
      status: "detected",
      kind: "malformed-header",
      detected: true,
      repaired: false,
    });
    const blankHeader = [
      ["id", "", "name"],
      ["a", "b", "c"],
    ];
    expect(scenario.detectCorruption(blankHeader)).toEqual({
      status: "detected",
      kind: "malformed-header",
      detected: true,
      repaired: false,
    });
  });

  it("treats fully blank rows as padding, not corruption", () => {
    const rows = [
      ["id", "name", "tier", "active", "signupAt"],
      ["actor-1", "Ada", "gold", "true", "2024-01-01T00:00:00Z"],
      ["", "", "", "", ""],
    ];
    expect(scenario.detectCorruption(rows)).toEqual({ status: "clean" });
  });
});

describe("sheetCorruptionDetection execute (fake client)", () => {
  it("injects a duplicate identity, detects it, and records repaired:false (ok)", async () => {
    const plan = corruptPlan("duplicate-identity");
    const client = new FakeClient();
    const em = new FakeEm();
    hookProjection(plan, client, em);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    // Detection is the EXPECTED outcome: one expected error, zero failures.
    expect(result.status).toBe("ok");
    expect(result.expectedErrors).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.cleanupFailures).toBe(0);
    expect(result.reason).toBe("corruption-detected-duplicate-identity");
    // Guaranteed cleanup: the dedicated row and its duplicate copy are both
    // gone from the authority and the tab.
    expect(em.rows()).toEqual([]);
    expect(tabIds(client, plan)).not.toContain(plan.target.dedicatedId);
  });

  it("injects a cell-shifted row, detects it, and cleans up (ok)", async () => {
    const plan = corruptPlan("shifted-cell");
    const client = new FakeClient();
    const em = new FakeEm();
    hookProjection(plan, client, em);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.expectedErrors).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.reason).toBe("corruption-detected-shifted-cell");
    expect(em.rows()).toEqual([]);
    expect(tabIds(client, plan)).not.toContain(plan.target.dedicatedId);
  });

  it("injects a missing required field through the guarded write seam and detects it (ok)", async () => {
    const plan = corruptPlan("missing-field");
    const client = new FakeClient();
    const em = new FakeEm();
    hookProjection(plan, client, em);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("ok");
    expect(result.expectedErrors).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.reason).toBe("corruption-detected-missing-field");
    // The injection went through the guarded identity-resolved write seam
    // with an empty value into the required field cell.
    expect(client.mutateCalls).toEqual([
      { identity: plan.target.dedicatedId, headerName: plan.target.field, value: "" },
    ]);
    expect(em.rows()).toEqual([]);
    expect(tabIds(client, plan)).not.toContain(plan.target.dedicatedId);
  });

  it("records an identity-shifted guarded injection rejection as a transient skip, not a failure", async () => {
    // The guarded write seam rejects the missing-field injection with the
    // fail-closed `identity_shifted` class when a CONCURRENT actor shifted
    // the tab mid-write. The seam proved no silent overwrite, so this is
    // an EXPECTED TRANSIENT of the adversarial multi-writer environment: a
    // truthful skip (never a failure). The guaranteed cleanup still removes
    // the dedicated row.
    const plan = corruptPlan("missing-field");
    const client = new FakeClient();
    const em = new FakeEm();
    hookProjection(plan, client, em);
    client.throwOnMutateCall = { index: 1, code: "identity_shifted" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity-shifted-transient");
    expect(result.failures).toBe(0);
    expect(em.rows()).toEqual([]);
  });

  it("classifies an injected-but-undetected corruption as failed (guard miss)", async () => {
    // The injection is observable to the verification read but the DETECTION
    // read fails to surface it (the read seam misses the corruption): the
    // guard deficiency this scenario hunts.
    const plan = corruptPlan("duplicate-identity");
    const client = new FakeClient();
    client.hideInjectionAfterFirstRead = true;
    const em = new FakeEm();
    hookProjection(plan, client, em);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.failures).toBe(1);
    expect(result.reason).toBe("corruption-missed");
    expect(result.expectedErrors).toBe(0);
    // Cleanup still removes the dedicated authority row.
    expect(em.rows()).toEqual([]);
  });

  it("records a readTabRows rejection as failed, never a transient skip", async () => {
    // Narrowed transient scope: ONLY the direct writes (`mutateInputCell`
    // / `injectInputCells`) may classify as `identity-shifted-transient`.
    // A read rejection — even one duck-typed with `code:
    // "identity_shifted"` — rethrows to the normal failure path.
    const plan = corruptPlan("duplicate-identity");
    const client = new FakeClient();
    const em = new FakeEm();
    hookProjection(plan, client, em);
    client.throwOnRead = Object.assign(new Error("fake read failure"), {
      code: "identity_shifted",
    });
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Cleanup still removes the dedicated authority row.
    expect(em.rows()).toEqual([]);
  });

  it("guarantees independent cleanup: a failed injected-row delete still removes the row", async () => {
    const plan = corruptPlan("duplicate-identity");
    const client = new FakeClient();
    client.throwOnDeleteAtCall = 1; // the injected-row cleanup delete fails
    const em = new FakeEm();
    hookProjection(plan, client, em);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    // The cleanup failure turns the (otherwise ok) result into a failed
    // record with one cleanup failure; the authority row removal still ran.
    expect(result.status).toBe("failed");
    expect(result.cleanupFailures).toBe(1);
    expect(result.failures).toBe(1);
    expect(em.rows()).toEqual([]);
  });

  it("skips truthfully when the dedicated row's projection never appears", async () => {
    const plan = corruptPlan("duplicate-identity");
    const client = new FakeClient();
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", "name"]); // no projection
    const em = new FakeEm();
    const context = liveContext(plan, client, em, Date.now() + 60); // short gating window
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("projection-not-ready");
    // No injection was ever attempted; the dedicated row is still removed
    // from the authority in cleanup.
    expect(result.failures).toBe(0);
    expect(em.rows()).toEqual([]);
  });
});
