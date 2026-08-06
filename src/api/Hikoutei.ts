/**
 * Public SQLite-authoritative Hikoutei runtime and the `createTypedSheets()` factory.
 *
 * This module intentionally knows nothing about Sheet routes or provider
 * provisioning. When `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, the factory
 * delegates to the internal sync auto-start bridge, which builds a mapped
 * runtime and provisions the bound spreadsheet separately; the application-
 * facing contract stays unchanged either way.
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

/** Validates the public factory options before any runtime is constructed. */
export function validateTypedSheetsOptions(options: CreateTypedSheetsOptions): void {
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
}

/**
 * Opens the plain local-only SQLite runtime with no sync service.
 *
 * Internal construction hook shared by `createTypedSheets()` (env absent) and
 * the sync auto-start bridge (env present but disabled). It deliberately loads
 * the current provider lazily so importing the root package alone never
 * requires MikroORM or the Google SDK module graph.
 */
export async function createLocalTypedSheetsRuntime(
  options: CreateTypedSheetsOptions,
): Promise<Hikoutei> {
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

/**
 * Opens the local SQLite runtime for the declared scalar entities.
 *
 * When `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, the internal sync auto-start
 * bridge provisions the spreadsheet, validates the service-account
 * credentials file, and starts the outbound worker and User_Input polling
 * before returning. Startup failures are classified into stable
 * `HikouteiError` codes and fail closed. Without that env var this call never
 * contacts Google Sheets, creates projection tables, or starts a worker, and
 * the local-only behavior is byte-identical to previous releases.
 */
export async function createTypedSheets(
  options: CreateTypedSheetsOptions,
): Promise<Hikoutei> {
  validateTypedSheetsOptions(options);

  const spreadsheetUrl = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
  if (spreadsheetUrl === undefined || spreadsheetUrl.trim() === "") {
    // Env absent: the exact local-only path. The sync module graph (MikroORM
    // and the Google SDK) is never imported here.
    return createLocalTypedSheetsRuntime(options);
  }

  // Env present: delegate to the internal sync auto-start bridge. The dynamic
  // import keeps the module graph out of the env-absent path.
  const { createTypedSheetsWithSync } = await import(
    "../application/sync/service/syncAutoStart.js"
  );
  const result = await createTypedSheetsWithSync({
    dbName: options.dbName,
    entities: [...options.entities],
    env: process.env,
  });
  return result.hikoutei;
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
