/**
 * MikroORM convenience entrypoints for the built-in entity-to-Sheets mapping.
 *
 * The public `TypedSheetsOrm` remains ours. This module only chooses MikroORM
 * as the current SQLite execution engine and performs the mapping registry
 * setup before the application begins calling `em.persist()` and `em.flush()`.
 */

import {
  createMappedTypedSheetsFlushCoordinator,
  registeredTypedSheetsProjectionDefinitions,
  registerTypedSheetsEntityMappings,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
  type TypedSheetsEntityWriterOptions,
  type TypedSheetsOrm,
} from "../../../../../application/orm/index.js";
import { resolveTypedSheetsEntityMappingRegistry } from "../../../../../application/orm/persistence/flush/mappedMappingRegistry.js";
import type { RegisteredSyncProjectionDefinition } from "../../../../../application/sync/gateway/SyncGatewayBootstrap.js";
import {
  createTypedSheetsOrm,
} from "./MikroOrmTypedSheetsEngine.js";
import {
  initializeMikroOrmSqliteAdapter,
  type InitializeMikroOrmSqliteAdapterOptions,
  type MikroOrmSqliteAdapter,
} from "../storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "../storage/MikroOrmSqliteSchema.js";

/** Options for creating a mapped public ORM around an existing MikroORM SQLite adapter. */
export interface CreateMappedTypedSheetsOrmOptions {
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
}

/** Options for opening, migrating, registering, and mapping a dedicated SQLite runtime. */
export interface InitializeMappedTypedSheetsOrmOptions
  extends InitializeMikroOrmSqliteAdapterOptions, CreateMappedTypedSheetsOrmOptions {
  /**
   * Optional control-plane hook invoked after local registry writes succeed.
   *
   * Applications can pass `provisionRegisteredSyncSheets()` here to provision
   * the exact generated headers without duplicating route configuration.
   */
  readonly onRegisteredProjections?: (
    definitions: readonly RegisteredSyncProjectionDefinition[],
  ) => Promise<void>;
}

/**
 * Creates the public typed-sheets EntityManager facade with its built-in
 * canonical/outbox planner. Mapping routes must already be registered.
 */
export function createMappedTypedSheetsOrm(
  storage: MikroOrmSqliteAdapter,
  options: CreateMappedTypedSheetsOrmOptions,
): TypedSheetsOrm {
  const mappings = resolveTypedSheetsEntityMappingRegistry(options.mappings);
  return createTypedSheetsOrm(storage, {
    flushCoordinator: createMappedTypedSheetsFlushCoordinator({
      mappings,
      writer: options.writer,
    }),
  });
}

/**
 * Opens a dedicated MikroORM SQLite runtime ready for mapped entity lifecycle work.
 *
 * Startup performs non-destructive entity/schema migration and idempotent local
 * projection registration. Remote Apps Script provisioning remains explicit so
 * a process cannot mutate a spreadsheet merely by opening its local database.
 */
export async function initializeMappedTypedSheetsOrm(
  options: InitializeMappedTypedSheetsOrmOptions,
): Promise<TypedSheetsOrm> {
  const {
    mappings: mappingsInput,
    writer,
    onRegisteredProjections,
    ...adapterOptions
  } = options;
  const mappings = resolveTypedSheetsEntityMappingRegistry(mappingsInput);
  const storage = await initializeMikroOrmSqliteAdapter(adapterOptions);
  try {
    await migrateMikroOrmSqliteStorageSchema(storage);
    const registrations = await registerTypedSheetsEntityMappings(storage, mappings, writer);
    if (onRegisteredProjections !== undefined) {
      await onRegisteredProjections(registeredTypedSheetsProjectionDefinitions(registrations));
    }
    return createMappedTypedSheetsOrm(storage, { mappings, writer });
  } catch (error: unknown) {
    await storage.close(true);
    throw error;
  }
}
