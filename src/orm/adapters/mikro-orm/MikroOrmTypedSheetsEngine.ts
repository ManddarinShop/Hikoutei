/**
 * MikroORM implementation of the replaceable typed-sheets entity engine.
 *
 * This module owns engine construction and shutdown only. EntityManager
 * delegation and changeset normalization live in focused adapter modules.
 */

import { createTypedSheetsOrm as createTypedSheetsOrmFacade } from "../../api/TypedSheetsOrm.js";
import type {
  TypedSheetsEntityEngine,
  TypedSheetsEntityEngineManager,
} from "../../api/contracts.js";
import type {
  CreateTypedSheetsOrmOptions,
  TypedSheetsOrm,
} from "../../api/TypedSheetsOrm.js";
import {
  initializeMikroOrmSqliteAdapter,
  type InitializeMikroOrmSqliteAdapterOptions,
  type MikroOrmSqliteAdapter,
} from "./MikroOrmSqliteAdapter.js";
import { MikroOrmSqliteTypedSheetsEntityManager } from "./MikroOrmTypedSheetsEntityManager.js";
import { migrateMikroOrmSqliteStorageSchema } from "./MikroOrmSqliteSchema.js";

/** Options for initializing a dedicated typed-sheets SQLite ORM instance. */
export interface InitializeTypedSheetsOrmOptions extends InitializeMikroOrmSqliteAdapterOptions {
  /** Plans canonical and Sheets outbox work for every durable entity flush. */
  readonly flushCoordinator: CreateTypedSheetsOrmOptions["flushCoordinator"];
}

/**
 * Wraps the MikroORM SQLite adapter as our replaceable entity execution engine.
 *
 * A future Drizzle or another ORM implementation only needs to implement the
 * same typed-sheets engine contract; application lifecycle calls stay stable.
 */
export class MikroOrmSqliteTypedSheetsEngine implements TypedSheetsEntityEngine {
  constructor(private readonly storage: MikroOrmSqliteAdapter) {}

  /** Opens a MikroORM-backed manager behind the typed-sheets engine boundary. */
  fork(): TypedSheetsEntityEngineManager {
    return new MikroOrmSqliteTypedSheetsEntityManager(
      this.storage,
      this.storage.forkEntityManager(),
    );
  }

  /** Closes the dedicated MikroORM SQLite connection. */
  async close(force = false): Promise<void> {
    await this.storage.close(force);
  }
}

/** Creates the replaceable typed-sheets engine backed by one SQLite adapter. */
export function createMikroOrmSqliteTypedSheetsEngine(
  storage: MikroOrmSqliteAdapter,
): MikroOrmSqliteTypedSheetsEngine {
  return new MikroOrmSqliteTypedSheetsEngine(storage);
}

/** Creates our public entity facade around an existing MikroORM SQLite adapter. */
export function createTypedSheetsOrm(
  storage: MikroOrmSqliteAdapter,
  options: CreateTypedSheetsOrmOptions,
): TypedSheetsOrm {
  return createTypedSheetsOrmFacade(createMikroOrmSqliteTypedSheetsEngine(storage), options);
}

/**
 * Opens and migrates a dedicated SQLite runtime, then returns our public ORM
 * facade. Startup cleanup closes the adapter if migration or construction fails.
 */
export async function initializeTypedSheetsOrm(
  options: InitializeTypedSheetsOrmOptions,
): Promise<TypedSheetsOrm> {
  const { flushCoordinator, ...adapterOptions } = options;
  const storage = await initializeMikroOrmSqliteAdapter(adapterOptions);
  try {
    await migrateMikroOrmSqliteStorageSchema(storage);
    return createTypedSheetsOrm(storage, { flushCoordinator });
  } catch (error: unknown) {
    await storage.close(true);
    throw error;
  }
}
