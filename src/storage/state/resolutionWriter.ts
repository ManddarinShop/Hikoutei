/**
 * Durable, fenced storage mapping for trusted conflict-resolution commands.
 *
 * The pure core decides whether an acknowledgement is resolved, stale, or
 * rejected. This module records that decision with the command receipt,
 * clears only the currently active candidate pointer, and queues any
 * resolution projection effect in one SQLite transaction.
 */

import { applyResolution } from "../../core/index.js";
import { CONFLICT_TRANSITION_KINDS } from "../../core/conflict/transitions.js";
import {
  JAVASCRIPT_TYPE_NAMES,
  NORMALIZED_CELL_KINDS,
} from "../../core/encoding/constants.js";
import { isJavaScriptType } from "../../core/encoding/typeGuards.js";
import { CONFLICT_STATUSES } from "../../core/model/constants.js";
import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../core/state/constants.js";
import type {
  ConflictStatus,
  LookupResult,
  NormalizedCell,
  Presence,
  ResolutionCommand,
  SyncConflict,
} from "../../core/index.js";
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";
import {
  appendPendingEffects,
  appendPendingEffectsWithSql,
  type NewEffect,
} from "../sync/effectOutbox.js";
import { withImmediateTransaction, type DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { withSqlSavepoint } from "../sqlite/sqlTransaction.js";
import {
  isFencingValid,
  isFencingValidWithSql,
  type FencingContext,
} from "../sync/writerLease.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../adapter/orm/contracts.js";

const FENCE_EXISTS_SQL = `
  SELECT 1 FROM writer_lease
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?
`;

const FIND_EXISTING_COMMAND_SQL = `
  SELECT command_id, request_key, action, actor_id, role, target_conflict_id,
         expected_revision, active_candidate_hash, expected_candidate_epoch,
         payload_hash, status
  FROM resolution_command
  WHERE command_id = ? OR request_key = ?
`;

const READ_CONFLICT_SQL = `
  SELECT conflict_id, conflict_group_id, event_id, row_binding_id, entity_id, field_name,
         user_value, user_base_revision, canonical_value_at_detection,
         canonical_revision_at_detection, current_canonical_value,
         current_canonical_revision, candidate_epoch, status, resolution_command_id
  FROM sync_conflict
  WHERE logical_sheet_id = ? AND conflict_id = ?
`;

const READ_ACTIVE_CANDIDATE_POINTER_SQL = `
  SELECT physical_sheet_id, projection, candidate_epoch, active_candidate_hash
  FROM sheet_visible_field_state
  WHERE row_binding_id = ? AND field_name = ?
    AND active_candidate_conflict_id = ?
    AND active_candidate_hash IS NOT NULL
`;

const INSERT_PROCESSING_COMMAND_SQL = `
  INSERT INTO resolution_command (
    command_id, request_key, action, actor_id, role, target_conflict_id,
    expected_revision, active_candidate_hash, expected_candidate_epoch,
    payload_hash, status, issued_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

const MARK_CONFLICT_RESOLVED_SQL = `
  UPDATE sync_conflict
  SET status = 'RESOLVED', resolution_command_id = ?, updated_at = ?
  WHERE conflict_id = ? AND status IN ('OPEN', 'NEEDS_REBASE')
    AND current_canonical_revision = ? AND candidate_epoch = ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const CLEAR_ACTIVE_CANDIDATE_POINTER_SQL = `
  UPDATE sheet_visible_field_state
  SET active_candidate_conflict_id = NULL, active_candidate_hash = NULL,
      candidate_epoch = candidate_epoch + 1
  WHERE physical_sheet_id = ? AND projection = ?
    AND row_binding_id = ? AND field_name = ?
    AND active_candidate_conflict_id = ? AND candidate_epoch = ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL = `
  UPDATE row_binding
  SET candidate_epoch = CASE
    WHEN candidate_epoch <= ? THEN ?
    ELSE candidate_epoch
  END
  WHERE row_binding_id = ? AND logical_sheet_id = ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const MARK_COMMAND_APPLIED_SQL = `
  UPDATE resolution_command
  SET status = 'applied', applied_commit_id = ?
  WHERE command_id = ? AND status = 'processing'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const MARK_CONFLICT_STALE_SQL = `
  UPDATE sync_conflict
  SET status = ?, updated_at = ?
  WHERE conflict_id = ? AND status IN ('OPEN', 'NEEDS_REBASE')
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const MARK_COMMAND_STALE_SQL = `
  UPDATE resolution_command
  SET status = 'stale'
  WHERE command_id = ? AND status = 'processing'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const MARK_COMMAND_REJECTED_SQL = `
  UPDATE resolution_command
  SET status = 'rejected'
  WHERE command_id = ? AND status = 'processing'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const READ_EFFECT_DEDUPE_SQL = `
  SELECT effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, target_kind, target_id, payload_hash
  FROM sheet_effect_outbox
  WHERE effect_dedupe_key = ?
`;

const READ_REGISTERED_PROJECTION_SQL = `
  SELECT logical_sheet_id, projection, enabled
  FROM physical_sheet_registry
  WHERE physical_sheet_id = ?
`;

/** Runtime values for the durable resolution-command lifecycle. */
const RESOLUTION_COMMAND_STATUSES = {
  PROCESSING: "processing",
  APPLIED: "applied",
  STALE: "stale",
  REJECTED: "rejected",
  FAILED: "failed",
} as const;

/** Closed set of statuses stored for a resolution command. */
export type ResolutionCommandStatus =
  (typeof RESOLUTION_COMMAND_STATUSES)[keyof typeof RESOLUTION_COMMAND_STATUSES];

/** Runtime values for results returned by the resolution writer. */
const PERSIST_RESOLUTION_RESULT_KINDS = {
  FENCED_OUT: "fenced_out",
  APPLIED: "applied",
  STALE: "stale",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
} as const;

/** Closed set of resolution-writer result kinds. */
export type PersistResolutionCommandResultKind =
  (typeof PERSIST_RESOLUTION_RESULT_KINDS)[keyof typeof PERSIST_RESOLUTION_RESULT_KINDS];

/** Input required to durably process one trusted `acknowledge_system` request. */
export interface PersistResolutionCommandInput {
  readonly logicalSheetId: string;
  readonly command: ResolutionCommand;
  /** Durable transaction identity for effects created by this resolution. */
  readonly commitId: string;
  /** Effects to materialize after a successful acknowledge_system transition. */
  readonly effects: readonly NewEffect[];
  /**
   * Effects to materialize when the request is stale. This normally consumes a
   * checked control cell while projecting NEEDS_REBASE rather than retrying an
   * old acknowledgement forever.
   */
  readonly staleEffects?: readonly NewEffect[];
  /** Effects to materialize when a trusted request is rejected. */
  readonly rejectedEffects?: readonly NewEffect[];
  /**
   * Effects to materialize when a replay reaches an already terminal command.
   * This normally resets a still-checked one-shot control without reopening or
   * reapplying the canonical resolution.
   */
  readonly duplicateEffects?: readonly NewEffect[];
}

/** Terminal or replay-visible result of a resolution command transaction. */
export type PersistResolutionCommandResult =
  | { readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.FENCED_OUT }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.APPLIED;
      readonly commandId: string;
      readonly conflictId: string;
    }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.STALE;
      readonly commandId: string;
      readonly conflictId: string;
    }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.REJECTED;
      readonly commandId: string;
      readonly reason: string;
    }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.DUPLICATE;
      readonly commandId: string;
      readonly status: ResolutionCommandStatus;
    };

interface ConflictRow {
  readonly conflict_id: string;
  readonly conflict_group_id: string | null;
  readonly event_id: string;
  readonly row_binding_id: string;
  readonly entity_id: string;
  readonly field_name: string;
  readonly user_value: string;
  readonly user_base_revision: number;
  readonly canonical_value_at_detection: string;
  readonly canonical_revision_at_detection: number;
  readonly current_canonical_value: string;
  readonly current_canonical_revision: number;
  readonly candidate_epoch: number;
  readonly status: string;
  readonly resolution_command_id: string | null;
}

interface CommandRow {
  readonly command_id: string;
  readonly request_key: string;
  readonly action: string;
  readonly actor_id: string;
  readonly role: string;
  readonly target_conflict_id: string;
  readonly expected_revision: number;
  readonly active_candidate_hash: string;
  readonly expected_candidate_epoch: number;
  readonly payload_hash: string;
  readonly status: ResolutionCommandStatus;
}

interface ActiveCandidatePointer {
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly candidate_epoch: number;
  readonly active_candidate_hash: string;
}

interface EffectDedupeRow {
  readonly effect_kind: string;
  readonly commit_id: string;
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly payload_hash: string;
}

interface RegisteredProjectionRow {
  readonly logical_sheet_id: string;
  readonly projection: string;
  readonly enabled: number;
}

/**
 * Persists a resolution command at the writer-RPC boundary.
 *
 * An old command is stale unless the target conflict is still the active
 * candidate pointer for its field. That extra pointer check closes the
 * storage-level ABA gap that a historical conflict row alone cannot detect.
 */
export function persistResolutionCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): PersistResolutionCommandResult {
  validateInput(input);
  if (!isFencingValid(db, fence)) {
    return { kind: PERSIST_RESOLUTION_RESULT_KINDS.FENCED_OUT };
  }

  try {
    return withImmediateTransaction(db, () => {
      assertCurrentFence(db, fence);
      const duplicate = findExistingCommand(db, input.command);
      if (duplicate.kind === LOOKUP_RESULT_KINDS.FOUND) {
        const duplicateResult = duplicate.value;
        // A durable processing receipt already owns the request. Only a terminal
        // replay may consume a still-checked control with a reset projection.
        if (duplicateResult.status !== RESOLUTION_COMMAND_STATUSES.PROCESSING) {
          appendResolutionEffects(db, fence, input, input.duplicateEffects ?? []);
        }
        return duplicateResult;
      }

      const conflictResult = readConflict(db, input.logicalSheetId, input.command.targetConflictId);
      if (conflictResult.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
        return {
          kind: PERSIST_RESOLUTION_RESULT_KINDS.REJECTED,
          commandId: input.command.commandId,
          reason: "target conflict does not exist in the logical sheet",
        };
      }
      const conflict = conflictResult.value;

      insertProcessingCommand(db, fence, input);
      const pointerResult = readActiveCandidatePointer(db, conflict);
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
        applyResolvedCommand(db, fence, input, conflict, pointerResult.value);
        return {
          kind: PERSIST_RESOLUTION_RESULT_KINDS.APPLIED,
          commandId: input.command.commandId,
          conflictId: conflict.conflictId,
        };
      }
      if (transition.kind === CONFLICT_TRANSITION_KINDS.STALE) {
        markStaleCommand(db, fence, input, transition.conflict.status);
        return {
          kind: PERSIST_RESOLUTION_RESULT_KINDS.STALE,
          commandId: input.command.commandId,
          conflictId: conflict.conflictId,
        };
      }

      markRejectedCommand(db, fence, input);
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
      if (duplicate.kind === LOOKUP_RESULT_KINDS.FOUND) {
        const duplicateResult = duplicate.value;
        // A durable processing receipt already owns the request. Only a terminal
        // replay may consume a still-checked control with a reset projection.
        if (duplicateResult.status !== RESOLUTION_COMMAND_STATUSES.PROCESSING) {
          await appendResolutionEffectsWithSql(sql, fence, input, input.duplicateEffects ?? []);
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

      await insertProcessingCommandWithSql(sql, fence, input);
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

function findExistingCommand(
  db: DatabaseSyncLike,
  command: ResolutionCommand,
): LookupResult<Extract<
  PersistResolutionCommandResult,
  { readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.DUPLICATE }
>> {
  const rows = db.prepare(FIND_EXISTING_COMMAND_SQL)
    .all<CommandRow>(command.commandId, command.requestKey);
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

function readConflict(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  conflictId: string,
): LookupResult<SyncConflict> {
  const row = db.prepare(READ_CONFLICT_SQL)
    .get<ConflictRow>(logicalSheetId, conflictId);
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
      status: requireConflictStatus(row.status),
      resolutionCommandId: fromSqlNullable(row.resolution_command_id),
    },
  };
}

/** Reads and validates one conflict record through the active async SQL transaction. */
async function readConflictWithSql(
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
      status: requireConflictStatus(row.status),
      resolutionCommandId: fromSqlNullable(row.resolution_command_id),
    },
  };
}

function readActiveCandidatePointer(
  db: DatabaseSyncLike,
  conflict: SyncConflict,
): LookupResult<ActiveCandidatePointer> {
  const rows = db.prepare(READ_ACTIVE_CANDIDATE_POINTER_SQL)
    .all(conflict.rowBindingId, conflict.fieldName, conflict.conflictId) as ActiveCandidatePointer[];
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

function insertProcessingCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): void {
  const command = input.command;
  const result = db.prepare(INSERT_PROCESSING_COMMAND_SQL).run(
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
  );
  if (result.changes !== 1) throw new FenceLostError();
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

function applyResolvedCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  conflict: SyncConflict,
  pointer: ActiveCandidatePointer,
): void {
  const command = input.command;
  const conflictResult = db.prepare(MARK_CONFLICT_RESOLVED_SQL).run(
    command.commandId,
    fence.now,
    conflict.conflictId,
    command.expectedRevision,
    command.expectedCandidateEpoch,
    ...fenceParameters(fence),
  );
  if (conflictResult.changes !== 1) throw new FenceLostError();

  const clearedPointer = db.prepare(CLEAR_ACTIVE_CANDIDATE_POINTER_SQL).run(
    pointer.physical_sheet_id,
    pointer.projection,
    conflict.rowBindingId,
    conflict.fieldName,
    conflict.conflictId,
    command.expectedCandidateEpoch,
    ...fenceParameters(fence),
  );
  if (clearedPointer.changes !== 1) throw new FenceLostError();

  const binding = db.prepare(ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL).run(
    command.expectedCandidateEpoch,
    command.expectedCandidateEpoch + 1,
    conflict.rowBindingId,
    input.logicalSheetId,
    ...fenceParameters(fence),
  );
  if (binding.changes !== 1) throw new FenceLostError();

  appendResolutionEffects(db, fence, input, input.effects);
  const commandResult = db.prepare(MARK_COMMAND_APPLIED_SQL)
    .run(input.commitId, command.commandId, ...fenceParameters(fence));
  if (commandResult.changes !== 1) throw new FenceLostError();
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

  await appendResolutionEffectsWithSql(sql, fence, input, input.effects);
  const commandResult = await sql.run(MARK_COMMAND_APPLIED_SQL, [
    input.commitId,
    command.commandId,
    ...fenceParameters(fence),
  ]);
  if (commandResult.changes !== 1) throw new FenceLostError();
}

function markStaleCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  nextConflictStatus: ConflictStatus,
): void {
  db.prepare(MARK_CONFLICT_STALE_SQL).run(
    nextConflictStatus,
    fence.now,
    input.command.targetConflictId,
    ...fenceParameters(fence),
  );
  const command = db.prepare(MARK_COMMAND_STALE_SQL)
    .run(input.command.commandId, ...fenceParameters(fence));
  if (command.changes !== 1) throw new FenceLostError();
  appendResolutionEffects(db, fence, input, input.staleEffects ?? []);
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
  await appendResolutionEffectsWithSql(sql, fence, input, input.staleEffects ?? []);
}

function markRejectedCommand(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): void {
  const result = db.prepare(MARK_COMMAND_REJECTED_SQL)
    .run(input.command.commandId, ...fenceParameters(fence));
  if (result.changes !== 1) throw new FenceLostError();
  appendResolutionEffects(db, fence, input, input.rejectedEffects ?? []);
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
  await appendResolutionEffectsWithSql(sql, fence, input, input.rejectedEffects ?? []);
}

/** Registers a branch's projection effects in the same writer transaction as the command receipt. */
function appendResolutionEffects(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  effects: readonly NewEffect[],
): void {
  if (effects.length === 0) return;
  ensureResolutionEffectsRegistered(db, input, effects);
  const unseen = effects.filter((effect) => {
    const existing = db.prepare(READ_EFFECT_DEDUPE_SQL)
      .get<EffectDedupeRow>(effect.effectDedupeKey);
    if (existing === undefined) return true;
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
    return false;
  });
  if (unseen.length > 0 && !appendPendingEffects(db, fence, unseen)) throw new FenceLostError();
}

/** Registers unseen resolution effects through the active async SQL transaction. */
async function appendResolutionEffectsWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
  effects: readonly NewEffect[],
): Promise<void> {
  if (effects.length === 0) return;
  await ensureResolutionEffectsRegisteredWithSql(sql, input, effects);
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

/** Ensures no resolution branch can enqueue an effect for a foreign or disabled projection. */
function ensureResolutionEffectsRegistered(
  db: DatabaseSyncLike,
  input: PersistResolutionCommandInput,
  effects: readonly NewEffect[],
): void {
  for (const effect of effects) {
    const target = db.prepare(READ_REGISTERED_PROJECTION_SQL)
      .get<RegisteredProjectionRow>(effect.physicalSheetId);
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

/** Validates every resolution effect target through the active async SQL transaction. */
async function ensureResolutionEffectsRegisteredWithSql(
  sql: SqlExecutor,
  input: PersistResolutionCommandInput,
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

function parseNormalizedCell(serialized: string, fieldName: string): NormalizedCell {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_STORED_CONFLICT,
      `stored ${fieldName} is not valid JSON`,
    );
  }
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_STORED_CONFLICT,
      `stored ${fieldName} is not a normalized cell`,
    );
  }
  const cell = value as { readonly kind?: unknown; readonly value?: unknown };
  if (
    cell.kind === NORMALIZED_CELL_KINDS.STRING &&
    isJavaScriptType(cell.value, JAVASCRIPT_TYPE_NAMES.STRING)
  ) {
    return { kind: NORMALIZED_CELL_KINDS.STRING, value: cell.value };
  }
  if (cell.kind === NORMALIZED_CELL_KINDS.NUMBER &&
    isJavaScriptType(cell.value, JAVASCRIPT_TYPE_NAMES.NUMBER) && Number.isFinite(cell.value)) {
    return { kind: NORMALIZED_CELL_KINDS.NUMBER, value: cell.value };
  }
  if (
    cell.kind === NORMALIZED_CELL_KINDS.BOOLEAN &&
    isJavaScriptType(cell.value, JAVASCRIPT_TYPE_NAMES.BOOLEAN)
  ) {
    return { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: cell.value };
  }
  if (cell.kind === NORMALIZED_CELL_KINDS.DATE &&
    isJavaScriptType(cell.value, JAVASCRIPT_TYPE_NAMES.STRING) && isCanonicalDate(cell.value)) {
    return { kind: NORMALIZED_CELL_KINDS.DATE, value: cell.value };
  }
  throw new StorageError(
    STORAGE_ERROR_CODES.INVALID_STORED_CONFLICT,
    `stored ${fieldName} is not a normalized cell`,
  );
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function requireConflictStatus(value: string): ConflictStatus {
  if (
    value === CONFLICT_STATUSES.OPEN ||
    value === CONFLICT_STATUSES.NEEDS_REBASE ||
    value === CONFLICT_STATUSES.RESOLVED
  ) {
    return value;
  }
  throw new StorageError(
    STORAGE_ERROR_CODES.INVALID_STORED_CONFLICT,
    `stored conflict has invalid status ${value}`,
  );
}

/** Converts a nullable SQL column into the explicit internal presence contract. */
function fromSqlNullable<T>(value: T | null): Presence<T> {
  return value === null
    ? { kind: PRESENCE_KINDS.ABSENT }
    : { kind: PRESENCE_KINDS.PRESENT, value };
}

function assertCurrentFence(db: DatabaseSyncLike, fence: FencingContext): void {
  if (!isFencingValid(db, fence)) throw new FenceLostError();
}

/** Requires the writer fence to remain current in the active async SQL transaction. */
async function assertCurrentFenceWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) throw new FenceLostError();
}

function fenceParameters(fence: FencingContext): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

class FenceLostError extends StorageError {
  constructor() {
    super(STORAGE_ERROR_CODES.STALE_WRITER_FENCE, "writer fencing is stale or expired");
  }
}
