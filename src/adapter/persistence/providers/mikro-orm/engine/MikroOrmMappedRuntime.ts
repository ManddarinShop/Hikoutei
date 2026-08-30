/**
 * Composition helpers for the internal mapped MikroORM runtime.
 *
 * This module opens storage, migrates the entity and sync schemas, registers
 * mapping routes, and returns the planner resources. Entity lifecycle work is
 * executed by `MikroOrmScalarPersistenceProvider`; no ORM facade is created.
 */

import {
  registeredTypedSheetsProjectionDefinitions,
  registerTypedSheetsEntityMappings,
  createMappedTypedSheetsFlushCoordinator,
} from "../../../../../application/orm/persistence/flush/flushCoordinator.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "@hikoutei/contracts/sync-orm/mapping/contracts.js";
import {
  createTypedSheetsEntityMappingRegistry,
} from "@hikoutei/contracts/sync-orm/mapping/registry.js";

import type {
  MappedFlushSyncHook,
  RegisteredTypedSheetsMappedProjection,
  TypedSheetsEntityWriterOptions,
} from "../../../../../application/orm/persistence/support/contracts.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import {
  initializeMikroOrmSqliteAdapter,
  type InitializeMikroOrmSqliteAdapterOptions,
  type MikroOrmSqliteAdapter,
} from "../storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "../storage/MikroOrmSqliteSchema.js";
import type { ScalarEntityFlushCoordinator } from "@hikoutei/contracts/storage/scalar.js";

/** Options for opening and registering one mapped SQLite runtime. */
export interface InitializeMappedRuntimeOptions
  extends InitializeMikroOrmSqliteAdapterOptions {
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
  /** Optional service-side conflict planning hook inside the same flush transaction. */
  readonly syncFlushHook?: MappedFlushSyncHook;
  /** Called after local projection registration succeeds. */
  readonly onRegisteredProjections?: (
    definitions: readonly RegisteredSyncProjectionDefinition[],
  ) => Promise<void>;
}

/** Resources shared by the scalar provider and internal sync supervisors. */
export interface InitializedMappedRuntime {
  readonly storage: MikroOrmSqliteAdapter;
  readonly mappings: TypedSheetsEntityMappingRegistry;
  readonly registrations: readonly RegisteredTypedSheetsMappedProjection[];
  readonly flushCoordinator: ScalarEntityFlushCoordinator;
}

/** Opens storage, migrates schemas, registers mapping routes, and builds the planner. */
export async function initializeMappedRuntime(
  options: InitializeMappedRuntimeOptions,
): Promise<InitializedMappedRuntime> {
  const {
    mappings: mappingsInput,
    writer,
    onRegisteredProjections,
    syncFlushHook,
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
      mappings,
      registrations,
      flushCoordinator: createMappedTypedSheetsFlushCoordinator({
        mappings,
        writer,
        ...(syncFlushHook === undefined ? {} : { syncFlushHook }),
      }),
    };
  } catch (error: unknown) {
    await storage.close(true);
    throw error;
  }
}

function mappingRegistry(
  input: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
): TypedSheetsEntityMappingRegistry {
  if ("findByEntityName" in input) return input;
  return createTypedSheetsEntityMappingRegistry(input);
}
