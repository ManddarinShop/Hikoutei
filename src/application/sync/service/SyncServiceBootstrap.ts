/**
 * Internal same-process bootstrap for the SQLite-authoritative sync service.
 *
 * The root package deliberately does not export this module. It assembles the
 * mapped SQLite runtime, provisions the registered projections, starts the
 * outbound effect supervisor, and owns graceful shutdown around one SQLite
 * connection shared by ORM and sync storage.
 */

import { randomUUID } from "node:crypto";
import type { HikouteiEntity, ResolvedHikouteiEntityDescriptor } from "../../../api/entity.js";
import {
  createInternalHikoutei,
  type Hikoutei,
} from "../../../api/Hikoutei.js";
import { getEntityDescriptor, HikouteiEntity as HikouteiEntityToken } from "../../../api/entity.js";
import type { TypedSheetsEntityWriterOptions } from "../../orm/persistence/support/contracts.js";
import {
  initializeMappedTypedSheetsRuntime,
} from "../../../adapter/persistence/providers/mikro-orm/engine/MikroOrmMappedTypedSheets.js";
import {
  createMikroOrmScalarRuntime,
} from "../../../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarRuntime.js";
import {
  MikroOrmScalarPersistenceProvider,
} from "../../../adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js";
import type { MikroOrmSqliteAdapter } from "../../../adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import {
  registeredTypedSheetsProjectionDefinitions,
} from "../../orm/persistence/flush/flushCoordinator.js";
import type {
  SyncGatewayProvisioner,
  RegisteredSyncProjectionDefinition,
} from "../gateway/SyncGatewayBootstrap.js";
import {
  provisionRegisteredSyncSheets,
} from "../gateway/SyncGatewayBootstrap.js";
import type { SyncSheetGateway } from "../gateway/syncGateway.js";
import {
  AppsScriptOperationClient,
  type AppsScriptOperationClientOptions,
} from "../../../adapter/sheets/providers/apps-script-gateway/transport/operationClient.js";
import {
  AppsScriptOperationSyncGateway,
} from "../../../adapter/sheets/providers/apps-script-gateway/transport/operationSyncGateway.js";
import {
  createSyncEffectWorkerSupervisor,
  type SyncEffectWorkerSupervisor,
} from "../outbound/effects/SyncEffectSupervisor.js";
import type { SyncEffectWorkerReport } from "../outbound/effects/SyncEffectWorker.js";
import {
  pollMappedUserInputWithMikroOrm,
  type MappedUserInputPollingReport,
} from "../../../adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import { SyncPollingSupervisor } from "./SyncPollingSupervisor.js";
import type { SyncTimingSink } from "../telemetry/syncTiming.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "./errors.js";
import type {
  InternalSyncEntityConfig,
  InternalSyncProjectionConfig,
} from "./contracts.js";

/** Gateway capability required by internal service startup. */
export type InternalSyncGateway = SyncSheetGateway;

/** Internal service options; none are part of the root application contract. */
export interface InternalSyncServiceOptions {
  readonly dbName: string;
  readonly entities: readonly HikouteiEntity[];
  readonly projections: InternalSyncProjectionConfig;
  /** Injected gateway used by fake/in-process tests. */
  readonly gateway?: InternalSyncGateway;
  /** Optional provisioner for injected gateways that do not own setup. */
  readonly provisioner?: SyncGatewayProvisioner;
  /** Real Apps Script transport settings used when no gateway is injected. */
  readonly appsScript?: AppsScriptOperationClientOptions;
  readonly writerId?: string;
  readonly workerId?: string;
  readonly maxEffects?: number;
  readonly effectIdleIntervalMs?: number;
  readonly onTiming?: SyncTimingSink;
  readonly onEffectReport?: (report: SyncEffectWorkerReport) => void;
  readonly onEffectError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number;
  readonly onPollingReport?: (report: MappedUserInputPollingReport) => void;
  readonly onPollingError?: (error: unknown) => void;
}

/** Runtime returned to an internal service entrypoint, not to root consumers. */
export interface InternalSyncService {
  readonly hikoutei: Hikoutei;
  /** Internal inspection handle; never part of the root application API. */
  readonly storage: MikroOrmSqliteAdapter;
  readonly projectionDefinitions: readonly RegisteredSyncProjectionDefinition[];
  readonly effectSupervisor: SyncEffectWorkerSupervisor;
  readonly pollingSupervisor: SyncPollingSupervisor;
  stop(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens, provisions, and starts one internal sync service.
 *
 * Startup is fail-closed: a malformed route, missing gateway, or remote
 * provisioning failure closes the SQLite runtime before the error escapes.
 */
export async function createInternalSyncService(
  options: InternalSyncServiceOptions,
): Promise<InternalSyncService> {
  const descriptors = resolveSyncDescriptors(options.entities);
  validateServiceOptions(options, descriptors);
  const generated = createMikroOrmScalarRuntime(options.entities, options.projections);
  const writer = createWriterOptions(options);
  const runtime = await initializeMappedTypedSheetsRuntime({
    dbName: options.dbName,
    entities: generated.entities,
    mappings: generated.mappings,
    writer,
  });

  try {
    const projectionDefinitions = registeredTypedSheetsProjectionDefinitions(runtime.registrations);
    const remote = createRemoteGateway(options, projectionDefinitions);
    await provisionRegisteredSyncSheets(remote.provisioner, projectionDefinitions);

    const effectSupervisor = createSyncEffectWorkerSupervisor({
      storage: runtime.storage,
      gateway: remote.gateway,
      ...optionalWorkerOptions(options),
    });
    const pollingSupervisor = new SyncPollingSupervisor({
      runPass: () => pollMappedUserInputWithMikroOrm({
        storage: runtime.storage,
        gateway: remote.gateway,
        mappings: runtime.mappings,
        writer,
      }),
      ...(options.pollingIntervalMs === undefined ? {} : { intervalMs: options.pollingIntervalMs }),
      onReport: (report) => options.onPollingReport?.(report as MappedUserInputPollingReport),
      ...(options.onPollingError === undefined ? {} : { onError: options.onPollingError }),
    });

    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (stopped) return Promise.resolve();
      if (stopPromise !== undefined) return stopPromise;
      // Stop inbound reads first, then the outbound worker. Both supervisors
      // drain manual and background passes before SQLite is closed.
      stopPromise = (async () => {
        await pollingSupervisor.stop();
        await effectSupervisor.stop();
        stopped = true;
        stopPromise = undefined;
      })().catch((error: unknown) => {
        stopPromise = undefined;
        throw error;
      });
      return stopPromise;
    };

    const provider = new MikroOrmScalarPersistenceProvider(runtime.orm, generated.bindings);
    const hikoutei = createInternalHikoutei(provider, descriptors, stop);
    effectSupervisor.start();
    pollingSupervisor.start();

    return {
      hikoutei,
      storage: runtime.storage,
      projectionDefinitions,
      effectSupervisor,
      pollingSupervisor,
      stop,
      close: () => hikoutei.close(),
    };
  } catch (error: unknown) {
    await runtime.storage.close(true).catch(() => undefined);
    throw error;
  }
}

function resolveSyncDescriptors(
  entities: readonly HikouteiEntity[],
): ReadonlyMap<string, ResolvedHikouteiEntityDescriptor> {
  const descriptors = new Map<string, ResolvedHikouteiEntityDescriptor>();
  const tables = new Map<string, string>();
  for (const entity of entities) {
    if (!(entity instanceof HikouteiEntityToken)) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        "sync service entities must be tokens produced by defineTypedSheetsEntity().",
      );
    }
    const descriptor = getEntityDescriptor(entity);
    if (descriptors.has(descriptor.name)) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `sync service entity "${descriptor.name}" is registered more than once.`,
      );
    }
    const existing = tables.get(descriptor.tableName);
    if (existing !== undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `sync service table "${descriptor.tableName}" is shared by "${existing}" and "${descriptor.name}".`,
      );
    }
    descriptors.set(descriptor.name, descriptor);
    tables.set(descriptor.tableName, descriptor.name);
  }
  return descriptors;
}

function validateServiceOptions(
  options: InternalSyncServiceOptions,
  descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
): void {
  if (options.dbName.trim() === "") {
    throw new SyncServiceError(SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS, "sync service dbName is required.");
  }
  requireText(options.projections.spreadsheetId, "sync service spreadsheetId");
  if (descriptors.size === 0) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service requires at least one entity.",
    );
  }

  const routes = new Set<string>();
  for (const [entityName, descriptor] of descriptors) {
    const entityConfig = options.projections.entities[entityName];
    if (entityConfig === undefined) {
      throwInvalidProjection(`sync configuration is missing entity "${entityName}".`);
    }
    validateEntityConfig(entityName, descriptor, entityConfig, routes, options.projections.spreadsheetId);
  }
  for (const entityName of Object.keys(options.projections.entities)) {
    if (!descriptors.has(entityName)) {
      throwInvalidProjection(`sync configuration contains unknown entity "${entityName}".`);
    }
  }
  if (options.gateway === undefined && options.appsScript === undefined) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.GATEWAY_UNAVAILABLE,
      "sync service requires an injected gateway or Apps Script client settings.",
    );
  }
}

function validateEntityConfig(
  entityName: string,
  descriptor: ResolvedHikouteiEntityDescriptor,
  config: InternalSyncEntityConfig,
  routes: Set<string>,
  spreadsheetId: string,
): void {
  validateRoute(entityName, "systemState", config.systemState);
  addRoute(routes, spreadsheetId, config.systemState.tabName, entityName, "systemState");
  if (config.userInput !== undefined) {
    validateRoute(entityName, "userInput", config.userInput);
    addRoute(routes, spreadsheetId, config.userInput.tabName, entityName, "userInput");
  }
  for (const field of config.userOwnedFields ?? []) {
    if (!descriptor.properties.some((property) => property.name === field)) {
      throwInvalidProjection(`sync configuration references unknown property "${entityName}.${field}".`);
    }
  }
  if (config.userInput !== undefined && !(config.userOwnedFields ?? []).includes(descriptor.primaryKey)) {
    throwInvalidProjection(
      `User_Input for "${entityName}" must own primary key "${descriptor.primaryKey}".`,
    );
  }
}

function validateRoute(entityName: string, projection: string, route: { readonly tabName: string; readonly registeredRange: string }): void {
  if (route === null || typeof route !== "object") {
    throwInvalidProjection(`sync route ${entityName}.${projection} must be an object.`);
  }
  requireText(route.tabName, `sync route ${entityName}.${projection}.tabName`);
  requireText(route.registeredRange, `sync route ${entityName}.${projection}.registeredRange`);
}

function addRoute(
  routes: Set<string>,
  spreadsheetId: string,
  tabName: string,
  entityName: string,
  projection: string,
): void {
  const key = JSON.stringify([spreadsheetId, tabName.trim()]);
  if (routes.has(key)) {
    throwInvalidProjection(`sync route ${entityName}.${projection} reuses Sheet tab "${tabName}".`);
  }
  routes.add(key);
}

function createWriterOptions(options: InternalSyncServiceOptions): TypedSheetsEntityWriterOptions {
  return {
    writerId: options.writerId ?? `hikoutei-sync:${randomUUID()}`,
    ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
  };
}

function optionalWorkerOptions(options: InternalSyncServiceOptions): {
  readonly workerId?: string;
  readonly maxEffects?: number;
  readonly idleIntervalMs?: number;
  readonly onTiming?: SyncTimingSink;
  readonly onReport?: (report: SyncEffectWorkerReport) => void;
  readonly onError?: (error: unknown) => void;
} {
  return {
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.maxEffects === undefined ? {} : { maxEffects: options.maxEffects }),
    ...(options.effectIdleIntervalMs === undefined ? {} : { idleIntervalMs: options.effectIdleIntervalMs }),
    ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
    ...(options.onEffectReport === undefined ? {} : { onReport: options.onEffectReport }),
    ...(options.onEffectError === undefined ? {} : { onError: options.onEffectError }),
  };
}

function createRemoteGateway(
  options: InternalSyncServiceOptions,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): { readonly gateway: InternalSyncGateway; readonly provisioner: SyncGatewayProvisioner } {
  if (options.gateway !== undefined) {
    const provisioner = options.provisioner ?? asProvisioner(options.gateway);
    if (provisioner === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.GATEWAY_UNAVAILABLE,
        "the injected sync gateway does not provide projection provisioning.",
      );
    }
    return { gateway: options.gateway, provisioner };
  }

  const client = new AppsScriptOperationClient(options.appsScript!);
  const gateway = new AppsScriptOperationSyncGateway({
    operationGateway: client,
    definitions,
  });
  return { gateway, provisioner: gateway };
}

function asProvisioner(value: object): SyncGatewayProvisioner | undefined {
  const candidate = value as Partial<SyncGatewayProvisioner>;
  return typeof candidate.provisionRegistry === "function"
    ? candidate as SyncGatewayProvisioner
    : undefined;
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throwInvalidProjection(`${label} must be a non-empty string.`);
  }
}

function throwInvalidProjection(message: string): never {
  throw new SyncServiceError(SYNC_SERVICE_ERROR_CODES.INVALID_PROJECTION_CONFIG, message);
}
