import type { SqlExecutor, SqlStorageAdapter } from "../orm/contracts.js";
import type { MikroOrmSqliteAdapter } from "./MikroOrmSqliteAdapter.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../storage/errors.js";
import {
  CURRENT_SCHEMA_VERSION,
  REQUIRED_V2_COLUMNS,
  REQUIRED_V3_COLUMNS,
  SQLITE_CONNECTION_PRAGMAS,
  syncSchemaIndexesDdl,
  syncSchemaTablesDdl,
  type SchemaMigrationResult,
} from "../../storage/sqlite/schema.js";
import type {
  SchemaMigrationColumnName,
  SchemaMigrationTableName,
} from "../../storage/sqlite/schemaTypes.js";
import { executeSqlScript } from "../../storage/sqlite/sqlScript.js";

/**
 * Migrates typed-sheets sync tables through the application-owned MikroORM
 * SQLite connection.
 *
 * This preserves the existing `PRAGMA user_version` migration contract while
 * ensuring DDL and later entity/outbox writes use one ORM-owned connection.
 */
export async function migrateMikroOrmSqliteSchema(
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
    await verifyRequiredColumns(sql);
    await executeSqlScript(sql, syncSchemaIndexesDdl());
    await verifyCurrentSchema(sql);

    return {
      fromVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      appliedVersions,
    };
  });
}

/**
 * Applies the dedicated MikroORM entity schema and typed-sheets sync schema.
 *
 * Entity changes use MikroORM's non-destructive schema update; sync tables
 * retain the explicit `PRAGMA user_version` migration sequence. The two schema
 * systems are intentionally run in this order and are independently idempotent.
 */
export async function migrateMikroOrmSqliteStorageSchema(
  storage: MikroOrmSqliteAdapter,
): Promise<SchemaMigrationResult> {
  await storage.migrateEntitySchema();
  return migrateMikroOrmSqliteSchema(storage);
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

async function verifyCurrentSchema(sql: SqlExecutor): Promise<void> {
  await verifyRequiredColumns(sql);
  if (!(await indexExists(sql, "sync_conflict_candidate_attempt_uq"))) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SCHEMA_INDEX_MISSING,
      "SQLite schema is missing sync_conflict_candidate_attempt_uq.",
    );
  }
}

async function verifyRequiredColumns(sql: SqlExecutor): Promise<void> {
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_V2_COLUMNS) as Array<
    ["sync_conflict" | "resolution_command", readonly string[]]
  >) {
    await verifyTableColumns(sql, tableName, requiredColumns);
  }
  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_V3_COLUMNS) as Array<
    ["sheet_effect_outbox", readonly string[]]
  >) {
    await verifyTableColumns(sql, tableName, requiredColumns);
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
