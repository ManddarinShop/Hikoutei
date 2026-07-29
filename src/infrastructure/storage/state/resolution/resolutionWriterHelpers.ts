/** Validation and fencing helpers shared by the resolution writer paths. */

import {
  JAVASCRIPT_TYPE_NAMES,
  NORMALIZED_CELL_KINDS,
} from "../../../../shared/encoding/constants.js";
import { isJavaScriptType } from "../../../../shared/encoding/typeGuards.js";
import { CONFLICT_STATUSES } from "../../../../domain/model/constants.js";
import { PRESENCE_KINDS } from "../../../../shared/state/constants.js";
import type {
  ConflictStatus,
  NormalizedCell,
  Presence,
} from "../../../../domain/index.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import {
  isFencingValidWithSql,
  type FencingContext,
} from "../../sync/shared/writerLease.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";

/** Parses and validates a normalized cell stored as serialized JSON. */
export function parseNormalizedCell(serialized: string, fieldName: string): NormalizedCell {
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
  if (
    cell.kind === NORMALIZED_CELL_KINDS.NUMBER &&
    isJavaScriptType(cell.value, JAVASCRIPT_TYPE_NAMES.NUMBER) &&
    Number.isFinite(cell.value)
  ) {
    return { kind: NORMALIZED_CELL_KINDS.NUMBER, value: cell.value };
  }
  if (
    cell.kind === NORMALIZED_CELL_KINDS.BOOLEAN &&
    isJavaScriptType(cell.value, JAVASCRIPT_TYPE_NAMES.BOOLEAN)
  ) {
    return { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: cell.value };
  }
  if (
    cell.kind === NORMALIZED_CELL_KINDS.DATE &&
    isJavaScriptType(cell.value, JAVASCRIPT_TYPE_NAMES.STRING) &&
    isCanonicalDate(cell.value)
  ) {
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

/** Converts a nullable SQL column into the explicit internal presence contract. */
export function fromSqlNullable<T>(value: T | null): Presence<T> {
  return value === null
    ? { kind: PRESENCE_KINDS.ABSENT }
    : { kind: PRESENCE_KINDS.PRESENT, value };
}

/** Requires the writer fence to remain current in the active async SQL transaction. */
export async function assertCurrentFenceWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) throw new FenceLostError();
}

/** Returns the common fence parameter tuple used by resolution SQL statements. */
export function fenceParameters(
  fence: FencingContext,
): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

/** Signals that a resolution transaction lost its writer ownership. */
export class FenceLostError extends StorageError {
  constructor() {
    super(STORAGE_ERROR_CODES.STALE_WRITER_FENCE, "writer fencing is stale or expired");
  }
}
