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
import type { ExistingSheetAdoptionSpec } from "./adopt/existingSheetAdoption.js";
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
  /**
   * Existing-sheet adoption (MVP, direct mode only). In `dry-run` mode the
   * service reads the foreign tab, analyzes header-name bindings, and throws
   * `ExistingSheetAdoptionDryRunReportError` carrying the full report before
   * any provisioning mutation or supervisor start. In `adopt` mode the
   * seeding engine (`adopt/adoptionSeeding.ts`) binds every existing row before the
   * CleanupScanner can ever observe the tab (fail-closed ordering, D5).
   */
  readonly adopt?: ExistingSheetAdoptionSpec;
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
  readonly effectSupervisor: EffectWorkerSupervisor;
  readonly pollingSupervisor: SyncPollingSupervisor<MappedUserInputPollingReport>;
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
  if (options.adopt !== undefined) {
    validateExistingSheetAdoptionOptions(options);
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

/**
 * Existing-sheet adoption constraints (D1/D7 of
 * `design/existing-sheet-adoption-design.md`): direct Google Sheets API mode
 * only (the foreign-tab reader needs the raw transport), and each adopted
 * entity's adopt tab must equal that entity's configured User_Input
 * route so the existing tab becomes the human input surface. Multiple
 * entities may be adopted by one service; every entry is validated
 * independently.
 */
function validateExistingSheetAdoptionOptions(options: InternalSyncServiceOptions): void {
  const adopt = options.adopt!;
  if (options.googleSheetsApi === undefined || options.provider !== undefined) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "existing-sheet adoption requires the direct googleSheetsApi provider (no injected provider).",
    );
  }
  // D7 (Phase A): the single-entity MVP gate is gone — any number of
  // entities may be adopted by one service. Each entry is still validated
  // independently below.
  const adoptEntityNames = Object.keys(adopt.entities);
  // D7 (F4): an empty adopt.entities record would produce an `ok: true` empty
  // dry-run report while adopt fails generically later — reject it up front.
  if (adoptEntityNames.length === 0) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "existing-sheet adoption requires at least one adopted entity.",
    );
  }
  for (const entityName of adoptEntityNames) {
    const entityConfig = options.projections.entities[entityName];
    if (entityConfig === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `existing-sheet adoption references entity "${entityName}" that is absent from the projections config.`,
      );
    }
    if (entityConfig.userInput === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `existing-sheet adoption requires entity "${entityName}" to declare a userInput route (the adopted tab becomes the User_Input surface).`,
      );
    }
    if (adopt.entities[entityName]!.tabName !== entityConfig.userInput.tabName) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `existing-sheet adoption tabName "${adopt.entities[entityName]!.tabName}" must equal the userInput route tab "${entityConfig.userInput.tabName}" for entity "${entityName}".`,
      );
    }
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
  // Preserve the existing provider-headroom bound for the ordinary deferred
  // three-request worker shape. The complete fast-append/legacy path, which
  // may add receipt initialization and uses the actual bounded admission wait,
  // is checked explicitly below. Defaults with the 2,000 ms interval:
  // 60 + 2 + 2x10 + 30 = 112 s, inside the 120 s default effect lease.
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
  const intervalMs = options.googleSheetsApi.rateLimitIntervalMs
    ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_START_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service googleSheetsApi rateLimitIntervalMs must be a non-negative safe integer.",
    );
  }
  if (
    effectLeaseDurationMs <= requestTimeoutMs +
      intervalMs +
      2 * Math.max(readTimeoutMs, intervalMs) +
      EFFECT_LEASE_PROVIDER_HEADROOM_MS
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service effectLeaseDurationMs must exceed Google Sheets API requestTimeoutMs plus the request-start interval and two paced request slots (the larger of readTimeoutMs and the request-start interval) by 30 seconds before supervisors start.",
    );
  }
  // The provider's first fast-append/legacy apply can add one receipt-init
  // read after its two preflight reads. Count that complete leased path
  // explicitly: three timed reads, one timed write, and one bounded admission
  // wait for each request start. The receipt-init read is a single write-lane
  // ranged `spreadsheets.get` of the receipt tab (refreshReceiptForWrite), so
  // the stale branch — a concurrent write creating the tab between preflight
  // and write — is covered by the same count instead of adding a separate
  // enumeration read that could push the branch past the default lease. The
  // read-ahead preflight is read-only and happens before the in-lane renewal;
  // the service worker also forces deferred postconditions, so inline
  // verify/follow-up writes are not part of this worker lease window.
  const requestStartMaxWaitMs = options.googleSheetsApi.requestStartMaxWaitMs
    ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_START_MAX_ADMISSION_WAIT_MS;
  if (
    !Number.isSafeInteger(requestStartMaxWaitMs) ||
    requestStartMaxWaitMs < 0
  ) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service googleSheetsApi requestStartMaxWaitMs must be a non-negative safe integer.",
    );
  }
  const maxFastOrLegacyDispatchMs = requestTimeoutMs +
    3 * readTimeoutMs +
    4 * requestStartMaxWaitMs;
  if (effectLeaseDurationMs <= maxFastOrLegacyDispatchMs) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service effectLeaseDurationMs must cover the complete paced Google Sheets fast-append or legacy apply path, including receipt initialization, before the effect lease can expire.",
    );
  }
  // The writer lease is renewed in-lane immediately before the remote call,
  // at the same instant as the effect lease. A request-start limiter wait
  // (up to `requestStartMaxWaitMs`) happens INSIDE the remote call, so the
  // writer lease must outlive the effect lease by at least that wait; a
  // limiter wait that outlives writer authority would let a stale mutation
  // run after a takeover. The writer lease is fixed at the 180-second default
  // in the service, so the effect lease plus the admission wait must stay
  // inside it.
  if (effectLeaseDurationMs + requestStartMaxWaitMs >= DEFAULT_WRITER_LEASE_DURATION_MS) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      "sync service effectLeaseDurationMs plus the Google Sheets API request-start admission wait must stay inside the 180-second writer lease so a limiter wait cannot outlive writer authority.",
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
