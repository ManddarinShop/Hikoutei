/**
 * Internal sync service option contracts and validation.
 *
 * Holds the internal option/result types (`InternalSyncProvider`,
 * `InternalSyncServiceOptions`, `InternalSyncService`) plus every validation
 * rule the bootstrap enforces before it opens a SQLite runtime: service
 * options, effect-lease headroom against the ACTIVE provider's transport
 * timeouts, projection routes, and entity/property ownership. Also owns the
 * writer-identity derivation used by the runtime, supervisors, and shutdown.
 *
 * None of these types are part of the root application contract; the service
 * bootstrap re-exports them for internal entrypoints and tests.
 */

import { randomUUID } from "node:crypto";

import type { HikouteiEntity, ResolvedHikouteiEntityDescriptor } from "../../../api/entity.js";
import type { Hikoutei } from "../../../api/Hikoutei.js";
import type { EntityDescriptorResolutionFailure } from "../../../api/internalEntityRegistry.js";
import type { TypedSheetsEntityWriterOptions } from "../../orm/persistence/support/contracts.js";
import type {
  InternalSyncEntityConfig,
  InternalSyncProjectionConfig,
} from "./contracts.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncSheetsProvisioner,
} from "../sheetsContract/sheetsProvisioning.js";
import type { SyncSheetsProvider, SyncSheetsTableReader } from "../sheetsContract/syncSheets.js";
import type { CoordinatorLaneEvent } from "../sheetsContract/mutationCoordinator/laneTelemetry.js";
import type { GoogleSheetsApiProviderOptions } from "../../../adapter/sheets/providers/google-sheets-api/index.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "../../../adapter/sheets/providers/google-sheets-api/constants.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_LEASE_PROVIDER_HEADROOM_MS,
  type EffectWorkerSupervisor,
  type WorkerReport,
} from "@hikoutei/ikisaki";
import type { MikroOrmSqliteAdapter } from "../../../adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type { MappedUserInputPollingReport } from "../../../adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import type { SyncTimingSink } from "../telemetry/syncTiming.js";
import type { SyncPollingSupervisor } from "./SyncPollingSupervisor.js";
import type { SyncTaskSupervisor } from "./SyncTaskSupervisor.js";
import type { ReconciliationWorkerReport } from "./reconciliationSupervisor.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "./errors.js";

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
  /** Minimum delay between System_State reconciliation scans (default 60s). */
  readonly reconciliationIntervalMs?: number;
  /** Observability sink for one completed System_State reconciliation scan. */
  readonly onReconciliationReport?: (report: { readonly effectsEnqueued: number }) => void;
  /** Error sink for System_State reconciliation scan failures. */
  readonly onReconciliationError?: (error: unknown) => void;
}

/** Runtime returned to an internal service entrypoint, not to root consumers. */
export interface InternalSyncService {
  readonly hikoutei: Hikoutei;
  /** Internal inspection handle; never part of the root application API. */
  readonly storage: MikroOrmSqliteAdapter;
  readonly projectionDefinitions: readonly RegisteredSyncProjectionDefinition[];
  /** Retries durable OPEN system-wins commands after predecessors settle. */
  readonly retryDeferredConflicts: () => Promise<number>;
  /** Outbound-only durable effect delivery worker. */
  readonly effectSupervisor: EffectWorkerSupervisor;
  /** Inbound User_Input observation worker. */
  readonly pollingSupervisor: SyncPollingSupervisor<MappedUserInputPollingReport>;
  /** System_State repair and User_Input cleanup worker. */
  readonly reconciliationSupervisor: SyncTaskSupervisor<ReconciliationWorkerReport>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Maps a structured descriptor-registry failure to the internal
 * `SyncServiceError` contract with unchanged `INVALID_OPTIONS` messages.
 */
export function throwSyncResolutionError(
  failure: EntityDescriptorResolutionFailure,
): never {
  switch (failure.kind) {
    case "invalid-token":
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        "sync service entities must be tokens produced by defineTypedSheetsEntity().",
      );
    case "duplicate-name":
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `sync service entity "${failure.entityName}" is registered more than once.`,
      );
    case "duplicate-table":
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `sync service table "${failure.tableName}" is shared by "${failure.firstEntityName}" and "${failure.secondEntityName}".`,
      );
  }
}

export function validateServiceOptions(
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
  if (
    options.reconciliationIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.reconciliationIntervalMs) || options.reconciliationIntervalMs < 1)
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service reconciliationIntervalMs must be a positive safe integer.",
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

export function createWriterOptions(options: InternalSyncServiceOptions): TypedSheetsEntityWriterOptions {
  return {
    writerId: options.writerId ?? `hikoutei-sync:${randomUUID()}`,
    ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
  };
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throwInvalidProjection(`${label} must be a non-empty string.`);
  }
}

function throwInvalidProjection(message: string): never {
  throw new SyncServiceError(SYNC_SERVICE_ERROR_CODES.INVALID_PROJECTION_CONFIG, message);
}
