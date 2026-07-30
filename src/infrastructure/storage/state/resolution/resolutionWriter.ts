/**
 * Durable, fenced storage mapping for trusted conflict-resolution commands.
 *
 * The pure core decides whether an acknowledgement is resolved, stale, or
 * rejected. This module keeps that state-machine order visible and delegates
 * validation, reads, and SQL mutations to focused boundary modules.
 */

import { applyResolution } from "../../../../domain/index.js";
import { CONFLICT_TRANSITION_KINDS } from "../../../../domain/conflict/transitions.js";
import { LOOKUP_RESULT_KINDS } from "../../../../shared/state/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { withSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import {
  isFencingValidWithSql,
  type FencingContext,
} from "../../sync/shared/writerLease.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  PERSIST_RESOLUTION_RESULT_KINDS,
  RESOLUTION_COMMAND_STATUSES,
} from "./resolutionWriterContracts.js";
import type {
  PersistResolutionCommandInput,
  PersistResolutionCommandResult,
} from "./resolutionWriterContracts.js";
import {
  applyResolvedCommandWithSql,
  appendResolutionEffectsWithSql,
  insertProcessingCommandWithSql,
  markRejectedCommandWithSql,
  markStaleCommandWithSql,
} from "./resolutionWriterMutations.js";
import {
  findExistingCommandWithSql,
  readActiveCandidatePointerWithSql,
  readConflictWithSql,
} from "./resolutionWriterLookup.js";
import {
  assertCurrentFenceWithSql,
  FenceLostError,
} from "./resolutionWriterHelpers.js";
import { validateResolutionCommandInput } from "./resolutionWriterValidation.js";

export {
  PERSIST_RESOLUTION_RESULT_KINDS,
  RESOLUTION_COMMAND_STATUSES,
} from "./resolutionWriterContracts.js";
export type {
  PersistResolutionCommandInput,
  PersistResolutionCommandResult,
} from "./resolutionWriterContracts.js";

/** Persists one trusted resolution command through an active SQL transaction. */
export async function persistResolutionCommandWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistResolutionCommandInput,
): Promise<PersistResolutionCommandResult> {
  validateResolutionCommandInput(input);
  if (!(await isFencingValidWithSql(sql, fence))) {
    return { kind: PERSIST_RESOLUTION_RESULT_KINDS.FENCED_OUT };
  }

  try {
    return await withSqlSavepoint(sql, "persist_resolution_command", async () => {
      await assertCurrentFenceWithSql(sql, fence);
      const duplicate = await findExistingCommandWithSql(sql, input.command);
      if (duplicate.kind === LOOKUP_RESULT_KINDS.FOUND) {
        const duplicateResult = duplicate.value;
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
