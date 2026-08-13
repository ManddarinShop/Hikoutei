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
import { createEffectSupervisor } from "./effectSupervisor.js";
import { createPollingSupervisor } from "./pollingSupervisor.js";
import { createStopHandler, expireRuntimeWriterLeases } from "./shutdown.js";
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
