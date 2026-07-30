/** Updates the last observed row and field hashes after event creation. */

import { stableHash } from "../../../../domain/index.js";
import type { ObservedRowChange } from "../../../../domain/index.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import { rowHash } from "./observationAudit.js";
import type { PersistObservedRowInput } from "./observationTypes.js";
import {
  UPDATE_VISIBLE_FIELD_OBSERVED_HASH_SQL,
  UPDATE_VISIBLE_ROW_OBSERVED_HASH_SQL,
} from "./observationLedgerSql.js";
import { observedAfterRow } from "./observationLedgerRows.js";

/** Persists the observed hashes used by the next polling comparison. */
export async function persistObservedHashesWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
): Promise<void> {
  await sql.run(UPDATE_VISIBLE_ROW_OBSERVED_HASH_SQL, [
    rowHash(observedAfterRow(row), row.rowBindingId),
    input.physicalSheetId,
    input.batch.projection,
    row.rowBindingId,
  ]);
  for (const field of row.fields) {
    await sql.run(UPDATE_VISIBLE_FIELD_OBSERVED_HASH_SQL, [
      stableHash(field.nextValue),
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      field.fieldName,
    ]);
  }
}
