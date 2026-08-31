/** Validation and fencing helpers shared by the resolution writer paths. */

import { isNormalizedCell } from "@hikoutei/contracts/encoding/normalizedCell.js";
import { CONFLICT_STATUSES } from "@hikoutei/contracts/domain/model/constants.js";
import type {
  ConflictStatus,
} from "@hikoutei/contracts/domain/model/constants.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import {
  isFencingValidWithSql,
  type FencingContext,
} from "@hikoutei/ikisaki";
import type { SqlExecutor } from "@hikoutei/contracts/storage/sql.js";

/** Parses and validates a normalized cell stored as serialized JSON. */
export function parseNormalizedCell(serialized: string, fieldName: string): NormalizedCell {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_STORED_CONFLICT,
      `stored ${fieldName} is not valid JSON`,
    );
  }
  if (isNormalizedCell(value)) return value;
  throw new StorageError(
    STORAGE_ERROR_CODES.INVALID_STORED_CONFLICT,
    `stored ${fieldName} is not a normalized cell`,
  );
}

/** Promotes a stored status into the domain's closed conflict-status union. */
export function requireConflictStatus(value: string): ConflictStatus {
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

/** Requires the writer fence to remain current in the active async SQL transaction. */
export async function assertCurrentFenceWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) throw new ResolutionStaleFenceError();
}

/** Signals that a resolution transaction lost its writer ownership. */
export class ResolutionStaleFenceError extends StorageError {
  constructor() {
    super(STORAGE_ERROR_CODES.STALE_WRITER_FENCE, "writer fencing is stale or expired");
  }
}
