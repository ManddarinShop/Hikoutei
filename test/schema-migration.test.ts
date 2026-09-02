/**
 * SQLite schema v7 cleanup migration tests (Phase 7a).
 *
 * Covers the four contract paths of the v7 step:
 *  - fresh install lands on v7 with the cleanup already applied,
 *  - a genuine in-place v6 → v7 migration drops the orphan
 *    `projection_row_binding` table and the dead columns (the five
 *    write-never columns losslessly; the three quarantine repair columns by
 *    owner-approved intentional deletion of never-read data),
 *  - reopening an already-v7 database applies nothing,
 *  - a database stamped newer than v7 refuses to open.
 *
 * The v6 store is simulated the same way the conflict-system suite does:
 * migrate to the current version, stamp an older marker, then re-introduce
 * the pre-v7 state. `SCHEMA_VERSION_TOO_NEW` and dropped-state verification
 * helpers exercise the real `migrateSqliteSchema` code path; the assertion
 * on the `api/entity.ts` reserved list pins the durable contract that the
 * dropped table's name REMAINS reserved after v7 (the absence verification
 * in migrateSchema.ts depends on it, and a user entity must not race it).
 */

import { afterEach, describe, expect, it } from "vitest";
import { defineEntity, p } from "@mikro-orm/sql";

import { defineTypedSheetsEntity } from "../src/index.js";
import { HikouteiError, HIKOUTEI_ERROR_CODES } from "@hikoutei/sync-engine/api/errors.js";
import {
  initializeMikroOrmSqliteAdapter,
  type MikroOrmSqliteAdapter,
} from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";
import { migrateSqliteSchema } from "@hikoutei/storage/storage/sqlite/migrateSchema.js";
import { STORAGE_ERROR_CODES } from "@hikoutei/storage/storage/errors.js";
import type { SqlExecutor } from "@hikoutei/contracts/storage/sql.js";
import { RESERVED_TABLE_NAMES } from "@hikoutei/sync-engine/api/entity.js";

const MigrationOrderSchema = defineEntity({
  name: "SchemaMigrationOrder",
  tableName: "schema_migration_orders",
  properties: {
    id: p.string().primary(),
    status: p.string(),
  },
});

class SchemaMigrationOrder extends MigrationOrderSchema.class {
  declare id: string;
  declare status: string;
}

MigrationOrderSchema.setClass(SchemaMigrationOrder);

const openAdapters: Array<{ readonly close: (deleteFile?: boolean) => Promise<void> }> = [];

async function createAdapter(): Promise<MikroOrmSqliteAdapter> {
  const adapter = await initializeMikroOrmSqliteAdapter({
    dbName: ":memory:",
    entities: [SchemaMigrationOrder],
  });
  openAdapters.push(adapter);
  return adapter;
}

afterEach(() => {
  openAdapters.splice(0).map((adapter) => adapter.close(true).catch(() => undefined));
});

/** Re-introduces every piece of pre-v7 state dropped by the cleanup. */
async function reintroducePreV7State(sql: SqlExecutor): Promise<void> {
  await sql.run("ALTER TABLE sheet_registry ADD COLUMN locale TEXT");
  await sql.run("ALTER TABLE sheet_registry ADD COLUMN timezone TEXT");
  await sql.run(
    "ALTER TABLE sheet_registry ADD COLUMN stable_encode_version TEXT NOT NULL DEFAULT 'stable_encode_v1'",
  );
  await sql.run("ALTER TABLE event_observation ADD COLUMN redacted_at INTEGER");
  await sql.run("ALTER TABLE observation_receipt ADD COLUMN redacted_at INTEGER");
  await sql.run(
    "ALTER TABLE quarantine_record ADD COLUMN repair_fields_json TEXT NOT NULL DEFAULT '[]'",
  );
  await sql.run("ALTER TABLE quarantine_record ADD COLUMN repair_state TEXT");
  await sql.run("ALTER TABLE quarantine_record ADD COLUMN candidate_payload_json TEXT");
  await sql.run(`
    CREATE TABLE projection_row_binding (
      projection_row_id TEXT PRIMARY KEY,
      physical_sheet_id TEXT NOT NULL REFERENCES physical_sheet_registry(physical_sheet_id),
      row_binding_id TEXT REFERENCES row_binding(row_binding_id),
      conflict_id TEXT,
      anchor_reference TEXT NOT NULL,
      physical_row_locator INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      CHECK ((row_binding_id IS NOT NULL) != (conflict_id IS NOT NULL)),
      UNIQUE(physical_sheet_id, anchor_reference)
    )
  `);
  await sql.run(`
    CREATE UNIQUE INDEX projection_row_binding_entity_uq
      ON projection_row_binding(physical_sheet_id, row_binding_id)
      WHERE row_binding_id IS NOT NULL
  `);
  await sql.run(`
    CREATE UNIQUE INDEX projection_row_binding_conflict_uq
      ON projection_row_binding(physical_sheet_id, conflict_id)
      WHERE conflict_id IS NOT NULL
  `);
}

const DROPPED_SHEET_REGISTRY_COLUMNS = ["locale", "timezone", "stable_encode_version"];
const DROPPED_QUARANTINE_COLUMNS = ["repair_fields_json", "repair_state", "candidate_payload_json"];

async function tableColumnNames(
  adapter: MikroOrmSqliteAdapter,
  tableName: string,
): Promise<string[]> {
  const rows = await adapter.read(({ sql }) => sql.all<{ readonly name: string }>(
    `PRAGMA table_info(${tableName})`,
  ));
  return rows.map((row) => row.name);
}

async function sqliteTableNames(adapter: MikroOrmSqliteAdapter): Promise<string[]> {
  const rows = await adapter.read(({ sql }) => sql.all<{ readonly name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ));
  return rows.map((row) => row.name);
}

async function sqliteIndexNames(adapter: MikroOrmSqliteAdapter): Promise<string[]> {
  const rows = await adapter.read(({ sql }) => sql.all<{ readonly name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
  ));
  return rows.map((row) => row.name);
}

/** Seeds one registry row plus one quarantine row carrying pre-v7 repair data. */
async function seedPreV7Rows(sql: SqlExecutor): Promise<void> {
  await sql.run(
    "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
    ["logical-v7", 1, "{}", "id"],
  );
  await sql.run(
    "INSERT INTO quarantine_record (quarantine_id, event_id, observation_id, logical_sheet_id, row_binding_id, reason, before_row_json, after_row_json, fields_json, repair_fields_json, repair_state, candidate_payload_json, created_at, updated_at) VALUES (?, NULL, NULL, ?, ?, 'duplicate', NULL, NULL, '{}', '[\"field-a\"]', 'pending', 'payload-evidence', 1_000, 1_000)",
    ["quar-v7", "logical-v7", "binding-v7"],
  );
}

describe("SQLite schema v7 cleanup migration", () => {
  it("installs the v8 schema fresh: no projection_row_binding, no dead columns, straight version stamp", async () => {
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [SchemaMigrationOrder],
    });
    openAdapters.push(adapter);

    await expect(migrateSqliteSchema(adapter)).resolves.toEqual({
      fromVersion: 0,
      toVersion: 8,
      appliedVersions: [8],
    });

    expect(await sqliteTableNames(adapter)).not.toContain("projection_row_binding");
    const indexes = await sqliteIndexNames(adapter);
    expect(indexes).not.toContain("projection_row_binding_entity_uq");
    expect(indexes).not.toContain("projection_row_binding_conflict_uq");

    expect(await tableColumnNames(adapter, "sheet_registry"))
      .not.toEqual(expect.arrayContaining(DROPPED_SHEET_REGISTRY_COLUMNS));
    expect(await tableColumnNames(adapter, "event_observation")).not.toContain("redacted_at");
    expect(await tableColumnNames(adapter, "observation_receipt")).not.toContain("redacted_at");
    expect(await tableColumnNames(adapter, "quarantine_record"))
      .not.toEqual(expect.arrayContaining(DROPPED_QUARANTINE_COLUMNS));

    // v8: the writer-lease heartbeat evidence column exists on fresh installs.
    expect(await tableColumnNames(adapter, "writer_lease")).toContain("heartbeat_at");

    await expect(adapter.read(({ sql }) => sql.get<{ readonly user_version: number }>("PRAGMA user_version")))
      .resolves.toEqual({ user_version: 8 });
  });

  it("migrates a genuine v6 store to v7 in place: drops the orphan table and dead columns, keeps row data", async () => {
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [SchemaMigrationOrder],
    });
    openAdapters.push(adapter);

    // Build a current store, downgrade the marker to 6, then restore the
    // pre-v7 state so the migration runs against a real v6-shaped database.
    await migrateSqliteSchema(adapter);
    await adapter.transaction(async ({ sql }) => {
      await reintroducePreV7State(sql);
      await seedPreV7Rows(sql);
      await sql.run("PRAGMA user_version = 6");
    });

    await expect(migrateSqliteSchema(adapter)).resolves.toEqual({
      fromVersion: 6,
      toVersion: 8,
      appliedVersions: [7, 8],
    });

    // Dropped state is gone for good.
    expect(await sqliteTableNames(adapter)).not.toContain("projection_row_binding");
    const indexes = await sqliteIndexNames(adapter);
    expect(indexes).not.toContain("projection_row_binding_entity_uq");
    expect(indexes).not.toContain("projection_row_binding_conflict_uq");
    const registryColumns = await tableColumnNames(adapter, "sheet_registry");
    for (const dropped of DROPPED_SHEET_REGISTRY_COLUMNS) {
      expect(registryColumns).not.toContain(dropped);
    }
    const quarantineColumns = await tableColumnNames(adapter, "quarantine_record");
    for (const dropped of DROPPED_QUARANTINE_COLUMNS) {
      expect(quarantineColumns).not.toContain(dropped);
    }
    expect(await tableColumnNames(adapter, "event_observation")).not.toContain("redacted_at");
    expect(await tableColumnNames(adapter, "observation_receipt")).not.toContain("redacted_at");

    // Data in surviving columns is untouched (lossless removal).
    await expect(adapter.read(({ sql }) => sql.get<{ readonly business_key_field: string }>(
      "SELECT business_key_field FROM sheet_registry WHERE sheet_id = ?",
      ["logical-v7"],
    ))).resolves.toEqual({ business_key_field: "id" });
    await expect(adapter.read(({ sql }) => sql.get<{
      readonly logical_sheet_id: string;
      readonly row_binding_id: string;
      readonly reason: string;
      readonly fields_json: string;
      readonly created_at: number;
    }>(
      "SELECT logical_sheet_id, row_binding_id, reason, fields_json, created_at FROM quarantine_record WHERE quarantine_id = ?",
      ["quar-v7"],
    ))).resolves.toEqual({
      logical_sheet_id: "logical-v7",
      row_binding_id: "binding-v7",
      reason: "duplicate",
      fields_json: "{}",
      created_at: 1_000,
    });
    await expect(adapter.read(({ sql }) => sql.get<{ readonly user_version: number }>("PRAGMA user_version")))
      .resolves.toEqual({ user_version: 8 });
  });

  it("is idempotent on reopen: an already-current database applies no steps", async () => {
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [SchemaMigrationOrder],
    });
    openAdapters.push(adapter);

    await migrateSqliteSchema(adapter);
    await expect(migrateSqliteSchema(adapter)).resolves.toEqual({
      fromVersion: 8,
      toVersion: 8,
      appliedVersions: [],
    });
    // A current database where the cleanup already happened is also a no-op even
    // if the marker lags (tolerates any already-clean intermediate state).
    await adapter.transaction(async ({ sql }) => {
      await sql.run("PRAGMA user_version = 6");
    });
    await expect(migrateSqliteSchema(adapter)).resolves.toEqual({
      fromVersion: 6,
      toVersion: 8,
      appliedVersions: [7, 8],
    });
  });

  it("refuses a database stamped newer than the current schema", async () => {
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [SchemaMigrationOrder],
    });
    openAdapters.push(adapter);

    await migrateSqliteSchema(adapter);
    await adapter.transaction(async ({ sql }) => {
      await sql.run("PRAGMA user_version = 9");
    });
    await expect(migrateSqliteSchema(adapter)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.SCHEMA_VERSION_TOO_NEW,
    });
  });

  it("keeps api/entity.ts and the verification in agreement: projection_row_binding REMAINS reserved after v7", () => {
    // The orphan table is dropped by the v7 DDL, but the name stays reserved:
    // verifyDroppedColumns permanently checks its absence, and only the
    // reservation prevents a user entity from racing that check. This is the
    // durable contract — the name must never be un-reserved.
    expect(RESERVED_TABLE_NAMES.has("projection_row_binding")).toBe(true);
    // Frozen neighbours must still be reserved.
    expect(RESERVED_TABLE_NAMES.has("row_binding")).toBe(true);
    expect(RESERVED_TABLE_NAMES.has("sheet_effect_outbox")).toBe(true);
  });

  it("fresh-startup trap: an entity literally named projection_row_binding fails with the reserved-table-name error, never schema_version_invalid (descriptor gate + mapped-runtime resolution order)", async () => {
    // Pin for the Terra reproduction: while the name was un-reserved, a user
    // entity could legally bring its own `projection_row_binding` table to
    // startup, and the dropped-table verification then failed permanently with
    // SCHEMA_VERSION_INVALID on every launch. Keeping the name reserved closes
    // the trap at the earliest gate — descriptor definition — so the failure
    // is the reserved-table-name error before any runtime or migration runs.
    let error: unknown;
    try {
      defineTypedSheetsEntity({
        name: "ProjectionRowBinding",
        tableName: "projection_row_binding",
        properties: { id: { type: "string", primary: true } },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HikouteiError);
    expect((error as { code?: string }).code).toBe(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
    );
    expect((error as Error).message).toContain(
      'table name "projection_row_binding" is reserved by Hikoutei',
    );
    // The anti-trap assertion: this is NOT the migration-verification error a
    // version trap would produce.
    expect((error as { code?: string }).code).not.toBe(
      STORAGE_ERROR_CODES.SCHEMA_VERSION_INVALID,
    );

    // Mapped-runtime layer (Terra re-review): the original bug fired at the
    // mapped runtime, where MikroOrmSqliteSchema runs entity mapping BEFORE
    // the schema version check — a then-legal entity table was mapped first
    // and verifyDroppedColumns rejected every subsequent launch. Drive that
    // real production resolution order (MikroOrmSqliteSchema.ts:
    // migrateEntitySchema() → migrateSqliteSchema()) against one in-memory DB
    // with a legal mapped entity: entity mapping genuinely runs first, and
    // the version check that follows still finds the retired name absent —
    // the reservation makes the trap unreachable through any mapped runtime.
    const adapter = await createAdapter();
    await expect(migrateMikroOrmSqliteStorageSchema(adapter)).resolves.toEqual({
      fromVersion: 0,
      toVersion: 8,
      appliedVersions: [8],
    });
    expect(await sqliteTableNames(adapter)).toContain("schema_migration_orders");
    expect(await sqliteTableNames(adapter)).not.toContain("projection_row_binding");

    // Trap-control on the same DB: the runtime verification stays armed. A
    // legal entity can never create the table (descriptor gate above), so the
    // only remaining way in is a raw bypass — exactly what the un-reserved
    // name would have permitted through the entity-mapping layer. The same
    // resolution order then refuses deterministically: the descriptor gate is
    // what keeps mapped entities from ever reaching this rejection.
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "CREATE TABLE projection_row_binding (projection_row_id TEXT PRIMARY KEY)",
      );
    });
    await expect(migrateMikroOrmSqliteStorageSchema(adapter)).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.SCHEMA_VERSION_INVALID,
    });
  });
});