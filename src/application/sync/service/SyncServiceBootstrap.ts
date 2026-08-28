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
 *
 * This module is the thin ordered composition root: cohesive responsibilities
 * (option/lease/projection validation, remote provider assembly, effect and
 * polling supervisor construction, shutdown and lease release) live in the
 * sibling modules in this directory, and startup failure cleanup stays here.
 */

import {
  createInternalHikoutei,
  type Hikoutei,
} from "../../../api/Hikoutei.js";
import {
  resolveEntityDescriptors,
} from "../../../api/internalEntityRegistry.js";
import {
  initializeMappedRuntime,
} from "../../../adapter/persistence/providers/mikro-orm/engine/MikroOrmMappedRuntime.js";
import {
  createMikroOrmScalarRuntime,
} from "../../../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarRuntime.js";
import {
  MikroOrmScalarPersistenceProvider,
} from "../../../adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js";
import {
  registeredTypedSheetsProjectionDefinitions,
  resolveTypedSheetsEntityWriterOptions,
} from "../../orm/persistence/flush/flushCoordinator.js";
import type { MappedFlushSyncHook } from "../../orm/persistence/support/contracts.js";
import {
  provisionRegisteredSyncSheets,
} from "../sheetsContract/sheetsProvisioning.js";
import {
  registerSyncConflictProjectionRoutes,
} from "../sheetsContract/conflictProjectionRegistration.js";
import {
  retryOpenMappedConflictsWithAdapter,
  planMappedFlushConflictSyncWithSql,
} from "../inbound/autoSystemConflictResolution.js";
import { createRemoteProvider } from "./remoteProvider.js";
import {
  resolveAdoptionReaderTransport,
  runExistingSheetAdoptionStartup,
} from "./adopt/existingSheetAdoption.js";
import { createEffectSupervisor } from "./effectSupervisor.js";
import { createPollingSupervisor } from "./pollingSupervisor.js";
import { createStopHandler, expireRuntimeWriterLeases } from "./shutdown.js";
import {
  registerSystemStateReadiness,
  unregisterSystemStateReadiness,
} from "./systemStateReadiness.js";
import {
  describeErrorForInternalLog,
  logHikouteiInternalEvent,
} from "../../../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../../../shared/observability/logEvents.js";
import {
  createWriterOptions,
  throwSyncResolutionError,
  validateServiceOptions,
  type InternalSyncService,
  type InternalSyncServiceOptions,
} from "./serviceOptions.js";

export type {
  InternalSyncProvider,
  InternalSyncService,
  InternalSyncServiceOptions,
} from "./serviceOptions.js";

/**
 * Opens, provisions, and starts one internal sync service.
 *
 * Startup is fail-closed: a malformed route, missing provider, or remote
 * provisioning failure closes the SQLite runtime before the error escapes.
 */
export async function createInternalSyncService(
  options: InternalSyncServiceOptions,
): Promise<InternalSyncService> {
  const descriptors = resolveEntityDescriptors(options.entities, throwSyncResolutionError);
  validateServiceOptions(options, descriptors);
  const generated = createMikroOrmScalarRuntime(options.entities, options.projections);
  const writer = createWriterOptions(options);
  // The effect worker claims its own lease role with the same runtime identity
  // as the mapped writer unless the caller pinned an explicit worker id; one
  // resolved identity is reused by the supervisor and by the graceful-shutdown
  // lease release so both roles expire together on stop().
  const effectWorkerId = options.workerId ?? writer.writerId;
  // Implicit system-wins planning runs inside the mapped flush transaction:
  // the same commit that advances a conflicted field's canonical revision
  // rebases the conflict and plans its resolution atomically.
  const syncFlushHook: MappedFlushSyncHook = (input) =>
    planMappedFlushConflictSyncWithSql(
      input.sql,
      input.fence,
      input.writer,
      input.plan.mapping,
      {
        entityId: input.plan.entityId,
        rowBindingId: input.plan.rowBindingId,
        commitId: input.plan.commitId,
        changedFieldNames: input.plan.changedFields.map((field) => field.fieldName),
        suppressedUserProjection: input.plan.suppressedUserProjection,
      },
    );
  const runtime = await initializeMappedRuntime({
    dbName: options.dbName,
    entities: generated.entities,
    mappings: generated.mappings,
    writer,
    syncFlushHook,
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
    if (options.adopt !== undefined) {
      // Existing-sheet adoption gate (D5, fail-closed): runs BEFORE any
      // provisioning mutation. dry-run reads the foreign tab, analyzes the
      // header-name bindings, and throws the full report — the service never
      // reaches its running state. adopt-mode seeding replaces this gate in
      // the next milestone.
      await runExistingSheetAdoptionStartup({
        adopt: options.adopt,
        spreadsheetId: options.projections.spreadsheetId,
        transport: resolveAdoptionReaderTransport(options.googleSheetsApi),
        descriptors: [...descriptors.values()],
        projections: options.projections,
        userOwnedFieldsByEntity: Object.fromEntries(
          Object.entries(options.projections.entities).map(([name, config]) => [
            name,
            config.userOwnedFields ?? [],
          ]),
        ),
        ...(options.googleSheetsApi?.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.googleSheetsApi.requestTimeoutMs }),
      });
    }
    await provisionRegisteredSyncSheets(remote.provisioner, projectionDefinitions);

    const effectSupervisor = createEffectSupervisor({
      storage: runtime.storage,
      mappings: runtime.mappings.mappings,
      provider: remote.provider,
      writer,
      effectWorkerId,
      options,
    });
    const pollingSupervisor = createPollingSupervisor({
      storage: runtime.storage,
      provider: remote.provider,
      mappings: runtime.mappings,
      writer,
      options,
    });
    const retryDeferredConflicts = (): Promise<number> => retryOpenMappedConflictsWithAdapter(
      runtime.storage,
      runtime.mappings.mappings,
      resolveTypedSheetsEntityWriterOptions(writer),
    );
    const stop = createStopHandler({
      storage: runtime.storage,
      writer,
      effectWorkerId,
      pollingSupervisor,
      effectSupervisor,
    });

    const provider = new MikroOrmScalarPersistenceProvider(
      runtime.storage,
      generated.bindings,
      runtime.flushCoordinator,
    );
    // The runtime object is the readiness key: the beforeClose hook runs
    // only after this assignment, so the captured reference is always the
    // fully constructed runtime. Unregistering happens BEFORE the stop
    // handler runs, so a closing runtime reports ready (no outbox to drain)
    // the moment its close begins.
    let hikoutei: Hikoutei;
    const hikouteiClose = async (): Promise<void> => {
      unregisterSystemStateReadiness(hikoutei);
      await stop();
    };
    hikoutei = createInternalHikoutei(provider, descriptors, hikouteiClose);
    // Phase 4: register the runtime's System_State readiness right after
    // bootstrap so external convergence barriers can wait on the drain;
    // unregistered on close (see hikouteiClose). Never part of the public
    // API — the registration is keyed to the internal/public runtime object
    // and read only through this internal module.
    registerSystemStateReadiness(hikoutei, runtime.storage);
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
    logHikouteiInternalEvent({
      event: HIKOUTEI_LOG_EVENTS.SYNC_SERVICE_START_FAILED,
      level: "error",
      component: HIKOUTEI_LOG_COMPONENTS.SYNC_SERVICE,
      ...describeErrorForInternalLog(error),
    });
    // Conflict-route registration claims this runtime's mapped-role writer
    // lease before remote provisioning runs; a provisioning failure would
    // otherwise leave the claim valid for the full lease window and every
    // immediate retry would fail at the same claim with
    // WRITER_LEASE_UNAVAILABLE. Expire the claimed leases (CAS-guarded,
    // warn-and-continue) so the retry takes over at once; the extra guard
    // ensures this can never mask the original startup error.
    await expireRuntimeWriterLeases(runtime.storage, writer, effectWorkerId)
      .catch(() => undefined);
    await runtime.storage.close(true).catch(() => undefined);
    throw error;
  }
}
