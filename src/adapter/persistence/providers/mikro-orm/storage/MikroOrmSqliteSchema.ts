import type { MikroOrmSqliteAdapter } from "./MikroOrmSqliteAdapter.js";
import {
  migrateSqliteSchema,
} from "../../../../../infrastructure/storage/sqlite/migrateSchema.js";
import type { SchemaMigrationResult } from "../../../../../infrastructure/storage/sqlite/schema.js";
import type { SqlStorageAdapter } from "../../../contracts/sql.js";

/**
 * Migrates typed-sheets sync tables through the application-owned MikroORM
 * SQLite connection.
 *
 * The migration logic itself is provider-neutral and lives in
 * `migrateSqliteSchema`; this thin wrapper preserves the historical import path
 * for callers that route through the MikroORM-backed adapter.
 */
export async function migrateMikroOrmSqliteSchema(
  storage: SqlStorageAdapter,
): Promise<SchemaMigrationResult> {
  return migrateSqliteSchema(storage);
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
