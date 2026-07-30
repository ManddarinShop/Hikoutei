/** Converts observed row operation variants into SQL-audited snapshots. */

import { ROW_OPERATIONS } from "../../../../domain/model/constants.js";
import type { NormalizedRow, ObservedRowChange } from "../../../../domain/index.js";

/** Returns the before snapshot, using null only for insert rows. */
export function observedBeforeRow(row: ObservedRowChange): NormalizedRow | null {
  switch (row.operation) {
    case ROW_OPERATIONS.INSERT:
      return null;
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
    case ROW_OPERATIONS.DELETE:
      return row.beforeRow;
  }
}

/** Returns the after snapshot, using null only for delete rows. */
export function observedAfterRow(row: ObservedRowChange): NormalizedRow | null {
  switch (row.operation) {
    case ROW_OPERATIONS.INSERT:
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
      return row.afterRow;
    case ROW_OPERATIONS.DELETE:
      return null;
  }
}
