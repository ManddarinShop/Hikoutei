/**
 * Internal same-process bootstrap for the SQLite-authoritative sync service.
 *
 * The root package deliberately does not export this module. It assembles the
 * mapped SQLite runtime, provisions the registered projections, starts the
 * outbound effect supervisor, and owns graceful shutdown around one SQLite
 * connection shared by ORM and sync storage.
 *
 * The full service-account Google Sheets API provider owns provisioning,
 * outbound effects, table reads, anchors, and snapshots; no Apps Script or
 * mixed-mode provider is supported anymore. In-process tests may inject a
 * provider double through the internal `provider`/`provisioner` options.
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
  SyncSheetsProvisioner,
  RegisteredSyncProjectionDefinition,
} from "../sheets/sheetsProvisioning.js";
import {
  provisionRegisteredSyncSheets,
} from "../sheets/sheetsProvisioning.js";
import {
  registerSyncConflictProjectionRoutes,
} from "../sheets/conflictProjectionRegistration.js";
import {
  autoResolveExistingMappedConflictsWithAdapter,
  retryOpenMappedConflictsWithAdapter,
} from "../inbound/autoSystemConflictResolution.js";
import type { SyncSheetsProvider, SyncSheetsTableReader } from "../sheets/syncSheets.js";
import {
  CoordinatedSheetsProvider,
} from "../sheets/mutationCoordinator/CoordinatedSheetsProvider.js";
import type { CoordinatorLaneEvent } from "../sheets/mutationCoordinator/laneTelemetry.js";
import {
  GoogleSheetsApiSyncProvider,
  type GoogleSheetsApiProviderOptions,
} from "../../../adapter/sheets/providers/google-sheets-api/index.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "../../../adapter/sheets/providers/google-sheets-api/constants.js";
import {
  createEffectWorkerSupervisor,
  APPEND_DISPATCH_THROTTLE_INTERVAL_MS,
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_LEASE_PROVIDER_HEADROOM_MS,
  FAST_APPEND_BATCH_CANDIDATE_LIMIT,
  type EffectWorkerSupervisor,
  type WorkerReport,
} from "@hikoutei/outbox";
import { SheetsEffectDispatcher } from "../outbound/SheetsEffectDispatcher.js";
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
import type {
  InternalSyncEntityConfig,
  InternalSyncProjectionConfig,
} from "./contracts.js";

const DEFAULT_POLLING_FULL_SCAN_INTERVAL_MS = 60_000;

/** Provider capability required by internal service startup (incl. table reads). */
export type InternalSyncProvider = SyncSheetsProvider & SyncSheetsTableReader;

/** Internal service options; none are part of the root application contract. */
export interface InternalSyncServiceOptions {
  readonly dbName: string;
  readonly entities: readonly HikouteiEntity[];
  readonly projections: InternalSyncProjectionConfig;
  /**
   * Injected provider used by fake/in-process tests; mutually exclusive with
   * `googleSheetsApi`. The coordinator wraps it exactly like the real
   * provider so mutations share one mutation lane.
   */
  readonly provider?: InternalSyncProvider;
  /** Optional provisioner for injected providers that do not own setup. */
  readonly provisioner?: SyncSheetsProvisioner;
  /**
   * The full service-account Google Sheets API provider owns provisioning,
   * outbound effects, table reads, anchors, and snapshots with no Apps
   * Script at all. Requires Application Default Credentials (a service
   * account shared on the spreadsheet). Never part of the root API.
   */
  readonly googleSheetsApi?: GoogleSheetsApiProviderOptions;
  readonly writerId?: string;
  readonly workerId?: string;
  readonly maxEffects?: number;
  /** Internal lease for one remote effect batch; must exceed provider timeout. */
  readonly effectLeaseDurationMs?: number;
  readonly effectIdleIntervalMs?: number;
  readonly onTiming?: SyncTimingSink;
  readonly onEffectReport?: (report: WorkerReport) => void;
  readonly onEffectError?: (error: unknown) => void;
  readonly pollingIntervalMs?: number;
  /** Maximum interval between metadata-preserving safety scans. */
  readonly pollingFullScanIntervalMs?: number;
  /** Injectable clock for the polling coordinator cadence; defaults to Date.now. */
  readonly now?: () => number;
  /** Optional per-spreadsheet mutation-lane key for the provider coordinator. */
  readonly coordinatorLaneKeyForPhysicalSheet?: (physicalSheetId: string) => string;
  /** Optional diagnostic observer for coordinator mutation-lane events. */
  readonly onCoordinatorLaneEvent?: (event: CoordinatorLaneEvent) => void;
  readonly onPollingReport?: (report: MappedUserInputPollingReport) => void;
  readonly onPollingError?: (error: unknown) => void;
}

/** Runtime returned to an internal service entrypoint, not to root consumers. */
export interface InternalSyncService {
  readonly hikoutei: Hikoutei;
  /** Internal inspection handle; never part of the root application API. */
  readonly storage: MikroOrmSqliteAdapter;
  readonly projectionDefinitions: readonly RegisteredSyncProjectionDefinition[];
  /** Retries durable OPEN system-wins commands after predecessors settle. */
  readonly retryDeferredConflicts: () => Promise<number>;
  readonly effectSupervisor: EffectWorkerSupervisor;
  readonly pollingSupervisor: SyncPollingSupervisor<MappedUserInputPollingReport>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Opens, provisions, and starts one internal sync service.
 *
 * Startup is fail-closed: a malformed route, missing provider, or remote
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
    const remote = createRemoteProvider(options, projectionDefinitions);
    await provisionRegisteredSyncSheets(remote.provisioner, projectionDefinitions);
    await autoResolveExistingMappedConflictsWithAdapter(
      runtime.storage,
      runtime.mappings.mappings,
      resolveTypedSheetsEntityWriterOptions(writer),
    );

    const effectSupervisor = createEffectWorkerSupervisor({
      storage: runtime.storage,
      dispatcher: new SheetsEffectDispatcher({
        provider: remote.provider,
        storage: runtime.storage,
      }),
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
        provider: remote.provider,
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
  if (options.googleSheetsApi !== undefined && options.provider !== undefined) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service cannot supply both an injected provider and googleSheetsApi client settings.",
    );
  }
  if (options.provisioner !== undefined && options.provider === undefined) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service provisioner requires an injected provider.",
    );
  }
  if (options.provider === undefined && options.googleSheetsApi === undefined) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.PROVIDER_UNAVAILABLE,
      "sync service requires an injected provider or googleSheetsApi client settings.",
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
  // Injected test providers carry no transport timeouts, so the lease
  // headroom check applies only to the real Google Sheets API provider.
  if (options.googleSheetsApi === undefined) return;

  // The lease-headroom check uses the ACTIVE provider's timeouts: the full
  // direct Google provider's own defaults when the options omit them.
  const requestTimeoutMs = options.googleSheetsApi.requestTimeoutMs
    ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < GOOGLE_SHEETS_API_DEFAULTS.MIN_REQUEST_TIMEOUT_MS ||
    requestTimeoutMs > GOOGLE_SHEETS_API_DEFAULTS.MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service googleSheetsApi requestTimeoutMs must be between 1 second and 120 seconds.",
    );
  }
  // A direct-mode dispatch performs up to THREE sequential paced transport
  // calls (two preflight reads plus one write), each with its own timeout;
  // the lease must cover the whole sequence, so the headroom check sums
  // the write timeout and two read timeouts. Defaults: 60 + 2x10 + 30 =
  // 110 s, inside the 120 s default effect lease.
  const readTimeoutMs = options.googleSheetsApi.readTimeoutMs
    ?? GOOGLE_SHEETS_API_DEFAULTS.READ_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(readTimeoutMs) ||
    readTimeoutMs < GOOGLE_SHEETS_API_DEFAULTS.MIN_REQUEST_TIMEOUT_MS ||
    readTimeoutMs > GOOGLE_SHEETS_API_DEFAULTS.MAX_READ_TIMEOUT_MS
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service googleSheetsApi readTimeoutMs must be between 1 second and 60 seconds.",
    );
  }
  if (
    effectLeaseDurationMs <= requestTimeoutMs + 2 * readTimeoutMs +
      EFFECT_LEASE_PROVIDER_HEADROOM_MS
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service effectLeaseDurationMs must exceed Google Sheets API requestTimeoutMs plus two read timeouts by 30 seconds before supervisors start.",
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
  readonly requestTimeoutMs?: number;
  readonly idleIntervalMs?: number;
  readonly maxFastAppendCandidates?: number;
  readonly appendDispatchIntervalMs?: number;
  readonly onTiming?: SyncTimingSink;
  readonly onReport?: (report: WorkerReport) => void;
  readonly onError?: (error: unknown) => void;
} {
  // The knobs are tied to the ACTIVE provider: the full direct Google
  // provider's timeouts (its defaults when omitted). The worker provider
  // timeout bounds the WHOLE sequential dispatch (two preflight reads plus
  // one write), so it sums the write timeout and two read timeouts instead
  // of the single write timeout. Injected test providers carry no transport
  // timeouts and keep the bounded 20-item window with no bulk throttle.
  const outboundTimeoutMs = options.googleSheetsApi === undefined
    ? undefined
    : (options.googleSheetsApi.requestTimeoutMs ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_TIMEOUT_MS) +
      2 * (options.googleSheetsApi.readTimeoutMs ?? GOOGLE_SHEETS_API_DEFAULTS.READ_TIMEOUT_MS);
  return {
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.maxEffects === undefined ? {} : { maxEffects: options.maxEffects }),
    ...(options.effectLeaseDurationMs === undefined ? {} : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
    ...(outboundTimeoutMs === undefined ? {} : { requestTimeoutMs: outboundTimeoutMs }),
    ...(options.effectIdleIntervalMs === undefined ? {} : { idleIntervalMs: options.effectIdleIntervalMs }),
    // The bulk append claim window and the append dispatch throttle belong to
    // the real Google Sheets API provider.
    ...(options.googleSheetsApi === undefined
      ? {}
      : {
        maxFastAppendCandidates: FAST_APPEND_BATCH_CANDIDATE_LIMIT,
        appendDispatchIntervalMs: APPEND_DISPATCH_THROTTLE_INTERVAL_MS,
      }),
    ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
    ...(options.onEffectReport === undefined ? {} : { onReport: options.onEffectReport }),
    ...(options.onEffectError === undefined ? {} : { onError: options.onEffectError }),
  };
}

function createRemoteProvider(
  options: InternalSyncServiceOptions,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): {
  readonly provider: InternalSyncProvider;
  readonly provisioner: SyncSheetsProvisioner;
} {
  if (options.provider !== undefined) {
    // Injected fake/in-process provider: the coordinator wraps it exactly
    // like the real provider so writes and anchor observation share one
    // mutation lane; provisioning runs on the injected provisioner (or the
    // provider itself when it implements the provisioner boundary).
    const injected = options.provider;
    const provisioner = options.provisioner ??
      (isSyncSheetsProvisioner(injected) ? injected : undefined);
    if (provisioner === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.PROVIDER_UNAVAILABLE,
        "the injected sync provider does not provide projection provisioning.",
      );
    }
    const coordinated = new CoordinatedSheetsProvider({
      inner: injected,
      ...(options.coordinatorLaneKeyForPhysicalSheet === undefined
        ? {}
        : { mutationKeyForPhysicalSheet: options.coordinatorLaneKeyForPhysicalSheet }),
      ...(options.onCoordinatorLaneEvent === undefined
        ? {}
        : { onLaneEvent: options.onCoordinatorLaneEvent }),
    });
    return { provider: coordinated, provisioner };
  }
  // Preferred full-direct mode: ONE provider owns outbound effects,
  // provisioning, table reads, anchors, and snapshots. No Apps Script
  // object is constructed and no router is needed. The coordinator wraps
  // the provider so writes and anchor observation share one mutation lane;
  // provisioning runs at startup on the provider itself.
  const provider = new GoogleSheetsApiSyncProvider({
    ...options.googleSheetsApi,
    spreadsheetId: options.projections.spreadsheetId,
    definitions,
  });
  const coordinated = new CoordinatedSheetsProvider({
    inner: provider,
    ...(options.coordinatorLaneKeyForPhysicalSheet === undefined
      ? {}
      : { mutationKeyForPhysicalSheet: options.coordinatorLaneKeyForPhysicalSheet }),
    ...(options.onCoordinatorLaneEvent === undefined
      ? {}
      : { onLaneEvent: options.onCoordinatorLaneEvent }),
  });
  return {
    provider: coordinated,
    provisioner: provider,
  };
}

/** Returns whether a provider also implements the provisioner boundary. */
function isSyncSheetsProvisioner(
  provider: InternalSyncProvider,
): provider is InternalSyncProvider & SyncSheetsProvisioner {
  return "provisionRegistry" in provider &&
    typeof (provider as InternalSyncProvider & Record<"provisionRegistry", unknown>).provisionRegistry === "function";
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throwInvalidProjection(`${label} must be a non-empty string.`);
  }
}

function throwInvalidProjection(message: string): never {
  throw new SyncServiceError(SYNC_SERVICE_ERROR_CODES.INVALID_PROJECTION_CONFIG, message);
}
