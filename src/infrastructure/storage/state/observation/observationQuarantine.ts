/** Quarantine persistence for invalid or unresolvable observed rows. */

import {
  stableHash,
  type ObservedRowChange,
  type Presence,
  type QuarantinePlan,
} from "../../../../domain/index.js";
import {
  QUARANTINE_ID_PREFIX,
  QUARANTINE_REPAIR_STATUSES,
  ROW_OUTCOMES,
} from "../../../../domain/evaluate/constants.js";
import { QUARANTINE_REASONS, ROW_OPERATIONS } from "../../../../domain/model/constants.js";
import type { DatabaseSyncLike } from "../../sqlite/sqliteBridge.js";
import { toSqlNullable } from "../../sqlite/sqlState.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
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

/** Persists a deterministic quarantine for incompatible receipt or event identity. */
export function persistIntegrityQuarantine(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  eventId: Presence<string>,
  discriminator: ObservationIntegrityDiscriminator,
): string {
  const quarantine = makeIntegrityQuarantine(input, row, discriminator);
  return persistQuarantine(db, input, quarantine, eventId);
}

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

/** Inserts a core-provided quarantine plan once and retains its raw evidence. */
export function persistQuarantine(
  db: DatabaseSyncLike,
  input: PersistObservedRowInput,
  quarantine: QuarantinePlan,
  eventId: Presence<string>,
): string {
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
  db.prepare(INSERT_QUARANTINE_RECORD_SQL).run(
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
  );
  return quarantine.quarantineId;
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
