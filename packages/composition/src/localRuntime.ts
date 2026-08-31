/**
 * Composition wiring for the plain local-only scalar runtime (P8-C).
 *
 * The exact wiring block previously owned by `createLocalTypedSheetsRuntime`
 * in `src/api/Hikoutei.ts`: it generates the MikroORM scalar entity runtime
 * for the declared entities, opens the dedicated SQLite storage, and binds
 * the scalar persistence provider. The public API factory calls this module
 * lazily (dynamic import), so importing the root package alone never loads
 * the MikroORM module graph — only opening a runtime does. Runtime behavior
 * is byte-identical: same generation, same storage options, same provider
 * construction, same construction order and failure propagation.
 */

import {
  createMikroOrmScalarEntityRuntime,
  type MikroOrmScalarEntityRuntimeDefinition,
} from "@hikoutei/storage/persistence/providers/mikro-orm/engine/MikroOrmScalarEntityRuntime.js";
import {
  initializeMikroOrmScalarStorage,
} from "@hikoutei/storage/persistence/providers/mikro-orm/engine/MikroOrmScalarStorage.js";
import {
  MikroOrmScalarPersistenceProvider,
} from "@hikoutei/storage/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js";
import type {
  MikroOrmSqliteAdapter,
} from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type {
  ScalarEntityPersistenceProvider,
} from "@hikoutei/contracts/storage/scalar.js";
import type { HikouteiEntity } from "@hikoutei/sync-engine/api/entity.js";
import {
  createInternalHikoutei,
  resolveDefaultDbPath,
  type CreateTypedSheetsOptions,
  type Hikoutei,
} from "@hikoutei/sync-engine/api/hikouteiCore.js";
import {
  getRegisteredEntityTokens,
} from "@hikoutei/sync-engine/api/entity.js";
import {
  resolveEntityDescriptors,
  type EntityDescriptorResolutionFailure,
} from "@hikoutei/sync-engine/api/internalEntityRegistry.js";
import {
  HIKOUTEI_ERROR_CODES,
  HikouteiError,
} from "@hikoutei/sync-engine/api/errors.js";
import {
  describeErrorForInternalLog,
  HIKOUTEI_LOG_LEVELS,
  logHikouteiInternalEvent,
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";


/** Lazily-loaded provider resources for one local runtime open. */
export interface LocalScalarRuntimeWiring {
  /** Generated MikroORM entity materialization (schemas + bindings). */
  readonly generated: MikroOrmScalarEntityRuntimeDefinition;
  /** Opens the MikroORM-configured SQLite storage for the entity set. */
  readonly initializeStorage: (dbName: string) => Promise<unknown>;
  /** Binds the scalar persistence provider to the opened storage. */
  readonly createPersistenceProvider: (storage: unknown) => ScalarEntityPersistenceProvider;
}

/**
 * Generates the concrete local runtime wiring for the declared entity tokens.
 * Called after the API resolved descriptors, only when a runtime is opened.
 */
export async function createLocalScalarRuntimeWiring(
  entities: readonly HikouteiEntity[],
): Promise<LocalScalarRuntimeWiring> {
  const generated = createMikroOrmScalarEntityRuntime(entities);
  return {
    generated,
    initializeStorage: (dbName: string) =>
      initializeMikroOrmScalarStorage({ dbName, entities: generated.entities }),
    createPersistenceProvider: (storage: unknown) =>
      new MikroOrmScalarPersistenceProvider(
        storage as MikroOrmSqliteAdapter,
        generated.bindings,
      ),
  };
}

/**
 * Opens the plain local-only SQLite runtime with no sync service.
 *
 * Internal construction hook shared by `createTypedSheets()` (root package,
 * the sync auto-start bridge (env present but disabled). It deliberately loads
 * the current provider lazily so importing the root package alone never
 * requires MikroORM or the Google SDK module graph. Omitting `dbName` or
 * `entities` here applies the same defaults as `createTypedSheets()`.
 */
export async function createLocalTypedSheetsRuntime(
  options: CreateTypedSheetsOptions,
): Promise<Hikoutei> {
  const startedAt = Date.now();
  try {
    const dbName = options.dbName ?? resolveDefaultDbPath();
    const entities = options.entities ?? getRegisteredEntityTokens();
    const descriptors = resolveEntityDescriptors(entities, throwHikouteiResolutionError);
    // Load the current provider only when a runtime is opened. Importing the
    // root package alone must not require MikroORM or expose its module graph.
    // P8-C: the concrete wiring is composition-owned. The lazy-loading
    // guarantee is preserved by the DYNAMIC imports that reach THIS module
    // (root `createTypedSheets()` and the sync-engine local-runtime port
    // thunk), so MikroORM stays out of the root package graph.
    const wiring = await createLocalScalarRuntimeWiring(entities);
    const storage = await wiring.initializeStorage(dbName);
    const provider = wiring.createPersistenceProvider(storage);
    const hikoutei = createInternalHikoutei(provider, descriptors);
    logHikouteiInternalEvent({
      event: HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED,
      level: HIKOUTEI_LOG_LEVELS.INFO,
      component: HIKOUTEI_LOG_COMPONENTS.RUNTIME,
      durationMs: Date.now() - startedAt,
      counts: { entities: descriptors.size },
    });
    return hikoutei;
  } catch (error: unknown) {
    logHikouteiInternalEvent({
      event: HIKOUTEI_LOG_EVENTS.RUNTIME_OPEN_FAILED,
      level: HIKOUTEI_LOG_LEVELS.ERROR,
      component: HIKOUTEI_LOG_COMPONENTS.RUNTIME,
      durationMs: Date.now() - startedAt,
      ...describeErrorForInternalLog(error),
    });
    throw error;
  }
}

/**
 * Maps a structured descriptor-registry failure to the public
 * `HikouteiError` contract with unchanged codes and messages.
 */
function throwHikouteiResolutionError(
  failure: EntityDescriptorResolutionFailure,
): never {
  switch (failure.kind) {
    case "invalid-token":
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
        "createTypedSheets() accepts only tokens produced by defineTypedSheetsEntity().",
      );
    case "duplicate-name":
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
        `entity name "${failure.entityName}" is registered more than once.`,
      );
    case "duplicate-table":
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
        `table "${failure.tableName}" is shared by entities "${failure.firstEntityName}" and "${failure.secondEntityName}".`,
      );
  }
}
