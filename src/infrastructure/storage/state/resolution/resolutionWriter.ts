/**
 * Durable, fenced storage mapping for trusted conflict-resolution commands.
 *
 * The pure core decides whether an acknowledgement is resolved, stale, or
 * rejected. This module records that decision with the command receipt,
 * clears only the currently active candidate pointer, and queues any
 * resolution projection effect in one SQLite transaction.
 */

import {
  applyResolution,
  CONFLICT_TRANSITION_KINDS,
} from "../../../../domain/conflict/transitions.js";
import { PROJECTION_KINDS } from "../../../../domain/model/constants.js";
import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../../../shared/state/constants.js";
import type {
  ConflictStatus,
} from "../../../../domain/model/constants.js";
import type {
  ResolutionCommand,
  SyncConflict,
} from "../../../../domain/model/types.js";
import type { LookupResult } from "../../../../shared/state/types.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import {
  appendPendingEffectsWithSql,
  fenceParameters,
  isFencingValidWithSql,
  supersedeAndReplanWithSql,
  type FencingContext,
  type NewEffect,
} from "@hikoutei/ikisaki";
import { readMappedLatestProjectionEffectWithSql } from "../mapped/mappedPersistenceSql.js";
import { fromSqlNullable } from "../../sqlite/sqlState.js";
import { withSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import {
  promoteCandidateVisibleEvidence,
} from "../resolution/candidateEvidence.js";
import { auditJson } from "../observation/observationAudit.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  PERSIST_RESOLUTION_RESULT_KINDS,
  RESOLUTION_COMMAND_STATUSES,
} from "./resolutionWriterContracts.js";
import type {
  ActiveCandidatePointer,
  CommandRow,
  ConflictRow,
  EffectDedupeRow,
  PersistResolutionCommandInput,
  PersistResolutionCommandResult,
  RegisteredProjectionRow,
} from "./resolutionWriterContracts.js";
import {
  ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL,
  CLEAR_ACTIVE_CANDIDATE_POINTER_SQL,
  FIND_EXISTING_COMMAND_SQL,
  INSERT_PROCESSING_COMMAND_SQL,
  INSERT_PENDING_COMMAND_SQL,
  MARK_PENDING_COMMAND_PROCESSING_SQL,
  MARK_COMMAND_APPLIED_SQL,
  MARK_COMMAND_REJECTED_SQL,
  MARK_COMMAND_STALE_SQL,
  MARK_CONFLICT_RESOLVED_SQL,
  MARK_CONFLICT_STALE_SQL,
  MARK_PENDING_COMMAND_STALE_SQL,
  READ_ACTIVE_CANDIDATE_POINTER_SQL,
  READ_CONFLICT_SQL,
  READ_EFFECT_DEDUPE_SQL,
  READ_PENDING_COMMANDS_FOR_CONFLICT_SQL,
  READ_PENDING_CONFLICT_IDS_SQL,
  READ_PROCESSING_PREDECESSOR_SQL,
  READ_REGISTERED_PROJECTION_SQL,
  REBASE_ACTIVE_CONFLICT_SQL,
  SUPERSEDE_PENDING_USER_INPUT_REWRITES_SQL,
  STALE_SUPERSEDED_PENDING_COMMANDS_SQL,
} from "./resolutionWriterSql.js";
import {
  assertCurrentFenceWithSql,
  FenceLostError,
  parseNormalizedCell,
  requireConflictStatus,
} from "./resolutionWriterHelpers.js";

export {
  PERSIST_RESOLUTION_RESULT_KINDS,
  RESOLUTION_COMMAND_STATUSES,
} from "./resolutionWriterContracts.js";
export type {
  PersistResolutionCommandInput,
  PersistResolutionCommandResult,
} from "./resolutionWriterContracts.js";

/**
 * Persists one trusted resolution command through an already-active async SQL
 * transaction. A command receipt, its conflict transition, and any effects
 * remain atomic with an ORM-managed user-entity mutation.
 */
export async function persistResolutionCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): Promise<PersistResolutionCommandResult> {
  validateInput(input);
  if (!(await isFencingValidWithSql(sql, fence))) {
    return { kind: PERSIST_RESOLUTION_RESULT_KINDS.FENCED_OUT };
  }

  try {
    return await withSqlSavepoint(sql, "persist_resolution_command", async () => {
      await assertCurrentFenceWithSql(sql, fence);
      const duplicate = await findExistingCommandWithSql(sql, input.command);
      const pendingCommand = duplicate.kind === LOOKUP_RESULT_KINDS.FOUND &&
        duplicate.value.status === RESOLUTION_COMMAND_STATUSES.PENDING;
      if (duplicate.kind === LOOKUP_RESULT_KINDS.FOUND && !pendingCommand) {
        const duplicateResult = duplicate.value;
        // A durable processing receipt already owns the request. Only a terminal
        // replay may consume a still-checked control with a reset projection.
        if (duplicateResult.status !== RESOLUTION_COMMAND_STATUSES.PROCESSING) {
          await appendResolutionEffectsWithSql(sql, fence, input.duplicateEffects ?? []);
        }
        return duplicateResult;
      }

      const conflictResult = await readConflictWithSql(
        sql,
        input.logicalSheetId,
        input.command.targetConflictId,
      );
      if (conflictResult.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
        return {
          kind: PERSIST_RESOLUTION_RESULT_KINDS.REJECTED,
          commandId: input.command.commandId,
          reason: "target conflict does not exist in the logical sheet",
        };
      }
      const conflict = conflictResult.value;
      const processingPredecessor = await findProcessingPredecessorWithSql(
        sql,
        input.effects,
      );
      if (processingPredecessor !== undefined) {
        // Do not resolve the conflict while an older remote write is still in
        // flight. The late response could materialize after the system-wins
        // effect and overwrite the value that the resolution just selected.
        // Keep a pending command receipt so the next polling pass can retry the
        // exact CAS request after the predecessor has settled.
        await insertPendingCommandWithSql(sql, fence, input);
        return {
          kind: PERSIST_RESOLUTION_RESULT_KINDS.DEFERRED,
          commandId: input.command.commandId,
          conflictId: conflict.conflictId,
          reason: "processing_predecessor",
        };
      }

      if (pendingCommand) {
        await markPendingCommandProcessingWithSql(sql, fence, input.command.commandId, input.command.requestKey);
      } else {
        await insertProcessingCommandWithSql(sql, fence, input);
      }
      const pointerResult = await readActiveCandidatePointerWithSql(sql, conflict);
      const transition = pointerResult.kind === LOOKUP_RESULT_KINDS.FOUND &&
        pointerResult.value.candidate_epoch === input.command.expectedCandidateEpoch &&
        pointerResult.value.active_candidate_hash === input.command.activeCandidateHash
        ? applyResolution(conflict, input.command)
        : { kind: CONFLICT_TRANSITION_KINDS.STALE, conflict };

      if (transition.kind === CONFLICT_TRANSITION_KINDS.RESOLVED) {
        if (pointerResult.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
          throw new StorageError(
            STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
            "resolved command lost its active candidate pointer",
          );
        }
        await applyResolvedCommandWithSql(sql, fence, input, conflict, pointerResult.value);
        return {
          kind: PERSIST_RESOLUTION_RESULT_KINDS.APPLIED,
          commandId: input.command.commandId,
          conflictId: conflict.conflictId,
        };
      }
      if (transition.kind === CONFLICT_TRANSITION_KINDS.STALE) {
        await markStaleCommandWithSql(sql, fence, input, transition.conflict.status);
        return {
          kind: PERSIST_RESOLUTION_RESULT_KINDS.STALE,
          commandId: input.command.commandId,
          conflictId: conflict.conflictId,
        };
      }

      await markRejectedCommandWithSql(sql, fence, input);
      return {
        kind: PERSIST_RESOLUTION_RESULT_KINDS.REJECTED,
        commandId: input.command.commandId,
        reason: transition.error.code,
      };
    });
  } catch (error: unknown) {
    if (error instanceof FenceLostError) {
      return { kind: PERSIST_RESOLUTION_RESULT_KINDS.FENCED_OUT };
    }
    throw error;
  }
}

/** Persists one resolution command in an adapter-owned transaction. */
export async function persistResolutionCommandWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): Promise<PersistResolutionCommandResult> {
  return storage.transaction(({ sql }) => persistResolutionCommandWithSql(sql, fence, input));
}

function validateInput(input: PersistResolutionCommandInput): void {
  if (input.logicalSheetId.length === 0 || input.commitId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_RESOLUTION_COMMAND,
      "logical sheet ID and resolution commit ID are required",
    );
  }
  const command = input.command;
  if (
    command.commandId.length === 0 ||
    command.requestKey.length === 0 ||
    command.actorId.length === 0 ||
    command.targetConflictId.length === 0 ||
    command.activeCandidateHash.length === 0 ||
    command.payloadHash.length === 0 ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    !Number.isSafeInteger(command.expectedCandidateEpoch) ||
    command.expectedCandidateEpoch < 0
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_RESOLUTION_COMMAND,
      "resolution command has an invalid durable identity or CAS input",
    );
  }
  for (const effect of allResolutionEffects(input)) {
    const isConflictControlProjection =
      effect.projection === "sync_conflicts" &&
      effect.targetKind === "conflict" &&
      effect.conflictId.kind === PRESENCE_KINDS.PRESENT &&
      effect.conflictId.value === command.targetConflictId;
    if (effect.logicalSheetId !== input.logicalSheetId && !isConflictControlProjection) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_RESOLUTION_COMMAND,
        "resolution effect belongs to a different logical sheet",
      );
    }
  }
}

/** Finds a replayed resolution command through the active async SQL transaction. */
async function findExistingCommandWithSql(
  sql: SqlExecutor,
  command: ResolutionCommand,
): Promise<LookupResult<Extract<
  PersistResolutionCommandResult,
  { readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.DUPLICATE }
>>> {
  const rows = await sql.all<CommandRow>(FIND_EXISTING_COMMAND_SQL, [
    command.commandId,
    command.requestKey,
  ]);
  if (rows.length === 0) return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  if (rows.length !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_COMMAND_IDENTITY_CONFLICT,
      "resolution command identity is internally inconsistent",
    );
  }
  const existing = rows[0];
  if (existing === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      "resolution command lookup unexpectedly lost its row",
    );
  }
  if (!sameCommandIdentity(existing, command)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_COMMAND_IDENTITY_CONFLICT,
      "resolution command ID or request key was replayed with a different payload",
    );
  }
  return {
    kind: LOOKUP_RESULT_KINDS.FOUND,
    value: {
      kind: PERSIST_RESOLUTION_RESULT_KINDS.DUPLICATE,
      commandId: existing.command_id,
      status: existing.status,
    },
  };
}

function sameCommandIdentity(existing: CommandRow, command: ResolutionCommand): boolean {
  return existing.command_id === command.commandId &&
    existing.request_key === command.requestKey &&
    existing.action === command.action &&
    existing.actor_id === command.actorId &&
    existing.role === command.role &&
    existing.target_conflict_id === command.targetConflictId &&
    existing.expected_revision === command.expectedRevision &&
    existing.active_candidate_hash === command.activeCandidateHash &&
    existing.expected_candidate_epoch === command.expectedCandidateEpoch &&
    existing.payload_hash === command.payloadHash;
}

/** Reads conflict ids that carry a durable pending resolution command for one logical entity sheet. */
export function readPendingConflictIdsWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
): Promise<readonly string[]> {
  return sql.all<{ readonly conflict_id: string }>(READ_PENDING_CONFLICT_IDS_SQL, [
    logicalSheetId,
  ]).then((rows) => rows.map((row) => row.conflict_id));
}

/** Reads every durable pending command targeting one conflict. */
export function readPendingCommandsForConflictWithSql(
  sql: SqlExecutor,
  conflictId: string,
): Promise<readonly CommandRow[]> {
  return sql.all<CommandRow>(READ_PENDING_COMMANDS_FOR_CONFLICT_SQL, [conflictId]);
}

/**
 * Marks one durable pending command stale idempotently.
 *
 * Legacy automatic commands and obsolete revision generations are never
 * applied; staling is a no-op when the command already left the pending set.
 */
export async function markPendingResolutionCommandStaleWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  commandId: string,
): Promise<void> {
  await sql.run(MARK_PENDING_COMMAND_STALE_SQL, [
    commandId,
    ...fenceParameters(fence),
  ]);
}

/**
 * Stales every pending automatic command superseded by a newer resolution
 * identity.
 *
 * Only the newest planned automatic command for a conflict may remain pending;
 * older automatic generations are obsolete the moment a newer canonical
 * revision is planned. Manual or unknown pending commands are never consumed:
 * the SQL restricts supersession to the retired legacy
 * `sync:auto-system-wins` and current implicit `sync:system-wins` identities.
 */
export async function staleSupersededPendingCommandsWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  conflictId: string,
  keepCommandId: string,
): Promise<void> {
  await sql.run(STALE_SUPERSEDED_PENDING_COMMANDS_SQL, [
    conflictId,
    keepCommandId,
    ...fenceParameters(fence),
  ]);
}

/**
 * Rebases an unresolved conflict to the current canonical field state.
 *
 * The caller must have already verified the new revision strictly exceeds the
 * conflict's current canonical revision; the guarded UPDATE never downgrades
 * a resolved row.
 */
export async function rebaseActiveConflictWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: {
    readonly conflictId: string;
    readonly currentCanonicalValue: import("../../../../shared/encoding/types.js").NormalizedCell;
    readonly currentCanonicalRevision: number;
    readonly lastRebasedCommitId: string;
    readonly updatedAt: number;
  },
): Promise<void> {
  const result = await sql.run(REBASE_ACTIVE_CONFLICT_SQL, [
    auditJson(input.currentCanonicalValue),
    input.currentCanonicalRevision,
    input.lastRebasedCommitId,
    input.updatedAt,
    input.conflictId,
    ...fenceParameters(fence),
  ]);
  if (result.changes !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `conflict ${input.conflictId} could not be rebased to the current canonical state`,
    );
  }
}

/** Reads and validates one conflict record through the active async SQL transaction. */
export async function readConflictWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  conflictId: string,
): Promise<LookupResult<SyncConflict>> {
  const row = await sql.get<ConflictRow>(READ_CONFLICT_SQL, [logicalSheetId, conflictId]);
  if (row === undefined) return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  return {
    kind: LOOKUP_RESULT_KINDS.FOUND,
    value: {
      conflictId: row.conflict_id,
      conflictGroupId: fromSqlNullable(row.conflict_group_id),
      eventId: row.event_id,
      rowBindingId: row.row_binding_id,
      entityId: row.entity_id,
      fieldName: row.field_name,
      userValue: parseNormalizedCell(row.user_value, "user_value"),
      userBaseRevision: row.user_base_revision,
      canonicalValueAtDetection: parseNormalizedCell(
        row.canonical_value_at_detection,
        "canonical_value_at_detection",
      ),
      canonicalRevisionAtDetection: row.canonical_revision_at_detection,
      currentCanonicalValue: parseNormalizedCell(row.current_canonical_value, "current_canonical_value"),
      currentCanonicalRevision: row.current_canonical_revision,
      candidateEpoch: row.candidate_epoch,
      candidateVisibleEvidence: promoteCandidateVisibleEvidence(
        row.candidate_visible_revision,
        row.candidate_visible_hash,
        row.conflict_id,
      ),
      status: requireConflictStatus(row.status),
      resolutionCommandId: fromSqlNullable(row.resolution_command_id),
    },
  };
}

/** Reads the unique active candidate pointer through the active async SQL transaction. */
async function readActiveCandidatePointerWithSql(
  sql: SqlExecutor,
  conflict: SyncConflict,
): Promise<LookupResult<ActiveCandidatePointer>> {
  const rows = await sql.all<ActiveCandidatePointer>(READ_ACTIVE_CANDIDATE_POINTER_SQL, [
    conflict.rowBindingId,
    conflict.fieldName,
    conflict.conflictId,
  ]);
  if (rows.length === 0) return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  if (rows.length !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      "a conflict cannot be active in more than one physical projection",
    );
  }
  const pointer = rows[0];
  if (pointer === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      "active candidate lookup returned an empty result after reporting a row",
    );
  }
  return { kind: LOOKUP_RESULT_KINDS.FOUND, value: pointer };
}

/** Inserts a processing command receipt through the active async SQL transaction. */
async function insertProcessingCommandWithSql(
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

/** Stores a deferred command as durable pending work without changing conflict state. */
async function insertPendingCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): Promise<void> {
  const command = input.command;
  const result = await sql.run(INSERT_PENDING_COMMAND_SQL, [
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
    command.commandId,
    command.requestKey,
    ...fenceParameters(fence),
  ]);
  if (result.changes === 1) return;
  if (result.changes === 0 && await isFencingValidWithSql(sql, fence)) return;
  throw new FenceLostError();
}

/** Claims a pending deferred command after its processing predecessor settles. */
async function markPendingCommandProcessingWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  commandId: string,
  requestKey: string,
): Promise<void> {
  const result = await sql.run(MARK_PENDING_COMMAND_PROCESSING_SQL, [
    commandId,
    requestKey,
    ...fenceParameters(fence),
  ]);
  if (result.changes !== 1) throw new FenceLostError();
}

/** Applies a resolved transition, pointer clear, effects, and receipt through active async SQL. */
async function applyResolvedCommandWithSql(
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
  // A legacy anchor-keyed cleanup/repair rewrite enqueued before this
  // resolution streams under the physical anchor, so the append above could
  // not supersede it; new cleanup rewrites stream under the binding key and
  // are already covered by the replan above. The resolution's own reconcile
  // is authoritative for the row: supersede any such pending rewrite in the
  // same transaction, attributed to the reconcile, so the stale snapshot can
  // never deliver after the gate opens.
  const reconcileEffect = input.effects.find(
    (effect) => effect.projection === PROJECTION_KINDS.USER_INPUT,
  );
  if (reconcileEffect !== undefined) {
    await sql.run(SUPERSEDE_PENDING_USER_INPUT_REWRITES_SQL, [
      reconcileEffect.effectId,
      input.logicalSheetId,
      conflict.rowBindingId,
      reconcileEffect.effectId,
      ...fenceParameters(fence),
    ]);
  }
  const commandResult = await sql.run(MARK_COMMAND_APPLIED_SQL, [
    input.commitId,
    command.commandId,
    ...fenceParameters(fence),
  ]);
  if (commandResult.changes !== 1) throw new FenceLostError();
}

/** Marks a command stale and appends its stale branch effects through active async SQL. */
async function markStaleCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  nextConflictStatus: ConflictStatus,
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

/** Marks a command rejected and appends its rejection effects through active async SQL. */
async function markRejectedCommandWithSql(
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

/** Registers unseen resolution effects through the active async SQL transaction. */
export async function appendResolutionEffectsWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  effects: readonly NewEffect[],
): Promise<void> {
  if (effects.length === 0) return;
  await ensureResolutionEffectsRegisteredWithSql(sql, effects);
  for (const effect of effects) {
    const existing = await sql.get<EffectDedupeRow>(READ_EFFECT_DEDUPE_SQL, [
      effect.effectDedupeKey,
    ]);
    if (existing !== undefined) {
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
      continue;
    }

    const processingPredecessor = await findProcessingPredecessorWithSql(sql, [effect]);
    if (processingPredecessor !== undefined) {
      throw new StorageError(
        STORAGE_ERROR_CODES.EFFECT_REPLAN_CONFLICT,
        `effect ${effect.effectId} cannot replace processing predecessor ${processingPredecessor}`,
      );
    }

    const predecessor = await readMappedLatestProjectionEffectWithSql(
      sql,
      effect.logicalSheetId,
      effect.targetKind,
      effect.targetId,
    );
    if (
      predecessor !== undefined &&
      (predecessor.status === "pending" ||
        predecessor.status === "blocked_candidate" ||
        predecessor.status === "conflict" ||
        predecessor.status === "failed")
    ) {
      await supersedeAndReplanWithSql(sql, fence, predecessor.effect_id, effect);
      continue;
    }
    if (!(await appendPendingEffectsWithSql(sql, fence, [effect]))) {
      throw new FenceLostError();
    }
  }
}

/** Finds processing predecessors that must finish before a replacement is planned. */
async function findProcessingPredecessorWithSql(
  sql: SqlExecutor,
  effects: readonly NewEffect[],
): Promise<string | undefined> {
  for (const effect of effects) {
    const row = await sql.get<{ readonly effect_id: string }>(
      READ_PROCESSING_PREDECESSOR_SQL,
      [effect.logicalSheetId, effect.targetKind, effect.targetId, effect.streamSequence],
    );
    if (row !== undefined) return row.effect_id;
  }
  return undefined;
}

/** Validates every resolution effect target through the active async SQL transaction. */
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

/** Returns every branch effect so structural validation remains uniform. */
function allResolutionEffects(input: PersistResolutionCommandInput): readonly NewEffect[] {
  return [
    ...input.effects,
    ...(input.staleEffects ?? []),
    ...(input.rejectedEffects ?? []),
    ...(input.duplicateEffects ?? []),
  ];
}
