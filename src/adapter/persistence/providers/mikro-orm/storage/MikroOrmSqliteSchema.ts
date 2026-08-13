import type { MikroOrmSqliteAdapter } from "./MikroOrmSqliteAdapter.js";
import {
  migrateSqliteSchema,
} from "../../../../../infrastructure/storage/sqlite/migrateSchema.js";
import type { SchemaMigrationResult } from "../../../../../infrastructure/storage/sqlite/schema.js";

/**
 * Applies the dedicated MikroORM entity schema and typed-sheets sync schema.
 *
 * Entity changes use MikroORM's non-destructive schema update; sync tables
 * retain the explicit `PRAGMA user_version` migration sequence through the
 * provider-neutral `migrateSqliteSchema`. The two schema systems are
 * intentionally run in this order and are independently idempotent.
 */
export async function migrateMikroOrmSqliteStorageSchema(
  storage: MikroOrmSqliteAdapter,
): Promise<SchemaMigrationResult> {
  await storage.migrateEntitySchema();
  return migrateSqliteSchema(storage);
}
