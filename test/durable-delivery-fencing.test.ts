import { defineEntity, MikroORM, NodeSqliteDialect, p, SqliteDriver } from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import {
  appendPendingEffectsWithAdapter,
  claimEffectWithAdapter,
  claimWriterLeaseWithAdapter,
  listReadyEffectsWithAdapter,
  markDeliveryUncertainWithAdapter,
  recoverExpiredLeasesWithAdapter,
} from "@hikoutei/ikisaki";
import {
  ensureSpreadsheetAuthorityWithAdapter,
  readSpreadsheetAuthorityWithAdapter,
} from "../src/infrastructure/storage/sync/shared/spreadsheetAuthority.js";
import { migrateSqliteSchema } from "../src/infrastructure/storage/sqlite/migrateSchema.js";
import { MikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "../src/shared/state/constants.js";
import type { NewEffect } from "@hikoutei/ikisaki";

describe("durable delivery and spreadsheet fencing", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("migrates the outbox and authority tables with durable probe columns", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateSqliteSchema(adapter);

    await expect(adapter.read(({ sql }) => sql.get<{ readonly user_version: number }>("PRAGMA user_version")))
      .resolves.toEqual({ user_version: 6 });
    const columns = await adapter.read(({ sql }) => sql.all<{ readonly name: string }>(
      "PRAGMA table_info(sheet_effect_outbox)",
    ));
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "next_attempt_at",
      "uncertain_since",
      "next_probe_at",
      "dispatch_id",
    ]));
    await expect(adapter.read(({ sql }) => sql.get<{ readonly name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ["spreadsheet_authority"],
    ))).resolves.toEqual({ name: "spreadsheet_authority" });
  });

  it("upgrades a v4 outbox table to durable delivery without losing rows", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateSqliteSchema(adapter);

    // Rewrite the outbox into its pre-v5 shape (no durable delivery columns)
    // with the v4 stream index, seed a row, then rewind the version marker so
    // the next startup must run the v5 rebuild.
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
        ["logical-v4", 1, "{}", "id"],
      );
      await sql.run(
        "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["physical-v4", "logical-v4", "spreadsheet-v4", "Orders", "A:B", "system_state", 1],
      );
      await sql.run("DROP INDEX IF EXISTS effect_outbox_probe_idx");
      await sql.run("DROP INDEX IF EXISTS effect_outbox_stream_idx");
      await sql.run("ALTER TABLE sheet_effect_outbox RENAME TO sheet_effect_outbox_v4");
      await sql.run(V4_OUTBOX_TABLE_DDL);
      await sql.run(`
        INSERT INTO sheet_effect_outbox (
          effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
          projection, row_binding_id, conflict_id, target_kind, target_id,
          target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
          expected_visible_revision, expected_visible_hash, repair_guard_hash,
          source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
          stream_sequence, status, attempts, claim_token, last_error_code,
          last_error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        "effect-v4",
        "system_projection",
        "commit-v4",
        "logical-v4",
        "physical-v4",
        "system_state",
        null,
        null,
        "entity",
        "order-v4",
        null,
        null,
        null,
        0,
        "",
        null,
        null,
        "{}",
        "payload-v4",
        "dedupe-v4",
        1,
        "pending",
        0,
        "claim-v4",
        null,
        null,
        0,
      ]);
      await sql.run("DROP TABLE sheet_effect_outbox_v4");
      await sql.run("PRAGMA user_version = 4");
    });

    // The v5 index must not be created against the v4 table (next_probe_at
    // does not exist yet); the rebuild must run and then recreate the index.
    await expect(migrateSqliteSchema(adapter)).resolves.toEqual({
      fromVersion: 4,
      toVersion: 6,
      appliedVersions: [5, 6],
    });

    const columns = await adapter.read(({ sql }) => sql.all<{ readonly name: string }>(
      "PRAGMA table_info(sheet_effect_outbox)",
    ));
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "next_attempt_at",
      "uncertain_since",
      "next_probe_at",
      "dispatch_id",
    ]));
    await expect(adapter.read(({ sql }) => sql.get<{ readonly name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      ["effect_outbox_probe_idx"],
    ))).resolves.toEqual({ name: "effect_outbox_probe_idx" });
    // The rebuild preserves every row; the v5 copy maps claim_token into
    // dispatch_id while keeping the rest of the effect evidence intact.
    await expect(adapter.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly dispatch_id: string | null;
      readonly claim_token: string | null;
      readonly payload_hash: string;
    }>(
      "SELECT status, dispatch_id, claim_token, payload_hash FROM sheet_effect_outbox WHERE effect_id = ?",
      ["effect-v4"],
    ))).resolves.toEqual({
      status: "pending",
      dispatch_id: "claim-v4",
      claim_token: "claim-v4",
      payload_hash: "payload-v4",
    });
  });

  it("persists dispatch identity and only exposes uncertain effects at probe time", async () => {
    const { adapter, fence } = await setupStorage(openOrms, "probe-worker", 1_000);
    const effect = makeEffect();
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

    await expect(claimEffectWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      dispatchId: "dispatch-1",
      leaseDurationMs: 10_000,
    })).resolves.toMatchObject({ status: "claimed" });
    await expect(adapter.read(({ sql }) => sql.get<{ dispatch_id: string; status: string }>(
      "SELECT dispatch_id, status FROM sheet_effect_outbox WHERE effect_id = ?",
      [effect.effectId],
    ))).resolves.toEqual({ dispatch_id: "dispatch-1", status: "processing" });

    await expect(markDeliveryUncertainWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      uncertainSince: 1_000,
      nextProbeAt: 2_000,
      lastErrorCode: "delivery_uncertain_requires_probe",
      lastErrorMessage: "response was lost",
    })).resolves.toBe(true);
    await expect(listReadyEffectsWithAdapter(adapter, 10, 1_999)).resolves.toHaveLength(0);
    await expect(listReadyEffectsWithAdapter(adapter, 10, 2_000)).resolves.toMatchObject([
      { effect_id: effect.effectId, status: "delivery_uncertain", dispatch_id: "dispatch-1" },
    ]);
  });

  it("rejects stale spreadsheet authority and recovers expired processing as uncertain", async () => {
    const { adapter, fence } = await setupStorage(openOrms, "authority-a", 3_000);
    await expect(ensureSpreadsheetAuthorityWithAdapter(adapter, {
      ...fence,
      physicalSheetId: "physical-probe",
      ownerId: "authority-a",
    })).resolves.toMatchObject({ kind: "claimed" });
    await expect(readSpreadsheetAuthorityWithAdapter(adapter, "physical-probe"))
      .resolves.toMatchObject({ authorityEpoch: fence.writerEpoch, ownerId: "authority-a" });
    await expect(ensureSpreadsheetAuthorityWithAdapter(adapter, {
      ...fence,
      physicalSheetId: "physical-probe",
      ownerId: "authority-b",
    })).resolves.toEqual({ kind: "fenced_out" });

    const effect = makeEffect("expired");
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'processing', claim_token = ?, writer_epoch = ?, lease_until = ? WHERE effect_id = ?",
      ["expired-claim", fence.writerEpoch, 2_999, effect.effectId],
    ));
    await expect(recoverExpiredLeasesWithAdapter(adapter, fence)).resolves.toBe(1);
    await expect(adapter.read(({ sql }) => sql.get<{ readonly status: string; readonly next_probe_at: number }>(
      "SELECT status, next_probe_at FROM sheet_effect_outbox WHERE effect_id = ?",
      [effect.effectId],
    ))).resolves.toEqual({ status: "delivery_uncertain", next_probe_at: 3_000 });
  });
});

async function createOrm() {
  return MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [defineEntity({
      name: "DurableDeliveryEntity",
      tableName: "durable_delivery_entity",
      properties: { id: p.string().primary() },
    })],
  });
}

async function setupStorage(
  openOrms: Array<Awaited<ReturnType<typeof createOrm>>>,
  writerId: string,
  now: number,
): Promise<{ readonly adapter: MikroOrmSqliteAdapter; readonly fence: {
  readonly role: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly now: number;
} }> {
  const orm = await createOrm();
  openOrms.push(orm);
  const adapter = new MikroOrmSqliteAdapter(orm);
  await migrateSqliteSchema(adapter);
  const lease = await claimWriterLeaseWithAdapter(adapter, {
    role: "sync-effect-worker",
    writerId,
    leaseDurationMs: 10_000,
    now,
  });
  if (lease.kind !== "claimed") throw new Error("expected writer lease");
  const fence = {
    role: lease.lease.role,
    writerEpoch: lease.lease.writerEpoch,
    fencingToken: lease.lease.fencingToken,
    now,
  } as const;
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-probe", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-probe", "logical-probe", "spreadsheet-probe", "Probe", "A:B", "system_state", 1],
    );
  });
  return { adapter, fence };
}

/** Pre-v5 outbox table shape used to exercise the durable delivery rebuild. */
const V4_OUTBOX_TABLE_DDL = `
  CREATE TABLE sheet_effect_outbox (
    effect_id TEXT PRIMARY KEY,
    effect_kind TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    physical_sheet_id TEXT NOT NULL REFERENCES physical_sheet_registry(physical_sheet_id),
    projection TEXT NOT NULL,
    row_binding_id TEXT,
    conflict_id TEXT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('entity', 'row_binding', 'projection_row', 'conflict')),
    target_id TEXT NOT NULL,
    target_entity_revision INTEGER,
    target_field_revision_hash TEXT,
    target_canonical_commit_id TEXT,
    expected_visible_revision INTEGER NOT NULL,
    expected_visible_hash TEXT NOT NULL,
    repair_guard_hash TEXT,
    source_quarantine_id TEXT,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    effect_dedupe_key TEXT NOT NULL UNIQUE,
    stream_sequence INTEGER NOT NULL,
    predecessor_effect_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'applied', 'blocked_candidate', 'superseded', 'conflict', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    next_attempt_at INTEGER,
    claim_token TEXT,
    writer_epoch INTEGER,
    supersedes_effect_id TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(logical_sheet_id, target_kind, target_id, stream_sequence)
  );

  CREATE INDEX IF NOT EXISTS effect_outbox_stream_idx
    ON sheet_effect_outbox(logical_sheet_id, target_kind, target_id, stream_sequence)
    WHERE status IN ('pending', 'processing');
`;

function makeEffect(suffix = "probe"): NewEffect {
  return {
    effectId: "effect-" + suffix,
    effectKind: "system_projection",
    commitId: "commit-" + suffix,
    logicalSheetId: "logical-probe",
    physicalSheetId: "physical-probe",
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId: "entity-" + suffix,
    targetEntityRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: "{}",
    payloadHash: "payload-" + suffix,
    effectDedupeKey: "dedupe-" + suffix,
    streamSequence: suffix === "probe" ? 1 : 2,
  };
}
