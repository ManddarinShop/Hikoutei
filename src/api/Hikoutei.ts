/**
 * Public SQLite-authoritative Hikoutei runtime and the `createTypedSheets()` factory.
 *
 * This module intentionally knows nothing about Sheet routes or gateway
 * provisioning. The internal sync service builds a mapped runtime separately
 * and can reuse the internal construction hook below without expanding the
 * application-facing contract.
 */

import type { ScalarEntityPersistenceProvider } from "../adapter/persistence/contracts/scalar.js";
import type { EntityManager } from "./EntityManager.js";
import { createEntityManager } from "./internalEntityManager.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
import {
  getEntityDescriptor,
  HikouteiEntity,
  type ResolvedHikouteiEntityDescriptor,
} from "./entity.js";

/** Options for opening the local Hikoutei runtime. */
export interface CreateTypedSheetsOptions {
  /** SQLite database path, URI, or `:memory:`. */
  readonly dbName: string;
  /** Entity tokens produced by `defineTypedSheetsEntity()`. */
  readonly entities: readonly HikouteiEntity[];
}

/**
 * Root object for the local entity runtime.
 *
 * Use `hikoutei.em.fork()` to obtain a request-local manager. Sheet delivery
 * and User_Input polling belong to the internal sync service, not this object.
 */
export interface Hikoutei {
  /** Root entity manager; call `fork()` before request or job-local work. */
  readonly em: EntityManager;
  close(): Promise<void>;
}

class HikouteiImpl implements Hikoutei {
  /** Root entity manager; call `fork()` before request or job-local work. */
  readonly em: EntityManager;
  private closed = false;

  constructor(
    private readonly provider: ScalarEntityPersistenceProvider,
    descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
    private readonly beforeClose: (() => Promise<void>) | undefined,
  ) {
    this.em = createEntityManager(provider, descriptors);
  }

  /** Stops internal service work, then releases the local SQLite connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    let beforeCloseError: unknown;
    try {
      await this.beforeClose?.();
    } catch (error: unknown) {
      beforeCloseError = error;
    }

    try {
      await this.provider.close();
    } catch (providerError: unknown) {
      if (beforeCloseError !== undefined) {
        throw new AggregateError(
          [beforeCloseError, providerError],
          "Hikoutei failed to stop internal work and close SQLite.",
        );
      }
      throw providerError;
    }

    if (beforeCloseError !== undefined) throw beforeCloseError;
  }
}

/**
 * Internal construction hook used by the sync service to attach shutdown work
 * without adding worker methods to the public `Hikoutei` contract.
 */
export function createInternalHikoutei(
  provider: ScalarEntityPersistenceProvider,
  descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
  beforeClose?: () => Promise<void>,
): Hikoutei {
  return new HikouteiImpl(provider, descriptors, beforeClose);
}

/**
 * Opens the local SQLite runtime for the declared scalar entities.
 *
 * This call validates entity descriptors and initializes the local provider. It
 * never contacts Google Sheets, creates projection tables, or starts a worker.
 */
export async function createTypedSheets(
  options: CreateTypedSheetsOptions,
): Promise<Hikoutei> {
  if (options === null || typeof options !== "object") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() options must be an object.",
    );
  }
  if (typeof options.dbName !== "string" || options.dbName.trim() === "") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() dbName must be a non-empty string.",
    );
  }
  if (!Array.isArray(options.entities)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() entities must be an array.",
    );
  }

  const descriptors = resolveRuntimeDescriptors(options.entities);
  // Load the current provider only when a runtime is opened. Importing the
  // root package alone must not require MikroORM or expose its module graph.
  const [engineModule, providerModule, runtimeModule] = await Promise.all([
    import("../adapter/persistence/providers/mikro-orm/engine/MikroOrmTypedSheetsEngine.js"),
    import("../adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js"),
    import("../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarEntityRuntime.js"),
  ]);
  const generated = runtimeModule.createMikroOrmScalarEntityRuntime(options.entities);
  const orm = await engineModule.initializeTypedSheetsOrm({
    dbName: options.dbName,
    entities: generated.entities,
    flushCoordinator: { onFlush: async () => undefined },
  });
  const provider = new providerModule.MikroOrmScalarPersistenceProvider(orm, generated.bindings);
  return createInternalHikoutei(provider, descriptors);
}

/** Validates name/table uniqueness and indexes descriptors by entity name. */
function resolveRuntimeDescriptors(
  entities: readonly HikouteiEntity[],
): ReadonlyMap<string, ResolvedHikouteiEntityDescriptor> {
  const descriptors = new Map<string, ResolvedHikouteiEntityDescriptor>();
  const tablesByName = new Map<string, string>();
  for (const entity of entities) {
    if (!(entity instanceof HikouteiEntity)) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
        "createTypedSheets() accepts only tokens produced by defineTypedSheetsEntity().",
      );
    }
    const descriptor = getEntityDescriptor(entity);
    if (descriptors.has(descriptor.name)) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
        `entity name "${descriptor.name}" is registered more than once.`,
      );
    }
    const existingTableEntity = tablesByName.get(descriptor.tableName);
    if (existingTableEntity !== undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
        `table "${descriptor.tableName}" is shared by entities "${existingTableEntity}" and "${descriptor.name}".`,
      );
    }
    descriptors.set(descriptor.name, descriptor);
    tablesByName.set(descriptor.tableName, descriptor.name);
  }
  return descriptors;
}
