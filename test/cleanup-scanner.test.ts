/**
 * User_Input cleanup scan tests: overwrite semantics against the real
 * provider snapshot shape.
 *
 * The fake provider runs with `realProviderSnapshotShape` (visibleRevision /
 * visibleHash ABSENT on snapshot rows, exactly like the real Google provider)
 * and `allowDuplicateAnchors`, so the scan must derive CAS evidence from the
 * observed cells and resolve duplicated anchors the way the real provider
 * does (first row per anchor). Every scan runs the production path: fake sync
 * provider, SQLite/MikroORM storage, and the actual effect worker through the
 * Sheets effect dispatcher.
 *
 * Semantics under test: bound rows are rewritten from SQLite canonical values
 * (candidate-protected rewrites carry the candidate hash so the existing
 * candidate guards block them); duplicates, empty-ID rows, and orphans are
 * deleted with full-row CAS; duplicated anchors converge one row per scan;
 * a converged tab re-scans to zero effects.
 */

import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS } from "../src/shared/state/constants.js";
import type { NormalizedCell } from "../src/shared/encoding/types.js";
import { SYNC_PROJECTIONS } from "../src/application/sync/sheetsContract/constants.js";
import { computeSyncVisibleHash } from "../src/application/sync/sheetsContract/syncSheets.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";
import { MikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type { SqlExecutor } from "../src/adapter/persistence/contracts/sql.js";
import { migrateSqliteSchema } from "../src/infrastructure/storage/sqlite/migrateSchema.js";
import {
  runUserInputCleanupScan,
  type CleanupScanReport,
} from "../src/application/sync/outbound/reconciliation/CleanupScanner.js";
import {
  listReadyEffectsWithAdapter,
  runEffectWorkerWithAdapter,
} from "@hikoutei/ikisaki";
import { SheetsEffectDispatcher } from "../src/application/sync/outbound/SheetsEffectDispatcher.js";

const EntitySchema = defineEntity({
  name: "CleanupEntity",
  tableName: "cleanup_entity",
  properties: { id: p.string().primary() },
});

class Entity extends EntitySchema.class {}

EntitySchema.setClass(Entity);

const INPUT_HEADERS = ["id", "status"] as const;

describe("runUserInputCleanupScan", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("converges duplicated-anchor rows by deleting the resolvable row first, then rewriting the survivor from canonical state", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        inputRow("input-a", "user-1", "open"),
        // The real provider reports both physical rows with the same
        // business-key anchor; only the first row is provider-resolvable.
        inputRow("input-a", "user-1", "stale"),
      ],
      bindings: [
        binding("binding-a", "input-a", "active", {
          entityId: "entity:u1",
          canonicalFields: { id: cell("user-1"), status: cell("open") },
        }),
      ],
    });
    // One id source for every scan of this test so stream ids never collide.
    const createId = counter();

    // Pass 1: the duplicated-anchor group converges by deleting the
    // resolvable (first) row; the group's rewrite is deferred until the
    // group is down to one row.
    const first = await runCleanupScan(adapter, provider, createId);
    expect(first).toMatchObject({
      rowsScanned: 2,
      duplicateRows: 1,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });

    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      effect_kind: "user_input_delete",
      target_kind: "projection_row",
      // Bound-row corrections stream under the binding key shared with
      // flush projections and resolution reconciles, not the anchor.
      target_id: "projection-row:physical-input:binding-a",
      row_binding_id: "binding-a",
      status: "pending",
    });

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    // The resolvable row is gone; the survivor still carries its stale cells.
    expect(provider.readRow("physical-input", "input-a").fields.status)
      .toEqual({ kind: "string", value: "stale" });

    // Pass 2: the survivor is uniquely anchored and bound, so the scan
    // rewrites the row from SQLite canonical values through the worker.
    const second = await runCleanupScan(adapter, provider, createId);
    expect(second).toMatchObject({
      rowsScanned: 1,
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 1,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const rewrite = await listReadyEffectsWithAdapter(adapter, 10);
    expect(rewrite).toHaveLength(1);
    expect(rewrite[0]).toMatchObject({
      effect_kind: "candidate_reconcile",
      target_kind: "projection_row",
      target_id: "projection-row:physical-input:binding-a",
      row_binding_id: "binding-a",
      status: "pending",
    });
    expect(await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    })).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    expect(provider.readRow("physical-input", "input-a").fields).toEqual({
      id: { kind: "string", value: "user-1" },
      status: { kind: "string", value: "open" },
    });

    // Pass 3: the tab equals SQLite canonical state; a re-scan enqueues
    // nothing and does not claim the fence.
    const converged = await runCleanupScan(adapter, provider, createId);
    expect(converged).toMatchObject({
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(listReadyEffectsWithAdapter(adapter, 10)).resolves.toHaveLength(0);
  });

  it("deletes empty-ID and orphan rows (including quarantined and duplicated-identity orphans) and keeps the durable evidence", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        inputRow("bound-a", "user-1", "open"),
        inputRow("empty-q", "", "open"),
        inputRow("extra-q", "orphan", "open"),
        // Same identity as extra-q but a different anchor: both orphan rows
        // are surplus relative to SQLite canonical state.
        inputRow("orphan-b", "orphan", "open"),
      ],
      bindings: [
        binding("binding-a", "bound-a", "active", {
          entityId: "entity:u1",
          canonicalFields: { id: cell("user-1"), status: cell("open") },
        }),
      ],
      quarantines: [
        { quarantineId: "q-empty", bindingId: "empty-q" },
        { quarantineId: "q-extra", bindingId: "extra-q" },
      ],
    });

    const report = await runCleanupScan(adapter, provider);
    expect(report).toMatchObject({
      rowsScanned: 4,
      duplicateRows: 0,
      emptyIdRows: 1,
      extraRows: 2,
      rewrittenRows: 0,
      effectsEnqueued: 3,
      fenceClaimed: true,
    });

    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending.map((effect) => effect.target_id).sort())
      .toEqual(["empty-q", "extra-q", "orphan-b"]);

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ applied: 3 });
    expect(() => provider.readRow("physical-input", "empty-q")).toThrow();
    expect(() => provider.readRow("physical-input", "extra-q")).toThrow();
    expect(() => provider.readRow("physical-input", "orphan-b")).toThrow();
    expect(provider.readRow("physical-input", "bound-a").fields.id)
      .toEqual({ kind: "string", value: "user-1" });

    // Quarantine evidence stays durable in SQLite even though the surplus
    // rows are gone; the scan never touches evidence records.
    const quarantineCount = await adapter.read(({ sql }) =>
      sql.get<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM quarantine_record WHERE logical_sheet_id = ?",
        ["logical-clean"],
      ));
    expect(quarantineCount?.count).toBe(2);

    const rescan = await runCleanupScan(adapter, provider);
    expect(rescan).toMatchObject({
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
  });

  it("skips bindings with an OPEN conflict: no rewrite or delete is planned for a conflicted binding", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        inputRow("bound-a", "user-1", "open"),
        // Bound row drifted from canonical state; the durable OPEN conflict
        // must suppress the rewrite entirely (never enqueued).
        inputRow("bound-cand", "user-2", "candidate-edit"),
        // Orphan duplicate of the bound key with a remote candidate marker:
        // genuinely surplus (no binding), so the delete is enqueued and the
        // provider CAS blocks it.
        inputRow("dup-cand", "user-1", "duplicate", "candidate-hash"),
        // Empty-ID row under a candidate binding with an OPEN conflict: the
        // disputed row is skipped, never deleted, until resolution.
        inputRow("empty-cand", "", "open"),
      ],
      bindings: [
        binding("binding-a", "bound-a", "active", {
          entityId: "entity:u1",
          canonicalFields: { id: cell("user-1"), status: cell("open") },
        }),
        binding("binding-cand", "bound-cand", "active", {
          entityId: "entity:u2",
          canonicalFields: { id: cell("user-2"), status: cell("open") },
        }),
        binding("binding-empty-cand", "empty-cand", "candidate"),
      ],
      candidates: [
        { conflictId: "conflict-1", bindingId: "binding-cand", entityId: "entity:u2" },
        { conflictId: "conflict-2", bindingId: "binding-empty-cand", entityId: "entity:empty" },
      ],
    });

    const createId = counter();
    const report = await runCleanupScan(adapter, provider, createId);
    expect(report).toMatchObject({
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 1,
      rewrittenRows: 0,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });

    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    // Only the genuinely surplus orphan delete was enqueued; the conflicted
    // bindings never produced a rewrite or a delete.
    expect(pending[0]).toMatchObject({
      effect_kind: "user_input_delete",
      target_id: "dup-cand",
      row_binding_id: null,
    });

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    // The orphan delete is blocked by the provider's candidate CAS; the
    // conflicted rows are untouched and nothing was enqueued for them.
    expect(workerReport).toMatchObject({ blockedCandidate: 1, applied: 0 });
    expect(provider.readRow("physical-input", "bound-cand").fields.status)
      .toEqual({ kind: "string", value: "candidate-edit" });
    expect(provider.readRow("physical-input", "dup-cand").fields.id)
      .toEqual({ kind: "string", value: "user-1" });
    expect(provider.readRow("physical-input", "empty-cand").fields.id)
      .toEqual({ kind: "string", value: "" });

    // A re-scan after the worker pass still plans nothing for the conflicted
    // bindings; the orphan delete is re-attempted by superseding its
    // terminal blocked_candidate head (the existing recovery contract).
    const rescan = await runCleanupScan(adapter, provider, createId);
    expect(rescan).toMatchObject({
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 1,
      rewrittenRows: 0,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
  });

  it("enqueues no rewrite for a drifted bound row whose binding has an OPEN conflict (restart-style scan)", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        // The live #196 restart shape: the row still carries the human edit
        // while canonical has advanced, and the conflict is already OPEN.
        inputRow("bound-a", "user-1", "stale"),
      ],
      bindings: [
        binding("binding-a", "bound-a", "active", {
          entityId: "entity:u1",
          canonicalFields: { id: cell("user-1"), status: cell("open") },
        }),
      ],
      candidates: [
        { conflictId: "conflict-1", bindingId: "binding-a", entityId: "entity:u1" },
      ],
    });

    const report = await runCleanupScan(adapter, provider);
    expect(report).toMatchObject({
      rowsScanned: 1,
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(listReadyEffectsWithAdapter(adapter, 10)).resolves.toHaveLength(0);

    // The conflicted row is untouched on the sheet.
    expect(provider.readRow("physical-input", "bound-a").fields.status)
      .toEqual({ kind: "string", value: "stale" });
  });

  it("leaves rows bound to candidate, tombstoned, or ambiguous bindings untouched", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        // Candidate binding without an entity: a human row pending
        // acceptance, never rewritten (no canonical) and never deleted.
        inputRow("new-row", "user-new", "open"),
        inputRow("tomb-row", "user-gone", "open"),
        inputRow("ambig-row", "user-ambig", "open"),
      ],
      bindings: [
        binding("binding-new", "new-row", "candidate"),
        binding("binding-tomb", "tomb-row", "tombstoned"),
        binding("binding-ambig", "ambig-row", "ambiguous"),
      ],
    });

    const report = await runCleanupScan(adapter, provider);
    expect(report).toMatchObject({
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(listReadyEffectsWithAdapter(adapter, 10)).resolves.toHaveLength(0);
  });

  it("enqueues nothing for a tab that already equals SQLite canonical state", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [inputRow("bound-a", "user-1", "open")],
      bindings: [
        binding("binding-a", "bound-a", "active", {
          entityId: "entity:u1",
          canonicalFields: { id: cell("user-1"), status: cell("open") },
        }),
      ],
    });

    const report = await runCleanupScan(adapter, provider);
    expect(report).toMatchObject({
      rowsScanned: 1,
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(listReadyEffectsWithAdapter(adapter, 10)).resolves.toHaveLength(0);
  });

  it("assigns sync-anchor values to unanchored rows through the observation pass, then cleans them as orphans", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        // physicalAnchor null models a row the built-in append path wrote
        // without anchor metadata; the real provider assigns a sync-anchor
        // during the observation pass that precedes the snapshot read.
        { anchor: "", id: "ghost", status: "open", unanchored: true },
      ],
      bindings: [],
    });

    const report = await runCleanupScan(adapter, provider);
    expect(report).toMatchObject({
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 1,
      rewrittenRows: 0,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ effect_kind: "user_input_delete" });
    expect(pending[0]?.target_id.startsWith("sync-anchor:")).toBe(true);

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    expect(await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    })).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    const snapshot = await provider.readSnapshot({
      physicalSheetId: "physical-input",
      sheetName: "Orders_Input",
      registeredRange: "A:B",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    expect(snapshot.rows).toHaveLength(0);
  });

  it("rewrites a bound row without regressing a higher confirmed visible revision", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        // Bound row drifted from canonical; the durable confirmed state is
        // revision 3 from earlier write history, while the real-provider
        // snapshot carries no revision (the scan falls back to 1).
        inputRow("bound-a", "user-1", "stale"),
      ],
      bindings: [
        binding("binding-a", "bound-a", "active", {
          entityId: "entity:u1",
          canonicalFields: { id: cell("user-1"), status: cell("open") },
        }),
      ],
    });
    await seedCleanupVisibleState(adapter, "binding-a", 3, computeSyncVisibleHash({
      id: cell("user-1"),
      status: cell("stale"),
    }));
    const createId = counter();

    const report = await runCleanupScan(adapter, provider, createId);
    expect(report).toMatchObject({ rewrittenRows: 1, effectsEnqueued: 1, fenceClaimed: true });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    // The effect's expected revision is derived from the durable confirmed
    // state (3), not the snapshot fallback revision 1, so the confirmation
    // mirror can never see a backwards move.
    expect(pending[0]?.expected_visible_revision).toBe(3);
    // Bound-row rewrites stream under the binding key, not the anchor.
    expect(pending[0]).toMatchObject({
      target_id: "projection-row:physical-input:binding-a",
      row_binding_id: "binding-a",
    });

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    await expect(outboxStatus(adapter, pending[0]!.effect_id)).resolves.toBe("applied");
    // The provider receipt advances the confirmed revision past the write
    // history instead of regressing it (3 -> 4).
    await expect(visibleStateRevision(adapter, "binding-a")).resolves.toBe(4);
    expect(provider.readRow("physical-input", "bound-a").fields).toEqual({
      id: { kind: "string", value: "user-1" },
      status: { kind: "string", value: "open" },
    });

    // A re-scan of the converged tab enqueues nothing.
    const rescan = await runCleanupScan(adapter, provider, createId);
    expect(rescan).toMatchObject({
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(listReadyEffectsWithAdapter(adapter, 10)).resolves.toHaveLength(0);
  });

  it("deletes a duplicated-anchor row without regressing a higher confirmed visible revision", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [
        // The resolvable first row is stale and deleted; the survivor already
        // matches SQLite canonical state, so the converged tab needs no
        // follow-up rewrite.
        inputRow("input-a", "user-1", "stale"),
        inputRow("input-a", "user-1", "open"),
      ],
      bindings: [
        binding("binding-a", "input-a", "active", {
          entityId: "entity:u1",
          canonicalFields: { id: cell("user-1"), status: cell("open") },
        }),
      ],
    });
    await seedCleanupVisibleState(adapter, "binding-a", 3, computeSyncVisibleHash({
      id: cell("user-1"),
      status: cell("stale"),
    }));
    const createId = counter();

    const report = await runCleanupScan(adapter, provider, createId);
    expect(report).toMatchObject({ duplicateRows: 1, effectsEnqueued: 1, fenceClaimed: true });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      effect_kind: "user_input_delete",
      target_id: "projection-row:physical-input:binding-a",
      row_binding_id: "binding-a",
    });
    expect(pending[0]?.expected_visible_revision).toBe(3);

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    await expect(outboxStatus(adapter, pending[0]!.effect_id)).resolves.toBe("applied");
    // The deletion receipt echoes the expected revision (3), so the
    // confirmation equals the confirmed revision instead of regressing it.
    await expect(visibleStateRevision(adapter, "binding-a")).resolves.toBe(3);
    expect(provider.readRow("physical-input", "input-a").fields.status)
      .toEqual({ kind: "string", value: "open" });

    // The survivor matches canonical state: a re-scan enqueues nothing.
    const rescan = await runCleanupScan(adapter, provider, createId);
    expect(rescan).toMatchObject({
      duplicateRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(listReadyEffectsWithAdapter(adapter, 10)).resolves.toHaveLength(0);
  });

  it("writes no projection confirmation for orphan deletes that have no binding", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [inputRow("extra-q", "orphan", "open")],
      bindings: [],
    });

    const report = await runCleanupScan(adapter, provider);
    expect(report).toMatchObject({ extraRows: 1, effectsEnqueued: 1, fenceClaimed: true });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    // Orphan deletes carry no row binding id, so the worker writes no
    // confirmation for a binding that does not exist.
    expect(pending[0]?.row_binding_id).toBeNull();

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ applied: 1 });
    expect(() => provider.readRow("physical-input", "extra-q")).toThrow();
    // No stray durable visible-state rows for the anchor-as-binding-id.
    await expect(adapter.read(({ sql }) => sql.get<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM sheet_visible_state WHERE physical_sheet_id = ? AND row_binding_id = ?",
      ["physical-input", "extra-q"],
    ))).resolves.toEqual({ count: 0 });
    await expect(adapter.read(({ sql }) => sql.get<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM sheet_visible_field_state WHERE physical_sheet_id = ? AND row_binding_id = ?",
      ["physical-input", "extra-q"],
    ))).resolves.toEqual({ count: 0 });
  });

  it("refuses non-user_input projections", async () => {
    const { adapter, provider } = await bootstrap({
      sheetRows: [inputRow("bound-a", "user-1", "open")],
      bindings: [],
    });
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE physical_sheet_registry SET projection = 'system_state' WHERE physical_sheet_id = 'physical-input'",
    ));

    await expect(runCleanupScan(adapter, provider)).rejects.toThrow();
  });
});

interface BindingSeed {
  readonly rowBindingId: string;
  readonly anchorReference: string;
  readonly state: string;
  readonly entityId?: string;
  readonly canonicalFields?: Readonly<Record<string, NormalizedCell>>;
}

interface CandidateSeed {
  readonly conflictId: string;
  readonly bindingId: string;
  readonly entityId: string;
}

interface QuarantineSeed {
  readonly quarantineId: string;
  readonly bindingId: string;
}

interface BootstrapInput {
  readonly sheetRows: readonly {
    readonly anchor: string;
    readonly id: string;
    readonly status: string;
    readonly activeCandidateHash?: string;
    /** Models a row without physical anchor metadata (built-in append path). */
    readonly unanchored?: boolean;
  }[];
  readonly bindings: readonly BindingSeed[];
  readonly candidates?: readonly CandidateSeed[];
  readonly quarantines?: readonly QuarantineSeed[];
}

interface BootstrapResult {
  readonly adapter: MikroOrmSqliteAdapter;
  readonly provider: FakeSyncSheetsProvider;
}

function inputRow(
  anchor: string,
  id: string,
  status: string,
  activeCandidateHash?: string,
): BootstrapInput["sheetRows"][number] {
  return activeCandidateHash === undefined
    ? { anchor, id, status }
    : { anchor, id, status, activeCandidateHash };
}

/** Builds one string normalized cell for canonical field seeding. */
function cell(value: string): NormalizedCell {
  return { kind: "string", value };
}

function binding(
  rowBindingId: string,
  anchorReference: string,
  state: string,
  canonical?: { readonly entityId: string; readonly canonicalFields: Readonly<Record<string, NormalizedCell>> },
): BindingSeed {
  return canonical === undefined
    ? { rowBindingId, anchorReference, state }
    : { rowBindingId, anchorReference, state, ...canonical };
}

async function bootstrap(args: BootstrapInput): Promise<BootstrapResult> {
  const orm = await createOrm();
  const adapter = new MikroOrmSqliteAdapter(orm);
  await migrateSqliteSchema(adapter);
  await seedRegistry(adapter, args);

  const provider = new FakeSyncSheetsProvider([{
    physicalSheetId: "physical-input",
    sheetName: "Orders_Input",
    registeredRange: "A:B",
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: 1,
    identityField: "id",
    headers: [...INPUT_HEADERS],
    rows: args.sheetRows.map((row) => {
      const base = {
        targetId: row.id.length === 0 ? row.anchor : row.id,
        physicalAnchor: row.unanchored === true ? null : row.anchor,
        // The real provider leaves visible state to SQLite; the snapshot
        // omits revision/hash and the scan derives them from the cells.
        visibleRevision: 1,
        fields: {
          id: { kind: "string", value: row.id },
          status: { kind: "string", value: row.status },
        },
      } as const;
      return row.activeCandidateHash === undefined
        ? base
        : {
          ...base,
          activeCandidateHash: {
            kind: APPLICABILITY_KINDS.APPLICABLE,
            value: row.activeCandidateHash,
          },
        };
    }),
  }], {
    allowDuplicateAnchors: true,
    realProviderSnapshotShape: true,
  });

  return { adapter, provider };
}

async function seedRegistry(
  adapter: MikroOrmSqliteAdapter,
  args: BootstrapInput,
): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-clean", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-input", "logical-clean", "spreadsheet", "Orders_Input", "A:B", "user_input", 1],
    );
    for (const seed of args.bindings) {
      if (seed.entityId !== undefined && seed.canonicalFields !== undefined) {
        await seedCanonicalEntity(sql, seed.entityId, seed.canonicalFields);
      }
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state, candidate_epoch) VALUES (?, ?, ?, ?, ?, 0)",
        [seed.rowBindingId, "logical-clean", seed.anchorReference, seed.entityId ?? null, seed.state],
      );
    }
    for (const candidate of args.candidates ?? []) {
      await seedCandidate(sql, candidate);
    }
    for (const quarantine of args.quarantines ?? []) {
      await sql.run(
        "INSERT INTO quarantine_record (quarantine_id, event_id, observation_id, logical_sheet_id, row_binding_id, reason, before_row_json, after_row_json, fields_json, repair_fields_json, repair_state, candidate_payload_json, created_at, updated_at) VALUES (?, NULL, NULL, ?, ?, 'duplicate', NULL, NULL, '{}', '[]', NULL, NULL, 1_000, 1_000)",
        [quarantine.quarantineId, "logical-clean", quarantine.bindingId],
      );
    }
  });
}

/** Seeds one canonical entity with user-owned fields. */
async function seedCanonicalEntity(
  sql: SqlExecutor,
  entityId: string,
  fields: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  await sql.run(
    "INSERT INTO entity_state (entity_id, entity_revision, accepted_snapshot_hash, status) VALUES (?, 1, NULL, 'active')",
    [entityId],
  );
  for (const [fieldName, value] of Object.entries(fields)) {
    await sql.run(
      "INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES (?, ?, ?, 1, 'user')",
      [entityId, fieldName, JSON.stringify(value)],
    );
  }
}

/**
 * Seeds one durable active candidate: the OPEN conflict plus the
 * sheet_visible_field_state pointer the worker candidate gate reads.
 */
async function seedCandidate(
  sql: SqlExecutor,
  candidate: CandidateSeed,
): Promise<void> {
  const batchId = `batch-${candidate.conflictId}`;
  const eventId = `event-${candidate.conflictId}`;
  await sql.run(
    "INSERT INTO event_batch (batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash) VALUES (?, ?, ?, 'polling', 'user_input', 'row_independent', 'hash')",
    [batchId, "logical-clean", "physical-input"],
  );
  await sql.run(
    "INSERT INTO event_log (event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash, event_sequence, batch_id, row_binding_id, operation, status, received_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'update', 'accepted', 1_000)",
    [eventId, "logical-clean", "physical-input", `key-${candidate.conflictId}`, "hash", batchId, candidate.bindingId],
  );
  await sql.run(
    "INSERT INTO sync_conflict (conflict_id, event_id, logical_sheet_id, entity_id, row_binding_id, field_name, user_value, user_base_revision, canonical_value_at_detection, canonical_revision_at_detection, current_canonical_value, current_canonical_revision, candidate_epoch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'status', 'user', 0, 'canonical', 0, 'canonical', 0, 0, 'OPEN', 1_000, 1_000)",
    [candidate.conflictId, eventId, "logical-clean", candidate.entityId, candidate.bindingId],
  );
  await sql.run(
    "INSERT INTO sheet_visible_field_state (physical_sheet_id, projection, row_binding_id, field_name, confirmed_field_hash, confirmed_visible_revision, active_candidate_conflict_id, active_candidate_hash, candidate_epoch, last_observed_field_hash) VALUES (?, 'user_input', ?, 'status', 'h', 1, ?, 'candidate-hash', 0, 'h')",
    ["physical-input", candidate.bindingId, candidate.conflictId],
  );
}

function runCleanupScan(
  adapter: MikroOrmSqliteAdapter,
  provider: FakeSyncSheetsProvider,
  createId: () => string = counter(),
): Promise<CleanupScanReport> {
  return runUserInputCleanupScan({
    storage: adapter,
    provider,
    physicalSheetId: "physical-input",
    logicalSheetId: "logical-clean",
    identityField: "id",
    schemaVersion: 1,
    writerId: "cleaner",
    now: () => 5_000,
    createId,
  });
}

/** Seeds one durable user_input confirmed visible state row. */
async function seedCleanupVisibleState(
  adapter: MikroOrmSqliteAdapter,
  rowBindingId: string,
  revision: number,
  snapshotHash: string,
): Promise<void> {
  await adapter.transaction(({ sql }) => sql.run(
    "INSERT INTO sheet_visible_state (physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash, confirmed_visible_revision, confirmed_entity_revision, last_observed_hash) VALUES (?, 'user_input', ?, ?, ?, 1, ?)",
    ["physical-input", rowBindingId, snapshotHash, revision, snapshotHash],
  ));
}

/** Reads one outbox row status by effect id. */
async function outboxStatus(
  adapter: MikroOrmSqliteAdapter,
  effectId: string,
): Promise<string | undefined> {
  return adapter.read(({ sql }) => sql.get<{ readonly status: string }>(
    "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?",
    [effectId],
  )).then((row) => row?.status);
}

/** Reads the durable confirmed revision for one user_input binding. */
async function visibleStateRevision(
  adapter: MikroOrmSqliteAdapter,
  rowBindingId: string,
): Promise<number | null | undefined> {
  return adapter.read(({ sql }) => sql.get<{ readonly confirmed_visible_revision: number }>(
    "SELECT confirmed_visible_revision FROM sheet_visible_state WHERE physical_sheet_id = ? AND projection = 'user_input' AND row_binding_id = ?",
    ["physical-input", rowBindingId],
  )).then((row) => row?.confirmed_visible_revision);
}

async function createOrm() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Entity],
  });
  await orm.schema.create();
  return orm;
}

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `cleanup-id-${n}`;
  };
}
