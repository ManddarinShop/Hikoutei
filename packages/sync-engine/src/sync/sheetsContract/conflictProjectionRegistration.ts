/** Registers and provisions the mandatory entity-specific Sync_Conflicts routes. */

import {
  awaitTakeoverableWriterLeaseWithAdapter,
  claimWriterLeaseWithSql,
  WRITER_LEASE_CLAIM_FAILURE_REASONS,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS,
  writerLeaseHeartbeatStaleBoundMs,
  type FencingContext,
} from "@hikoutei/ikisaki";
import { logWriterLeaseStartupWait } from "../../shared/observability/internalLog.js";
import {
  registerSyncSheetWithSql,
  type RegisteredSyncSheet,
} from "@hikoutei/storage/storage/sync/shared/syncRegistry.js";
import type { SqlStorageAdapter } from "@hikoutei/contracts/storage/sql.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../orm/errors.js";
import {
  serializeTypedSheetsEntityOwnershipManifest,
} from "../../orm/mapping/projection.js";
import type {
  RegisteredTypedSheetsMappedProjection,
  TypedSheetsEntityWriterOptions,
} from "@hikoutei/storage/orm/persistence/support/contracts.js";
import {
  resolveTypedSheetsEntityWriterOptions,
} from "@hikoutei/storage/orm/persistence/flush/flushCoordinator.js";
import type { InternalSyncProjectionConfig } from "../service/contracts.js";
import {
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import {
  SYNC_CONFLICT_PROJECTION_HEADERS,
} from "@hikoutei/storage/sync/sheetsContract/conflictProjection.js";
import type {
  RegisteredSyncProjectionDefinition,
} from "@hikoutei/contracts/sheets/sheetsProvisioning.js";

/** Registers all conflict routes under one writer fence for a mapped runtime. */
export async function registerSyncConflictProjectionRoutes(
  storage: SqlStorageAdapter,
  registrations: readonly RegisteredTypedSheetsMappedProjection[],
  projections: InternalSyncProjectionConfig,
  writerInput: TypedSheetsEntityWriterOptions,
): Promise<readonly RegisteredSyncProjectionDefinition[]> {
  const writer = resolveTypedSheetsEntityWriterOptions(writerInput);
  const uniqueMappings = new Map<string, RegisteredTypedSheetsMappedProjection>();
  for (const registration of registrations) {
    uniqueMappings.set(registration.mapping.logicalSheetId, registration);
  }

  // Startup wait gate: a crash→relaunch within the stale-heartbeat window
  // cannot be told apart from a live writer by a single read, so wait
  // (read-only) until the observed heartbeat goes stale before attempting
  // the claim. The real claim stays a compare-and-set inside the transaction
  // below; this gate is purely advisory. The gate must run on the wall clock
  // (Date.now default): heartbeat staleness is a real-time property, and a
  // test-injected fixed `writer.now` would make the wait never progress.
  const gate = await awaitTakeoverableWriterLeaseWithAdapter(storage, {
    role: writer.role,
    writerId: writer.writerId,
    // Warn AT WAIT ENTRY (before sleeping), routed through the bootstrap's
    // latched callback when injected so one startup emits one warn across
    // every gate site; the direct helper is the standalone-caller fallback.
    onWaitEntry: writer.onStartupLeaseWait ?? logWriterLeaseStartupWait,
  });
  if (gate.kind === WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS.FAILED) {
    // Byte-identical fail-closed contract: every gate failure is a lease the
    // pre-gate claim CAS below would have rejected, so the error keeps the
    // existing `active_writer` reason instead of leaking gate-specific ones.
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
      `conflict projection registration lease is unavailable: ${WRITER_LEASE_CLAIM_FAILURE_REASONS.ACTIVE_WRITER}.`,
    );
  }

  return storage.transaction(async ({ sql }) => {
    // Mapped-role claim; mirror this site in expireRuntimeWriterLeases (SyncServiceBootstrap).
    // Stale-heartbeat takeover evidence keeps a crash-restart from blocking
    // startup registration for the full lease window.
    const claim = await claimWriterLeaseWithSql(sql, {
      role: writer.role,
      writerId: writer.writerId,
      leaseDurationMs: writer.leaseDurationMs,
      now: writer.now(),
      heartbeatStaleBeforeMs: writerLeaseHeartbeatStaleBoundMs(writer.now()),
    });
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
        `conflict projection registration lease is unavailable: ${claim.reason}.`,
      );
    }
    const fence: FencingContext = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: writer.now(),
    };
    const definitions: RegisteredSyncProjectionDefinition[] = [];
    for (const registration of uniqueMappings.values()) {
      const config = projections.entities[registration.mapping.entityName];
      if (config === undefined) {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
          `sync configuration is missing entity ${registration.mapping.entityName}.`,
        );
      }
      const input = {
        logicalSheetId: registration.mapping.logicalSheetId,
        physicalSheetId: `${registration.mapping.logicalSheetId}:sync_conflicts`,
        spreadsheetId: projections.spreadsheetId,
        tabName: config.syncConflicts.tabName,
        registeredRange: config.syncConflicts.registeredRange,
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: registration.mapping.schemaVersion,
        ownershipManifestJson: serializeTypedSheetsEntityOwnershipManifest(registration.mapping),
        businessKeyField: registration.mapping.businessKey.fieldName,
      } as const;
      const result = await registerSyncSheetWithSql(sql, fence, input);
      if (result.kind !== "registered") {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
          `writer lease was lost while registering ${input.physicalSheetId}.`,
        );
      }
      definitions.push({
        sheet: result.sheet,
        headers: SYNC_CONFLICT_PROJECTION_HEADERS,
        identityField: "Conflict_ID",
      });
    }
    return definitions;
  });
}

/** Returns the registered conflict route for one logical entity sheet. */
export function conflictProjectionSheet(
  definitions: readonly RegisteredSyncProjectionDefinition[],
  logicalSheetId: string,
): RegisteredSyncSheet {
  const definition = definitions.find(
    (candidate) => candidate.sheet.logicalSheetId === logicalSheetId &&
      candidate.sheet.projection === SYNC_PROJECTIONS.SYNC_CONFLICTS,
  );
  if (definition === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `no Sync_Conflicts projection is registered for ${logicalSheetId}.`,
    );
  }
  return definition.sheet;
}
