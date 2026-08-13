/**
 * Implicit system-wins conflict resolution for the mapped sync path.
 *
 * A detected User_Input conflict is never resolved by polling alone. The first
 * observation persists an OPEN conflict, its active candidate, the
 * candidate-time full-row visible evidence, and a durable OPEN Sync_Conflicts
 * audit effect; no resolution command is created. Only a later canonical field
 * revision increase on the SAME conflicted field (planned by the mapped flush
 * hook inside the flush transaction) is an implicit system-wins trigger: the
 * conflict is rebased to NEEDS_REBASE and a revision-identified
 * acknowledge_system command is planned from the stored candidate evidence.
 *
 * Pending commands are durable retry records: a processing or
 * delivery_uncertain predecessor defers the exact command, and later polling
 * passes reconstruct the identical command from the stored conflict row.
 * Legacy `sync:auto-system-wins` pending commands and obsolete revision
 * generations are staled idempotently without resolving the conflict.
 */

import {
  candidateHash,
} from "../../../domain/conflict/transitions.js";
import {
  CONFLICT_STATUSES,
  FIELD_OWNERSHIPS,
} from "../../../domain/model/constants.js";
import { LOOKUP_RESULT_KINDS } from "../../../shared/state/constants.js";
import { stableHash } from "../../../shared/encoding/stableEncode.js";
import type { NormalizedCell } from "../../../shared/encoding/types.js";
import type {
  ResolutionCommand,
  SyncConflict,
} from "../../../domain/model/types.js";
import {
  applicableValue,
  absentValue,
  notApplicableValue,
  presentValue,
} from "../../../shared/state/index.js";
import {
  SYNC_PROJECTIONS,
} from "../sheetsContract/constants.js";
import {
  openSyncConflictAuditProjectionFields,
  resolvedSyncConflictAuditProjectionFields,
} from "../sheetsContract/conflictProjection.js";
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
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
} from "../sheetsContract/syncSheets.js";
import {
  availableCandidateVisibleEvidence,
} from "../../../infrastructure/storage/state/resolution/candidateEvidence.js";
import {
  persistResolutionCommandWithSql,
  readConflictWithSql,
  readPendingCommandsForConflictWithSql,
  readPendingConflictIdsWithSql,
  markPendingResolutionCommandStaleWithSql,
  staleSupersededPendingCommandsWithSql,
  rebaseActiveConflictWithSql,
  appendResolutionEffectsWithSql,
} from "../../../infrastructure/storage/state/resolution/resolutionWriter.js";
import {
  readActiveCandidateWithSql,
} from "../../../infrastructure/storage/state/observation/observationLedger.js";
import {
  readMappedActiveCanonicalEntityWithSql,
  readMappedCanonicalFieldsWithSql,
  readMappedCanonicalFieldRevisionsWithSql,
  readMappedLatestAppliedProjectionEffectWithSql,
  readMappedLatestProjectionEffectWithSql,
  readMappedRowBindingWithSql,
  type MappedLatestProjectionEffectSqlRow,
} from "../../../infrastructure/storage/state/mapped/mappedPersistenceSql.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../../infrastructure/storage/errors.js";
import {
  requireRegisteredSyncSheetWithSql,
} from "../../../infrastructure/storage/sync/shared/syncRegistry.js";
import {
  claimWriterLeaseWithSql,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
  type NewEffect,
} from "@hikoutei/ikisaki";
import type { SqlExecutor, SqlStorageAdapter } from "../../../adapter/persistence/contracts/sql.js";
import type { CommandRow } from "../../../infrastructure/storage/state/resolution/resolutionWriterContracts.js";

/** Actor identity recorded on every implicit system-wins resolution command. */
export const SYSTEM_WINS_ACTOR_ID = "sync:system-wins";

/** Actor identity recorded by the retired creation-time auto resolver. */
export const LEGACY_AUTO_SYSTEM_WINS_ACTOR_ID = "sync:auto-system-wins";

/** Command identity prefix of the retired creation-time auto resolver. */
export const LEGACY_AUTO_SYSTEM_WINS_COMMAND_PREFIX = "auto-system-wins:";

/** Command identity prefix of the revision-identified implicit resolver. */
export const SYSTEM_WINS_COMMAND_PREFIX = "sync:system-wins:";

const MAX_CONFLICTS_PER_LEASE_RENEWAL = 16;
const PROJECTION_ROW_TARGET_KIND = "projection_row" as const;
const CONFLICT_TARGET_KIND = "conflict" as const;
const EMPTY_CONFLICT_STREAM_BASELINE = {
  expectedVisibleRevision: 0,
  expectedVisibleHash: "",
  createIfMissing: true,
  streamSequence: 1,
} as const;

/** Renews the startup resolver fence without accepting a silent epoch takeover. */
export async function renewAutomaticConflictResolutionLeaseWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
): Promise<FencingContext> {
  const now = Math.max(fence.now, writer.now());
  // Mapped-role claim; mirror this site in expireRuntimeWriterLeases (SyncServiceBootstrap).
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

/**
 * Plans the durable OPEN Sync_Conflicts audit effect for newly detected
 * conflicts inside the caller's SQLite transaction.
 *
 * This is the only audit work a detection performs: zero resolution commands
 * are created, so polling and restart alone can never resolve a conflict.
 */
export async function planOpenConflictAuditEffectsWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  conflictIds: readonly string[],
): Promise<void> {
  if (conflictIds.length === 0) return;
  const conflictSheet = await requireRegisteredSyncSheetWithSql(
    sql,
    `${mapping.logicalSheetId}:sync_conflicts`,
  );
  for (const conflictId of conflictIds) {
    const conflictResult = await readConflictWithSql(sql, mapping.logicalSheetId, conflictId);
    if (conflictResult.kind !== LOOKUP_RESULT_KINDS.FOUND) continue;
    const conflict = conflictResult.value;
    const baseline = await nextConflictAuditBaselineWithSql(
      sql,
      mapping.logicalSheetId,
      conflict.conflictId,
    );
    const effect = createResolutionProjectionEffect({
      effectId: identifiedValue("effect", writer),
      commitId: `open-conflict-audit:${conflict.conflictId}`,
      logicalSheetId: mapping.logicalSheetId,
      physicalSheetId: conflictSheet.physicalSheetId,
      sheetName: conflictSheet.tabName,
      registeredRange: conflictSheet.registeredRange,
      schemaVersion: mapping.schemaVersion,
      targetId: conflict.conflictId,
      rowBindingId: absentValue(),
      conflictId: presentValue(conflict.conflictId),
      targetAnchor: `conflict:${conflict.conflictId}`,
      fields: openSyncConflictAuditProjectionFields(conflict),
      createIfMissing: baseline.createIfMissing,
      expectedVisibleRevision: baseline.expectedVisibleRevision,
      expectedVisibleHash: baseline.expectedVisibleHash,
      streamSequence: baseline.streamSequence,
    });
    await appendResolutionEffectsWithSql(sql, fence, [effect]);
  }
}

/**
 * Decides whether a committed canonical field change is an implicit
 * system-wins trigger for an unresolved conflict.
 *
 * Only a REAL field revision increase on the SAME conflicted field counts:
 * the new revision must strictly exceed the conflict's current canonical
 * revision and the committed value must differ from the current canonical
 * value. Unrelated fields and same-value/no-revision updates never trigger.
 */
export function shouldTriggerImplicitSystemWins(
  conflict: SyncConflict,
  nextFieldRevision: number,
  nextFieldValue: NormalizedCell,
): boolean {
  if (conflict.status === CONFLICT_STATUSES.RESOLVED) return false;
  if (nextFieldRevision <= conflict.currentCanonicalRevision) return false;
  return stableHash(conflict.currentCanonicalValue) !== stableHash(nextFieldValue);
}

/**
 * Returns the durable command identity for one implicit system-wins attempt.
 *
 * The identity embeds the conflict ID, the active candidate epoch, and the
 * current canonical revision, so a newer same-field commit plans a strictly
 * newer command that supersedes any older pending generation.
 */
export function systemWinsCommandId(conflict: SyncConflict): string {
  return `${SYSTEM_WINS_COMMAND_PREFIX}${conflict.conflictId}:${conflict.candidateEpoch}:${conflict.currentCanonicalRevision}`;
}

/** Returns the deterministic commit ID shared by one system-wins command and its effects. */
export function systemWinsCommitId(conflict: SyncConflict): string {
  return `system-wins-commit:${conflict.conflictId}:${conflict.candidateEpoch}:${conflict.currentCanonicalRevision}`;
}

/**
 * Builds the exact implicit system-wins command for one conflict row.
 *
 * The command is fully derived from durable conflict state (candidate hash,
 * epoch, current canonical revision), so a deferred command can be
 * reconstructed byte-for-byte on later retries.
 */
export function systemWinsCommandFor(conflict: SyncConflict): ResolutionCommand {
  const commandId = systemWinsCommandId(conflict);
  const activeCandidateHash = candidateHash(conflict);
  return {
    commandId,
    requestKey: commandId,
    action: "acknowledge_system",
    actorId: SYSTEM_WINS_ACTOR_ID,
    role: "sync_operator",
    targetConflictId: conflict.conflictId,
    expectedRevision: conflict.currentCanonicalRevision,
    activeCandidateHash,
    expectedCandidateEpoch: conflict.candidateEpoch,
    payloadHash: stableHash({
      action: "acknowledge_system",
      targetConflictId: conflict.conflictId,
      expectedRevision: conflict.currentCanonicalRevision,
      activeCandidateHash,
      expectedCandidateEpoch: conflict.candidateEpoch,
    }),
  };
}

/**
 * Plans rebase, audit, and implicit system-wins work after one mapped flush.
 *
 * Runs inside the same SQLite transaction that committed the entity change.
 * For every changed field with an OPEN/NEEDS_REBASE active candidate, a real
 * revision increase rebases the conflict to NEEDS_REBASE (with the committed
 * value, revision, and commit ID), appends the durable NEEDS_REBASE audit
 * effect, and plans the revision-identified system-wins command. Conflicts
 * without stored candidate evidence are never guessed: they stay rebased for
 * human resolution.
 */
export async function planMappedFlushConflictSyncWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  input: {
    readonly entityId: string;
    readonly rowBindingId: string;
    readonly commitId: string;
    readonly changedFieldNames: readonly string[];
    readonly suppressedUserProjection: boolean;
  },
): Promise<void> {
  // The flush already verified the row carries an active candidate; without
  // one there is nothing to rebase or resolve.
  if (!input.suppressedUserProjection) return;
  const userProjection = mapping.projections.find(
    (projection) => projection.projection === SYNC_PROJECTIONS.USER_INPUT,
  );
  if (userProjection === undefined) return;
  const changedFieldNames = new Set(input.changedFieldNames);
  if (changedFieldNames.size === 0) return;

  const canonicalFields = await readMappedCanonicalFieldsWithSql(sql, input.entityId);
  const fieldRevisions = await readMappedCanonicalFieldRevisionsWithSql(sql, input.entityId);
  const nextRevisions = new Map(fieldRevisions.map((row) => [row.field_name, row.field_revision]));
  for (const fieldName of changedFieldNames) {
    const nextValue = canonicalFields[fieldName];
    const nextRevision = nextRevisions.get(fieldName);
    if (nextValue === undefined || nextRevision === undefined) continue;
    const active = await readActiveCandidateWithSql(
      sql,
      userProjection.physicalSheetId,
      SYNC_PROJECTIONS.USER_INPUT,
      input.rowBindingId,
      fieldName,
    );
    if (active.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) continue;
    if (active.value.status === CONFLICT_STATUSES.RESOLVED) continue;
    const conflictResult = await readConflictWithSql(
      sql,
      mapping.logicalSheetId,
      active.value.active_candidate_conflict_id,
    );
    if (conflictResult.kind !== LOOKUP_RESULT_KINDS.FOUND) continue;
    const conflict = conflictResult.value;
    if (!shouldTriggerImplicitSystemWins(conflict, nextRevision, nextValue)) continue;

    await rebaseActiveConflictWithSql(sql, fence, {
      conflictId: conflict.conflictId,
      currentCanonicalValue: nextValue,
      currentCanonicalRevision: nextRevision,
      lastRebasedCommitId: input.commitId,
      updatedAt: fence.now,
    });
    const rebasedConflict: SyncConflict = {
      ...conflict,
      currentCanonicalValue: nextValue,
      currentCanonicalRevision: nextRevision,
      status: CONFLICT_STATUSES.NEEDS_REBASE,
    };
    const conflictSheet = await requireRegisteredSyncSheetWithSql(
      sql,
      `${mapping.logicalSheetId}:sync_conflicts`,
    );
    const auditEffect = await conflictAuditEffectFor(
      sql,
      writer,
      mapping,
      conflictSheet,
      rebasedConflict,
    );
    await appendConflictAuditEffectOrDeferWithSql(sql, fence, [auditEffect]);

    const effects = await systemWinsResolutionEffects(sql, writer, mapping, rebasedConflict);
    if (effects === undefined) continue;
    const command = systemWinsCommandFor(rebasedConflict);
    await staleSupersededPendingCommandsWithSql(
      sql,
      fence,
      rebasedConflict.conflictId,
      command.commandId,
    );
    await persistResolutionCommandWithSql(sql, fence, {
      logicalSheetId: mapping.logicalSheetId,
      command,
      commitId: systemWinsCommitId(rebasedConflict),
      effects,
    });
  }
}

/**
 * Classifies one durable pending command by its coherent automatic identity.
 *
 * Only retired legacy `sync:auto-system-wins` commands and new implicit
 * `sync:system-wins` commands are polling-owned: actor, action, and command
 * identity prefix must all agree. Anything else is a manual or unknown
 * command that polling must never stale, supersede, or retry.
 */
type PendingAutomaticCommandKind = "legacy-auto" | "implicit" | "other";

function classifyPendingAutomaticCommand(pending: CommandRow): PendingAutomaticCommandKind {
  if (
    pending.actor_id === LEGACY_AUTO_SYSTEM_WINS_ACTOR_ID &&
    pending.action === "acknowledge_system" &&
    pending.command_id.startsWith(LEGACY_AUTO_SYSTEM_WINS_COMMAND_PREFIX)
  ) {
    return "legacy-auto";
  }
  if (
    pending.actor_id === SYSTEM_WINS_ACTOR_ID &&
    pending.action === "acknowledge_system" &&
    pending.command_id.startsWith(SYSTEM_WINS_COMMAND_PREFIX)
  ) {
    return "implicit";
  }
  return "other";
}

/**
 * Retries durable pending system-wins commands after later polling passes.
 *
 * Legacy `sync:auto-system-wins` pending commands are staled idempotently
 * without resolving their conflicts. New-style pending commands are
 * reconstructed exactly from the stored conflict row and re-issued; an
 * obsolete revision generation is staled. A still-in-flight predecessor keeps
 * the exact command pending for the next pass. Manual or unknown pending
 * commands are never touched by polling.
 */
export async function retryOpenMappedConflictsWithAdapter(
  storage: SqlStorageAdapter,
  mappings: readonly TypedSheetsEntityMapping[],
  writer: ResolvedWriterOptions,
): Promise<number> {
  const candidates = await storage.read(async ({ sql }) => {
    const result: Array<{
      readonly mapping: TypedSheetsEntityMapping;
      readonly conflictIds: readonly string[];
    }> = [];
    for (const mapping of mappings) {
      if (!mapping.projections.some((projection) => projection.projection === SYNC_PROJECTIONS.USER_INPUT)) {
        continue;
      }
      const conflictIds = await readPendingConflictIdsWithSql(sql, mapping.logicalSheetId);
      if (conflictIds.length > 0) result.push({ mapping, conflictIds });
    }
    return result;
  });
  if (candidates.length === 0) return 0;

  return storage.transaction(async ({ sql }) => {
    const now = writer.now();
    // Mapped-role claim; mirror this site in expireRuntimeWriterLeases (SyncServiceBootstrap).
    const claim = await claimWriterLeaseWithSql(sql, {
      role: writer.role,
      writerId: writer.writerId,
      leaseDurationMs: writer.leaseDurationMs,
      now,
    });
    // Another writer may be processing an observation. The next polling pass
    // will retry the durable pending rows; do not turn a temporary lease race
    // into a polling failure.
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) return 0;
    let fence: FencingContext = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now,
    };
    let attempted = 0;
    for (const candidate of candidates) {
      const currentIds = await readPendingConflictIdsWithSql(sql, candidate.mapping.logicalSheetId);
      for (const conflictBatch of chunkConflictIds(currentIds)) {
        fence = await renewAutomaticConflictResolutionLeaseWithSql(sql, fence, writer);
        for (const conflictId of conflictBatch) {
          const handled = await retryPendingCommandsForConflictWithSql(
            sql,
            fence,
            writer,
            candidate.mapping,
            conflictId,
          );
          if (handled) attempted += 1;
        }
      }
    }
    return attempted;
  });
}

/** Processes every durable pending command targeting one conflict. */
async function retryPendingCommandsForConflictWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  conflictId: string,
): Promise<boolean> {
  const conflictResult = await readConflictWithSql(sql, mapping.logicalSheetId, conflictId);
  if (conflictResult.kind !== LOOKUP_RESULT_KINDS.FOUND) return false;
  const conflict = conflictResult.value;
  const pendingCommands = await readPendingCommandsForConflictWithSql(sql, conflictId);
  if (pendingCommands.length === 0) return false;

  let handled = false;
  for (const pending of pendingCommands) {
    const kind = classifyPendingAutomaticCommand(pending);
    if (kind === "other") {
      // A manual or unknown pending command is not polling-owned: it must
      // survive untouched so the human resolution path can still act on it.
      continue;
    }
    if (kind === "legacy-auto") {
      // Retired creation-time commands are never applied: their conflict had
      // no real same-field canonical advance, so it stays OPEN for a human.
      await markPendingResolutionCommandStaleWithSql(sql, fence, pending.command_id);
      handled = true;
      continue;
    }
    const command = systemWinsCommandFor(conflict);
    const obsolete = command.commandId !== pending.command_id ||
      command.expectedRevision !== pending.expected_revision;
    if (obsolete) {
      await markPendingResolutionCommandStaleWithSql(sql, fence, pending.command_id);
      handled = true;
      continue;
    }
    // The flush defers the NEEDS_REBASE audit effect while a processing or
    // delivery_uncertain predecessor owns the conflict stream; replan it
    // before the RESOLVED effect baseline is derived so the ordered audit
    // stream still materializes OPEN, NEEDS_REBASE, and RESOLVED.
    await ensureConflictRebaseAuditEffectWithSql(sql, fence, writer, mapping, conflict);
    const effects = await systemWinsResolutionEffects(sql, writer, mapping, conflict);
    if (effects === undefined) {
      // The conflict lost its CAS baseline (legacy evidence): the pending
      // command cannot proceed and must never guess confirmed evidence.
      await markPendingResolutionCommandStaleWithSql(sql, fence, pending.command_id);
      handled = true;
      continue;
    }
    await persistResolutionCommandWithSql(sql, fence, {
      logicalSheetId: mapping.logicalSheetId,
      command,
      commitId: systemWinsCommitId(conflict),
      effects,
    });
    handled = true;
  }
  return handled;
}

/**
 * Builds the User_Input reconcile and RESOLVED audit effects for one
 * system-wins command, or returns undefined when the conflict carries no
 * usable candidate evidence.
 *
 * The reconcile baseline is ALWAYS the candidate-time full-row visible
 * evidence stored on the conflict; confirmed projection evidence is never a
 * fallback, so a later human edit fails the visible-hash CAS instead of being
 * silently overwritten.
 */
async function systemWinsResolutionEffects(
  sql: SqlExecutor,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  conflict: SyncConflict,
): Promise<readonly NewEffect[] | undefined> {
  const evidence = availableCandidateVisibleEvidence(conflict.candidateVisibleEvidence);
  if (evidence === null) return undefined;
  const userProjection = requireTypedSheetsEntityProjection(mapping, SYNC_PROJECTIONS.USER_INPUT);
  const userSheet = await requireRegisteredSyncSheetWithSql(sql, userProjection.physicalSheetId);
  const conflictSheet = await requireRegisteredSyncSheetWithSql(
    sql,
    `${mapping.logicalSheetId}:sync_conflicts`,
  );
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

  const entity = await readMappedActiveCanonicalEntityWithSql(sql, conflict.entityId);
  const userTargetId = `projection-row:${userSheet.physicalSheetId}:${conflict.rowBindingId}`;
  const userStreamSequence = await nextTargetStreamSequenceWithSql(
    sql,
    mapping.logicalSheetId,
    PROJECTION_ROW_TARGET_KIND,
    userTargetId,
  );
  const commitId = systemWinsCommitId(conflict);
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
    expectedVisibleRevision: evidence.visibleRevision,
    expectedVisibleHash: evidence.visibleHash,
    expectedCandidateHash: applicableValue(candidateHash(conflict)),
    targetEntityRevision: entity === undefined
      ? notApplicableValue()
      : applicableValue(entity.entity_revision),
    streamSequence: userStreamSequence,
  });
  const resolvedConflict: SyncConflict = {
    ...conflict,
    status: CONFLICT_STATUSES.RESOLVED,
    resolutionCommandId: presentValue(systemWinsCommandId(conflict)),
  };
  const conflictBaseline = await nextConflictAuditBaselineWithSql(
    sql,
    mapping.logicalSheetId,
    conflict.conflictId,
  );
  const conflictEffect = createResolutionProjectionEffect({
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
    fields: resolvedSyncConflictAuditProjectionFields(resolvedConflict),
    createIfMissing: conflictBaseline.createIfMissing,
    expectedVisibleRevision: conflictBaseline.expectedVisibleRevision,
    expectedVisibleHash: conflictBaseline.expectedVisibleHash,
    streamSequence: conflictBaseline.streamSequence,
  });
  return [userEffect, conflictEffect];
}

/**
 * Appends an audit effect unless a processing or delivery_uncertain
 * predecessor still owns its target stream.
 *
 * The flush must never roll back the canonical advance because the OPEN
 * audit effect is still in flight: the append is deferred and the retry
 * pass replans the missing NEEDS_REBASE effect in stream order before the
 * RESOLVED effect once the predecessor settles. Any other append failure
 * is a real storage failure and still propagates.
 */
async function appendConflictAuditEffectOrDeferWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  effects: readonly NewEffect[],
): Promise<void> {
  try {
    await appendResolutionEffectsWithSql(sql, fence, effects);
  } catch (error: unknown) {
    if (
      error instanceof StorageError &&
      error.code === STORAGE_ERROR_CODES.EFFECT_REPLAN_CONFLICT
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Replans the deferred NEEDS_REBASE audit effect before a pending command
 * is retried.
 *
 * The flush hook defers this append while a processing/delivery_uncertain
 * predecessor owns the conflict stream; this pass replans it once the
 * stream head no longer reflects the conflict's current rebased state, so
 * the ordered audit stream still materializes OPEN, NEEDS_REBASE, and
 * RESOLVED after the predecessor settles. A still-in-flight predecessor
 * keeps the append deferred and the exact command pending for the next
 * pass. RESOLVED conflicts are never re-audited.
 */
async function ensureConflictRebaseAuditEffectWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  conflict: SyncConflict,
): Promise<void> {
  if (conflict.status === CONFLICT_STATUSES.RESOLVED) return;
  const latest = await readMappedLatestProjectionEffectWithSql(
    sql,
    mapping.logicalSheetId,
    CONFLICT_TARGET_KIND,
    conflict.conflictId,
  );
  const expectedFields = openSyncConflictAuditProjectionFields(conflict);
  if (latest !== undefined && latestConflictAuditEffectReflects(latest, expectedFields)) {
    return;
  }
  const conflictSheet = await requireRegisteredSyncSheetWithSql(
    sql,
    `${mapping.logicalSheetId}:sync_conflicts`,
  );
  const auditEffect = await conflictAuditEffectFor(
    sql,
    writer,
    mapping,
    conflictSheet,
    conflict,
  );
  await appendConflictAuditEffectOrDeferWithSql(sql, fence, [auditEffect]);
}

/**
 * Returns whether the newest conflict-stream effect already reflects the
 * conflict's current unresolved audit fields.
 *
 * The visible hash is the stable projection of the full audit row, so an
 * OPEN effect, a stale NEEDS_REBASE generation, or any other older row
 * state never satisfies the check.
 */
function latestConflictAuditEffectReflects(
  latest: MappedLatestProjectionEffectSqlRow,
  expectedFields: Readonly<Record<string, NormalizedCell>>,
): boolean {
  const payload = parseSyncProjectionEffectPayload(latest.payload_json);
  return payload.targetVisibleHash === computeSyncVisibleHash(expectedFields);
}

/** Builds the durable audit effect for one unresolved (OPEN/NEEDS_REBASE) conflict. */
async function conflictAuditEffectFor(
  sql: SqlExecutor,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  conflictSheet: Awaited<ReturnType<typeof requireRegisteredSyncSheetWithSql>>,
  conflict: SyncConflict,
): Promise<NewEffect> {
  const baseline = await nextConflictAuditBaselineWithSql(
    sql,
    mapping.logicalSheetId,
    conflict.conflictId,
  );
  return createResolutionProjectionEffect({
    effectId: identifiedValue("effect", writer),
    commitId: `open-conflict-audit:${conflict.conflictId}`,
    logicalSheetId: mapping.logicalSheetId,
    physicalSheetId: conflictSheet.physicalSheetId,
    sheetName: conflictSheet.tabName,
    registeredRange: conflictSheet.registeredRange,
    schemaVersion: mapping.schemaVersion,
    targetId: conflict.conflictId,
    rowBindingId: absentValue(),
    conflictId: presentValue(conflict.conflictId),
    targetAnchor: `conflict:${conflict.conflictId}`,
    fields: openSyncConflictAuditProjectionFields(conflict),
    createIfMissing: baseline.createIfMissing,
    expectedVisibleRevision: baseline.expectedVisibleRevision,
    expectedVisibleHash: baseline.expectedVisibleHash,
    streamSequence: baseline.streamSequence,
  });
}

/**
 * Derives the next effect baseline on one conflict audit stream.
 *
 * A fresh stream (no effect ever applied) starts with an empty visible
 * baseline so the first audit row is created by the provider. Successor
 * effects guard against the newest effect that actually reached the
 * provider: pending and superseded effects never materialize, so deriving
 * from the raw latest effect would guard against a row state that never
 * exists. The ordered stream still materializes OPEN, NEEDS_REBASE, and
 * RESOLVED rows in stream order with each successor superseding only the
 * still-pending head.
 */
async function nextConflictAuditBaselineWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  conflictId: string,
): Promise<{
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}> {
  const latest = await readMappedLatestProjectionEffectWithSql(
    sql,
    logicalSheetId,
    CONFLICT_TARGET_KIND,
    conflictId,
  );
  if (latest === undefined) return { ...EMPTY_CONFLICT_STREAM_BASELINE };
  const applied = await readMappedLatestAppliedProjectionEffectWithSql(
    sql,
    logicalSheetId,
    CONFLICT_TARGET_KIND,
    conflictId,
  );
  if (applied === undefined) {
    // Every pending head was superseded before it could materialize, so the
    // row is still absent; the replacement effect keeps the empty visible
    // baseline but must occupy the next stream position.
    return {
      ...EMPTY_CONFLICT_STREAM_BASELINE,
      streamSequence: latest.stream_sequence + 1,
    };
  }
  const payload = parseSyncProjectionEffectPayload(applied.payload_json);
  return {
    expectedVisibleRevision: applied.expected_visible_revision + 1,
    expectedVisibleHash: payload.targetVisibleHash,
    createIfMissing: false,
    streamSequence: latest.stream_sequence + 1,
  };
}

/** Reads the next ordered stream sequence for one effect target. */
async function nextTargetStreamSequenceWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): Promise<number> {
  const latest = await readMappedLatestProjectionEffectWithSql(
    sql,
    logicalSheetId,
    targetKind,
    targetId,
  );
  return latest === undefined ? 1 : latest.stream_sequence + 1;
}
