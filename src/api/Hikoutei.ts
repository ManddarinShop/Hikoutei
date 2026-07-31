/**
 * Public Hikoutei runtime and the `createTypedSheets()` factory.
 *
 * Runtime creation opens and registers the local SQLite authority only. Remote
 * Sheet provisioning is an explicit `setupSheets()` call, so process startup
 * never mutates a spreadsheet or depends on network availability.
 */

import { provisionRegisteredSyncSheets } from "../application/sync/gateway/SyncGatewayBootstrap.js";
import type { ScalarEntityPersistenceProvider } from "../adapter/persistence/contracts/scalar.js";
import type { EntityManager } from "./EntityManager.js";
import { createEntityManager } from "./internalEntityManager.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
import {
  getEntityDescriptor,
  HikouteiEntity,
  type ResolvedHikouteiEntityDescriptor,
} from "./entity.js";

/** One physical tab/range used by a scalar entity projection. */
export interface HikouteiSheetRoute {
  readonly tabName: string;
  readonly registeredRange: string;
}

/** System projection and optional human-editable projection routes for one entity. */
export interface HikouteiEntityRoutes {
  readonly systemState: HikouteiSheetRoute;
  readonly userInput?: HikouteiSheetRoute;
}

/** Environment-specific spreadsheet routes kept separate from entity metadata. */
export interface HikouteiSheetsOptions {
  readonly spreadsheetId: string;
  readonly routes: Readonly<Record<string, HikouteiEntityRoutes>>;
}

/** Route accepted by a provider-neutral Sheet provisioning client. */
export interface HikouteiProvisionRoute {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: "user_input" | "system_state";
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly identityField?: string;
}

/** Result returned by one explicit Sheet setup call. */
export interface HikouteiSetupResult {
  readonly registrations: readonly Omit<HikouteiProvisionRoute, "headers">[];
  readonly createdSheets: readonly string[];
  readonly initializedHeaders: readonly string[];
}

/** Provider-neutral boundary used by `setupSheets()`; Apps Script stays behind it. */
export interface HikouteiSheetProvisioner {
  provisionRegistry(registrations: readonly HikouteiProvisionRoute[]): Promise<HikouteiSetupResult>;
}

/** Options for opening the local Hikoutei runtime. */
export interface CreateTypedSheetsOptions {
  /** SQLite database path, URI, or `:memory:`. */
  readonly dbName: string;
  /** Entity tokens produced by `defineTypedSheetsEntity()`. */
  readonly entities: readonly HikouteiEntity[];
  /** Environment-specific Sheet routes; route setup remains explicit. */
  readonly sheets: HikouteiSheetsOptions;
  /** Optional provider-neutral provisioner retained for an explicit setup call. */
  readonly provisioner?: HikouteiSheetProvisioner;
}

interface RegisteredProjectionSetup {
  readonly sheet: {
    readonly logicalSheetId: string;
    readonly physicalSheetId: string;
    readonly spreadsheetId: string;
    readonly tabName: string;
    readonly registeredRange: string;
    readonly projection: "user_input" | "system_state" | "sync_conflicts";
    readonly schemaVersion: number;
    readonly ownershipManifestJson: string;
    readonly businessKeyField: string;
    readonly anchorMode: "business_key" | "developer_metadata";
  };
  readonly headers: readonly string[];
}

/**
 * Root object for the local entity runtime.
 *
 * Use `hikoutei.em.fork()` to obtain a request-local manager. `setupSheets()`
 * is deliberately separate because it performs an external, idempotent Sheet
 * provisioning side effect.
 */
export interface Hikoutei {
  /** Root entity manager; call `fork()` before request or job-local work. */
  readonly em: EntityManager;
  close(): Promise<void>;
  setupSheets(provisioner?: HikouteiSheetProvisioner): Promise<HikouteiSetupResult>;
}

class HikouteiImpl implements Hikoutei {
  /** Root entity manager; call `fork()` before request or job-local work. */
  readonly em: EntityManager;

  constructor(
    private readonly provider: ScalarEntityPersistenceProvider,
    descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
    private readonly projectionDefinitions: readonly RegisteredProjectionSetup[],
    private readonly configuredProvisioner: HikouteiSheetProvisioner | undefined,
  ) {
    this.em = createEntityManager(provider, descriptors);
  }

  /** Releases the local SQLite connection. */
  async close(): Promise<void> {
    await this.provider.close();
  }

  /**
   * Provisions and validates the locally registered Sheet routes remotely.
   *
   * The operation is explicit and idempotent; a missing or mismatched header
   * is rejected by the provisioner instead of being silently overwritten.
   */
  async setupSheets(provisioner?: HikouteiSheetProvisioner): Promise<HikouteiSetupResult> {
    const selectedProvisioner = provisioner ?? this.configuredProvisioner;
    if (
      selectedProvisioner === null
      || typeof selectedProvisioner !== "object"
      || typeof selectedProvisioner.provisionRegistry !== "function"
    ) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.SHEET_SETUP_UNAVAILABLE,
        "setupSheets() requires a provider-neutral Sheet provisioner.",
      );
    }
    const definitions = this.projectionDefinitions.map((definition) => ({
      sheet: definition.sheet,
      headers: definition.headers,
    }));
    return provisionRegisteredSyncSheets(
      selectedProvisioner as never,
      definitions as never,
    ) as Promise<HikouteiSetupResult>;
  }

}

/** Internal construction hook; kept out of the root public barrel. */
function createHikoutei(
  provider: ScalarEntityPersistenceProvider,
  descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
  projectionDefinitions: readonly RegisteredProjectionSetup[],
  provisioner: HikouteiSheetProvisioner | undefined,
): Hikoutei {
  return new HikouteiImpl(provider, descriptors, projectionDefinitions, provisioner);
}

/**
 * Opens the local Hikoutei runtime for the declared scalar entities.
 *
 * This call validates routes, initializes MikroORM's current provider and the
 * local canonical/outbox registry, but never contacts a remote gateway.
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
  const sheets = validateSheetsOptions(options.sheets, descriptors);
  const routes = new Map(Object.entries(sheets.routes));
  // Load the current provider only when a runtime is opened. Importing the
  // root package alone must not require MikroORM or expose its module graph.
  const [mappedRuntime, providerModule, runtimeModule] = await Promise.all([
    import("../adapter/persistence/providers/mikro-orm/index.js"),
    import("../adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js"),
    import("../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarRuntime.js"),
  ]);
  const generated = runtimeModule.createMikroOrmScalarRuntime(
    options.entities,
    routes,
    sheets.spreadsheetId,
  );
  let projectionDefinitions: readonly RegisteredProjectionSetup[] = [];
  const writerId = `hikoutei:${process.pid}`;
  const orm = await mappedRuntime.initializeMappedTypedSheetsOrm({
    dbName: options.dbName,
    entities: generated.entities,
    mappings: generated.mappings,
    writer: { writerId },
    onRegisteredProjections: async (definitions) => {
      projectionDefinitions = definitions.map((definition) => ({
        sheet: definition.sheet,
        headers: definition.headers,
      }));
    },
  });
  const provider = new providerModule.MikroOrmScalarPersistenceProvider(orm, generated.bindings);
  return createHikoutei(provider, descriptors, projectionDefinitions, options.provisioner);
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

function validateSheetsOptions(
  options: HikouteiSheetsOptions,
  descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
): HikouteiSheetsOptions {
  if (options === null || typeof options !== "object") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
      "sheets must be an object.",
    );
  }
  if (typeof options.spreadsheetId !== "string" || options.spreadsheetId.trim() === "") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
      "sheets.spreadsheetId must be a non-empty string.",
    );
  }
  if (
    options.routes === null
    || typeof options.routes !== "object"
    || Array.isArray(options.routes)
  ) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
      "sheets.routes must be an object keyed by entity name.",
    );
  }
  const routeNames = Object.keys(options.routes);
  for (const entityName of descriptors.keys()) {
    if (options.routes[entityName] === undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
        `sheets.routes is missing an entry for entity "${entityName}".`,
      );
    }
  }
  for (const routeName of routeNames) {
    if (!descriptors.has(routeName)) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
        `sheets.routes contains an unknown entity "${routeName}".`,
      );
    }
    const route = options.routes[routeName];
    if (route === undefined) continue;
    validateRoute(routeName, "systemState", route.systemState);
    if (route.userInput !== undefined) validateRoute(routeName, "userInput", route.userInput);
  }
  return options;
}

function validateRoute(
  entityName: string,
  projection: string,
  route: HikouteiSheetRoute,
): void {
  if (
    route === null
    || typeof route !== "object"
    || typeof route.tabName !== "string"
    || route.tabName.trim() === ""
    || typeof route.registeredRange !== "string"
    || route.registeredRange.trim() === ""
  ) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
      `sheets.routes.${entityName}.${projection} requires tabName and registeredRange.`,
    );
  }
}
