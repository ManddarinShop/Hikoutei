/**
 * Semantic persistence boundary used by the mapped entity flush planner.
 *
 * The context keeps SQL execution, row-shape conversion, and storage-specific
 * state tags inside infrastructure. Application code receives lifecycle-level
 * operations that can later be implemented by another ORM provider.
 */

import type { EffectStatus } from "../../../../domain/index.js";
import type {
  SqlExecutor,
  SqlStorageAdapter,
} from "../../../../adapter/persistence/contracts/sql.js";
import {
  commitCanonicalChangesWithSql,
  type CanonicalCommitInput,
  type CanonicalCommitResult,
} from "../canonical/canonicalCommit.js";
import {
  appendPendingEffectsWithSql,
  claimWriterLeaseWithSql,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type ClaimLeaseOptions,
  type FencingContext,
  type NewEffect,
  type WriterLeaseClaimResult,
} from "@hikoutei/ikisaki";
import {
  registerSyncSheetWithSql,
  requireRegisteredSyncSheetWithSql,
  type RegisterSyncSheetInput,
  type RegisterSyncSheetResult,
  type RegisteredSyncSheet,
} from "../../sync/shared/syncRegistry.js";
import {
  insertMappedActiveBusinessKeyWithSql,
  insertMappedActiveRowBindingWithSql,
  readMappedActiveBusinessKeyWithSql,
  readMappedActiveCanonicalEntityWithSql,
  readMappedBusinessKeyOwnerWithSql,
  readMappedCanonicalFieldRevisionsWithSql,
  readMappedLatestProjectionEffectWithSql,
  readMappedRowBindingWithSql,
  readMappedVisibleProjectionStateWithSql,
  retireMappedActiveBusinessKeyWithSql,
  retireMappedEntityBusinessKeysWithSql,
  tombstoneMappedActiveRowBindingWithSql,
} from "./mappedPersistenceSql.js";

/** Row-binding state exposed without SQLite column naming. */
export interface TypedSheetsPersistenceRowBinding {
  readonly logicalSheetId: string;
  readonly anchorReference: string;
  readonly entityId: string | null;
  readonly state: string;
}

/** Canonical field revision exposed without a raw SQL row shape. */
export interface TypedSheetsPersistenceFieldRevision {
  readonly fieldName: string;
  readonly fieldRevision: number;
}

/** Active business key exposed without SQLite column naming. */
export interface TypedSheetsPersistenceBusinessKey {
  readonly normalizedKey: string;
}

/** Confirmed projection baseline exposed in application naming. */
export interface TypedSheetsPersistenceVisibleState {
  readonly confirmedSnapshotHash: string;
  readonly confirmedVisibleRevision: number;
}

/** Latest projection effect exposed in application naming. */
export interface TypedSheetsPersistenceLatestEffect {
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly status: EffectStatus;
  readonly payloadJson: string;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly streamSequence: number;
}

/**
 * Storage operations required by one mapped entity flush.
 *
 * Mutation helpers return whether exactly one state transition was applied;
 * callers do not need to interpret provider-specific row-count objects.
 */
export interface TypedSheetsPersistenceContext {
  claimWriterLease(options: ClaimLeaseOptions): Promise<WriterLeaseClaimResult>;
  registerSyncSheet(
    fence: FencingContext,
    input: RegisterSyncSheetInput,
  ): Promise<RegisterSyncSheetResult>;
  requireRegisteredSyncSheet(physicalSheetId: string): Promise<RegisteredSyncSheet>;

  readRowBinding(rowBindingId: string): Promise<TypedSheetsPersistenceRowBinding | undefined>;
  insertActiveRowBinding(
    rowBindingId: string,
    logicalSheetId: string,
    anchorReference: string,
    entityId: string,
  ): Promise<boolean>;
  tombstoneActiveRowBinding(
    rowBindingId: string,
    logicalSheetId: string,
    entityId: string,
  ): Promise<boolean>;

  readCanonicalEntityRevision(entityId: string): Promise<number | undefined>;
  readCanonicalFieldRevisions(
    entityId: string,
  ): Promise<readonly TypedSheetsPersistenceFieldRevision[]>;

  readActiveBusinessKey(
    logicalSheetId: string,
    fieldName: string,
    entityId: string,
  ): Promise<TypedSheetsPersistenceBusinessKey | undefined>;
  readBusinessKeyOwner(
    logicalSheetId: string,
    fieldName: string,
    normalizedKey: string,
  ): Promise<string | undefined>;
  insertActiveBusinessKey(
    logicalSheetId: string,
    fieldName: string,
    normalizedKey: string,
    entityId: string,
  ): Promise<boolean>;
  retireActiveBusinessKey(
    logicalSheetId: string,
    fieldName: string,
    normalizedKey: string,
    entityId: string,
  ): Promise<boolean>;
  retireEntityBusinessKeys(logicalSheetId: string, entityId: string): Promise<boolean>;

  readVisibleProjectionState(
    physicalSheetId: string,
    projection: string,
    rowBindingId: string,
  ): Promise<TypedSheetsPersistenceVisibleState | undefined>;
  readLatestProjectionEffect(
    logicalSheetId: string,
    targetKind: string,
    targetId: string,
  ): Promise<TypedSheetsPersistenceLatestEffect | undefined>;

  commitCanonicalChanges(
    fence: FencingContext,
    input: CanonicalCommitInput,
  ): Promise<CanonicalCommitResult>;
  appendPendingEffects(fence: FencingContext, effects: readonly NewEffect[]): Promise<boolean>;
}

/** Result of registering a batch of mapped projection routes under one fence. */
export type TypedSheetsPersistenceRegistrationResult =
  | {
      readonly kind: "registered";
      readonly sheets: readonly RegisteredSyncSheet[];
    }
  | { readonly kind: "fenced_out" };

class TypedSheetsPersistenceRoutesFencedOutError extends Error {
  override readonly name = "TypedSheetsPersistenceRoutesFencedOutError";
}

/** Creates the semantic mapped persistence context for one active SQL transaction. */
export function createTypedSheetsPersistenceContext(
  sql: SqlExecutor,
): TypedSheetsPersistenceContext {
  return {
    claimWriterLease: (options) => claimWriterLeaseWithSql(sql, options),
    registerSyncSheet: (fence, input) => registerSyncSheetWithSql(sql, fence, input),
    requireRegisteredSyncSheet: (physicalSheetId) =>
      requireRegisteredSyncSheetWithSql(sql, physicalSheetId),
    readRowBinding: async (rowBindingId) => {
      const row = await readMappedRowBindingWithSql(sql, rowBindingId);
      return row === undefined
        ? undefined
        : {
            logicalSheetId: row.logical_sheet_id,
            anchorReference: row.anchor_reference,
            entityId: row.entity_id,
            state: row.state,
          };
    },
    insertActiveRowBinding: async (
      rowBindingId,
      logicalSheetId,
      anchorReference,
      entityId,
    ) => {
      const result = await insertMappedActiveRowBindingWithSql(
        sql,
        rowBindingId,
        logicalSheetId,
        anchorReference,
        entityId,
      );
      return result.changes === 1;
    },
    tombstoneActiveRowBinding: async (rowBindingId, logicalSheetId, entityId) => {
      const result = await tombstoneMappedActiveRowBindingWithSql(
        sql,
        rowBindingId,
        logicalSheetId,
        entityId,
      );
      return result.changes === 1;
    },
    readCanonicalEntityRevision: async (entityId) => {
      const row = await readMappedActiveCanonicalEntityWithSql(sql, entityId);
      return row?.entity_revision;
    },
    readCanonicalFieldRevisions: async (entityId) => {
      const rows = await readMappedCanonicalFieldRevisionsWithSql(sql, entityId);
      return rows.map((row) => ({
        fieldName: row.field_name,
        fieldRevision: row.field_revision,
      }));
    },
    readActiveBusinessKey: async (logicalSheetId, fieldName, entityId) => {
      const row = await readMappedActiveBusinessKeyWithSql(
        sql,
        logicalSheetId,
        fieldName,
        entityId,
      );
      return row === undefined ? undefined : { normalizedKey: row.normalized_key };
    },
    readBusinessKeyOwner: async (logicalSheetId, fieldName, normalizedKey) => {
      const row = await readMappedBusinessKeyOwnerWithSql(
        sql,
        logicalSheetId,
        fieldName,
        normalizedKey,
      );
      return row?.entity_id;
    },
    insertActiveBusinessKey: async (logicalSheetId, fieldName, normalizedKey, entityId) => {
      const result = await insertMappedActiveBusinessKeyWithSql(
        sql,
        logicalSheetId,
        fieldName,
        normalizedKey,
        entityId,
      );
      return result.changes === 1;
    },
    retireActiveBusinessKey: async (logicalSheetId, fieldName, normalizedKey, entityId) => {
      const result = await retireMappedActiveBusinessKeyWithSql(
        sql,
        logicalSheetId,
        fieldName,
        normalizedKey,
        entityId,
      );
      return result.changes === 1;
    },
    retireEntityBusinessKeys: async (logicalSheetId, entityId) => {
      const result = await retireMappedEntityBusinessKeysWithSql(sql, logicalSheetId, entityId);
      return result.changes === 1;
    },
    readVisibleProjectionState: async (physicalSheetId, projection, rowBindingId) => {
      const row = await readMappedVisibleProjectionStateWithSql(
        sql,
        physicalSheetId,
        projection,
        rowBindingId,
      );
      return row === undefined
        ? undefined
        : {
            confirmedSnapshotHash: row.confirmed_snapshot_hash,
            confirmedVisibleRevision: row.confirmed_visible_revision,
          };
    },
    readLatestProjectionEffect: async (logicalSheetId, targetKind, targetId) => {
      const row = await readMappedLatestProjectionEffectWithSql(
        sql,
        logicalSheetId,
        targetKind,
        targetId,
      );
      return row === undefined
        ? undefined
        : {
            physicalSheetId: row.physical_sheet_id,
            projection: row.projection,
            status: row.status,
            payloadJson: row.payload_json,
            expectedVisibleRevision: row.expected_visible_revision,
            expectedVisibleHash: row.expected_visible_hash,
            streamSequence: row.stream_sequence,
          };
    },
    commitCanonicalChanges: (fence, input) =>
      commitCanonicalChangesWithSql(sql, fence, input),
    appendPendingEffects: (fence, effects) =>
      appendPendingEffectsWithSql(sql, fence, effects),
  };
}

/** Registers mapped projection routes in one adapter-owned transaction. */
export async function registerTypedSheetsPersistenceRoutesWithAdapter(
  storage: SqlStorageAdapter,
  lease: ClaimLeaseOptions,
  inputs: readonly RegisterSyncSheetInput[],
): Promise<TypedSheetsPersistenceRegistrationResult> {
  try {
    return await storage.transaction(async ({ sql }) => {
      // Mapped-role claim; mirror this site in expireRuntimeWriterLeases (SyncServiceBootstrap).
      const claim = await claimWriterLeaseWithSql(sql, lease);
      if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
        return { kind: "fenced_out" };
      }

      const fence: FencingContext = {
        role: claim.lease.role,
        writerEpoch: claim.lease.writerEpoch,
        fencingToken: claim.lease.fencingToken,
        now: lease.now,
      };
      const sheets: RegisteredSyncSheet[] = [];
      for (const input of inputs) {
        const result = await registerSyncSheetWithSql(sql, fence, input);
        if (result.kind !== "registered") {
          // A previous route may have been inserted in this transaction. Throw
          // so the adapter rolls back the whole registration batch.
          throw new TypedSheetsPersistenceRoutesFencedOutError();
        }
        sheets.push(result.sheet);
      }
      return { kind: "registered", sheets };
    });
  } catch (error: unknown) {
    if (error instanceof TypedSheetsPersistenceRoutesFencedOutError) {
      return { kind: "fenced_out" };
    }
    throw error;
  }
}
