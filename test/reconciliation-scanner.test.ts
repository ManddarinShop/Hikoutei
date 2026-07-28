import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { FakeSyncSheetGateway } from "./support/FakeSyncSheetGateway.js";
import {
  migrateMikroOrmSqliteSchema,
  MikroOrmSqliteAdapter,
} from "../src/adapter/persistence/providers/mikro-orm/index.js";
import {
  runReconciliationScan,
  RECONCILIATION_DEFAULTS,
} from "../src/application/sync/operations/ReconciliationScanner.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  listReadyEffectsWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "../src/infrastructure/storage/index.js";
import { createSystemProjectionEffect } from "../src/application/sync/projection/ProjectionEffectFactory.js";
import type { NormalizedCell } from "../src/domain/index.js";

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
    const { adapter, gateway } = await bootstrap({
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
      gateway,
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

  it("matches a fast-appended row by business key without creating a duplicate", async () => {
    const { adapter, gateway } = await bootstrap({
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
      gateway,
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

  it("enqueues a correction effect when the sheet drifted from canonical", async () => {
    const { adapter, gateway } = await bootstrap({
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
      gateway,
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
    const { adapter, gateway } = await bootstrap({
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
      gateway,
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
    const { adapter, gateway } = await bootstrap({
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
      gateway,
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

  it("leaves extra sheet rows untouched in the report without enqueuing effects", async () => {
    const { adapter, gateway } = await bootstrap({
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
      gateway,
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
    const { adapter, gateway } = await bootstrap({
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
      gateway,
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
});

interface DesiredEntityInput {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly anchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

interface SheetRowInput {
  readonly targetId: string;
  readonly physicalAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

interface BootstrapResult {
  readonly adapter: MikroOrmSqliteAdapter;
  readonly gateway: FakeSyncSheetGateway;
}

async function bootstrap(args: {
  readonly entities: readonly DesiredEntityInput[];
  readonly sheetRows: readonly SheetRowInput[];
}): Promise<BootstrapResult> {
  const orm = await createOrm();
  const adapter = new MikroOrmSqliteAdapter(orm);
  await migrateMikroOrmSqliteSchema(adapter);
  await seedRegistryAndEntities(adapter, args.entities);

  const gateway = new FakeSyncSheetGateway([
    {
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      headers: [...SYSTEM_HEADERS],
      rows: args.sheetRows.map((row) => ({
        targetId: row.targetId,
        physicalAnchor: row.physicalAnchor,
        fields: row.fields,
      })),
    },
  ]);

  return { adapter, gateway };
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
