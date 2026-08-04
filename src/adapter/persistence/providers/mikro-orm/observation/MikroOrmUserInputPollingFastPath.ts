/**
 * Compares a values-only User_Input table against canonical SQLite state.
 *
 * This preflight deliberately does not accept or persist edits. It only decides
 * whether a table is unchanged or must be escalated to the metadata-preserving
 * snapshot path, so formula, merge, error, anchor, and quarantine semantics stay
 * in the existing full inspector.
 */

import {
  FIELD_OWNERSHIPS,
  type NormalizedCell,
} from "../../../../../domain/index.js";
import { stableHash } from "../../../../../shared/encoding/stableEncode.js";
import { NORMALIZED_CELL_KINDS } from "../../../../../shared/encoding/constants.js";
import { isCanonicalUtcIsoDate } from "../../../../../shared/validation.js";
import type {
  SyncTableRowsResult,
  SyncTableRow,
} from "../../../../../application/sync/gateway/syncGateway.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../../../../../application/sync/gateway/constants.js";
import {
  requireTypedSheetsEntityProjection,
  typedSheetsEntityProjectionHeaders,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
} from "../../../../../application/orm/mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../../../../application/orm/errors.js";
import type { MappedPollingState } from "./MikroOrmUserInputPollingState.js";

/** Result of one values-only table comparison. */
export interface FastPollingTableDecision {
  readonly needsFullMetadata: boolean;
  readonly rowsScanned: number;
  readonly changedRows: number;
}

/**
 * Validates and compares one values-only table without mutating local state.
 * Unknown, duplicate, missing, or type-invalid rows force full inspection so
 * the existing quarantine and conflict rules remain authoritative.
 */
export function inspectFastPollingTable(
  mapping: TypedSheetsEntityMapping,
  result: SyncTableRowsResult,
  state: MappedPollingState,
): FastPollingTableDecision {
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  const expectedHeaders = typedSheetsEntityProjectionHeaders(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  validateTableRoute(mapping, result, expectedHeaders, projection);

  const businessKey = mapping.businessKey;
  const byBusinessKey = state.businessKeysByLogicalAndField
    .get(mapping.logicalSheetId)
    ?.get(businessKey.fieldName) ?? new Map<string, string>();
  const identityCounts = countBusinessKeys(result.rows, businessKey);
  let needsFullMetadata = false;
  let changedRows = 0;
  const seenEntityIds = new Set<string>();

  for (const row of result.rows) {
    const identity = row.fields[businessKey.fieldName];
    if (!isValidFastCell(businessKey, identity)) {
      needsFullMetadata = true;
      continue;
    }
    const normalizedBusinessKey = stableHash(identity!);
    if (identityCounts.get(normalizedBusinessKey) !== 1) {
      needsFullMetadata = true;
      continue;
    }

    const entityId = byBusinessKey.get(normalizedBusinessKey);
    const canonical = entityId === undefined ? undefined : state.entitiesById.get(entityId);
    if (entityId === undefined || canonical === undefined || canonical.status !== "active") {
      needsFullMetadata = true;
      continue;
    }
    seenEntityIds.add(entityId);
    let rowChanged = false;

    for (const field of mapping.fields) {
      if (field.ownership !== FIELD_OWNERSHIPS.USER) continue;
      const observed = row.fields[field.fieldName];
      const expected = canonical.fields.get(field.fieldName);
      if (!isValidFastCell(field, observed) || expected === undefined) {
        needsFullMetadata = true;
        continue;
      }
      if (!sameCell(observed!, expected.value)) {
        rowChanged = true;
        needsFullMetadata = true;
      }
    }
    if (rowChanged) changedRows += 1;
  }

  for (const entityId of byBusinessKey.values()) {
    if (seenEntityIds.has(entityId)) continue;
    const canonical = state.entitiesById.get(entityId);
    if (canonical?.status === "active") needsFullMetadata = true;
  }

  return {
    needsFullMetadata,
    rowsScanned: result.rows.length,
    changedRows,
  };
}

function countBusinessKeys(
  rows: readonly SyncTableRow[],
  businessKey: TypedSheetsEntityFieldMapping,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const identity = row.fields[businessKey.fieldName];
    if (!isValidFastCell(businessKey, identity) || identity === null || identity === undefined) continue;
    const key = stableHash(identity);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function validateTableRoute(
  mapping: TypedSheetsEntityMapping,
  result: SyncTableRowsResult,
  expectedHeaders: readonly string[],
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
): void {
  if (
    result.sheetName !== projection.tabName ||
    result.registeredRange !== projection.registeredRange ||
    result.headers.length !== expectedHeaders.length ||
    result.headers.some((header, index) => header !== expectedHeaders[index])
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `User_Input values-only read does not match the registered route ${mapping.logicalSheetId}.`,
    );
  }
}

function isValidFastCell(
  field: TypedSheetsEntityFieldMapping,
  cell: NormalizedCell | undefined,
): boolean {
  if (cell === undefined) return false;
  if (cell === null) return !field.required;
  if (cell.kind !== field.cellKind) return false;
  switch (cell.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return !field.required || cell.value.length > 0;
    case NORMALIZED_CELL_KINDS.NUMBER:
      return Number.isFinite(cell.value);
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return true;
    case NORMALIZED_CELL_KINDS.DATE:
      return isCanonicalUtcIsoDate(cell.value);
  }
}

function sameCell(left: NormalizedCell, right: NormalizedCell): boolean {
  if (left === null || right === null) return left === right;
  return left.kind === right.kind && left.value === right.value;
}
