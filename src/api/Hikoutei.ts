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
  getRegisteredEntityTokens,
  HikouteiEntity,
  type ResolvedHikouteiEntityDescriptor,
} from "./entity.js";

/** Environment variable that supplies the default SQLite path. */
const HIKOUTEI_DB_PATH_ENV = "HIKOUTEI_DB_PATH";

/** SQLite path used when neither `dbName` nor the env var is set. */
const DEFAULT_DB_PATH = "./hikoutei.sqlite";

/** Options for opening the local Hikoutei runtime. */
export interface CreateTypedSheetsOptions {
  /**
   * SQLite database path, URI, or `:memory:`.
   *
   * Defaults to the `HIKOUTEI_DB_PATH` environment variable when it is set to
   * a non-empty value, otherwise `./hikoutei.sqlite`.
   */
  readonly dbName?: string;
  /**
   * Entity tokens produced by `defineTypedSheetsEntity()`.
   *
   * Defaults to the entities registered by `defineTypedSheetsEntity()` at the
   * time of the call, in registration order.
   */
  readonly entities?: readonly HikouteiEntity[];
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
 * Resolves the default SQLite path for a factory call that omits `dbName`.
 *
 * Prefers the `HIKOUTEI_DB_PATH` environment variable when it is set to a
 * non-empty string, otherwise falls back to `./hikoutei.sqlite`. The `env`
 * parameter defaults to `process.env` and exists so tests can exercise the
 * precedence without mutating the process environment.
 */
export function resolveDefaultDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromEnv = env[HIKOUTEI_DB_PATH_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return DEFAULT_DB_PATH;
}

/**
 * Validates the public factory options before any runtime is constructed.
 *
 * Fields are optional; each one is validated only when it is provided. The
 * registry/env defaults are applied afterwards by `createTypedSheets()`.
 */
export function validateTypedSheetsOptions(options: CreateTypedSheetsOptions): void {
  if (options === null || typeof options !== "object") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() options must be an object.",
    );
  }
  if (options.dbName !== undefined && (typeof options.dbName !== "string" || options.dbName.trim() === "")) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() dbName must be a non-empty string.",
    );
  }
  if (options.entities !== undefined && !Array.isArray(options.entities)) {
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
 * requires MikroORM or the Google SDK module graph. Omitting `dbName` or
 * `entities` here applies the same defaults as `createTypedSheets()`.
 */
export async function createLocalTypedSheetsRuntime(
  options: CreateTypedSheetsOptions,
): Promise<Hikoutei> {
  const dbName = options.dbName ?? resolveDefaultDbPath();
  const entities = options.entities ?? getRegisteredEntityTokens();
  const descriptors = resolveRuntimeDescriptors(entities);
  // Load the current provider only when a runtime is opened. Importing the
  // root package alone must not require MikroORM or expose its module graph.
  const [engineModule, providerModule, runtimeModule] = await Promise.all([
    import("../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarStorage.js"),
    import("../adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js"),
    import("../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarEntityRuntime.js"),
  ]);
  const generated = runtimeModule.createMikroOrmScalarEntityRuntime(entities);
  const storage = await engineModule.initializeMikroOrmScalarStorage({
    dbName,
    entities: generated.entities,
  });
  const provider = new providerModule.MikroOrmScalarPersistenceProvider(storage, generated.bindings);
  return createInternalHikoutei(provider, descriptors);
}

/**
 * Opens the local SQLite runtime for the declared scalar entities.
 *
 * When `dbName` is omitted the `HIKOUTEI_DB_PATH` environment variable or
 * `./hikoutei.sqlite` is used; when `entities` is omitted the tokens registered
 * by `defineTypedSheetsEntity()` are used, in registration order.
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
  options: CreateTypedSheetsOptions = {},
): Promise<Hikoutei> {
  validateTypedSheetsOptions(options);

  const dbName = options.dbName ?? resolveDefaultDbPath();
  const entities = options.entities ?? getRegisteredEntityTokens();
  if (options.entities === undefined && entities.length === 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() requires at least one entity; pass `entities` or call defineTypedSheetsEntity() before opening the runtime.",
    );
  }

  const spreadsheetUrl = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
  if (spreadsheetUrl === undefined || spreadsheetUrl.trim() === "") {
    // Env absent: the exact local-only path. The sync module graph (MikroORM
    // and the Google SDK) is never imported here.
    return createLocalTypedSheetsRuntime({ dbName, entities });
  }

  // Env present: delegate to the internal sync auto-start bridge. The dynamic
  // import keeps the module graph out of the env-absent path.
  const { createTypedSheetsWithSync } = await import(
    "../application/sync/service/syncAutoStart.js"
  );
  const result = await createTypedSheetsWithSync({
    dbName,
    entities: [...entities],
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
