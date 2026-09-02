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
} from "../../api/hikouteiCore.js";
import {
  resolveEntityDescriptors,
} from "../../api/internalEntityRegistry.js";
import {
  registeredTypedSheetsProjectionDefinitions,
  resolveTypedSheetsEntityWriterOptions,
} from "@hikoutei/storage/orm/persistence/flush/flushCoordinator.js";
import type { MappedFlushSyncHook } from "@hikoutei/storage/orm/persistence/support/contracts.js";
import {
  provisionRegisteredSyncSheets,
} from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import {
  registerSyncConflictProjectionRoutes,
} from "../sheetsContract/conflictProjectionRegistration.js";
import {
  retryOpenMappedConflictsWithAdapter,
  planMappedFlushConflictSyncWithSql,
} from "@hikoutei/storage/sync/inbound/autoSystemConflictResolution.js";
import { createRemoteProvider } from "./remoteProvider.js";
import { requireSyncEnginePorts } from "./compositionPorts.js";
import {
  planExistingSheetAdoptionStartup,
  resolveAdoptionReaderTransport,
  type ExistingSheetAdoptionStartupPlan,
  withAdoptionRegisteredRangeOverride,
  withAdoptedPhysicalHeaders,
} from "./adopt/existingSheetAdoption.js";
import {
  applyAdoptionSystemColumns,
  completeExistingSheetAdoption,
} from "./adopt/adoptionSeeding.js";
import { createEffectSupervisor } from "./effectSupervisor.js";
import { createPollingSupervisor } from "./pollingSupervisor.js";
import { createStopHandler, expireRuntimeWriterLeases } from "./shutdown.js";
import {
  createWriterLeaseHeartbeat,
  type WriterLeaseHeartbeatHandle,
} from "@hikoutei/ikisaki";
import {
  registerSystemStateReadiness,
  unregisterSystemStateReadiness,
} from "./systemStateReadiness.js";
import {
  describeErrorForInternalLog,
  HIKOUTEI_LOG_LEVELS,
  logHikouteiInternalEvent,
} from "../../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../../shared/observability/logEvents.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "./errors.js";
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
  // P8-C: the concrete-adapter wiring (MikroORM SQLite runtime, the direct
  // Google Sheets API provider, the polling engine, the adoption transport)
  // resolves through the composition root; the engine only ever receives
  // port-typed closures. Fail closed when the composition root was never
  // loaded (only possible when the public API entrypoints are bypassed).
  const ports = await requireSyncEnginePorts();
  const descriptors = resolveEntityDescriptors(options.entities, throwSyncResolutionError);
  validateServiceOptions(options, descriptors);

  // Existing-sheet adoption planning (D5, fail-closed): reads the foreign
  // tab BEFORE any mutation. dry-run throws the full report; adopt computes
  // the managed layout and the User_Input registered-range override.
  let adoptionPlan: ExistingSheetAdoptionStartupPlan | undefined;
  if (options.adopt !== undefined) {
    adoptionPlan = await planExistingSheetAdoptionStartup({
      adopt: options.adopt,
      spreadsheetId: options.projections.spreadsheetId,
      transport: resolveAdoptionReaderTransport(options.googleSheetsApi, ports.createAdoptionReaderTransport),
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
  // The adopted User_Input route's registered range is DERIVED from the
  // foreign layout (managed span + row-id column), so the declared range is
  // replaced rather than trusted.
  const effectiveProjections = adoptionPlan === undefined
    ? options.projections
    : withAdoptionRegisteredRangeOverride(options.projections, adoptionPlan);

  const generated = ports.planMappedRuntime(options.entities, effectiveProjections);
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
  const runtime = await generated.openMappedRuntime({ dbName: options.dbName, writer, syncFlushHook });
  // Declared OUTSIDE the try so a startup failure after heartbeat creation can
  // still stop the timer before the storage closes.
  let entityWriterLeaseHeartbeat: WriterLeaseHeartbeatHandle | undefined;

  try {
    const projectionDefinitions = [
      ...registeredTypedSheetsProjectionDefinitions(runtime.registrations),
      ...await registerSyncConflictProjectionRoutes(
        runtime.storage,
        runtime.registrations,
        effectiveProjections,
        writer,
      ),
    ];
    // §12 columnMap: the ADOPTED User_Input route's physical header row
    // carries the legacy headers (positionally parallel to the canonical
    // field-name headers, guaranteed by the C4 declaration-order gate plus
    // the appended-PK-last rule). Attach the physical headers to exactly
    // that one definition — provisioning, observation, and the writer all
    // read the translation from this single source. A name-bound route
    // (no columnMap) derives identical physical headers, so attaching them
    // unconditionally for adopted routes is a no-op there.
    const definitionsForRemote = adoptionPlan === undefined
      ? projectionDefinitions
      : withAdoptedPhysicalHeaders(projectionDefinitions, adoptionPlan);
    const remote = createRemoteProvider(options, definitionsForRemote, ports);
    if (adoptionPlan !== undefined) {
      // D7 (F3): adoption resolves tab names case-insensitively, so two
      // entities adopting `Invoices` and `invoices` collapse onto ONE sheet
      // id. Applying system columns twice to the same tab (or provisioning it
      // twice) corrupts it, so reject duplicate resolved sheet ids BEFORE the
      // first mutation.
      const seenAdoptionSheetIds = new Set<number>();
      for (const adoptionEntity of adoptionPlan.entities) {
        if (seenAdoptionSheetIds.has(adoptionEntity.sheetId)) {
          throw new SyncServiceError(
            SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
            `existing-sheet adoption resolves multiple entities to the same tab (sheet id ${adoptionEntity.sheetId}); adopt tab names must be distinct.`,
          );
        }
        seenAdoptionSheetIds.add(adoptionEntity.sheetId);
      }
      // D7 (fail-closed): adoption requires an empty canonical state for EACH
      // adopted entity — a nonempty local state would silently merge with (or
      // collide against) the adopted rows. Validate EVERY adopted entity before
      // the first sheet mutation so a later entity can never leave an earlier
      // one's system columns already written (multi-entity adoption).
      for (const adoptionEntity of adoptionPlan.entities) {
        const adoptionMapping = runtime.mappings.mappings.find(
          (candidate) => candidate.entityName === adoptionEntity.entityName,
        );
        if (adoptionMapping !== undefined) {
          const existing = await runtime.storage.transaction(async ({ sql }) =>
            sql.all<{ entity_id: string }>(
              "SELECT entity_id FROM entity_state WHERE entity_id IN (SELECT entity_id FROM row_binding WHERE logical_sheet_id = ?)",
              [adoptionMapping.logicalSheetId],
            ));
          if (existing.length > 0) {
            throw new SyncServiceError(
              SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
              `existing-sheet adoption requires an empty SQLite state for entity "${adoptionEntity.entityName}"; found ${existing.length} existing row(s).`,
            );
          }
        }
        // D7 also covers the application-owned ORM entity table: seeding INSERTs
        // into it, so any pre-existing row would collide (or silently merge)
        // with the adopted rows. Fail closed BEFORE the first sheet mutation.
        const ormRowCount = await runtime.storage.transaction(async ({ sql }) =>
          sql.get<{ count: number }>(
            `SELECT COUNT(*) AS count FROM ${adoptionEntity.entityTableName}`,
            [],
          ));
        if ((ormRowCount?.count ?? 0) > 0) {
          throw new SyncServiceError(
            SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
            `existing-sheet adoption requires an empty SQLite state for entity "${adoptionEntity.entityName}": table "${adoptionEntity.entityTableName}" already holds ${ormRowCount?.count ?? 0} row(s).`,
          );
        }
      }
      // D7 (fail-closed, second pass): ONLY once every adopted entity's local
      // state is proven empty do we write system columns. This second loop has
      // no throw points before/among its writes, so no entity is ever mutated
      // when the adoption as a whole must reject.
      for (const adoptionEntity of adoptionPlan.entities) {
        await applyAdoptionSystemColumns({
          transport: resolveAdoptionReaderTransport(options.googleSheetsApi, ports.createAdoptionReaderTransport),
          verifyReply: ports.verifyBatchUpdateReply,
          spreadsheetId: options.projections.spreadsheetId,
          sheetId: adoptionEntity.sheetId,
          rowIdColumnIndex: adoptionEntity.rowIdColumnIndex,
          ...(adoptionEntity.pkAppend === undefined
            ? {}
            : { pkAppend: adoptionEntity.pkAppend }),
          rows: adoptionEntity.dataRows,
        });
      }
    }
    await provisionRegisteredSyncSheets(remote.provisioner, definitionsForRemote);
    if (adoptionPlan !== undefined) {
      // Observe the adopted tab (anchors already in place), bind every row
      // in one all-or-nothing transaction, then re-verify until stable —
      // all BEFORE any supervisor can observe the tab (D5).
      await completeExistingSheetAdoption({
        plan: adoptionPlan,
        provider: remote.provider,
        storage: runtime.storage,
        mappings: runtime.mappings.mappings,
        writer,
      });
    }

    const effectSupervisor = createEffectSupervisor({
      storage: runtime.storage,
      mappings: runtime.mappings.mappings,
      provider: remote.provider,
      writer,
      effectWorkerId,
      options,
    });
    // Entity-writer lease heartbeat (strictly renew-only): keeps the mapped
    // writer's `heartbeat_at` fresh between flushes so a NEW process after a
    // crash takes the lease over through the stale-heartbeat evidence rule
    // instead of waiting out the full mapped lease window. Stopped with the
    // runtime (createStopHandler) so graceful shutdown stops renewing first.
    const resolvedEntityWriter = resolveTypedSheetsEntityWriterOptions(writer);
    let entityHeartbeatHeld: boolean | undefined;
    entityWriterLeaseHeartbeat = createWriterLeaseHeartbeat({
      storage: runtime.storage,
      role: resolvedEntityWriter.role,
      writerId: resolvedEntityWriter.writerId,
      leaseDurationMs: resolvedEntityWriter.leaseDurationMs,
      now: resolvedEntityWriter.now,
      onEvent: (event) => {
        const held = event.result.kind === "renewed";
        if (entityHeartbeatHeld === held) return;
        entityHeartbeatHeld = held;
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.WRITER_LEASE_HEARTBEAT,
          level: held ? HIKOUTEI_LOG_LEVELS.INFO : HIKOUTEI_LOG_LEVELS.WARN,
          component: HIKOUTEI_LOG_COMPONENTS.OUTBOX,
          counts: { mappedWriter: held ? 1 : 0 },
        });
      },
    });
    const pollingSupervisor = createPollingSupervisor({
      storage: runtime.storage,
      provider: remote.provider,
      mappings: runtime.mappings,
      writer,
      options,
      pollMappedUserInput: ports.pollMappedUserInput,
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
      entityWriterLeaseHeartbeat,
    });

    const provider = runtime.createScalarPersistenceProvider();
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
      level: HIKOUTEI_LOG_LEVELS.ERROR,
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
    await entityWriterLeaseHeartbeat?.stop().catch(() => undefined);
    await expireRuntimeWriterLeases(runtime.storage, writer, effectWorkerId)
      .catch(() => undefined);
    await runtime.storage.close(true).catch(() => undefined);
    throw error;
  }
}
