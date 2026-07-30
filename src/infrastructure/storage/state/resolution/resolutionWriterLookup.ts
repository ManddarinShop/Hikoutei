/** Reads and promotes durable resolution command state from SQLite. */

import { LOOKUP_RESULT_KINDS } from "../../../../shared/state/constants.js";
import type {
  LookupResult,
  ResolutionCommand,
  SyncConflict,
} from "../../../../domain/index.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import {
  fromSqlNullable,
  parseNormalizedCell,
  requireConflictStatus,
} from "./resolutionWriterHelpers.js";
import type {
  ActiveCandidatePointer,
  CommandRow,
  ConflictRow,
  PersistResolutionCommandResult,
} from "./resolutionWriterContracts.js";
import { PERSIST_RESOLUTION_RESULT_KINDS } from "./resolutionWriterContracts.js";
import {
  FIND_EXISTING_COMMAND_SQL,
  READ_ACTIVE_CANDIDATE_POINTER_SQL,
  READ_CONFLICT_SQL,
} from "./resolutionWriterSql.js";

/** Finds an existing command and verifies its durable identity on replay. */
export async function findExistingCommandWithSql(
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

/** Reads and validates one conflict record. */
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
      currentCanonicalValue: parseNormalizedCell(
        row.current_canonical_value,
        "current_canonical_value",
      ),
      currentCanonicalRevision: row.current_canonical_revision,
      candidateEpoch: row.candidate_epoch,
      status: requireConflictStatus(row.status),
      resolutionCommandId: fromSqlNullable(row.resolution_command_id),
    },
  };
}

/** Reads the unique active candidate pointer for a conflict. */
export async function readActiveCandidatePointerWithSql(
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
