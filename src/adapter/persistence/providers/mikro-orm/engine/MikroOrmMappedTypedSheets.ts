/**
 * MikroORM convenience entrypoints for the built-in entity-to-Sheets mapping.
 *
 * The public `TypedSheetsOrm` remains ours. This module only chooses MikroORM
 * as the current SQLite execution engine and performs the mapping registry
 * setup before the application begins calling `em.persist()` and `em.flush()`.
 */

import {
  registeredTypedSheetsProjectionDefinitions,
  registerTypedSheetsEntityMappings,
  createMappedTypedSheetsFlushCoordinator,
} from "../../../../../application/orm/persistence/flush/flushCoordinator.js";
import {
  createTypedSheetsEntityMappingRegistry,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "../../../../../application/orm/mapping/entityMapping.js";
import type {
  RegisteredTypedSheetsMappedProjection,
  TypedSheetsEntityWriterOptions,
} from "../../../../../application/orm/persistence/support/contracts.js";
import type { TypedSheetsOrm } from "../../../../../application/orm/api/TypedSheetsOrm.js";
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
   * Optional internal hook invoked after local registry writes succeed.
   *
   * The hook receives the exact generated projection definitions so the sync
   * service can provision a remote gateway without duplicating route metadata.
   */
  readonly onRegisteredProjections?: (
    definitions: readonly RegisteredSyncProjectionDefinition[],
  ) => Promise<void>;
}

/** Internal mapped runtime resources shared by the ORM facade and sync worker. */
export interface InitializedMappedTypedSheetsRuntime {
  readonly storage: MikroOrmSqliteAdapter;
  readonly orm: TypedSheetsOrm;
  readonly mappings: TypedSheetsEntityMappingRegistry;
  readonly registrations: readonly RegisteredTypedSheetsMappedProjection[];
}

/**
 * Creates the public typed-sheets EntityManager facade with its built-in
 * canonical/outbox planner. Mapping routes must already be registered.
 */
export function createMappedTypedSheetsOrm(
  storage: MikroOrmSqliteAdapter,
  options: CreateMappedTypedSheetsOrmOptions,
): TypedSheetsOrm {
  const mappings = mappingRegistry(options.mappings);
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
export async function initializeMappedTypedSheetsRuntime(
  options: InitializeMappedTypedSheetsOrmOptions,
): Promise<InitializedMappedTypedSheetsRuntime> {
  const {
    mappings: mappingsInput,
    writer,
    onRegisteredProjections,
    ...adapterOptions
  } = options;
  const mappings = mappingRegistry(mappingsInput);
  const storage = await initializeMikroOrmSqliteAdapter(adapterOptions);
  try {
    await migrateMikroOrmSqliteStorageSchema(storage);
    const registrations = await registerTypedSheetsEntityMappings(storage, mappings, writer);
    if (onRegisteredProjections !== undefined) {
      await onRegisteredProjections(registeredTypedSheetsProjectionDefinitions(registrations));
    }
    return {
      storage,
      orm: createMappedTypedSheetsOrm(storage, { mappings, writer }),
      mappings,
      registrations,
    };
  } catch (error: unknown) {
    await storage.close(true);
    throw error;
  }
}

/** Opens a mapped runtime and returns only its ORM facade for existing callers. */
export async function initializeMappedTypedSheetsOrm(
  options: InitializeMappedTypedSheetsOrmOptions,
): Promise<TypedSheetsOrm> {
  const runtime = await initializeMappedTypedSheetsRuntime(options);
  return runtime.orm;
}

function mappingRegistry(
  input: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
): TypedSheetsEntityMappingRegistry {
  if ("findByEntityName" in input) return input;
  return createTypedSheetsEntityMappingRegistry(input);
}
