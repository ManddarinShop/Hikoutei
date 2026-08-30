/**
 * Composition seams for the internal sync engine (P8-C).
 *
 * The sync engine (application/sync) must not name concrete adapters: the
 * concrete-adapter wiring lives in `packages/hikoutei-composition/src/`, which registers the
 * engine-facing ports below at composition-root load (see
 * `packages/hikoutei-composition/src/index.ts`; the public API layer is the composition
 * carrier). Engine modules resolve the ports lazily and fail closed with a
 * stable `SyncServiceError` when the composition root has not been
 * registered (which can only mean an import graph bypassed `src/api`).
 *
 * Every port type here names CONTRACT types only (the contracts leaf
 * package,
 * the engine's own modules, and kernel types). Nothing in this module (or
 * anything importing it) may import `src/adapter` — the direction is
 * composition → engine, never the reverse.
 *
 * `registerSyncEnginePorts` takes a lazy LOADER THUNK so the composition
 * root registers nothing but an arrow function at module evaluation: the
 * heavyweight adapter module graphs (MikroORM, the Google Sheets API client)
 * start loading only on the first `requireSyncEnginePorts()` call — i.e. at
 * engine bootstrap — preserving the root-package-to-local-runtime lazy
 * loading guarantee. The resolved ports are memoized: concurrent invokers
 * share one promise, and the thunk never runs more than once per registration.
 */

import { SyncServiceError, SYNC_SERVICE_ERROR_CODES } from "./errors.js";
import type {
  InternalSyncProvider,
  InternalSyncServiceOptions,
} from "./serviceOptions.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncSheetsProvisioner,
} from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import type { GoogleSheetsApiProviderOptions } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type { MappedUserInputPollingReport } from "@hikoutei/contracts/sheets/userInputPolling.js";
import type { ScalarEntityFlushCoordinator, ScalarEntityPersistenceProvider } from "@hikoutei/contracts/storage/scalar.js";
import type { SqlStorageAdapter } from "@hikoutei/contracts/storage/sql.js";
import type { HikouteiEntity } from "../../api/entity.js";
import type {
  InternalSyncProjectionConfig,
} from "./contracts.js";
import type { RegisteredTypedSheetsMappedProjection } from "@hikoutei/storage/orm/persistence/support/contracts.js";
import type { TypedSheetsEntityWriterOptions } from "@hikoutei/storage/orm/persistence/support/contracts.js";
import type { MappedFlushSyncHook } from "@hikoutei/storage/orm/persistence/support/contracts.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "@hikoutei/contracts/sync-orm/mapping/contracts.js";
import type {
  GoogleSheetsApiAdoptionReader,
} from "./adopt/existingSheetAdoption.js";

/**
 * Storage surface owned by the internal sync service: the engine consumes
 * the adapter-neutral SQL executor plus graceful close. The concrete
 * MikroORM adapter satisfies this structurally; the composition root owns
 * the construction (and any adapter-specific casting inside `composition/`).
 */
export type SyncServiceStorage = SqlStorageAdapter & {
  /** Closes the underlying SQLite connection; `force` skips graceful waits. */
  close(force?: boolean): Promise<void>;
};

/** One registered mapped projection definition (planner resources). */
export type SyncMappedRuntimeRegistrations = readonly RegisteredTypedSheetsMappedProjection[];

/** Result of opening the mapped SQLite runtime through the composition root. */
export interface SyncMappedRuntime {
  readonly storage: SyncServiceStorage;
  readonly mappings: TypedSheetsEntityMappingRegistry;
  readonly registrations: SyncMappedRuntimeRegistrations;
  readonly flushCoordinator: ScalarEntityFlushCoordinator;
  /** Builds the scalar persistence provider over the opened runtime. */
  readonly createScalarPersistenceProvider: () => ScalarEntityPersistenceProvider;
}

/**
 * The concrete MikroORM SQLite runtime behind the internal sync service.
 *
 * Composition-specific shape: adapter-owned detail (schema-only entity
 * bindings and the MikroORM storage adapter) never appears in engine code.
 */
export interface SyncMappedRuntimeSeeds {
  /** Validated entity mappings for the declared entities. */
  readonly mappings: readonly TypedSheetsEntityMapping[];
  /**
   * Opens the SQLite runtime, migrates schemas, registers mapping routes,
   * and builds the flush planner. Fails closed by closing partially-opened
   * storage (engine bootstrap keeps its ordered startup profile unchanged).
   */
  readonly openMappedRuntime: (input: {
    readonly dbName: string;
    readonly writer: TypedSheetsEntityWriterOptions;
    readonly syncFlushHook?: MappedFlushSyncHook;
  }) => Promise<SyncMappedRuntime>;
}

/** Direct-mode remote provider construction (composition-owned wiring). */
export interface SyncDirectRemoteProvider {
  readonly provider: InternalSyncProvider & SyncSheetsProvisioner;
}

/** One fully wired sync engine port set. */
export interface SyncEngineCompositionPorts {
  /**
   * Generates the mapped entity runtime seeds (schema definitions, validated
   * mappings, binding metadata) for the declared entities and projections.
   */
  readonly planMappedRuntime: (
    entities: readonly HikouteiEntity[],
    projections: InternalSyncProjectionConfig,
  ) => SyncMappedRuntimeSeeds;
  /**
   * Builds the full-direct Google Sheets API remote provider (provisioning,
   * effects, table reads, anchors, and snapshots) from the validated
   * `googleSheetsApi` service options.
   */
  readonly createDirectRemoteProvider: (input: {
    readonly providerOptions: GoogleSheetsApiProviderOptions;
    readonly spreadsheetId: string;
    readonly definitions: readonly RegisteredSyncProjectionDefinition[];
  }) => SyncDirectRemoteProvider;
  /**
   * Runs one adaptive inbound User_Input polling pass over the opened
   * MikroORM runtime (the concrete polling engine stays adapter-owned).
   */
  readonly pollMappedUserInput: (input: {
    readonly storage: SyncServiceStorage;
    readonly provider: InternalSyncProvider;
    readonly mappings: SyncMappedPollingMappings;
    readonly writer: TypedSheetsEntityWriterOptions;
    readonly physicalSheetIds?: readonly string[];
    readonly forceFull: boolean;
    readonly safetyScanLagMs: number;
    readonly onTiming?: InternalSyncServiceOptions["onTiming"];
  }) => Promise<MappedUserInputPollingReport>;
  /**
   * Builds the raw ADC-backed HTTP transport for existing-sheet adoption
   * reads (foreign tabs carry no registered route metadata).
   */
  readonly createAdoptionReaderTransport: (
    providerOptions: GoogleSheetsApiProviderOptions | undefined,
  ) => GoogleSheetsApiAdoptionReader;
  /**
   * Provider-owned batchUpdate reply verification, reused verbatim by the
   * adoption seeding so the adopted system-column batch is validated exactly
   * like the provider's durable worker path.
   */
  readonly verifyBatchUpdateReply: (reply: unknown, requestCount: number) => void;
}

/** Validated mapping surface the polling port accepts. */
export type SyncMappedPollingMappings =
  | TypedSheetsEntityMappingRegistry
  | readonly TypedSheetsEntityMapping[];

let portsLoader: (() => Promise<SyncEngineCompositionPorts>) | undefined;
let portsPromise: Promise<SyncEngineCompositionPorts> | undefined;

/**
 * Registers the concrete composition ports LOADER (called by
 * `packages/hikoutei-composition/src/index.ts`). Lazy by design: only the thunk is stored at
 * registration time, so importing the composition root (and, transitively,
 * the public API layer) never starts loading the MikroORM / Google SDK
 * module graphs. A re-registration replaces any prior loader and memoized
 * promise (test isolation / re-wiring support).
 */
export function registerSyncEnginePorts(
  load: () => Promise<SyncEngineCompositionPorts>,
): void {
  portsLoader = load;
  portsPromise = undefined;
}

/**
 * Load-state of the composition ports seam (test/inspection surface).
 * `"registered"` means a loader thunk exists but has NOT been invoked;
 * `"loaded"` means the memoized ports are being/are resolved.
 */
export function syncEnginePortsLoadState():
  | "unregistered"
  | "registered"
  | "loaded" {
  if (portsLoader === undefined) return "unregistered";
  return portsPromise === undefined ? "registered" : "loaded";
}

/**
 * Resolves the registered composition ports; fail-closed with the stable
 * `SyncServiceError` when the composition root was never registered.
 * Memoized: the loader runs at most once per registration; concurrent
 * callers share the same promise (and therefore the same ports instance).
 */
export function requireSyncEnginePorts(): Promise<SyncEngineCompositionPorts> {
  if (portsPromise === undefined) {
    if (portsLoader === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
        "hikoutei internal sync engine is not wired: the composition root (src/composition) must be loaded through the public API entrypoints before a sync service can open.",
      );
    }
    const load = portsLoader;
    portsPromise = load();
  }
  return portsPromise;
}

/**
 * Composition-owned factory for the plain local-only SQLite runtime.
 *
 * P8-D2 phase 2: the concrete local-runtime wiring (MikroORM scalar runtime)
 * lives in `@hikoutei/composition/localRuntime.js`. The sync auto-start
 * bridge's env-absent branch opens that runtime through this port instead of
 * importing the composition package, keeping the engine->composition
 * direction forbidden. The resolved closure keeps the composition module
 * graph LAZY: it is loaded only when a runtime actually opens.
 */
export type SyncEngineLocalRuntimeFactory = (
  options: import("../../api/hikouteiCore.js").CreateTypedSheetsOptions,
) => Promise<import("../../api/hikouteiCore.js").Hikoutei>;

let localRuntimeLoader: (() => Promise<SyncEngineLocalRuntimeFactory>) | undefined;
let localRuntimePromise: Promise<SyncEngineLocalRuntimeFactory> | undefined;

/**
 * Registers the local-runtime factory LOADER (called by
 * `composition/index.ts`). Separate from `registerSyncEnginePorts`: the
 * heavy syncEngine thunk must never load for the local-only branch, so the
 * local runtime resolves through its own LIGHT thunk (dynamic import of
 * `localRuntime.js` only).
 */
export function registerSyncEngineLocalRuntime(
  load: () => Promise<SyncEngineLocalRuntimeFactory>,
): void {
  localRuntimeLoader = load;
  localRuntimePromise = undefined;
}

/** Load-state of the local-runtime seam (test/inspection surface). */
export function syncEngineLocalRuntimeLoadState():
  | "unregistered"
  | "registered"
  | "loaded" {
  if (localRuntimeLoader === undefined) return "unregistered";
  return localRuntimePromise === undefined ? "registered" : "loaded";
}

/**
 * Resolves the registered local-runtime factory; fail-closed with the stable
 * `SyncServiceError` when the composition root was never registered.
 * Memoized: the loader runs at most once per registration.
 */
export function requireSyncEngineLocalRuntime(): Promise<SyncEngineLocalRuntimeFactory> {
  if (localRuntimePromise === undefined) {
    if (localRuntimeLoader === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
        "hikoutei internal sync engine is not wired: the composition root (src/composition) must be loaded through the public API entrypoints before a sync service can open.",
      );
    }
    const load = localRuntimeLoader;
    localRuntimePromise = load();
  }
  return localRuntimePromise;
}

