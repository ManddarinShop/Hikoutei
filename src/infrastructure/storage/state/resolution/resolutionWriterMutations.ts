/** Applies resolution-command status, conflict, pointer, and effect transitions. */

import type { SyncConflict } from "../../../../domain/index.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import {
  appendPendingEffectsWithSql,
  type NewEffect,
} from "../../sync/outbound/effectOutbox.js";
import type { FencingContext } from "../../sync/shared/writerLease.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import {
  ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL,
  CLEAR_ACTIVE_CANDIDATE_POINTER_SQL,
  INSERT_PROCESSING_COMMAND_SQL,
  MARK_COMMAND_APPLIED_SQL,
  MARK_COMMAND_REJECTED_SQL,
  MARK_COMMAND_STALE_SQL,
  MARK_CONFLICT_RESOLVED_SQL,
  MARK_CONFLICT_STALE_SQL,
  READ_EFFECT_DEDUPE_SQL,
  READ_REGISTERED_PROJECTION_SQL,
} from "./resolutionWriterSql.js";
import { FenceLostError, fenceParameters } from "./resolutionWriterHelpers.js";
import type {
  ActiveCandidatePointer,
  EffectDedupeRow,
  PersistResolutionCommandInput,
  RegisteredProjectionRow,
} from "./resolutionWriterContracts.js";

/** Inserts a processing receipt while the current writer fence is valid. */
export async function insertProcessingCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): Promise<void> {
  const command = input.command;
  const result = await sql.run(INSERT_PROCESSING_COMMAND_SQL, [
    command.commandId,
    command.requestKey,
    command.action,
    command.actorId,
    command.role,
    command.targetConflictId,
    command.expectedRevision,
    command.activeCandidateHash,
    command.expectedCandidateEpoch,
    command.payloadHash,
    fence.now,
    ...fenceParameters(fence),
  ]);
  if (result.changes !== 1) throw new FenceLostError();
}

/** Applies a resolved transition, clears its pointer, and queues effects. */
export async function applyResolvedCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  conflict: SyncConflict,
  pointer: ActiveCandidatePointer,
): Promise<void> {
  const command = input.command;
  const conflictResult = await sql.run(MARK_CONFLICT_RESOLVED_SQL, [
    command.commandId,
    fence.now,
    conflict.conflictId,
    command.expectedRevision,
    command.expectedCandidateEpoch,
    ...fenceParameters(fence),
  ]);
  if (conflictResult.changes !== 1) throw new FenceLostError();

  const clearedPointer = await sql.run(CLEAR_ACTIVE_CANDIDATE_POINTER_SQL, [
    pointer.physical_sheet_id,
    pointer.projection,
    conflict.rowBindingId,
    conflict.fieldName,
    conflict.conflictId,
    command.expectedCandidateEpoch,
    ...fenceParameters(fence),
  ]);
  if (clearedPointer.changes !== 1) throw new FenceLostError();

  const binding = await sql.run(ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL, [
    command.expectedCandidateEpoch,
    command.expectedCandidateEpoch + 1,
    conflict.rowBindingId,
    input.logicalSheetId,
    ...fenceParameters(fence),
  ]);
  if (binding.changes !== 1) throw new FenceLostError();

  await appendResolutionEffectsWithSql(sql, fence, input.effects);
  const commandResult = await sql.run(MARK_COMMAND_APPLIED_SQL, [
    input.commitId,
    command.commandId,
    ...fenceParameters(fence),
  ]);
  if (commandResult.changes !== 1) throw new FenceLostError();
}

/** Marks a command stale and queues the stale branch effects. */
export async function markStaleCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  nextConflictStatus: string,
): Promise<void> {
  await sql.run(MARK_CONFLICT_STALE_SQL, [
    nextConflictStatus,
    fence.now,
    input.command.targetConflictId,
    ...fenceParameters(fence),
  ]);
  const command = await sql.run(MARK_COMMAND_STALE_SQL, [
    input.command.commandId,
    ...fenceParameters(fence),
  ]);
  if (command.changes !== 1) throw new FenceLostError();
  await appendResolutionEffectsWithSql(sql, fence, input.staleEffects ?? []);
}

/** Marks a command rejected and queues the rejection effects. */
export async function markRejectedCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): Promise<void> {
  const result = await sql.run(MARK_COMMAND_REJECTED_SQL, [
    input.command.commandId,
    ...fenceParameters(fence),
  ]);
  if (result.changes !== 1) throw new FenceLostError();
  await appendResolutionEffectsWithSql(sql, fence, input.rejectedEffects ?? []);
}

/** Registers and appends unseen resolution effects with dedupe validation. */
export async function appendResolutionEffectsWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  effects: readonly NewEffect[],
): Promise<void> {
  if (effects.length === 0) return;
  await ensureResolutionEffectsRegisteredWithSql(sql, effects);
  const unseen: NewEffect[] = [];
  for (const effect of effects) {
    const existing = await sql.get<EffectDedupeRow>(READ_EFFECT_DEDUPE_SQL, [
      effect.effectDedupeKey,
    ]);
    if (existing === undefined) {
      unseen.push(effect);
      continue;
    }
    if (
      existing.effect_kind !== effect.effectKind ||
      existing.commit_id !== effect.commitId ||
      existing.logical_sheet_id !== effect.logicalSheetId ||
      existing.physical_sheet_id !== effect.physicalSheetId ||
      existing.projection !== effect.projection ||
      existing.target_kind !== effect.targetKind ||
      existing.target_id !== effect.targetId ||
      existing.payload_hash !== effect.payloadHash
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.RESOLUTION_EFFECT_CONFLICT,
        "resolution effect dedupe key was reused with a different payload",
      );
    }
  }
  if (unseen.length > 0 && !(await appendPendingEffectsWithSql(sql, fence, unseen))) {
    throw new FenceLostError();
  }
}

/** Validates every resolution effect target against the registry. */
async function ensureResolutionEffectsRegisteredWithSql(
  sql: SqlExecutor,
  effects: readonly NewEffect[],
): Promise<void> {
  for (const effect of effects) {
    const target = await sql.get<RegisteredProjectionRow>(READ_REGISTERED_PROJECTION_SQL, [
      effect.physicalSheetId,
    ]);
    if (
      target === undefined ||
      target.logical_sheet_id !== effect.logicalSheetId ||
      target.projection !== effect.projection ||
      target.enabled !== 1
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.RESOLUTION_TARGET_UNAVAILABLE,
        "resolution effect targets an unregistered physical projection",
      );
    }
  }
}
