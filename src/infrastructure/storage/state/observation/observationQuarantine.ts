/** Quarantine persistence for invalid or unresolvable observed rows. */

import {
  stableHash,
  type ObservedRowChange,
  type Presence,
  type QuarantinePlan,
  type QuarantineReason,
} from "../../../../domain/index.js";
import {
  QUARANTINE_ID_PREFIX,
  QUARANTINE_REPAIR_STATUSES,
  ROW_OUTCOMES,
} from "../../../../domain/evaluate/constants.js";
import { QUARANTINE_REASONS, ROW_OPERATIONS } from "../../../../domain/model/constants.js";
import { toSqlNullable } from "../../sqlite/sqlState.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import {
  FENCE_EXISTS_SQL,
  fenceParameters,
  isFencingValidWithSql,
  type FencingContext,
} from "@hikoutei/ikisaki";
import { auditJson } from "./observationAudit.js";
import type { ObservationIntegrityDiscriminator } from "./observationConstants.js";
import type { PersistObservedRowInput } from "./observationTypes.js";

const INSERT_QUARANTINE_RECORD_SQL = `
  INSERT INTO quarantine_record (
    quarantine_id, event_id, observation_id, logical_sheet_id, row_binding_id,
    reason, before_row_json, after_row_json, fields_json, repair_fields_json,
    repair_state, candidate_payload_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(quarantine_id) DO NOTHING
`;

const INSERT_POLLING_QUARANTINE_RECORD_SQL = `
  INSERT INTO quarantine_record (
    quarantine_id, event_id, observation_id, logical_sheet_id, row_binding_id,
    reason, before_row_json, after_row_json, fields_json, repair_fields_json,
    repair_state, candidate_payload_json, created_at, updated_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (${FENCE_EXISTS_SQL})
  ON CONFLICT(quarantine_id) DO NOTHING
`;

export const POLLING_QUARANTINE_WRITE_RESULT_KINDS = {
  INSERTED: "inserted",
  DUPLICATE: "duplicate",
  FENCED_OUT: "fenced_out",
} as const;

export type PollingQuarantineWriteResult =
  | { readonly kind: typeof POLLING_QUARANTINE_WRITE_RESULT_KINDS.INSERTED; readonly quarantineId: string }
  | { readonly kind: typeof POLLING_QUARANTINE_WRITE_RESULT_KINDS.DUPLICATE; readonly quarantineId: string }
  | { readonly kind: typeof POLLING_QUARANTINE_WRITE_RESULT_KINDS.FENCED_OUT };

/** Persists an integrity quarantine through the active async SQL transaction. */
export async function persistIntegrityQuarantineWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  eventId: Presence<string>,
  discriminator: ObservationIntegrityDiscriminator,
): Promise<string> {
  const quarantine = makeIntegrityQuarantine(input, row, discriminator);
  return persistQuarantineWithSql(sql, input, quarantine, eventId);
}

/** Inserts a core-provided quarantine plan through the active async SQL transaction. */
export async function persistQuarantineWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  quarantine: QuarantinePlan,
  eventId: Presence<string>,
): Promise<string> {
  const beforeRow = quarantine.operation === ROW_OPERATIONS.INSERT
    ? null
    : quarantine.beforeRow;
  const afterRow = quarantine.operation === ROW_OPERATIONS.DELETE
    ? null
    : quarantine.afterRow;
  const repairState = input.evaluation.outcome === ROW_OUTCOMES.QUARANTINE &&
      input.evaluation.repair.status === QUARANTINE_REPAIR_STATUSES.PLANNED
    ? "pending"
    : null;
  await sql.run(INSERT_QUARANTINE_RECORD_SQL, [
    quarantine.quarantineId,
    toSqlNullable(eventId),
    input.observation.observationId,
    input.batch.sheetId,
    quarantine.rowBindingId,
    quarantine.reason,
    auditJson(beforeRow),
    auditJson(afterRow),
    auditJson(quarantine.fields),
    auditJson(quarantine.repairFields),
    repairState,
    input.observation.payloadJson,
    input.observation.receivedAt,
    input.observation.receivedAt,
  ]);
  return quarantine.quarantineId;
}

/** Raw invalid polling evidence that cannot enter the evaluator. */
export interface PollingQuarantineInput {
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly rowBindingId: string;
  /** Row-local evidence used for idempotent invalid-row deduplication. */
  readonly rowEvidenceHash: string;
  readonly reason: QuarantineReason;
  readonly beforeRowJson: string | null;
  readonly afterRowJson: string | null;
  readonly fieldsJson: string;
  readonly payloadJson: string;
  readonly detectedAt: number;
}

/**
 * Persists invalid polling evidence without pretending that it was an entity
 * event. This path is fenced like normal observation writes but has no event
 * identity or canonical mutation because the row never passed normalization.
 */
export async function persistPollingQuarantineWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PollingQuarantineInput,
): Promise<PollingQuarantineWriteResult> {
  if (!(await isFencingValidWithSql(sql, fence))) {
    return { kind: POLLING_QUARANTINE_WRITE_RESULT_KINDS.FENCED_OUT };
  }
  const quarantineId = `${QUARANTINE_ID_PREFIX}${stableHash({
    logicalSheetId: input.logicalSheetId,
    physicalSheetId: input.physicalSheetId,
    rowBindingId: input.rowBindingId,
    rowEvidenceHash: input.rowEvidenceHash,
    reason: input.reason,
  })}`;
  const result = await sql.run(INSERT_POLLING_QUARANTINE_RECORD_SQL, [
    quarantineId,
    null,
    null,
    input.logicalSheetId,
    input.rowBindingId,
    input.reason,
    input.beforeRowJson,
    input.afterRowJson,
    input.fieldsJson,
    "[]",
    null,
    input.payloadJson,
    input.detectedAt,
    input.detectedAt,
    ...fenceParameters(fence),
  ]);
  if (result.changes === 1) {
    return { kind: POLLING_QUARANTINE_WRITE_RESULT_KINDS.INSERTED, quarantineId };
  }
  return (await isFencingValidWithSql(sql, fence))
    ? { kind: POLLING_QUARANTINE_WRITE_RESULT_KINDS.DUPLICATE, quarantineId }
    : { kind: POLLING_QUARANTINE_WRITE_RESULT_KINDS.FENCED_OUT };
}

/** Builds an operation-specific quarantine plan for an identity collision. */
function makeIntegrityQuarantine(
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  discriminator: ObservationIntegrityDiscriminator,
): QuarantinePlan {
  const common = {
    quarantineId: `${QUARANTINE_ID_PREFIX}${stableHash({
      logicalSheetId: input.batch.sheetId,
      observationKey: input.observation.observationKey,
      representative: discriminator,
      payloadHash: input.observation.payloadHash,
      rowBindingId: row.rowBindingId,
    })}`,
    reason: QUARANTINE_REASONS.INVALID_EVENT,
    rowBindingId: row.rowBindingId,
    fields: row.fields,
    repairFields: [],
  };

  switch (row.operation) {
    case ROW_OPERATIONS.INSERT:
      return { ...common, operation: row.operation, afterRow: row.afterRow };
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
      return {
        ...common,
        operation: row.operation,
        beforeRow: row.beforeRow,
        afterRow: row.afterRow,
      };
    case ROW_OPERATIONS.DELETE:
      return { ...common, operation: row.operation, beforeRow: row.beforeRow };
  }
}
