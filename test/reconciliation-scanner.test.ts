import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";
import { MikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateSqliteSchema } from "@hikoutei/storage/storage/sqlite/migrateSchema.js";
import {
  runReconciliationScan,
  RECONCILIATION_DEFAULTS,
} from "../src/application/sync/outbound/reconciliation/ReconciliationScanner.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  isRecoverableEffectErrorCode,
  listReadyEffectsWithAdapter,
  runEffectWorkerWithAdapter,
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "@hikoutei/ikisaki";
import {
  readReconciliationCorrectionStateWithAdapter,
} from "@hikoutei/storage/storage/sync/outbound/reconciliationSql.js";
import { SheetsEffectDispatcher } from "../src/application/sync/outbound/SheetsEffectDispatcher.js";
import { createSystemProjectionEffect } from "../src/application/sync/outbound/projection/ProjectionEffectFactory.js";
import { computeSyncVisibleHash, parseSyncProjectionEffectPayload } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";

const EntitySchema = defineEntity({
  name: "ReconciliationEntity",
  tableName: "reconciliation_entity",
  properties: { id: p.string().primary() },
});

class Entity extends EntitySchema.class {}

EntitySchema.setClass(Entity);

const SYSTEM_HEADERS = ["id", "status", "_deleted"] as const;

describe("runReconciliationScan", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("reports zero drift when the sheet matches the desired state", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
      matchedRows: 1,
      desiredRowsScanned: 1,
      snapshotRowsScanned: 1,
    });
    await expect(noPendingEffects(adapter)).resolves.toBe(0);
  });

  it("rejects malformed canonical cells before scheduling a correction", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [],
    });
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE entity_field_state SET normalized_value = ? WHERE entity_id = ? AND field_name = ?",
      [JSON.stringify({ kind: "string", value: 42 }), "order-1", "status"],
    ));

    await expect(runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    })).rejects.toThrow("entity_field_state.normalized_value is not a normalized cell");
    await expect(noPendingEffects(adapter)).resolves.toBe(0);
  });

  it("matches a fast-appended row by business key without creating a duplicate", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 0,
    });
    await expect(noPendingEffects(adapter)).resolves.toBe(0);
  });

  it("matches an unanchored row by visible business key when canonical IDs are namespaced", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "entity:orders:order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [],
    });

    await provider.fastAppendRows({
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [{
        effectId: "append-1",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
          _deleted: { kind: "boolean", value: false },
        },
      }],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 0,
    });
    await expect(noPendingEffects(adapter)).resolves.toBe(0);
  });

  it("matches a row with no physical anchor metadata by visible business key", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          // No Developer Metadata anchor exists on this row; the built-in
          // append path never materializes anchors.
          physicalAnchor: null,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 0,
    });
    await expect(noPendingEffects(adapter)).resolves.toBe(0);
  });

  it("does not silently match a duplicated identity and stays fail-closed", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-a",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
        {
          targetId: "order-1",
          physicalAnchor: "anchor-b",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    // The ambiguous binding is never counted as matched and no row is
    // deleted; the only repair is a createIfMissing correction that the
    // provider rejects on the duplicate identity guard (fail-closed).
    expect(report).toMatchObject({
      matchedRows: 0,
      driftedRows: 0,
      missingRows: 1,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    const payload = JSON.parse(pending[0]?.payload_json ?? "{}") as { createIfMissing: boolean };
    expect(payload.createIfMissing).toBe(true);
  });

  it("does not silently choose a row when the physical anchor is duplicated", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      // Both rows claim the same physical anchor. The last row carries the
      // exact desired content, so a last-wins anchor index would silently
      // accept the binding; the scanner must instead stay fail-closed.
      sheetRows: [
        {
          targetId: "order-2",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-2" },
            status: { kind: "string", value: "stale" },
            _deleted: { kind: "boolean", value: false },
          },
        },
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    }, { allowDuplicateAnchors: true });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    // The duplicated anchor is treated like a duplicated identity: no row is
    // chosen, the binding is reported missing, and only a fail-closed
    // createIfMissing correction is enqueued.
    expect(report).toMatchObject({
      matchedRows: 0,
      driftedRows: 0,
      missingRows: 1,
      extraRows: 1,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    const payload = JSON.parse(pending[0]?.payload_json ?? "{}") as { createIfMissing: boolean };
    expect(payload.createIfMissing).toBe(true);
  });

  it("does not accept a unique desired anchor when the desired identity is duplicated in the sheet", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      // The desired row's own anchor is unique and carries the exact desired
      // content, so a naive anchor match would accept the binding. The second
      // row duplicates the business identity, which must quarantine the
      // binding: neither its unique anchor nor its identity may count as
      // matched, in computeDrifts or in the matched/extra counters.
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
        {
          targetId: "order-1",
          physicalAnchor: "anchor-2",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    // The duplicated business identity quarantines the binding: the unique
    // anchor is not accepted, neither snapshot row counts as owned (both are
    // reported extra), and only a fail-closed createIfMissing correction is
    // enqueued, which the provider rejects on its own identity guard.
    expect(report).toMatchObject({
      matchedRows: 0,
      driftedRows: 0,
      missingRows: 1,
      extraRows: 2,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    const payload = JSON.parse(pending[0]?.payload_json ?? "{}") as { createIfMissing: boolean };
    expect(payload.createIfMissing).toBe(true);
  });

  it("enqueues a correction effect when the sheet drifted from canonical", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      driftedRows: 1,
      missingRows: 0,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });

    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      effect_kind: "system_projection",
      target_id: "order-1",
      status: "pending",
    });
  });

  it("enqueues a createIfMissing effect when the sheet is missing the row", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      driftedRows: 0,
      missingRows: 1,
      effectsEnqueued: 1,
    });

    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    const pendingEffect = pending[0];
    if (pendingEffect === undefined) throw new Error("Expected a pending reconciliation effect");
    const payload = JSON.parse(pendingEffect.payload_json) as { createIfMissing: boolean };
    expect(payload.createIfMissing).toBe(true);
  });

  it("does not enqueue a duplicate while an equivalent correction is pending", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "seed-writer",
      writerId: "seed-writer",
      leaseDurationMs: 60_000,
      now: 5_000,
    });
    expect(claim.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) return;

    const effect = createSystemProjectionEffect({
      effectId: "effect-existing",
      commitId: "commit-existing",
      logicalSheetId: "logical-recon",
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      targetKind: "entity",
      targetId: "order-1",
      rowBindingId: { kind: "present", value: "binding-1" },
      conflictId: { kind: "absent" },
      targetAnchor: "anchor-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
        _deleted: { kind: "boolean", value: false },
      },
      createIfMissing: true,
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      streamSequence: 1,
    });
    await expect(appendPendingEffectsWithAdapter(adapter, {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 5_000,
    }, [effect])).resolves.toBe(true);

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      driftedRows: 1,
      effectsEnqueued: 0,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    const pendingEffect = pending[0];
    if (pendingEffect === undefined) throw new Error("Expected the existing effect to remain pending");
    expect(pendingEffect.effect_id).toBe("effect-existing");
  });

  it("defers corrections while the latest effect is delivery-uncertain", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "seed-writer",
      writerId: "seed-writer",
      leaseDurationMs: 60_000,
      now: 5_000,
    });
    expect(claim.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) return;

    const effect = createSystemProjectionEffect({
      effectId: "effect-uncertain",
      commitId: "commit-uncertain",
      logicalSheetId: "logical-recon",
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      targetKind: "entity",
      targetId: "order-1",
      rowBindingId: { kind: "present", value: "binding-1" },
      conflictId: { kind: "absent" },
      targetAnchor: "anchor-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
        _deleted: { kind: "boolean", value: false },
      },
      createIfMissing: true,
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      streamSequence: 1,
    });
    await expect(appendPendingEffectsWithAdapter(adapter, {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 5_000,
    }, [effect])).resolves.toBe(true);
    // The response was lost and the worker is waiting for its next probe; the
    // remote write may still commit, so reconciliation must not plan against
    // stale visible state yet.
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'delivery_uncertain', claim_token = NULL, lease_until = NULL, uncertain_since = ?, next_probe_at = ? WHERE effect_id = ?",
      [5_000, 5_100, effect.effectId],
    ));

    // The reconciliation status decoder must accept delivery_uncertain rows.
    await expect(readReconciliationCorrectionStateWithAdapter(adapter, {
      logicalSheetId: "logical-recon",
      physicalSheetId: "physical-recon",
      entityId: "order-1",
      rowBindingId: "binding-1",
    })).resolves.toMatchObject({
      latestEffect: { status: "delivery_uncertain" },
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      driftedRows: 1,
      effectsEnqueued: 0,
      fenceClaimed: true,
    });
    await expect(adapter.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?",
      [effect.effectId],
    ))).resolves.toEqual({ status: "delivery_uncertain" });
    // No successor correction was enqueued behind the uncertain predecessor.
    await expect(adapter.read(({ sql }) => sql.all<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox",
    ))).resolves.toEqual([{ status: "delivery_uncertain" }]);
  });

  it("leaves extra sheet rows untouched in the report without enqueuing effects", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
        {
          targetId: "orphan",
          physicalAnchor: "anchor-orphan",
          fields: {
            id: { kind: "string", value: "orphan" },
            status: { kind: "string", value: "stale" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      extraRows: 1,
      effectsEnqueued: 0,
    });
    await expect(noPendingEffects(adapter)).resolves.toBe(0);
  });

  it("skips enqueuing effects when the reconciler cannot claim the writer fence", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    // Pre-claim the reconciler role so the scanner is fenced out.
    await adapter.transaction(({ sql }) => sql.run(
      "INSERT INTO writer_lease (role, writer_id, writer_epoch, fencing_token, lease_until) VALUES (?, ?, ?, ?, ?)",
      [RECONCILIATION_DEFAULTS.ROLE, "other-reconciler", 1, "token", 9_999],
    ));

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      driftedRows: 1,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(noPendingEffects(adapter)).resolves.toBe(0);
  });

  it("supersedes a terminal failed head so the repair applies and the sheet converges", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 3,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "shipped" },
      _deleted: { kind: "boolean", value: false },
    }));
    // A previous correction was lost in delivery uncertainty past the durable
    // probe bound and force-settled as a terminal failed head; the worker can
    // never retry it, so the stream is wedged until the scanner supersedes it.
    const wedged = await seedFailedHead(adapter, {
      effectId: "effect-wedged",
      streamSequence: 1,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      },
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      lastErrorCode: "delivery_uncertain_timeout",
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      driftedRows: 1,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    // The terminal failed head was superseded by the new repair inside the
    // same transaction as the append: the predecessor guard now sees it as
    // superseded, so the repair is the claimable stream head.
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.effect_id).not.toBe(wedged.effectId);
    await expect(effectRow(adapter, wedged.effectId)).resolves.toMatchObject({
      status: "superseded",
      supersedes_effect_id: pending[0]?.effect_id,
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
    await expect(effectRow(adapter, pending[0]!.effect_id)).resolves.toMatchObject({
      status: "applied",
    });
    // The Sheet converges to the canonical state and the confirmed visible
    // state advances past the recovered head.
    expect(provider.readRow("physical-recon", "anchor-1").fields.status)
      .toEqual({ kind: "string", value: "paid" });
    await expect(adapter.read(({ sql }) => sql.get<{ readonly confirmed_visible_revision: number }>(
      "SELECT confirmed_visible_revision FROM sheet_visible_state WHERE physical_sheet_id = ? AND row_binding_id = ?",
      ["physical-recon", "binding-1"],
    ))).resolves.toMatchObject({ confirmed_visible_revision: 4 });
  });

  it("supersedes a terminal failed head with the in-flight correction when no append is needed", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 3,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "shipped" },
      _deleted: { kind: "boolean", value: false },
    }));
    const wedged = await seedFailedHead(adapter, {
      effectId: "effect-wedged",
      streamSequence: 1,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      },
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      lastErrorCode: "delivery_uncertain_timeout",
    });
    // An equivalent correction is already in flight behind the failed head
    // (appended while the head was processing, then blocked forever). Its
    // target matches the canonical state, so the scan must not append a
    // duplicate: it supersedes the failed head with the in-flight effect.
    const inFlight = await seedEffect(adapter, {
      effectId: "effect-inflight",
      streamSequence: 2,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
        _deleted: { kind: "boolean", value: false },
      },
      expectedVisibleRevision: 3,
      expectedVisibleHash: visibleHashFor({
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "shipped" },
        _deleted: { kind: "boolean", value: false },
      }),
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({ driftedRows: 1, effectsEnqueued: 0, fenceClaimed: true });
    // No duplicate correction was appended; the failed head was superseded
    // with the in-flight correction, which is now the claimable stream head.
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending.map((effect) => effect.effect_id)).toEqual([inFlight.effectId]);
    await expect(effectRow(adapter, wedged.effectId)).resolves.toMatchObject({
      status: "superseded",
      supersedes_effect_id: inFlight.effectId,
    });

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ applied: 1 });
    expect(provider.readRow("physical-recon", "anchor-1").fields.status)
      .toEqual({ kind: "string", value: "paid" });
  });

  it("repairs a wedged stream when the sheet already matches canonical and a follower is blocked", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      // The Sheet already matches canonical: no drift, yet the stream is
      // wedged behind a terminal failed head that blocks every follower.
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 3,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "paid" },
      _deleted: { kind: "boolean", value: false },
    }));
    const wedged = await seedFailedHead(adapter, {
      effectId: "effect-wedged-clean",
      streamSequence: 1,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      },
      expectedVisibleRevision: 3,
      expectedVisibleHash: visibleHashFor({
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      }),
      lastErrorCode: "delivery_uncertain_timeout",
    });
    // The blocked follower: an equivalent correction already in flight
    // behind the failed head (appended, then blocked forever by the durable
    // predecessor guard). Its target matches canonical, so the scan must
    // not append a duplicate: it supersedes the failed head with the
    // in-flight effect, which becomes the claimable stream head.
    const follower = await seedEffect(adapter, {
      effectId: "effect-follower-clean",
      streamSequence: 2,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
        _deleted: { kind: "boolean", value: false },
      },
      expectedVisibleRevision: 3,
      expectedVisibleHash: visibleHashFor({
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
        _deleted: { kind: "boolean", value: false },
      }),
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    // The Sheet matched canonical (no drift) yet the scan still repaired the
    // wedged stream: no duplicate was appended and the failed head was
    // superseded with the in-flight follower.
    expect(report).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending.map((effect) => effect.effect_id)).toEqual([follower.effectId]);
    await expect(effectRow(adapter, wedged.effectId)).resolves.toMatchObject({
      status: "superseded",
      supersedes_effect_id: follower.effectId,
    });

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    // The follower is no longer blocked: the stream progressed and the
    // canonical state is confirmed on the Sheet.
    expect(workerReport).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    await expect(effectRow(adapter, follower.effectId)).resolves.toMatchObject({
      status: "applied",
    });
  });

  it("appends a fresh repair superseding a terminal failed head when the sheet already matches and no correction is in flight", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 3,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "paid" },
      _deleted: { kind: "boolean", value: false },
    }));
    const wedged = await seedFailedHead(adapter, {
      effectId: "effect-wedged-clean-2",
      streamSequence: 1,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      },
      expectedVisibleRevision: 3,
      expectedVisibleHash: visibleHashFor({
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      }),
      lastErrorCode: "delivery_uncertain_timeout",
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    // No drift, but the terminal failed head wedges the stream: the scan
    // appends a fresh repair and supersedes the failed head with it in the
    // same fenced transaction.
    expect(report).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.effect_id).not.toBe(wedged.effectId);
    await expect(effectRow(adapter, wedged.effectId)).resolves.toMatchObject({
      status: "superseded",
      supersedes_effect_id: pending[0]?.effect_id,
    });

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    // The repair wrote the identical canonical values with CAS evidence and
    // the stream is unblocked for any later effect.
    expect(workerReport).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    await expect(effectRow(adapter, pending[0]!.effect_id)).resolves.toMatchObject({
      status: "applied",
    });
    expect(provider.readRow("physical-recon", "anchor-1").fields.status)
      .toEqual({ kind: "string", value: "paid" });
  });

  it("supersedes non-recoverable failed heads but leaves recoverable failed heads on the worker retry path", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
        {
          entityId: "order-2",
          rowBindingId: "binding-2",
          anchor: "anchor-2",
          fields: {
            id: { kind: "string", value: "order-2" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 3,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
        {
          targetId: "order-2",
          physicalAnchor: "anchor-2",
          visibleRevision: 3,
          fields: {
            id: { kind: "string", value: "order-2" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "shipped" },
      _deleted: { kind: "boolean", value: false },
    }));
    await seedVisibleState(adapter, "binding-2", 3, visibleHashFor({
      id: { kind: "string", value: "order-2" },
      status: { kind: "string", value: "shipped" },
      _deleted: { kind: "boolean", value: false },
    }));
    const terminal = await seedFailedHead(adapter, {
      effectId: "effect-terminal",
      streamSequence: 1,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: { id: { kind: "string", value: "order-1" }, status: { kind: "string", value: "paid" } },
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      lastErrorCode: "delivery_uncertain_timeout",
    });
    const recoverable = await seedFailedHead(adapter, {
      effectId: "effect-recoverable",
      streamSequence: 1,
      targetId: "order-2",
      rowBindingId: "binding-2",
      fields: { id: { kind: "string", value: "order-2" }, status: { kind: "string", value: "paid" } },
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      lastErrorCode: SYNC_EFFECT_RECOVERY_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
    });

    // The helper is the single source of truth for both the SQL retry
    // fragment and the scanner's supersede decision.
    expect(isRecoverableEffectErrorCode(SYNC_EFFECT_RECOVERY_ERROR_CODES.PROVIDER_RETRYABLE_ERROR)).toBe(true);
    expect(isRecoverableEffectErrorCode("delivery_uncertain_timeout")).toBe(false);
    expect(isRecoverableEffectErrorCode(null)).toBe(false);
    expect(isRecoverableEffectErrorCode(undefined)).toBe(false);

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({ driftedRows: 2, effectsEnqueued: 2, fenceClaimed: true });
    await expect(effectRow(adapter, terminal.effectId)).resolves.toMatchObject({
      status: "superseded",
    });
    // The recoverable failed head stays failed and remains selectable by the
    // worker's retry path; its stream got a trailing repair (blocked behind
    // the head until the worker settles it) but no supersede.
    await expect(effectRow(adapter, recoverable.effectId)).resolves.toMatchObject({
      status: "failed",
      last_error_code: SYNC_EFFECT_RECOVERY_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
    });
    const ready = await listReadyEffectsWithAdapter(adapter, 10);
    expect(ready.some((effect) => effect.effect_id === recoverable.effectId)).toBe(true);
  });

  it("applies a create-if-missing repair on a binding with a higher confirmed revision without regressing confirmed state", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      // The row is missing from the Sheet entirely (deleted after it was
      // applied); the durable confirmed revision is 3 from that earlier
      // write history.
      sheetRows: [],
    });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "paid" },
      _deleted: { kind: "boolean", value: false },
    }));

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });
    expect(report).toMatchObject({ missingRows: 1, effectsEnqueued: 1 });

    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    // The repair is a create-if-missing effect with an empty visible
    // baseline (revision 0), so the provider's receipt restarts at revision 1.
    expect(pending[0]?.expected_visible_revision).toBe(0);

    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ applied: 1 });
    await expect(effectRow(adapter, pending[0]!.effect_id)).resolves.toMatchObject({
      status: "applied",
    });
    // The confirmation advances the durable revision past the confirmed 3
    // (confirmed + 1) instead of rejecting the applied repair as a
    // regression and wedging it in delivery_uncertain forever.
    await expect(adapter.read(({ sql }) => sql.get<{ readonly confirmed_visible_revision: number }>(
      "SELECT confirmed_visible_revision FROM sheet_visible_state WHERE physical_sheet_id = ? AND row_binding_id = ?",
      ["physical-recon", "binding-1"],
    ))).resolves.toMatchObject({ confirmed_visible_revision: 4 });
    // The row was re-created remotely through the append path (it carries a
    // sync anchor, never the advisory anchor), with the canonical fields.
    const snapshot = await provider.readSnapshot({
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
    });
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.cells.id?.normalizedCell)
      .toEqual({ kind: "string", value: "order-1" });
    expect(snapshot.rows[0]?.cells.status?.normalizedCell)
      .toEqual({ kind: "string", value: "paid" });

    // The repaired tab converges: a re-scan finds no drift and enqueues
    // nothing.
    const rescan = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });
    expect(rescan).toMatchObject({ missingRows: 0, driftedRows: 0, effectsEnqueued: 0 });
  });

  it("floors the follower repair revision at the confirmed state when a create-baseline repair is in flight", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      // The row is missing from the Sheet entirely (deleted after it was
      // applied); the durable confirmed revision is 3 from that earlier
      // write history.
      sheetRows: [],
      // Snapshot reads carry the real provider's shape: visible revision
      // and hash stay in SQLite, never on the snapshot rows.
    }, { realProviderSnapshotShape: true });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "paid" },
      _deleted: { kind: "boolean", value: false },
    }));

    const scanOptions = {
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
    };
    // One id source shared by every scan so effect ids stay unique across
    // the whole scenario.
    const scanIds = counter();

    // Scan 1 enqueues the create-baseline repair (empty visible baseline,
    // expected revision 0) and leaves it in flight.
    const firstScan = await runReconciliationScan({
      ...scanOptions,
      createId: scanIds,
    });
    expect(firstScan).toMatchObject({ missingRows: 1, effectsEnqueued: 1 });
    const repair = await listReadyEffectsWithAdapter(adapter, 10);
    expect(repair).toHaveLength(1);
    expect(repair[0]?.expected_visible_revision).toBe(0);
    const repairId = repair[0]!.effect_id;
    const repairPayload = parseSyncProjectionEffectPayload(repair[0]!.payload_json);

    // The repair's remote write landed (the row reappears with the repair's
    // target content) but the response was lost and the probe is still
    // pending: the outbox holds the repair as delivery_uncertain, exactly
    // like a worker pass that defers after an unavailable postcondition
    // read.
    provider.restoreRow(
      "physical-recon",
      "anchor-1",
      "order-1",
      repairPayload.fields,
    );
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'delivery_uncertain', claim_token = NULL, lease_until = NULL, uncertain_since = ?, next_probe_at = ? WHERE effect_id = ?",
      [5_000, 5_100, repairId],
    ));

    // Canonical content changes while the repair is still in flight: the
    // desired status becomes "shipped".
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE entity_field_state SET normalized_value = ? WHERE entity_id = ? AND field_name = ?",
      [JSON.stringify({ kind: "string", value: "shipped" }), "order-1", "status"],
    ));

    // Scan 2: the row is present but stale, so the drift is a drifted-row
    // repair appended behind the uncertain create-baseline repair. Its
    // expected revision must be floored at the confirmed revision (3), not
    // the repair's expected + 1 (1): after the create-baseline repair
    // settles, the durable revision clamps to confirmed + 1, and a
    // follower whose receipt echoes 1 + 1 = 2 would be rejected by the
    // confirmation upsert guard as a regression, wedging the stream.
    const secondScan = await runReconciliationScan({
      ...scanOptions,
      createId: scanIds,
    });
    expect(secondScan).toMatchObject({ driftedRows: 1, missingRows: 0, effectsEnqueued: 1 });
    // Only the repair is claimable while it is uncertain; the follower sits
    // behind it in the stream. Read the whole stream to inspect both.
    const streamEffects = await adapter.read(({ sql }) => sql.all<{
      readonly effect_id: string;
      readonly expected_visible_revision: number;
      readonly expected_visible_hash: string;
    }>(
      "SELECT effect_id, expected_visible_revision, expected_visible_hash FROM sheet_effect_outbox WHERE logical_sheet_id = ? AND target_kind = 'entity' AND target_id = ? ORDER BY stream_sequence",
      ["logical-recon", "order-1"],
    ));
    expect(streamEffects).toHaveLength(2);
    const follower = streamEffects.find((effect) => effect.effect_id !== repairId);
    expect(follower).toBeDefined();
    expect(follower!.expected_visible_revision).toBe(3);
    // The follower still carries the in-flight repair's target hash: that is
    // the hash the sheet will show once the create-baseline repair applies.
    expect(follower!.expected_visible_hash).toBe(repairPayload.targetVisibleHash);

    // The probe settles the create-baseline repair (clamping the durable
    // revision to 4); the follower becomes claimable only after its
    // predecessor settles. Its receipt revision 4 then clears the
    // confirmation guard instead of regressing it.
    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerOptions = {
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_101,
      maxEffects: 10,
    };
    await expect(runEffectWorkerWithAdapter(workerOptions)).resolves.toMatchObject({ applied: 1, failed: 0 });
    await expect(effectRow(adapter, repairId)).resolves.toMatchObject({ status: "applied" });
    await expect(runEffectWorkerWithAdapter({ ...workerOptions, now: 5_102 })).resolves.toMatchObject({ applied: 1, failed: 0 });
    await expect(effectRow(adapter, follower!.effect_id)).resolves.toMatchObject({ status: "applied" });
    await expect(adapter.read(({ sql }) => sql.get<{ readonly confirmed_visible_revision: number }>(
      "SELECT confirmed_visible_revision FROM sheet_visible_state WHERE physical_sheet_id = ? AND row_binding_id = ?",
      ["physical-recon", "binding-1"],
    ))).resolves.toMatchObject({ confirmed_visible_revision: 4 });

    // The stream settles: a re-scan finds no drift and enqueues nothing.
    const rescan = await runReconciliationScan({
      ...scanOptions,
      createId: scanIds,
    });
    expect(rescan).toMatchObject({ missingRows: 0, driftedRows: 0, effectsEnqueued: 0 });
  });

  it("repairs a clean failed-head stream from observed evidence when no confirmed state exists", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      // The Sheet already contains the row and it matches canonical, but the
      // local visible-state confirmation is ABSENT (a response-loss restart:
      // no sheet_visible_state row). The terminal failed head was a create
      // baseline that delivery-uncertain timed out.
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 4,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });
    const wedged = await seedFailedHead(adapter, {
      effectId: "effect-wedged-clean-noconf",
      streamSequence: 1,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      },
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      lastErrorCode: "delivery_uncertain_timeout",
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });

    expect(report).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    const repair = pending[0]!;
    const payload = parseSyncProjectionEffectPayload(repair.payload_json);
    // The repair is a GUARDED regular repair, not the old unguarded insert
    // baseline: no confirmed state exists, so the observed row's current
    // visible hash becomes the expected-hash guard and createIfMissing must
    // be false — the row already exists, so an insert would fail on identity.
    expect(payload.createIfMissing).toBe(false);
    expect(repair.expected_visible_hash).toBe(visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "paid" },
      _deleted: { kind: "boolean", value: false },
    }));
    expect(repair.expected_visible_revision).toBe(0);
    await expect(effectRow(adapter, wedged.effectId)).resolves.toMatchObject({
      status: "superseded",
      supersedes_effect_id: repair.effect_id,
    });

    // The repair converges through the worker without an insert identity
    // failure: the existing row matches its guarded expectation.
    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ selected: 1, claimed: 1, applied: 1, failed: 0 });
    await expect(effectRow(adapter, repair.effect_id)).resolves.toMatchObject({
      status: "applied",
    });
    // The stream is recovered: a re-scan finds no drift and no failed head.
    const rescan = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });
    expect(rescan).toMatchObject({
      matchedRows: 1,
      driftedRows: 0,
      missingRows: 0,
      effectsEnqueued: 0,
    });
  });

  it("repairs a drifted row from observed evidence when no confirmed state exists", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      // The Sheet already contains the row but with stale content
      // ("shipped"), and no sheet_visible_state confirmation exists (a
      // response-loss restart). The old insert baseline produced a repair
      // that the provider rejected forever as an insert for an existing
      // identity; the observed row's current visible hash must guard a
      // regular update instead.
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 4,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });

    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });
    expect(report).toMatchObject({
      driftedRows: 1,
      missingRows: 0,
      effectsEnqueued: 1,
    });

    const pending = await listReadyEffectsWithAdapter(adapter, 10);
    expect(pending).toHaveLength(1);
    const repair = pending[0]!;
    const payload = parseSyncProjectionEffectPayload(repair.payload_json);
    // Guarded regular repair: createIfMissing false, non-empty observed
    // expected hash (the CURRENT "shipped" row), receipt revision 0.
    expect(payload.createIfMissing).toBe(false);
    expect(payload.targetVisibleHash).toBe(visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "paid" },
      _deleted: { kind: "boolean", value: false },
    }));
    expect(repair.expected_visible_hash).toBe(visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "shipped" },
      _deleted: { kind: "boolean", value: false },
    }));
    expect(repair.expected_visible_revision).toBe(0);

    // The repair converges through the worker: the observed hash passes the
    // CAS guard and the row is updated to canonical without overwriting
    // anything unguarded.
    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const workerReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 5_000,
      maxEffects: 10,
    });
    expect(workerReport).toMatchObject({ selected: 1, claimed: 1, applied: 1, failed: 0 });
    await expect(effectRow(adapter, repair.effect_id)).resolves.toMatchObject({
      status: "applied",
    });
    expect(provider.readRow("physical-recon", "anchor-1").fields.status)
      .toEqual({ kind: "string", value: "paid" });

    // The stream settles: a re-scan finds no drift and enqueues nothing.
    const rescan = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => 5_000,
      createId: counter(),
    });
    expect(rescan).toMatchObject({ missingRows: 0, driftedRows: 0, effectsEnqueued: 0 });
  });

  it("reports zero effects instead of throwing when the fence is lost during a supersede-only recovery", async () => {
    const { adapter, provider } = await bootstrap({
      entities: [
        {
          entityId: "order-1",
          rowBindingId: "binding-1",
          anchor: "anchor-1",
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "paid" },
          },
        },
      ],
      sheetRows: [
        {
          targetId: "order-1",
          physicalAnchor: "anchor-1",
          visibleRevision: 3,
          fields: {
            id: { kind: "string", value: "order-1" },
            status: { kind: "string", value: "shipped" },
            _deleted: { kind: "boolean", value: false },
          },
        },
      ],
    });
    await seedVisibleState(adapter, "binding-1", 3, visibleHashFor({
      id: { kind: "string", value: "order-1" },
      status: { kind: "string", value: "shipped" },
      _deleted: { kind: "boolean", value: false },
    }));
    const wedged = await seedFailedHead(adapter, {
      effectId: "effect-wedged",
      streamSequence: 1,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
      },
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      lastErrorCode: "delivery_uncertain_timeout",
    });
    // An equivalent correction is already in flight behind the failed head,
    // so the scan plans a supersede-only recovery (no append).
    const inFlight = await seedEffect(adapter, {
      effectId: "effect-inflight",
      streamSequence: 2,
      targetId: "order-1",
      rowBindingId: "binding-1",
      fields: {
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "paid" },
        _deleted: { kind: "boolean", value: false },
      },
      expectedVisibleRevision: 3,
      expectedVisibleHash: visibleHashFor({
        id: { kind: "string", value: "order-1" },
        status: { kind: "string", value: "shipped" },
        _deleted: { kind: "boolean", value: false },
      }),
    });

    // The reconciler clock advances between the fence claim and the fence
    // snapshot captured for the supersede: the lease the scan just claimed
    // is already expired when the supersede-only recovery runs, exactly like
    // a lease lost to a concurrent pass between baseline and enqueue.
    let clockCall = 0;
    const report = await runReconciliationScan({
      storage: adapter,
      provider,
      physicalSheetId: "physical-recon",
      logicalSheetId: "logical-recon",
      systemFields: [...SYSTEM_HEADERS],
      schemaVersion: 1,
      writerId: "reconciler",
      now: () => {
        clockCall += 1;
        return clockCall === 1 ? 5_000 : 105_000;
      },
      createId: counter(),
    });

    // A lost fence is not a scan failure: the scan settles as a 0-effect
    // report instead of throwing STALE_WRITER_FENCE out of the scan.
    expect(report).toMatchObject({ driftedRows: 1, effectsEnqueued: 0, fenceClaimed: true });
    // Nothing was superseded or appended: the terminal failed head and the
    // in-flight correction stay untouched for the next scan to re-evaluate.
    await expect(effectRow(adapter, wedged.effectId)).resolves.toMatchObject({
      status: "failed",
      last_error_code: "delivery_uncertain_timeout",
    });
    await expect(effectRow(adapter, inFlight.effectId)).resolves.toMatchObject({
      status: "pending",
    });
  });
});

interface DesiredEntityInput {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly anchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

interface SheetRowInput {
  readonly targetId: string;
  /** `null` models a row without Developer Metadata anchor assignment. */
  readonly physicalAnchor: string | null;
  readonly visibleRevision?: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

interface BootstrapResult {
  readonly adapter: MikroOrmSqliteAdapter;
  readonly provider: FakeSyncSheetsProvider;
}

async function bootstrap(
  args: {
    readonly entities: readonly DesiredEntityInput[];
    readonly sheetRows: readonly SheetRowInput[];
  },
  providerOptions?: ConstructorParameters<typeof FakeSyncSheetsProvider>[1],
): Promise<BootstrapResult> {
  const orm = await createOrm();
  const adapter = new MikroOrmSqliteAdapter(orm);
  await migrateSqliteSchema(adapter);
  await seedRegistryAndEntities(adapter, args.entities);

  const provider = new FakeSyncSheetsProvider([
    {
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      headers: [...SYSTEM_HEADERS],
      rows: args.sheetRows.map((row) => {
        const base = {
          targetId: row.targetId,
          physicalAnchor: row.physicalAnchor,
          fields: row.fields,
        } as const;
        return row.visibleRevision === undefined
          ? base
          : { ...base, visibleRevision: row.visibleRevision };
      }),
    },
  ], providerOptions);

  return { adapter, provider };
}

async function seedRegistryAndEntities(
  adapter: MikroOrmSqliteAdapter,
  entities: readonly DesiredEntityInput[],
): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-recon", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-recon", "logical-recon", "spreadsheet", "Orders", "A:C", "system_state", 1],
    );
    for (const entity of entities) {
      await sql.run(
        "INSERT INTO entity_state (entity_id, entity_revision, status) VALUES (?, ?, ?)",
        [entity.entityId, 1, "active"],
      );
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES (?, ?, ?, ?, ?)",
        [entity.rowBindingId, "logical-recon", entity.anchor, entity.entityId, "active"],
      );
      for (const [fieldName, value] of Object.entries(entity.fields)) {
        await sql.run(
          "INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES (?, ?, ?, ?, ?)",
          [entity.entityId, fieldName, JSON.stringify(value), 1, "system"],
        );
      }
    }
  });
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

async function noPendingEffects(adapter: MikroOrmSqliteAdapter): Promise<number> {
  const ready = await listReadyEffectsWithAdapter(adapter, 100);
  return ready.length;
}

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

function visibleHashFor(fields: Readonly<Record<string, NormalizedCell>>): string {
  return computeSyncVisibleHash(fields);
}

async function seedVisibleState(
  adapter: MikroOrmSqliteAdapter,
  rowBindingId: string,
  revision: number,
  snapshotHash: string,
): Promise<void> {
  await adapter.transaction(({ sql }) => sql.run(
    "INSERT INTO sheet_visible_state (physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash, confirmed_visible_revision, confirmed_entity_revision, last_observed_hash) VALUES (?, 'system_state', ?, ?, ?, 1, ?)",
    ["physical-recon", rowBindingId, snapshotHash, revision, snapshotHash],
  ));
}

interface SeedEffectInput {
  readonly effectId: string;
  readonly streamSequence: number;
  readonly targetId: string;
  readonly rowBindingId: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
}

/** Appends one system_projection effect under a seed writer fence. */
async function seedEffect(
  adapter: MikroOrmSqliteAdapter,
  input: SeedEffectInput,
): Promise<{ readonly effectId: string }> {
  const claim = await claimWriterLeaseWithAdapter(adapter, {
    role: "seed-writer",
    writerId: "seed-writer",
    leaseDurationMs: 60_000,
    now: 5_000,
  });
  if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    throw new Error("seed writer fence unavailable");
  }
  const effect = createSystemProjectionEffect({
    effectId: input.effectId,
    commitId: "commit-seed",
    logicalSheetId: "logical-recon",
    physicalSheetId: "physical-recon",
    sheetName: "Orders",
    registeredRange: "A:C",
    projection: "system_state",
    schemaVersion: 1,
    targetKind: "entity",
    targetId: input.targetId,
    rowBindingId: { kind: "present", value: input.rowBindingId },
    conflictId: { kind: "absent" },
    targetAnchor: input.targetId === "order-1" ? "anchor-1" : "anchor-2",
    fields: input.fields,
    createIfMissing: input.expectedVisibleRevision === 0 && input.expectedVisibleHash === "",
    expectedVisibleRevision: input.expectedVisibleRevision,
    expectedVisibleHash: input.expectedVisibleHash,
    streamSequence: input.streamSequence,
  });
  await expect(appendPendingEffectsWithAdapter(adapter, {
    role: claim.lease.role,
    writerEpoch: claim.lease.writerEpoch,
    fencingToken: claim.lease.fencingToken,
    now: 5_000,
  }, [effect])).resolves.toBe(true);
  return { effectId: input.effectId };
}

/** Appends a system_projection effect and force-settles it as a failed head. */
async function seedFailedHead(
  adapter: MikroOrmSqliteAdapter,
  input: SeedEffectInput & { readonly lastErrorCode: string },
): Promise<{ readonly effectId: string }> {
  const seeded = await seedEffect(adapter, input);
  await adapter.transaction(({ sql }) => sql.run(
    "UPDATE sheet_effect_outbox SET status = 'failed', claim_token = NULL, lease_until = NULL, next_attempt_at = NULL, last_error_code = ?, last_error_message = ? WHERE effect_id = ?",
    [input.lastErrorCode, "seeded terminal failure", input.effectId],
  ));
  return seeded;
}

async function effectRow(
  adapter: MikroOrmSqliteAdapter,
  effectId: string,
): Promise<{
  readonly status: string;
  readonly supersedes_effect_id: string | null;
  readonly last_error_code: string | null;
} | undefined> {
  return adapter.read(({ sql }) => sql.get<{
    readonly status: string;
    readonly supersedes_effect_id: string | null;
    readonly last_error_code: string | null;
  }>(
    "SELECT status, supersedes_effect_id, last_error_code FROM sheet_effect_outbox WHERE effect_id = ?",
    [effectId],
  ));
}
