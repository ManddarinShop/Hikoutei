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
} from "../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarEntityRuntime.js";
import {
  initializeMikroOrmScalarStorage,
} from "../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarStorage.js";
import {
  MikroOrmScalarPersistenceProvider,
} from "../adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js";
import type {
  MikroOrmSqliteAdapter,
} from "../adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type {
  ScalarEntityPersistenceProvider,
} from "@hikoutei/contracts/storage/scalar.js";
import type { HikouteiEntity } from "../api/entity.js";

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
