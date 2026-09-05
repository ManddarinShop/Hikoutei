/**
 * Offline tests for the `humanInsertDuplicateId` soak scenario, driven
 * against fake public seams (a fake direct-Sheet client and a fake
 * EntityManager).
 *
 * No network, credentials, or live Google Sheets are used. The scenario's
 * `plan` and `execute` are exercised exactly as the soak scheduler drives
 * them, with the bounded observation polls shortened so the settle/rejection
 * logic runs fast and deterministically. Only the `humanInsertDuplicateId`
 * scenario module is imported; the other attack-scenario modules are
 * deliberately not touched.
 */
import { describe, expect, it, vi } from "vitest";
import * as humanInsertDuplicateId from "../scripts/ci/local-soak/scenarios/human-insert-duplicate-id.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { SeededRandom } from "../scripts/ci/local-soak/prng.mjs";
import { SCENARIO_REGISTRY } from "../scripts/ci/local-soak/scenarios/registry.mjs";
import { FakeEm, liveContext, projectAllFieldsRow as projectPersistedRow } from "./support/soakScenarioFixtures.js";

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
const scenario = humanInsertDuplicateId;

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
  target: { entityName: string; targetId: string };
  dupRow: Record<string, unknown>;
}

/** A deterministic plan over SoakCustomer with a known duplicate-insert set. */
function dupPlan(): PlanLike {
  return {
    tag: "human-insert-duplicate-id",
    jitterMs: 1,
    target: { entityName: "SoakCustomer", targetId: "dup-cust-c1-0" },
    dupRow: {
      id: "dup-cust-c1-0",
      name: "duplicate-name",
      tier: "duplicate-tier",
      active: "duplicate-active",
      signupAt: "duplicate-signup",
    },
  };
}

// ---------------------------------------------------------------------------
// Fake seams.
// ---------------------------------------------------------------------------

/** A fake direct-Sheet client backed by in-memory tab state. */
class FakeClient {
  private tabs = new Map<string, { headers: string[]; rows: Map<string, unknown[]> }>();
  insertCalls: { tabName: string; row: Record<string, unknown> }[] = [];
  /** When set, the 1-based insert call at this index throws with this code. */
  throwOnInsertCall: { index: number; code: string } | undefined;
  /** When false, the seam fails to reject a duplicate id (a bug to expose). */
  rejectDuplicateId = true;
  /** When true, the seam corrupts the tab (overwrites with the duplicate) while still rejecting. */
  leakOnReject = false;

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

  async insertInputRow(input: {
    tabName: string;
    row: Record<string, unknown>;
  }): Promise<{ rowNumber: number }> {
    this.insertCalls.push({ tabName: input.tabName, row: input.row });
    if (this.throwOnInsertCall !== undefined && this.insertCalls.length === this.throwOnInsertCall.index) {
      throw Object.assign(new Error("fake insert failure"), {
        code: this.throwOnInsertCall.code,
      });
    }
    const tab = this.tabs.get(input.tabName);
    if (tab === undefined) return { rowNumber: 1 };
    // Pre-write validation: reject an already-existing id with the stable
    // identity_shifted code (never writes, never overwrites).
    if (this.rejectDuplicateId) {
      for (const identity of tab.rows.keys()) {
        if (identity === String(input.row.id)) {
          if (this.leakOnReject) {
            // A write-then-postcondition failure: the seam still corrupts the
            // tab (overwrites with the duplicate-insert values) while rejecting.
            tab.rows.set(String(input.row.id), tab.headers.map((header) => String(input.row[header] ?? "")));
          }
          throw Object.assign(new Error("identity already exists"), {
            code: "identity_shifted",
          });
        }
      }
    }
    tab.rows.set(String(input.row.id), tab.headers.map((header) => String(input.row[header] ?? "")));
    return { rowNumber: tab.rows.size + 1 };
  }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("humanInsertDuplicateId scenario", () => {
  it("is registered among the registered scenarios", () => {
    // Registry-agnostic: assert this scenario is registered without binding
    // to the full ordered id list, so later scenario PRs never need to touch
    // this test. Exact registry content is asserted once in the shared test.
    const ids = SCENARIO_REGISTRY.map((entry) => entry.id);
    expect(ids).toContain("human-insert-duplicate-id");
  });

  it("exposes the scheduler contract and a deterministic plan for a valid entity", () => {
    expect(scenario.id).toBe("human-insert-duplicate-id");
    expect(scenario.kind).toBe("data");
    expect(scenario.allowedPhases).toContain("concurrent-with-actors");
    expect(scenario.allowedPhases).toContain("after-actors");
    expect(scenario.TAG).toBe("human-insert-duplicate-id");
    expect(typeof scenario.execute).toBe("function");
    expect(typeof scenario.recover).toBe("function");
    const plan = buildPlan(777);
    const again = buildPlan(777);
    expect(again).toEqual(plan);
    expect(plan.tag).toBe("human-insert-duplicate-id");
    // The target is a real entity and the id a dedicated duplicate id.
    expect(SOAK_ENTITY_ORDER.some((entry) => entry.name === plan.target.entityName)).toBe(true);
    expect(plan.target.targetId).toMatch(/^dup-/);
    // The duplicate-insert set carries the SAME id with field values.
    expect(plan.dupRow.id).toBe(plan.target.targetId);
    // Every duplicate-insert value is a string (the insert seam requires
    // Record<string,string>; a number/boolean/date value would violate it).
    for (const [field, value] of Object.entries(plan.dupRow)) {
      expect(field).toBeDefined();
      expect(typeof value).toBe("string");
    }
    expect(plan.jitterMs).toBeGreaterThan(0);
  });

  it("skips when the plan's entity is not in the active subset (local-mode)", async () => {
    const plan = dupPlan();
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

  it("records a clean exact-identity rejection as the transient skip and leaves the existing row untouched", async () => {
    const plan = dupPlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    // A clean exact-identity rejection of the direct insert whose
    // no-overwrite checks passed is the expected multi-writer transient: a
    // truthful skip with the rejection's reasonTag, never a failure.
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity-shifted-transient");
    expect(result.expectedErrors).toBe(0);
    expect(result.failures).toBe(0);
    expect(typeof result.reasonTag).toBe("string");
    // The duplicate insert was attempted exactly once with the same id.
    const calls = client.insertCalls.filter((call) => call.row.id === plan.target.targetId);
    expect(calls.length).toBe(1);
    // No-overwrite invariant: the existing row's projected values are
    // unchanged (the seam rejected the duplicate BEFORE writing, so the tab
    // never carries the duplicate-insert values).
    const cells = await client.readTabRows("spreadsheet-1", `${plan.target.entityName}_Input`);
    const headers = cells[0]!;
    const idColumn = headers.indexOf("id");
    const projectedRow = cells.find((entry, index) => index > 0 && entry[idColumn] === plan.target.targetId);
    expect(projectedRow).toBeDefined();
    for (const [field, value] of Object.entries(plan.dupRow)) {
      if (field === "id") continue;
      const column = headers.indexOf(field);
      expect(projectedRow![column]).not.toBe(String(value));
    }
    // Guaranteed cleanup removes the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("matches boolean/date cells by their typed projected strings (TRUE / ISO)", async () => {
    // SoakCustomer has boolean `active` and date `signupAt`. The scenario's
    // direct-Sheet re-read must compare against the PROJECTED cell strings
    // (uppercase TRUE/FALSE and canonical ISO), never String(true)/Date#toString,
    // or a valid typed duplicate-id scenario would false-fail.
    const plan = dupPlan();
    const client = new FakeClient();
    const em = new FakeEm();
    const capture: { values: Record<string, string> } = { values: {} };
    projectPersistedRow(em, client, plan, capture);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("identity-shifted-transient");
    expect(result.expectedErrors).toBe(0);
    expect(result.failures).toBe(0);
    // The fake projection carried the typed display strings for the boolean
    // and date fields, and the identity re-read matched them exactly.
    expect(capture.values.active).toMatch(/^(TRUE|FALSE)$/);
    const signupAt = capture.values.signupAt;
    expect(typeof signupAt).toBe("string");
    expect(new Date(signupAt!).toISOString()).toBe(signupAt);
    expect(em.rows()).toEqual([]);
  });

  it("detects an overwrite when a typed boolean/date cell differs from the projected string", async () => {
    // A leak that overwrites the Sheet with the duplicate-insert (string)
    // values must be caught: the typed boolean/date cells no longer carry
    // their projected TRUE/ISO strings, so the identity re-read is false.
    const plan = dupPlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.rejectDuplicateId = true;
    client.leakOnReject = true;
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    expect(em.rows()).toEqual([]);
  });

  it("fails when a rejected duplicate insert still leaks an overwrite to the Sheet", async () => {
    // The authority read alone reports the existing row unchanged, but a
    // write-then-postcondition failure that leaked the duplicate values onto
    // the Sheet (overwriting the row) must be detected by the direct-Sheet
    // re-read: the identity must appear EXACTLY once with its ORIGINAL values.
    const plan = dupPlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.rejectDuplicateId = true;
    client.leakOnReject = true; // rejects but still overwrites the tab
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Guaranteed cleanup still removed the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("classifies a non-identity_shifted insert rejection as a real failure", async () => {
    // A rejected duplicate insert is an expected fail-closed conflict ONLY
    // on the exact `identity_shifted` evidence. A transport/validation
    // rejection is a real failure.
    const plan = dupPlan();
    const client = new FakeClient();
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    client.throwOnInsertCall = { index: 1, code: "google_sheets_api_network_error" };
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("scenario-error");
    expect(result.failures).toBe(1);
    // Guaranteed cleanup still removed the dedicated row.
    expect(em.rows()).toEqual([]);
  });

  it("skips truthfully when the dedicated row's projection never appears (gating)", async () => {
    const plan = dupPlan();
    const client = new FakeClient();
    // The tab exists but the dedicated row is never projected into it.
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", "name"]);
    const em = new FakeEm();
    const context = liveContext(plan, client, em, Date.now() + 80);
    const result = await scenario.execute({ plan, context });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("projection-not-ready");
    // No duplicate insert was ever attempted against a not-yet-projected row.
    expect(client.insertCalls).toEqual([]);
    // The dedicated row is still removed in cleanup.
    expect(em.rows()).toEqual([]);
  });

  it("guarantees cleanup removes the dedicated row even when the seam fails to reject", async () => {
    // A seam that fails to reject the duplicate (a bug) is the corruption
    // failure this scenario hunts -> failed, but the guaranteed finally still
    // removes the dedicated row so the authority matches the replay.
    const plan = dupPlan();
    const client = new FakeClient();
    client.rejectDuplicateId = false; // the seam fails to reject the duplicate
    const em = new FakeEm();
    projectPersistedRow(em, client, plan);
    const result = await scenario.execute({ plan, context: liveContext(plan, client, em) });
    expect(result.status).toBe("failed");
    expect(result.failures).toBe(1);
    expect(em.rows()).toEqual([]);
  });
});
