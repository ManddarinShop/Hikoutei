/** Public factory for the built-in SQLite execution provider. */

import type { TypedSheetsOrm } from "../../../../../application/orm/api/TypedSheetsOrm.js";
import type { CreateTypedSheetsOptions } from "../../../../../application/orm/api/factoryContracts.js";
import type { TypedSheetsFlushCoordinator } from "../../../../../application/orm/api/contracts.js";
import { createTypedSheetsEntityMappings } from "../../../../../application/orm/mapping/publicDefinitionMapping.js";
import {
  registeredTypedSheetsProjectionDefinitions,
  registerTypedSheetsEntityMappings,
} from "../../../../../application/orm/persistence/flush/mappedFlushCoordinator.js";
import { initializeMikroOrmSqliteAdapter } from "../storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "../storage/MikroOrmSqliteSchema.js";
import { createTypedSheetsOrm } from "./MikroOrmTypedSheetsEngine.js";
import { createMappedTypedSheetsOrm } from "./MikroOrmMappedTypedSheets.js";
import { materializeTypedSheetsEntityDefinitions } from "../entities/MikroOrmEntityDefinitionMaterializer.js";

const NOOP_FLUSH_COORDINATOR: TypedSheetsFlushCoordinator = {
  async onFlush(): Promise<void> {
    // No physical Sheet route is selected by the entity-only factory yet.
  },
};

/**
 * Creates the public entity lifecycle around SQLite without exposing MikroORM.
 *
 * This first factory is deliberately entity-only: the database is the local
 * authority, while physical Sheet route registration is supplied by the sync
 * bootstrap APIs. Entity and Sheet definitions therefore do not get coupled.
 */
export async function createTypedSheets(
  options: CreateTypedSheetsOptions,
): Promise<TypedSheetsOrm> {
  const materializedEntities = materializeTypedSheetsEntityDefinitions(options.entities);
  if (options.sync !== undefined) {
    const storage = await initializeMikroOrmSqliteAdapter({
      dbName: options.dbName,
      entities: materializedEntities,
    });
    try {
      await migrateMikroOrmSqliteStorageSchema(storage);
      const mappings = createTypedSheetsEntityMappings(options.entities, options.sync);
      const registrations = await registerTypedSheetsEntityMappings(
        storage,
        mappings,
        { writerId: options.sync.writerId },
      );
      if (options.sync.onRegisteredProjections !== undefined) {
        await options.sync.onRegisteredProjections(
          registeredTypedSheetsProjectionDefinitions(registrations),
        );
      }
      return createMappedTypedSheetsOrm(storage, {
        mappings,
        writer: { writerId: options.sync.writerId },
      });
    } catch (error: unknown) {
      await storage.close(true);
      throw error;
    }
  }

  const storage = await initializeMikroOrmSqliteAdapter({
    dbName: options.dbName,
    entities: materializedEntities,
  });
  try {
    await migrateMikroOrmSqliteStorageSchema(storage);
    return createTypedSheetsOrm(storage, {
      flushCoordinator: NOOP_FLUSH_COORDINATOR,
    });
  } catch (error: unknown) {
    await storage.close(true);
    throw error;
  }
}
