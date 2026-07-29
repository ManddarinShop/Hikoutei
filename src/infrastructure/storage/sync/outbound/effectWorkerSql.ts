/** SQL reads used to preserve active User_Input candidates during delivery. */

import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";

/** Parameters for the active-candidate guard query. */
export interface UserInputCandidateGuardQuery {
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly rowBindingId: string;
  readonly fieldNames: readonly string[];
  readonly openConflictStatus: string;
  readonly rebasedConflictStatus: string;
}

const USER_INPUT_CANDIDATE_BLOCK_SQL = `
  SELECT 1 AS blocked
  FROM sheet_visible_field_state AS visible
  LEFT JOIN sync_conflict AS conflict
    ON conflict.conflict_id = visible.active_candidate_conflict_id
  WHERE visible.physical_sheet_id = ?
    AND visible.projection = ?
    AND visible.row_binding_id = ?
    AND visible.field_name IN (__FIELD_NAMES__)
    AND visible.active_candidate_conflict_id IS NOT NULL
    AND visible.active_candidate_hash IS NOT NULL
    AND (conflict.conflict_id IS NULL OR conflict.status IN (?, ?))
  LIMIT 1
`;

/**
 * Checks whether an effect would overwrite an active User_Input candidate.
 * Field names become bound-value placeholders; no caller value is interpolated
 * into SQL text.
 */
export async function hasActiveUserInputCandidateWithSql(
  sql: SqlExecutor,
  query: UserInputCandidateGuardQuery,
): Promise<boolean> {
  if (query.fieldNames.length === 0) return true;
  const placeholders = query.fieldNames.map(() => "?").join(", ");
  const statement = USER_INPUT_CANDIDATE_BLOCK_SQL.replace(
    "__FIELD_NAMES__",
    placeholders,
  );
  const row = await sql.get<{ readonly blocked: number }>(statement, [
    query.physicalSheetId,
    query.projection,
    query.rowBindingId,
    ...query.fieldNames,
    query.openConflictStatus,
    query.rebasedConflictStatus,
  ]);
  return row !== undefined;
}
