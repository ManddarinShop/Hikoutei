/** Automatically resolves observed User_Input conflicts in favor of canonical SQLite state. */

import {
  candidateHash,
} from "../../../domain/conflict/transitions.js";
import {
  CONFLICT_STATUSES,
  FIELD_OWNERSHIPS,
  LOOKUP_RESULT_KINDS,
  type NormalizedCell,
  type SyncConflict,
} from "../../../domain/index.js";
import {
  applicableValue,
  absentValue,
  notApplicableValue,
  presentValue,
} from "../../../shared/state/index.js";
import { stableHash } from "../../../shared/encoding/stableEncode.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../gateway/constants.js";
import {
  syncConflictProjectionFields,
} from "../gateway/conflictProjection.js";
import {
  createCandidateReconcileEffect,
  createResolutionProjectionEffect,
} from "../outbound/projection/ProjectionEffectFactory.js";
import {
  requireTypedSheetsEntityProjection,
  type TypedSheetsEntityMapping,
} from "../../orm/mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../orm/errors.js";
import {
  identifiedValue,
} from "../../orm/persistence/support/helpers.js";
import type {
  ResolvedWriterOptions,
} from "../../orm/persistence/support/contracts.js";
import {
  parseSyncProjectionEffectPayload,
} from "../gateway/syncGateway.js";
import type {
  PersistObservedRowInput,
} from "../../../infrastructure/storage/state/observation/observationTypes.js";
import {
  appendResolutionEffectsWithSql,
  persistResolutionCommandWithSql,
  readConflictIdsWithSql,
  readConflictWithSql,
  readOpenConflictIdsWithSql,
} from "../../../infrastructure/storage/state/resolution/resolutionWriter.js";
import { PERSIST_RESOLUTION_RESULT_KINDS } from "../../../infrastructure/storage/state/resolution/resolutionWriterContracts.js";
import {
  readMappedActiveCanonicalEntityWithSql,
  readMappedCanonicalFieldsWithSql,
  readMappedLatestProjectionEffectWithSql,
  readMappedRowBindingWithSql,
  readMappedVisibleProjectionStateWithSql,
} from "../../../infrastructure/storage/state/mapped/mappedPersistenceSql.js";
import {
  requireRegisteredSyncSheetWithSql,
} from "../../../infrastructure/storage/sync/shared/syncRegistry.js";
import {
  claimWriterLeaseWithAdapter,
  claimWriterLeaseWithSql,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
  type NewEffect,
} from "../../../infrastructure/storage/index.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../adapter/persistence/contracts/sql.js";

const RESOLUTION_ACTOR_ID = "sync:auto-system-wins";
const MAX_CONFLICTS_PER_LEASE_RENEWAL = 16;
const PROJECTION_ROW_TARGET_KIND = "projection_row" as const;
const CONFLICT_TARGET_KIND = "conflict" as const;

/** Resolves existing unresolved conflicts before the sync supervisors start. */
export async function autoResolveExistingMappedConflictsWithAdapter(
  storage: SqlStorageAdapter,
  mappings: readonly TypedSheetsEntityMapping[],
  writer: ResolvedWriterOptions,
): Promise<void> {
  await storage.transaction(async ({ sql }) => {
    const initialNow = writer.now();
    const claim = await claimWriterLeaseWithSql(sql, {
      role: writer.role,
      writerId: writer.writerId,
      leaseDurationMs: writer.leaseDurationMs,
      now: initialNow,
    });
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
        `automatic conflict resolver lease is unavailable: ${claim.reason}.`,
      );
    }
    let fence: FencingContext = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: initialNow,
    };
    for (const mapping of mappings) {
      const conflictIds = await readOpenConflictIdsWithSql(sql, mapping.logicalSheetId);
      const handledConflictIds = new Set(conflictIds);
      for (const conflictBatch of chunkConflictIds(conflictIds)) {
        fence = await renewAutomaticConflictResolutionLeaseWithSql(sql, fence, writer);
        await autoResolveMappedConflictsWithSql(
          sql,
          fence,
          writer,
          mapping,
          undefined,
          conflictBatch,
        );
      }
      const allConflictIds = await readConflictIdsWithSql(sql, mapping.logicalSheetId);
      for (const conflictBatch of chunkConflictIds(allConflictIds)) {
        fence = await renewAutomaticConflictResolutionLeaseWithSql(sql, fence, writer);
        for (const conflictId of conflictBatch) {
          if (handledConflictIds.has(conflictId)) continue;
          const result = await readConflictWithSql(sql, mapping.logicalSheetId, conflictId);
          if (result.kind === LOOKUP_RESULT_KINDS.FOUND && result.value.status === CONFLICT_STATUSES.RESOLVED) {
            await ensureMappedConflictAuditWithSql(sql, fence, writer, mapping, result.value);
          }
        }
      }
    }
  });
}

/** Renews the startup resolver fence without accepting a silent epoch takeover. */
export async function renewAutomaticConflictResolutionLeaseWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
): Promise<FencingContext> {
  const now = Math.max(fence.now, writer.now());
  const claim = await claimWriterLeaseWithSql(sql, {
    role: writer.role,
    writerId: writer.writerId,
    leaseDurationMs: writer.leaseDurationMs,
    now,
  });
  if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
      `automatic conflict resolver lease renewal is unavailable: ${claim.reason}.`,
    );
  }
  if (
    claim.lease.writerEpoch !== fence.writerEpoch ||
    claim.lease.fencingToken !== fence.fencingToken
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
      "automatic conflict resolver lease changed ownership while processing conflicts.",
    );
  }
  return { ...fence, now };
}

function chunkConflictIds(conflictIds: readonly string[]): readonly (readonly string[])[] {
  const batches: string[][] = [];
  for (let index = 0; index < conflictIds.length; index += MAX_CONFLICTS_PER_LEASE_RENEWAL) {
    batches.push(conflictIds.slice(index, index + MAX_CONFLICTS_PER_LEASE_RENEWAL));
  }
  return batches;
}

/** Ensures one resolved conflict has an idempotent Sync_Conflicts audit effect. */
export async function ensureMappedConflictAuditWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  conflict: SyncConflict,
): Promise<void> {
  const conflictSheet = await requireRegisteredSyncSheetWithSql(
    sql,
    `${mapping.logicalSheetId}:sync_conflicts`,
  );
  const baseline = await nextEffectBaseline(
    sql,
    mapping.logicalSheetId,
    CONFLICT_TARGET_KIND,
    conflict.conflictId,
    0,
    "",
    true,
    false,
  );
  const commitId = `audit:${conflict.conflictId}`;
  const effect = createResolutionProjectionEffect({
    effectId: identifiedValue("effect", writer),
    commitId,
    logicalSheetId: mapping.logicalSheetId,
    physicalSheetId: conflictSheet.physicalSheetId,
    sheetName: conflictSheet.tabName,
    registeredRange: conflictSheet.registeredRange,
    schemaVersion: mapping.schemaVersion,
    targetId: conflict.conflictId,
    rowBindingId: absentValue(),
    conflictId: presentValue(conflict.conflictId),
    targetAnchor: `conflict:${conflict.conflictId}`,
    fields: syncConflictProjectionFields(conflict, "SYSTEM_WINS"),
    createIfMissing: baseline.createIfMissing,
    expectedVisibleRevision: baseline.expectedVisibleRevision,
    expectedVisibleHash: baseline.expectedVisibleHash,
    streamSequence: baseline.streamSequence,
  });
  await appendResolutionEffectsWithSql(sql, fence, [effect]);
}

/** Resolves newly persisted conflicts inside the caller's SQLite transaction. */
export async function autoResolveMappedConflictsWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  input: PersistObservedRowInput | undefined,
  conflictIds: readonly string[],
): Promise<readonly string[]> {
  if (conflictIds.length === 0) return [];
  const deferredConflictIds: string[] = [];
  const userProjection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  const userSheet = await requireRegisteredSyncSheetWithSql(sql, userProjection.physicalSheetId);
  const conflictSheet = await requireRegisteredSyncSheetWithSql(
    sql,
    `${mapping.logicalSheetId}:sync_conflicts`,
  );

  for (const conflictId of conflictIds) {
    const conflictResult = await readConflictWithSql(sql, mapping.logicalSheetId, conflictId);
    if (conflictResult.kind !== LOOKUP_RESULT_KINDS.FOUND) continue;
    const conflict = conflictResult.value;
    if (conflict.status === CONFLICT_STATUSES.RESOLVED) continue;

    const effects = await resolutionEffectsForConflict(
      sql,
      writer,
      mapping,
      input,
      conflict,
      userSheet,
      conflictSheet,
    );
    if (effects === undefined || effects.length === 0) continue;
    const commandId = `auto-system-wins:${conflict.conflictId}:${conflict.candidateEpoch}`;
    const commitId = `auto-system-wins-commit:${conflict.conflictId}:${conflict.candidateEpoch}`;
    const command = {
      commandId,
      requestKey: commandId,
      action: "acknowledge_system" as const,
      actorId: RESOLUTION_ACTOR_ID,
      role: "sync_operator" as const,
      targetConflictId: conflict.conflictId,
      expectedRevision: conflict.currentCanonicalRevision,
      activeCandidateHash: candidateHash(conflict),
      expectedCandidateEpoch: conflict.candidateEpoch,
      payloadHash: stableHash({
        action: "acknowledge_system",
        targetConflictId: conflict.conflictId,
        expectedRevision: conflict.currentCanonicalRevision,
        activeCandidateHash: candidateHash(conflict),
        expectedCandidateEpoch: conflict.candidateEpoch,
      }),
    };
    const resolutionResult = await persistResolutionCommandWithSql(sql, fence, {
      logicalSheetId: mapping.logicalSheetId,
      command,
      commitId,
      effects,
    });
    if (resolutionResult.kind === PERSIST_RESOLUTION_RESULT_KINDS.DEFERRED) {
      deferredConflictIds.push(conflict.conflictId);
    }
  }
  return deferredConflictIds;
}

/**
 * Retries durable open conflicts after a later polling pass.
 *
 * A conflict deliberately remains OPEN while an older effect is processing so
 * a late remote response cannot overwrite the system-wins decision. The open
 * conflict row is the durable retry record; this pass re-reads it on every
 * polling cycle and retries the same fenced resolution after the predecessor
 * has become applied, superseded, or otherwise recoverable.
 */
export async function retryOpenMappedConflictsWithAdapter(
  storage: SqlStorageAdapter,
  mappings: readonly TypedSheetsEntityMapping[],
  writer: ResolvedWriterOptions,
  observedInputs: readonly PersistObservedRowInput[] = [],
): Promise<number> {
  const candidates = await storage.read(async ({ sql }) => {
    const result: Array<{
      readonly mapping: TypedSheetsEntityMapping;
      readonly conflictIds: readonly string[];
    }> = [];
    for (const mapping of mappings) {
      if (!mapping.projections.some((projection) => projection.projection === SYNC_GATEWAY_PROJECTIONS.USER_INPUT)) {
        continue;
      }
      const conflictIds = await readOpenConflictIdsWithSql(sql, mapping.logicalSheetId);
      if (conflictIds.length > 0) result.push({ mapping, conflictIds });
    }
    return result;
  });
  if (candidates.length === 0) return 0;

  const observedByBinding = new Map<string, PersistObservedRowInput>();
  for (const observedInput of observedInputs) {
    const row = observedInput.batch.rows[observedInput.rowIndex];
    if (row === undefined) continue;
    observedByBinding.set(
      `${observedInput.physicalSheetId}:${row.rowBindingId}`,
      observedInput,
    );
  }

  return storage.transaction(async ({ sql }) => {
    const now = writer.now();
    const claim = await claimWriterLeaseWithSql(sql, {
      role: writer.role,
      writerId: writer.writerId,
      leaseDurationMs: writer.leaseDurationMs,
      now,
    });
    // Another writer may be processing an observation. The next polling pass
    // will retry the durable OPEN rows; do not turn a temporary lease race into
    // a polling failure.
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) return 0;
    let fence: FencingContext = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now,
    };
    let attempted = 0;
    for (const candidate of candidates) {
      const currentIds = await readOpenConflictIdsWithSql(sql, candidate.mapping.logicalSheetId);
      for (const conflictBatch of chunkConflictIds(currentIds)) {
        fence = await renewAutomaticConflictResolutionLeaseWithSql(sql, fence, writer);
        for (const conflictId of conflictBatch) {
          const conflictResult = await readConflictWithSql(
            sql,
            candidate.mapping.logicalSheetId,
            conflictId,
          );
          if (conflictResult.kind !== LOOKUP_RESULT_KINDS.FOUND) continue;
          const userProjection = requireTypedSheetsEntityProjection(
            candidate.mapping,
            SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
          );
          const observedInput = observedByBinding.get(
            `${userProjection.physicalSheetId}:${conflictResult.value.rowBindingId}`,
          );
          const deferred = await autoResolveMappedConflictsWithSql(
            sql,
            fence,
            writer,
            candidate.mapping,
            observedInput,
            [conflictId],
          );
          attempted += deferred.length === 0 ? 1 : 0;
        }
      }
    }
    return attempted;
  });
}

async function resolutionEffectsForConflict(
  sql: SqlExecutor,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  input: PersistObservedRowInput | undefined,
  conflict: SyncConflict,
  userSheet: Awaited<ReturnType<typeof requireRegisteredSyncSheetWithSql>>,
  conflictSheet: Awaited<ReturnType<typeof requireRegisteredSyncSheetWithSql>>,
): Promise<readonly NewEffect[] | undefined> {
  const binding = await readMappedRowBindingWithSql(sql, conflict.rowBindingId);
  if (binding === undefined || binding.entity_id === null) return undefined;
  const canonicalFields = await readMappedCanonicalFieldsWithSql(sql, conflict.entityId);
  const userFields: Record<string, NormalizedCell> = {};
  for (const field of mapping.fields) {
    if (field.ownership !== FIELD_OWNERSHIPS.USER) continue;
    const value = canonicalFields[field.fieldName];
    if (value === undefined) return undefined;
    userFields[field.fieldName] = value;
  }

  const visible = await readMappedVisibleProjectionStateWithSql(
    sql,
    userSheet.physicalSheetId,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
    conflict.rowBindingId,
  );
  const observed = input?.observedProjection;
  const userVisibleRevision = observed?.visibleRevision ?? visible?.confirmed_visible_revision;
  const userVisibleHash = observed?.visibleHash ?? visible?.confirmed_snapshot_hash;
  if (userVisibleRevision === undefined || userVisibleHash === undefined) return undefined;

  const entity = await readMappedActiveCanonicalEntityWithSql(sql, conflict.entityId);
  const userTargetId = `projection-row:${userSheet.physicalSheetId}:${conflict.rowBindingId}`;
  const userBaseline = await nextEffectBaseline(
    sql,
    mapping.logicalSheetId,
    PROJECTION_ROW_TARGET_KIND,
    userTargetId,
    userVisibleRevision,
    userVisibleHash,
    false,
    true,
  );
  const conflictTargetId = conflict.conflictId;
  const conflictBaseline = await nextEffectBaseline(
    sql,
    mapping.logicalSheetId,
    CONFLICT_TARGET_KIND,
    conflictTargetId,
    0,
    "",
    true,
    false,
  );
  const resolvedConflict: SyncConflict = {
    ...conflict,
    status: CONFLICT_STATUSES.RESOLVED,
    resolutionCommandId: presentValue(
      `auto-system-wins:${conflict.conflictId}:${conflict.candidateEpoch}`,
    ),
  };
  const commitId = `auto-system-wins-commit:${conflict.conflictId}:${conflict.candidateEpoch}`;
  const userEffect = createCandidateReconcileEffect({
    effectId: identifiedValue("effect", writer),
    commitId,
    logicalSheetId: mapping.logicalSheetId,
    physicalSheetId: userSheet.physicalSheetId,
    sheetName: userSheet.tabName,
    registeredRange: userSheet.registeredRange,
    schemaVersion: mapping.schemaVersion,
    targetKind: PROJECTION_ROW_TARGET_KIND,
    targetId: userTargetId,
    rowBindingId: presentValue(conflict.rowBindingId),
    conflictId: absentValue(),
    targetAnchor: binding.anchor_reference,
    fields: userFields,
    createIfMissing: false,
    expectedVisibleRevision: userBaseline.expectedVisibleRevision,
    expectedVisibleHash: userBaseline.expectedVisibleHash,
    expectedCandidateHash: applicableValue(candidateHash(conflict)),
    targetEntityRevision: entity === undefined
      ? notApplicableValue()
      : applicableValue(entity.entity_revision),
    streamSequence: userBaseline.streamSequence,
  });
  const conflictEffect = createResolutionProjectionEffect({
    effectId: identifiedValue("effect", writer),
    commitId,
    logicalSheetId: mapping.logicalSheetId,
    physicalSheetId: conflictSheet.physicalSheetId,
    sheetName: conflictSheet.tabName,
    registeredRange: conflictSheet.registeredRange,
    schemaVersion: mapping.schemaVersion,
    targetId: conflictTargetId,
    rowBindingId: absentValue(),
    conflictId: presentValue(conflict.conflictId),
    targetAnchor: `conflict:${conflict.conflictId}`,
    fields: syncConflictProjectionFields(resolvedConflict, "SYSTEM_WINS"),
    createIfMissing: conflictBaseline.createIfMissing,
    expectedVisibleRevision: conflictBaseline.expectedVisibleRevision,
    expectedVisibleHash: conflictBaseline.expectedVisibleHash,
    streamSequence: conflictBaseline.streamSequence,
  });
  return [userEffect, conflictEffect];
}

async function nextEffectBaseline(
  sql: SqlExecutor,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
  fallbackVisibleRevision: number,
  fallbackVisibleHash: string,
  fallbackCreateIfMissing: boolean,
  preferFallbackForUnresolved: boolean,
): Promise<{
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}> {
  const latest = await readMappedLatestProjectionEffectWithSql(
    sql,
    logicalSheetId,
    targetKind,
    targetId,
  );
  if (latest === undefined) {
    return {
      expectedVisibleRevision: fallbackVisibleRevision,
      expectedVisibleHash: fallbackVisibleHash,
      createIfMissing: fallbackCreateIfMissing,
      streamSequence: 1,
    };
  }
  const payload = parseSyncProjectionEffectPayload(latest.payload_json);
  const unresolved = latest.status !== "applied";
  return {
    expectedVisibleRevision: unresolved && preferFallbackForUnresolved
      ? fallbackVisibleRevision
      : unresolved
        ? latest.expected_visible_revision
        : latest.expected_visible_revision + 1,
    expectedVisibleHash: unresolved && preferFallbackForUnresolved
      ? fallbackVisibleHash
      : unresolved
        ? latest.expected_visible_hash
        : payload.targetVisibleHash,
    createIfMissing: unresolved
      ? preferFallbackForUnresolved ? fallbackCreateIfMissing : payload.createIfMissing
      : false,
    streamSequence: latest.stream_sequence + 1,
  };
}
