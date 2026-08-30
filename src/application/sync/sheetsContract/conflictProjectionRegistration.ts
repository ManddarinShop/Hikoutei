/** Registers and provisions the mandatory entity-specific Sync_Conflicts routes. */

import {
  claimWriterLeaseWithSql,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
} from "@hikoutei/ikisaki";
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
} from "../../orm/persistence/support/contracts.js";
import {
  resolveTypedSheetsEntityWriterOptions,
} from "../../orm/persistence/flush/flushCoordinator.js";
import type { InternalSyncProjectionConfig } from "../service/contracts.js";
import {
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import {
  SYNC_CONFLICT_PROJECTION_HEADERS,
} from "./conflictProjection.js";
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

  return storage.transaction(async ({ sql }) => {
    // Mapped-role claim; mirror this site in expireRuntimeWriterLeases (SyncServiceBootstrap).
    const claim = await claimWriterLeaseWithSql(sql, {
      role: writer.role,
      writerId: writer.writerId,
      leaseDurationMs: writer.leaseDurationMs,
      now: writer.now(),
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
