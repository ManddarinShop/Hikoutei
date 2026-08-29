/**
 * Provider-neutral SQLite schema migration for the typed-sheets sync storage.
 *
 * This operates purely on the adapter-neutral `SqlStorageAdapter` contract, so
 * the same migration runs whether SQLite is reached through node:sqlite,
 * MikroORM, or a future Prisma adapter. It preserves the `PRAGMA user_version`
 * migration sequence while keeping DDL and later writes on one connection.
 */

import type { SqlExecutor, SqlStorageAdapter } from "../../../adapter/persistence/contracts/sql.js";
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";
import {
  CURRENT_SCHEMA_VERSION,
  DROPPED_V7_COLUMNS,
  DROPPED_V7_TABLES,
  REQUIRED_V2_COLUMNS,
  REQUIRED_V3_COLUMNS,
  REQUIRED_V5_COLUMNS,
  REQUIRED_V6_COLUMNS,
  REQUIRED_V7_COLUMNS,
  SQLITE_CONNECTION_PRAGMAS,
  syncSchemaIndexesDdl,
  syncSchemaTablesDdl,
  syncSchemaV5IndexesDdl,
  type SchemaMigrationResult,
} from "./schema.js";
import type {
  SchemaMigrationColumnName,
  SchemaMigrationTableName,
} from "./schemaTypes.js";
import { executeSqlScript } from "./sqlScript.js";

/**
 * Brings one SQLite store to the current sync schema version.
 *
 * `journal_mode` is configured before the write transaction begins. The
 * migration is idempotent and refuses to trust a schema marker unless the
 * required columns and indexes are present.
 */
export async function migrateSqliteSchema(
  storage: SqlStorageAdapter,
): Promise<SchemaMigrationResult> {
  // `journal_mode` must be configured before the write transaction begins.
  await storage.read(async ({ sql }) => executeSqlScript(sql, SQLITE_CONNECTION_PRAGMAS));

  return storage.transaction(async ({ sql }) => {
    const fromVersion = await readSchemaVersion(sql);
    if (fromVersion > CURRENT_SCHEMA_VERSION) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SCHEMA_VERSION_TOO_NEW,
        `SQLite schema version ${fromVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}.`,
      );
    }

    const hasSchema = await tableExists(sql, "sheet_registry");
    if (fromVersion === 0 && !hasSchema) {
      await executeSqlScript(sql, syncSchemaTablesDdl());
      await verifyRequiredColumns(sql);
      await executeSqlScript(sql, syncSchemaIndexesDdl());
      await executeSqlScript(sql, syncSchemaV5IndexesDdl());
      await writeSchemaVersion(sql, CURRENT_SCHEMA_VERSION);
      await verifyCurrentSchema(sql);
      return {
        fromVersion,
        toVersion: CURRENT_SCHEMA_VERSION,
        appliedVersions: [CURRENT_SCHEMA_VERSION],
      };
    }

    if (!hasSchema) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SCHEMA_TABLE_MISSING,
        "SQLite schema is missing sheet_registry and cannot be migrated safely.",
      );
    }

    await executeSqlScript(sql, syncSchemaTablesDdl());
    const appliedVersions: number[] = [];
    if (fromVersion < 2) {
      await applyVersion2CandidateEpochMigration(sql);
      await writeSchemaVersion(sql, 2);
      appliedVersions.push(2);
    }
    if (fromVersion < 3) {
      await applyVersion3EffectTimestampMigration(sql);
      await writeSchemaVersion(sql, 3);
      appliedVersions.push(3);
    }
    if (fromVersion < 4) {
      // Version 4 moves schema ownership to the adapter and uses the
      // business-key anchor default. Existing tables need no destructive DDL;
      // persist the marker so the next startup cannot report a false version.
      await writeSchemaVersion(sql, 4);
      appliedVersions.push(4);
    }
    if (fromVersion < 5) {
      // SQLite cannot widen the existing status CHECK constraint with ALTER
      // TABLE. Rebuild only this durable outbox table transactionally while
      // preserving every existing row and effect evidence.
      await applyVersion5DurableDeliveryMigration(sql);
      await writeSchemaVersion(sql, 5);
      appliedVersions.push(5);
    }
    if (fromVersion < 6) {
      // Add nullable candidate-time visible evidence columns to sync_conflict.
      // Legacy conflicts keep both columns absent (NULL); only fresh conflicts
      // populated after this migration carry resolution CAS evidence.
      await applyVersion6CandidateEvidenceMigration(sql);
      await writeSchemaVersion(sql, 6);
      appliedVersions.push(6);
    }
    if (fromVersion < 7) {
      // Drop the orphan projection_row_binding table (with its two partial
      // unique indexes) and the dead columns. Of the dead columns, the five
      // "write-never" ones are lossless to drop; the three quarantine repair
      // columns did receive writes and their discard is an owner-approved
      // intentional deletion (see the step body below). Each step tolerates
      // already-clean databases so the step stays idempotent wherever a fresh
      // v7 DDL already applied.
      await applyVersion7CleanupMigration(sql);
      await writeSchemaVersion(sql, 7);
      appliedVersions.push(7);
    }
    await verifyRequiredColumns(sql);
    await executeSqlScript(sql, syncSchemaIndexesDdl());
    // v5-only indexes are created after every migration so an upgraded v4
    // installation gets the probe index the same way a fresh install does.
    await executeSqlScript(sql, syncSchemaV5IndexesDdl());
    await verifyCurrentSchema(sql);

    return {
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      appliedVersions,
    };
  });
}

async function applyVersion2CandidateEpochMigration(sql: SqlExecutor): Promise<void> {
  await addColumnIfMissing(sql, "sync_conflict", "candidate_epoch", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(
    sql,
    "resolution_command",
    "expected_candidate_epoch",
    "INTEGER NOT NULL DEFAULT 0",
  );
}

async function applyVersion3EffectTimestampMigration(sql: SqlExecutor): Promise<void> {
  await addColumnIfMissing(sql, "sheet_effect_outbox", "created_at", "INTEGER NOT NULL DEFAULT 0");
}

async function applyVersion5DurableDeliveryMigration(sql: SqlExecutor): Promise<void> {
  await sql.run("DROP INDEX IF EXISTS effect_outbox_stream_idx");
  await sql.run("DROP INDEX IF EXISTS effect_outbox_probe_idx");
  await sql.run("ALTER TABLE sheet_effect_outbox RENAME TO sheet_effect_outbox_v4");
  await executeSqlScript(sql, syncSchemaTablesDdl());
  await sql.run(`
    INSERT INTO sheet_effect_outbox (
      effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
      projection, row_binding_id, conflict_id, target_kind, target_id,
      target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
      expected_visible_revision, expected_visible_hash, repair_guard_hash,
      source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
      stream_sequence, predecessor_effect_id, status, attempts, lease_until,
      next_attempt_at, uncertain_since, next_probe_at, dispatch_id, claim_token,
      writer_epoch, supersedes_effect_id, last_error_code, last_error_message,
      created_at
    )
    SELECT
      effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
      projection, row_binding_id, conflict_id, target_kind, target_id,
      target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
      expected_visible_revision, expected_visible_hash, repair_guard_hash,
      source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
      stream_sequence, predecessor_effect_id, status, attempts, lease_until,
      next_attempt_at, NULL, NULL, claim_token, claim_token,
      writer_epoch, supersedes_effect_id, last_error_code, last_error_message,
      created_at
    FROM sheet_effect_outbox_v4
  `);
  await sql.run("DROP TABLE sheet_effect_outbox_v4");
  // The renamed table carried the old index names; recreate indexes against
  // the new table after the old table and its indexes have been removed. The
  // probe index is v5-only and is created by the caller after this rebuild so
  // the base DDL stays safe for pre-v5 tables that lack next_probe_at.
  await executeSqlScript(sql, syncSchemaTablesDdl());
}

async function applyVersion6CandidateEvidenceMigration(sql: SqlExecutor): Promise<void> {
  await addColumnIfMissing(sql, "sync_conflict", "candidate_visible_revision", "INTEGER");
  await addColumnIfMissing(sql, "sync_conflict", "candidate_visible_hash", "TEXT");
}

async function applyVersion7CleanupMigration(sql: SqlExecutor): Promise<void> {
  // The orphan table and its partial unique indexes: the indexes are dropped
  // by the table drop, but explicit IF EXISTS statements also cover renamed
  // legacy tables that may have left the index names behind (v5-style).
  await sql.run("DROP TABLE IF EXISTS projection_row_binding");
  await sql.run("DROP INDEX IF EXISTS projection_row_binding_entity_uq");
  await sql.run("DROP INDEX IF EXISTS projection_row_binding_conflict_uq");

  // Dead columns. The five write-never columns (sheet_registry.locale,
  // sheet_registry.timezone, sheet_registry.stable_encode_version,
  // event_observation.redacted_at, observation_receipt.redacted_at) never
  // received a single write, so dropping them is lossless. The three
  // quarantine repair columns DID receive writes, but were never read by any
  // executor: discarding them is an OWNER-APPROVED INTENTIONAL DELETION of
  // unused data, not a lossless cleanup.
  // Skip-if-absent keeps the step idempotent against any database whose
  // columns are already gone (including one created by fresh v7 DDL).
  await dropColumnIfPresent(sql, "sheet_registry", "locale");
  await dropColumnIfPresent(sql, "sheet_registry", "timezone");
  await dropColumnIfPresent(sql, "sheet_registry", "stable_encode_version");
  await dropColumnIfPresent(sql, "event_observation", "redacted_at");
  await dropColumnIfPresent(sql, "observation_receipt", "redacted_at");
  await dropColumnIfPresent(sql, "quarantine_record", "repair_state");
  await dropColumnIfPresent(sql, "quarantine_record", "repair_fields_json");
  await dropColumnIfPresent(sql, "quarantine_record", "candidate_payload_json");
}

async function verifyCurrentSchema(sql: SqlExecutor): Promise<void> {
  await verifyRequiredColumns(sql);
  await verifyDroppedColumns(sql);
  if (!(await indexExists(sql, "sync_conflict_candidate_attempt_uq"))) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SCHEMA_INDEX_MISSING,
      "SQLite schema is missing sync_conflict_candidate_attempt_uq.",
    );
  }
  if (!(await indexExists(sql, "effect_outbox_probe_idx"))) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SCHEMA_INDEX_MISSING,
      "SQLite schema is missing effect_outbox_probe_idx.",
    );
  }
}

async function verifyRequiredColumns(sql: SqlExecutor): Promise<void> {
  const versionTwoTables: readonly ("sync_conflict" | "resolution_command")[] = [
    "sync_conflict",
    "resolution_command",
  ];
  for (const tableName of versionTwoTables) {
    await verifyTableColumns(sql, tableName, REQUIRED_V2_COLUMNS[tableName]);
  }

  const versionThreeTables: readonly "sheet_effect_outbox"[] = ["sheet_effect_outbox"];
  for (const tableName of versionThreeTables) {
    await verifyTableColumns(sql, tableName, REQUIRED_V3_COLUMNS[tableName]);
  }
  const versionFiveTables: readonly ("sheet_effect_outbox" | "spreadsheet_authority")[] = [
    "sheet_effect_outbox",
    "spreadsheet_authority",
  ];
  for (const tableName of versionFiveTables) {
    await verifyTableColumns(sql, tableName, REQUIRED_V5_COLUMNS[tableName]);
  }
  for (const tableName of ["sync_conflict"] as const) {
    await verifyTableColumns(sql, tableName, REQUIRED_V6_COLUMNS[tableName]);
  }
  for (const tableName of ["quarantine_record"] as const) {
    await verifyTableColumns(sql, tableName, REQUIRED_V7_COLUMNS[tableName]);
  }
}

/**
 * Final-version expectations beyond required columns: the v7 cleanup tables
 * and columns must be gone. Fresh installs satisfy this from the DDL;
 * upgraded databases only after the v7 step has run.
 *
 * The TABLE-absence check on `projection_row_binding` is protected by that
 * name remaining in `RESERVED_TABLE_NAMES` (src/api/entity.ts): a user entity
 * can never re-create the table, so the check can never misfire on user data.
 * Do NOT un-reserve the name to match the DDL removal — the reservation is
 * the durable contract that keeps this verification sound.
 * The COLUMN-absence checks target only still-reserved system tables
 * (sheet_registry, event_observation, observation_receipt, quarantine_record
 * are all in RESERVED_TABLE_NAMES), so they can never collide with a user
 * entity's descriptor either.
 */
async function verifyDroppedColumns(sql: SqlExecutor): Promise<void> {
  for (const tableName of DROPPED_V7_TABLES) {
    if (await tableExists(sql, tableName)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SCHEMA_VERSION_INVALID,
        `SQLite schema still contains dropped table ${tableName}; refusing a v7 marker.`,
      );
    }
  }
  for (const [tableName, columns] of Object.entries(DROPPED_V7_COLUMNS)) {
    for (const columnName of columns) {
      if (await columnExists(sql, tableName, columnName)) {
        throw new StorageError(
          STORAGE_ERROR_CODES.SCHEMA_VERSION_INVALID,
          `SQLite schema still contains ${tableName}.${columnName}; refusing a v7 marker.`,
        );
      }
    }
  }
}

async function verifyTableColumns(
  sql: SqlExecutor,
  tableName: string,
  requiredColumns: readonly string[],
): Promise<void> {
  if (!(await tableExists(sql, tableName))) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SCHEMA_TABLE_MISSING,
      `SQLite schema is missing ${tableName}; refusing an unsafe migration marker.`,
    );
  }
  for (const columnName of requiredColumns) {
    if (!(await columnExists(sql, tableName, columnName))) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SCHEMA_COLUMN_MISSING,
        `SQLite schema is missing ${tableName}.${columnName}; refusing an unsafe migration marker.`,
      );
    }
  }
}

async function addColumnIfMissing(
  sql: SqlExecutor,
  tableName: SchemaMigrationTableName,
  columnName: SchemaMigrationColumnName,
  definition: string,
): Promise<void> {
  if (await columnExists(sql, tableName, columnName)) return;
  await sql.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function dropColumnIfPresent(
  sql: SqlExecutor,
  tableName: string,
  columnName: string,
): Promise<void> {
  if (!(await columnExists(sql, tableName, columnName))) return;
  await sql.run(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
}

async function readSchemaVersion(sql: SqlExecutor): Promise<number> {
  const row = await sql.get<{ readonly user_version?: unknown }>("PRAGMA user_version");
  const version = row?.user_version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SCHEMA_VERSION_INVALID,
      "SQLite user_version must be a non-negative safe integer.",
    );
  }
  return version;
}

async function writeSchemaVersion(sql: SqlExecutor, version: number): Promise<void> {
  await sql.run(`PRAGMA user_version = ${version}`);
}

async function tableExists(sql: SqlExecutor, tableName: string): Promise<boolean> {
  return (await sql.get<{ readonly present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  )) !== undefined;
}

async function columnExists(
  sql: SqlExecutor,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql.all<{ readonly name?: unknown }>(`PRAGMA table_info(${tableName})`);
  return rows.some((row) => row.name === columnName);
}

async function indexExists(sql: SqlExecutor, indexName: string): Promise<boolean> {
  return (await sql.get<{ readonly present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?",
    [indexName],
  )) !== undefined;
}
