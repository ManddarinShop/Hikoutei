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
  resolveTypedSheetsEntityWriterOptions,
} from "../../orm/persistence/flush/flushCoordinator.js";
import type {
  SyncGatewayProvisioner,
  RegisteredSyncProjectionDefinition,
} from "../gateway/SyncGatewayBootstrap.js";
import {
  provisionRegisteredSyncSheets,
} from "../gateway/SyncGatewayBootstrap.js";
import {
  registerSyncConflictProjectionRoutes,
} from "../gateway/conflictProjectionRegistration.js";
import {
  autoResolveExistingMappedConflictsWithAdapter,
  retryOpenMappedConflictsWithAdapter,
} from "../inbound/autoSystemConflictResolution.js";
import type { SyncSheetGateway, SyncSheetTableReaderGateway } from "../gateway/syncGateway.js";
import { isSyncSheetTableReaderGateway } from "../gateway/syncGateway.js";
import {
  CoordinatedSyncGateway,
  type CoordinatedGatewayInner,
} from "../gateway/coordinator/CoordinatedSyncGateway.js";
import type { CoordinatorLaneEvent } from "../gateway/coordinator/coordinatorTelemetry.js";
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
  MAPPED_USER_INPUT_POLL_MODES,
  pollMappedUserInputWithMikroOrm,
  type MappedUserInputPollingReport,
} from "../../../adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import { SyncPollingSupervisor } from "./SyncPollingSupervisor.js";
import type { SyncTimingSink } from "../telemetry/syncTiming.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "./errors.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_LEASE_GATEWAY_HEADROOM_MS,
} from "../outbound/effects/SyncEffectWorkerConstants.js";
import { SYNC_GATEWAY_CLIENT_DEFAULTS } from "../../../adapter/sheets/providers/apps-script-gateway/protocol/constants.js";
import type {
  InternalSyncEntityConfig,
  InternalSyncProjectionConfig,
} from "./contracts.js";

const DEFAULT_POLLING_FULL_SCAN_INTERVAL_MS = 60_000;

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
  /** Internal lease for one remote effect batch; must exceed Gateway timeout. */
  readonly effectLeaseDurationMs?: number;
  readonly effectIdleIntervalMs?: number;
  readonly onTiming?: SyncTimingSink;
  readonly onEffectReport?: (report: SyncEffectWorkerReport) => void;
  readonly onEffectError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number;
  /** Maximum interval between metadata-preserving safety scans. */
  readonly pollingFullScanIntervalMs?: number;
  /** Injectable clock for the polling coordinator cadence; defaults to Date.now. */
  readonly now?: () => number;
  /** Optional per-spreadsheet mutation-lane key for the Gateway coordinator. */
  readonly coordinatorLaneKeyForPhysicalSheet?: (physicalSheetId: string) => string;
  /** Optional diagnostic observer for coordinator mutation-lane events. */
  readonly onCoordinatorLaneEvent?: (event: CoordinatorLaneEvent) => void;
  readonly onPollingReport?: (report: MappedUserInputPollingReport) => void;
  readonly onPollingError?: (error: unknown) => void;
}

/** Internal control operation serialized by the service's Gateway coordinator. */
export type InternalSyncGatewayControl = <T>(
  physicalSheetId: string,
  operation: string,
  task: () => Promise<T>,
) => Promise<T>;

/** Runtime returned to an internal service entrypoint, not to root consumers. */
export interface InternalSyncService {
  readonly hikoutei: Hikoutei;
  /** Internal inspection handle; never part of the root application API. */
  readonly storage: MikroOrmSqliteAdapter;
  readonly projectionDefinitions: readonly RegisteredSyncProjectionDefinition[];
  /** Test/admin controls must use this lane instead of the raw operation client. */
  readonly runGatewayControl: InternalSyncGatewayControl | undefined;
  /** Retries durable OPEN system-wins commands after predecessors settle. */
  readonly retryDeferredConflicts: () => Promise<number>;
  readonly effectSupervisor: SyncEffectWorkerSupervisor;
  readonly pollingSupervisor: SyncPollingSupervisor<MappedUserInputPollingReport>;
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
    const projectionDefinitions = [
      ...registeredTypedSheetsProjectionDefinitions(runtime.registrations),
      ...await registerSyncConflictProjectionRoutes(
        runtime.storage,
        runtime.registrations,
        options.projections,
        writer,
      ),
    ];
    const remote = createRemoteGateway(options, projectionDefinitions);
    await provisionRegisteredSyncSheets(remote.provisioner, projectionDefinitions);
    await autoResolveExistingMappedConflictsWithAdapter(
      runtime.storage,
      runtime.mappings.mappings,
      resolveTypedSheetsEntityWriterOptions(writer),
    );

    const effectSupervisor = createSyncEffectWorkerSupervisor({
      storage: runtime.storage,
      gateway: remote.gateway,
      ...optionalWorkerOptions(options),
    });
    const pollingFullScanIntervalMs = options.pollingFullScanIntervalMs
      ?? DEFAULT_POLLING_FULL_SCAN_INTERVAL_MS;
    const clock = options.now ?? Date.now;
    let lastSuccessfulFullScanAt: number | undefined;
    const runPollingPass = async (): Promise<MappedUserInputPollingReport> => {
      const now = clock();
      const safetyFullScan = lastSuccessfulFullScanAt === undefined ||
        now - lastSuccessfulFullScanAt >= pollingFullScanIntervalMs;
      // Safety-scan lag is how far past the configured deadline this pass starts.
      // It is zero before the first completed scan and on adaptive passes, so the
      // report exposes a stable numeric field with a safe default elsewhere.
      const safetyScanLagMs = safetyFullScan && lastSuccessfulFullScanAt !== undefined
        ? Math.max(0, now - lastSuccessfulFullScanAt - pollingFullScanIntervalMs)
        : 0;
      const report = await pollMappedUserInputWithMikroOrm({
        storage: runtime.storage,
        gateway: remote.gateway,
        mappings: runtime.mappings,
        writer,
        mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
        forceFull: safetyFullScan,
        safetyScanLagMs,
        ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
      });
      // Only a completed safety scan advances the deadline. A failing safety scan
      // propagates its original error and leaves lastSuccessfulFullScanAt unchanged.
      if (report.safetyFullScan) lastSuccessfulFullScanAt = clock();
      return report;
    };
    const pollingSupervisor = new SyncPollingSupervisor({
      runPass: runPollingPass,
      ...(options.pollingIntervalMs === undefined ? {} : { intervalMs: options.pollingIntervalMs }),
      onReport: (report) => options.onPollingReport?.(report),
      ...(options.onPollingError === undefined ? {} : { onError: options.onPollingError }),
    });
    const retryDeferredConflicts = (): Promise<number> => retryOpenMappedConflictsWithAdapter(
      runtime.storage,
      runtime.mappings.mappings,
      resolveTypedSheetsEntityWriterOptions(writer),
    );

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
      runGatewayControl: remote.runGatewayControl,
      retryDeferredConflicts,
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
  validateEffectLeaseHeadroom(options);
  if (
    options.pollingFullScanIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.pollingFullScanIntervalMs) || options.pollingFullScanIntervalMs < 1)
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service pollingFullScanIntervalMs must be a positive safe integer.",
    );
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

function validateEffectLeaseHeadroom(options: InternalSyncServiceOptions): void {
  const effectLeaseDurationMs = options.effectLeaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS;
  if (
    !Number.isSafeInteger(effectLeaseDurationMs) ||
    effectLeaseDurationMs < 1
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service effectLeaseDurationMs must be a positive safe integer.",
    );
  }
  if (effectLeaseDurationMs >= DEFAULT_WRITER_LEASE_DURATION_MS) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service effectLeaseDurationMs must be shorter than the 180-second writer lease.",
    );
  }
  if (options.appsScript === undefined) return;

  const requestTimeoutMs = options.appsScript.requestTimeoutMs
    ?? SYNC_GATEWAY_CLIENT_DEFAULTS.REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < SYNC_GATEWAY_CLIENT_DEFAULTS.MIN_REQUEST_TIMEOUT_MS ||
    requestTimeoutMs > SYNC_GATEWAY_CLIENT_DEFAULTS.MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service Apps Script requestTimeoutMs must be between 1 second and 120 seconds.",
    );
  }
  if (effectLeaseDurationMs <= requestTimeoutMs + EFFECT_LEASE_GATEWAY_HEADROOM_MS) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service effectLeaseDurationMs must exceed Apps Script requestTimeoutMs by 30 seconds before supervisors start.",
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
  validateRoute(entityName, "syncConflicts", config.syncConflicts);
  addRoute(routes, spreadsheetId, config.syncConflicts.tabName, entityName, "syncConflicts");
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
  readonly effectLeaseDurationMs?: number;
  readonly gatewayTimeoutMs?: number;
  readonly idleIntervalMs?: number;
  readonly onTiming?: SyncTimingSink;
  readonly onReport?: (report: SyncEffectWorkerReport) => void;
  readonly onError?: (error: unknown) => void;
} {
  return {
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.maxEffects === undefined ? {} : { maxEffects: options.maxEffects }),
    ...(options.effectLeaseDurationMs === undefined ? {} : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
    ...(options.appsScript?.requestTimeoutMs === undefined ? {} : { gatewayTimeoutMs: options.appsScript.requestTimeoutMs }),
    ...(options.effectIdleIntervalMs === undefined ? {} : { idleIntervalMs: options.effectIdleIntervalMs }),
    ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
    ...(options.onEffectReport === undefined ? {} : { onReport: options.onEffectReport }),
    ...(options.onEffectError === undefined ? {} : { onError: options.onEffectError }),
  };
}

function createRemoteGateway(
  options: InternalSyncServiceOptions,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): {
  readonly gateway: InternalSyncGateway;
  readonly provisioner: SyncGatewayProvisioner;
  readonly runGatewayControl?: InternalSyncGatewayControl;
} {
  if (options.gateway !== undefined) {
    const injected = options.gateway;
    const provisioner = options.provisioner ?? asProvisioner(injected);
    if (provisioner === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.GATEWAY_UNAVAILABLE,
        "the injected sync gateway does not provide projection provisioning.",
      );
    }
    // Wrap in the per-spreadsheet mutation coordinator when the injected
    // gateway exposes lock-free table reads. This keeps worker, polling, and
    // test controls from issuing competing mutations through one global Apps
    // Script script lock, while leaving value reads untouched. Provisioning
    // stays on the original provisioner; it runs at startup before the worker.
    const coordinated = wrapInCoordinator(injected, options);
    return { gateway: coordinated ?? injected, provisioner };
  }

  const appsScript = options.appsScript;
  if (appsScript === undefined) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.GATEWAY_UNAVAILABLE,
      "Apps Script client settings are required when no gateway is injected.",
    );
  }
  const client = new AppsScriptOperationClient(appsScript);
  const inner = new AppsScriptOperationSyncGateway({
    operationGateway: client,
    definitions,
  });
  const gateway = new CoordinatedSyncGateway({
    inner,
    ...(options.coordinatorLaneKeyForPhysicalSheet === undefined
      ? {}
      : { mutationKeyForPhysicalSheet: options.coordinatorLaneKeyForPhysicalSheet }),
    ...(options.onCoordinatorLaneEvent === undefined
      ? {}
      : { onLaneEvent: options.onCoordinatorLaneEvent }),
  });
  // The inner gateway owns projection provisioning; provisioning runs at
  // startup before the worker, so it does not need the mutation lane.
  return {
    gateway,
    provisioner: inner,
    runGatewayControl: (physicalSheetId, operation, task) =>
      gateway.runSerializedControl(physicalSheetId, operation, task),
  };
}

/**
 * Wraps an injected gateway in the mutation coordinator when it exposes the
 * lock-free table-read capability the coordinator forwards. A gateway that
 * lacks table reads is returned unwrapped so existing fast-only fixtures keep
 * working without forcing a capability they do not implement.
 */
function wrapInCoordinator(
  gateway: InternalSyncGateway,
  options: InternalSyncServiceOptions,
): CoordinatedSyncGateway<CoordinatedGatewayInner> | undefined {
  if (!isSyncSheetTableReaderGateway(gateway)) return undefined;
  // The injected gateway already implements the full SyncSheetGateway boundary;
  // isSyncSheetTableReaderGateway confirms the table-reader capability, so the
  // combined object satisfies CoordinatedGatewayInner.
  const inner = gateway as unknown as CoordinatedGatewayInner;
  return new CoordinatedSyncGateway({
    inner,
    ...(options.coordinatorLaneKeyForPhysicalSheet === undefined
      ? {}
      : { mutationKeyForPhysicalSheet: options.coordinatorLaneKeyForPhysicalSheet }),
    ...(options.onCoordinatorLaneEvent === undefined
      ? {}
      : { onLaneEvent: options.onCoordinatorLaneEvent }),
  });
}

function asProvisioner(value: object): SyncGatewayProvisioner | undefined {
  return isSyncGatewayProvisioner(value) ? value : undefined;
}

function isSyncGatewayProvisioner(value: object): value is SyncGatewayProvisioner {
  return "provisionRegistry" in value && typeof value.provisionRegistry === "function";
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throwInvalidProjection(`${label} must be a non-empty string.`);
  }
}

function throwInvalidProjection(message: string): never {
  throw new SyncServiceError(SYNC_SERVICE_ERROR_CODES.INVALID_PROJECTION_CONFIG, message);
}
