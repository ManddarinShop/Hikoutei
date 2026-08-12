/**
 * MikroORM storage construction for the Hikoutei scalar provider.
 *
 * Public entity lifecycle orchestration lives in Hikoutei's scalar Unit of
 * Work and provider SPI. This module only opens the generated SQLite schemas.
 */

import {
  initializeMikroOrmSqliteAdapter,
  type InitializeMikroOrmSqliteAdapterOptions,
  type MikroOrmSqliteAdapter,
} from "../storage/MikroOrmSqliteAdapter.js";

/** Options for initializing a dedicated typed-sheets SQLite storage. */
export type InitializeMikroOrmTypedSheetsStorageOptions =
  InitializeMikroOrmSqliteAdapterOptions;

/** Opens and migrates the scalar entity schema used by the local runtime. */
export async function initializeMikroOrmTypedSheetsStorage(
  options: InitializeMikroOrmTypedSheetsStorageOptions,
): Promise<MikroOrmSqliteAdapter> {
  const storage = await initializeMikroOrmSqliteAdapter(options);
  try {
    await storage.migrateEntitySchema();
    return storage;
  } catch (error: unknown) {
    await storage.close(true);
    throw error;
  }
}
