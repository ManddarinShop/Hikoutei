/** Validates observed User_Input rows and prepares accepted entity changes. */

import {
  FIELD_OWNERSHIPS,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
} from "../../../../../domain/model/constants.js";
import type {
  NormalizedRowField,
  ObservedExistingRowChange,
} from "../../../../../domain/model/types.js";
import { stableHash } from "../../../../../shared/encoding/stableEncode.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../../../../../shared/state/constants.js";
import type {
  SyncSheetsSnapshot,
  SyncObservedSnapshot,
  SyncSnapshotCell,
  SyncSnapshotRow,
} from "../../../../../application/sync/sheetsContract/syncSheets.js";
import {
  SYNC_PROJECTIONS,
  SYNC_PROTOCOL_VERSIONS,
} from "../../../../../application/sync/sheetsContract/constants.js";
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
import { isCanonicalUtcIsoDate } from "../../../../../shared/validation.js";
import {
  type EntityStateRecord,
  type MappedPollingState,
  type RowBindingStateRecord,
  type VisibleProjectionState,
} from "./MikroOrmUserInputPollingState.js";
import {
  CELL_OBSERVATION_KINDS,
  NORMALIZED_CELL_KINDS,
} from "../../../../../shared/encoding/constants.js";

/** Stable reasons for a User_Input row that cannot enter the evaluator. */
export const MAPPED_USER_INPUT_INVALID_REASONS = {
  UNKNOWN_BUSINESS_KEY: "unknown_business_key",
  DUPLICATE_BUSINESS_KEY: "duplicate_business_key",
  NON_LITERAL_CELL: "non_literal_cell",
  FORMULA_CELL: "formula_cell",
  MERGED_CELL: "merged_cell",
  ERROR_CELL: "error_cell",
  MISSING_CELL: "missing_cell",
  INVALID_CELL: "invalid_cell",
  MISSING_CANONICAL_STATE: "missing_canonical_state",
  MISSING_VISIBLE_STATE: "missing_visible_state",
  PRIMARY_KEY_MUTATION: "primary_key_mutation",
} as const;

export type MappedUserInputInvalidReason =
  (typeof MAPPED_USER_INPUT_INVALID_REASONS)[keyof typeof MAPPED_USER_INPUT_INVALID_REASONS];

export interface PreparedRow {
  readonly mapping: TypedSheetsEntityMapping;
  readonly snapshot: SyncSheetsSnapshot;
  readonly snapshotHash: string;
  readonly snapshotRow: SyncSnapshotRow;
  readonly binding: RowBindingStateRecord;
  readonly canonical: EntityStateRecord;
  readonly row: ObservedExistingRowChange;
}

export interface InvalidRow {
  readonly mapping: TypedSheetsEntityMapping;
  readonly snapshot: SyncSheetsSnapshot;
  readonly snapshotRow: SyncSnapshotRow;
  readonly rowNumber: number;
  readonly reason: MappedUserInputInvalidReason;
}

export interface SheetAccumulator {
  readonly mapping: TypedSheetsEntityMapping;
  rowsScanned: number;
  changedRows: number;
  appliedRows: number;
  conflictRows: number;
  quarantinedRows: number;
  duplicateRows: number;
  staleRows: number;
  fencedRows: number;
  invalidRows: number;
  unknownBusinessKeyRows: number;
  duplicateBusinessKeyRows: number;
}

interface SnapshotRowInspectionContext {
  readonly mapping: TypedSheetsEntityMapping;
  readonly snapshot: SyncSheetsSnapshot;
  readonly snapshotHash: string;
  readonly businessKeyField: TypedSheetsEntityFieldMapping;
  readonly duplicateBusinessKeys: ReadonlySet<string>;
  readonly byBusinessKey: ReadonlyMap<string, string>;
  readonly byEntityId: ReadonlyMap<string, RowBindingStateRecord>;
  readonly entitiesById: ReadonlyMap<string, EntityStateRecord>;
  readonly visibleByBinding: ReadonlyMap<string, VisibleProjectionState>;
}

/** Inspects one projection snapshot and appends changed rows to the batch. */
export function inspectSnapshot(
  mapping: TypedSheetsEntityMapping,
  observed: SyncObservedSnapshot,
  state: MappedPollingState,
  accumulator: SheetAccumulator,
  preparedRows: PreparedRow[],
): readonly InvalidRow[] {
  const snapshot = observed.snapshot;
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_PROJECTIONS.USER_INPUT,
  );
  const expectedHeaders = typedSheetsEntityProjectionHeaders(
    mapping,
    SYNC_PROJECTIONS.USER_INPUT,
  );
  validateSnapshotRoute(mapping, snapshot, expectedHeaders, projection);
  const observedSnapshotHash = snapshotHash(snapshot);
  const businessKeyField = mapping.businessKey;
  const duplicateBusinessKeys = duplicateBusinessKeysForSnapshot(snapshot, businessKeyField);
  const byBusinessKey = state.businessKeysByLogicalAndField
    .get(mapping.logicalSheetId)
    ?.get(businessKeyField.fieldName) ?? new Map();
  const byEntityId = state.bindingsByEntityId.get(mapping.logicalSheetId) ?? new Map();
  const visibleByBinding = state.visibleRevisionsByPhysicalAndBinding.get(projection.physicalSheetId)
    ?? new Map();
  const context: SnapshotRowInspectionContext = {
    mapping,
    snapshot,
    snapshotHash: observedSnapshotHash,
    businessKeyField,
    duplicateBusinessKeys,
    byBusinessKey,
    byEntityId,
    entitiesById: state.entitiesById,
    visibleByBinding,
  };
  const invalidRows: InvalidRow[] = [];

  for (const snapshotRow of snapshot.rows) {
    accumulator.rowsScanned += 1;
    const result = inspectSnapshotRow(context, snapshotRow);
    if (result.kind === "invalid") {
      countInvalidRow(accumulator, result.invalid.reason);
      invalidRows.push(result.invalid);
      continue;
    }
    if (result.kind === "unchanged") continue;
    accumulator.changedRows += 1;
    preparedRows.push(result.prepared);
  }
  return invalidRows;
}

type SnapshotRowInspectionResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly invalid: InvalidRow }
  | { readonly kind: "changed"; readonly prepared: PreparedRow };

function inspectSnapshotRow(
  context: SnapshotRowInspectionContext,
  snapshotRow: SyncSnapshotRow,
): SnapshotRowInspectionResult {
  const invalid = (reason: MappedUserInputInvalidReason): SnapshotRowInspectionResult => ({
    kind: "invalid",
    invalid: {
      mapping: context.mapping,
      snapshot: context.snapshot,
      snapshotRow,
      rowNumber: snapshotRow.rowNumber,
      reason,
    },
  });
  const identityCell = snapshotRow.cells[context.businessKeyField.fieldName];
  const identityValidation = validateSnapshotCell(context.businessKeyField, identityCell);
  if (identityValidation !== undefined) return invalid(identityValidation);
  const identity = identityCell?.normalizedCell;
  if (identity === null || identity === undefined) {
    return invalid(MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL);
  }
  const normalizedBusinessKey = stableHash(identity);
  if (context.duplicateBusinessKeys.has(normalizedBusinessKey)) {
    return invalid(MAPPED_USER_INPUT_INVALID_REASONS.DUPLICATE_BUSINESS_KEY);
  }
  const entityId = context.byBusinessKey.get(normalizedBusinessKey);
  if (entityId === undefined) {
    return invalid(MAPPED_USER_INPUT_INVALID_REASONS.UNKNOWN_BUSINESS_KEY);
  }
  const binding = context.byEntityId.get(entityId);
  if (binding === undefined || binding.entityId === null) {
    return invalid(MAPPED_USER_INPUT_INVALID_REASONS.UNKNOWN_BUSINESS_KEY);
  }
  const canonical = context.entitiesById.get(binding.entityId);
  if (
    binding.state !== ROW_BINDING_STATES.ACTIVE ||
    canonical === undefined ||
    canonical.status !== "active"
  ) {
    return invalid(MAPPED_USER_INPUT_INVALID_REASONS.MISSING_CANONICAL_STATE);
  }
  const row = normalizeExistingRow(
    context.mapping,
    snapshotRow,
    binding,
    canonical,
    context.visibleByBinding.get(binding.rowBindingId),
  );
  if (row.kind === "invalid") return invalid(row.reason);
  if (row.kind === "unchanged") return row;
  return {
    kind: "changed",
    prepared: {
      mapping: context.mapping,
      snapshot: context.snapshot,
      snapshotHash: context.snapshotHash,
      snapshotRow,
      binding,
      canonical,
      row: row.row,
    },
  };
}

function countInvalidRow(
  accumulator: SheetAccumulator,
  reason: MappedUserInputInvalidReason,
): void {
  if (reason === MAPPED_USER_INPUT_INVALID_REASONS.DUPLICATE_BUSINESS_KEY) {
    accumulator.duplicateBusinessKeyRows += 1;
  }
  if (reason === MAPPED_USER_INPUT_INVALID_REASONS.UNKNOWN_BUSINESS_KEY) {
    accumulator.unknownBusinessKeyRows += 1;
  }
}

type NormalizedRowResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly reason: MappedUserInputInvalidReason }
  | { readonly kind: "changed"; readonly row: ObservedExistingRowChange };

function normalizeExistingRow(
  mapping: TypedSheetsEntityMapping,
  snapshotRow: SyncSnapshotRow,
  binding: RowBindingStateRecord,
  canonical: EntityStateRecord,
  visibleState: VisibleProjectionState | undefined,
): NormalizedRowResult {
  const beforeFields = new Map<string, NormalizedRowField>();
  const afterFields = new Map<string, NormalizedRowField>();
  const changes: ObservedExistingRowChange["fields"] extends readonly (infer Field)[] ? Field[] : never = [];
  let changed = false;
  const userFields = mapping.fields.filter((field) => field.ownership === FIELD_OWNERSHIPS.USER);
  // If canonical state advanced after the row was materialized, the exact
  // field baseline is unavailable, so force evaluator conflict handling.
  const forceConflict = visibleState === undefined ||
    visibleState.confirmedEntityRevision === null ||
    visibleState.confirmedEntityRevision < canonical.entityRevision;
  for (const field of userFields) {
    const canonicalField = canonical.fields.get(field.fieldName);
    if (canonicalField === undefined) {
      return { kind: "invalid", reason: MAPPED_USER_INPUT_INVALID_REASONS.MISSING_CANONICAL_STATE };
    }
    const observedCell = snapshotRow.cells[field.fieldName];
    const validation = validateSnapshotCell(field, observedCell);
    if (validation !== undefined) return { kind: "invalid", reason: validation };
    const nextValue = observedCell!.normalizedCell;
    const baseFieldRevision = {
      kind: APPLICABILITY_KINDS.APPLICABLE,
      value: forceConflict ? 0 : canonicalField.fieldRevision,
    } as const;
    beforeFields.set(field.fieldName, {
      fieldName: field.fieldName,
      cell: canonicalField.value,
      baseFieldRevision,
    });
    afterFields.set(field.fieldName, {
      fieldName: field.fieldName,
      cell: nextValue,
      baseFieldRevision,
    });
    if (stableHash(canonicalField.value) === stableHash(nextValue)) continue;
    if (field.property === mapping.primaryKey) {
      return { kind: "invalid", reason: MAPPED_USER_INPUT_INVALID_REASONS.PRIMARY_KEY_MUTATION };
    }
    changed = true;
    changes.push({
      fieldName: field.fieldName,
      previousValue: canonicalField.value,
      nextValue,
      baseFieldRevision: forceConflict ? 0 : canonicalField.fieldRevision,
    });
  }
  if (!changed) return { kind: "unchanged" };
  // A changed row whose evidence can only be synthetic (the provider snapshot
  // carries no visible revision) needs a confirmed SQLite baseline to produce
  // valid observation evidence. Without one the row cannot enter the evaluator,
  // so it is quarantined instead of aborting the whole polling pass.
  const baselineVisibleHash = visibleState === undefined ? undefined : visibleState.confirmedVisibleHash;
  if (
    snapshotRow.visibleRevision.kind === PRESENCE_KINDS.ABSENT &&
    (baselineVisibleHash === undefined || baselineVisibleHash.length === 0)
  ) {
    return { kind: "invalid", reason: MAPPED_USER_INPUT_INVALID_REASONS.MISSING_VISIBLE_STATE };
  }
  return {
    kind: "changed",
    row: {
      rowBindingId: binding.rowBindingId,
      operation: ROW_OPERATIONS.UPDATE,
      beforeRow: { rowBindingId: binding.rowBindingId, fields: beforeFields },
      afterRow: { rowBindingId: binding.rowBindingId, fields: afterFields },
      baseVisibleRevision: visibleState?.confirmedVisibleRevision ?? 0,
      ...(visibleState === undefined ? {} : { baseVisibleHash: visibleState.confirmedVisibleHash }),
      baseEntityRevision: canonical.entityRevision,
      fields: changes,
    },
  };
}

function validateSnapshotCell(
  field: TypedSheetsEntityFieldMapping,
  cell: SyncSnapshotCell | undefined,
): MappedUserInputInvalidReason | undefined {
  if (cell === undefined) return MAPPED_USER_INPUT_INVALID_REASONS.MISSING_CELL;
  if (cell.cellKind === CELL_OBSERVATION_KINDS.FORMULA) {
    return MAPPED_USER_INPUT_INVALID_REASONS.FORMULA_CELL;
  }
  if (cell.cellKind === CELL_OBSERVATION_KINDS.MERGED) {
    return MAPPED_USER_INPUT_INVALID_REASONS.MERGED_CELL;
  }
  if (cell.cellKind === CELL_OBSERVATION_KINDS.ERROR) {
    return MAPPED_USER_INPUT_INVALID_REASONS.ERROR_CELL;
  }
  if (cell.cellKind !== CELL_OBSERVATION_KINDS.LITERAL && cell.cellKind !== CELL_OBSERVATION_KINDS.BLANK) {
    return MAPPED_USER_INPUT_INVALID_REASONS.NON_LITERAL_CELL;
  }
  if (cell.cellKind === CELL_OBSERVATION_KINDS.BLANK && cell.normalizedCell !== null) {
    return MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
  }
  const value = cell.normalizedCell;
  if (value === null) {
    return field.required ? MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL : undefined;
  }
  if (value.kind !== field.cellKind) return MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
  switch (value.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return field.required && value.value.length === 0
        ? MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL
        : undefined;
    case NORMALIZED_CELL_KINDS.NUMBER:
      return Number.isFinite(value.value) ? undefined : MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return undefined;
    case NORMALIZED_CELL_KINDS.DATE:
      return isCanonicalUtcIsoDate(value.value) ? undefined : MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
  }
}

function validateSnapshotRoute(
  mapping: TypedSheetsEntityMapping,
  snapshot: SyncSheetsSnapshot,
  expectedHeaders: readonly string[],
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
): void {
  if (
    snapshot.protocolVersion !== SYNC_PROTOCOL_VERSIONS.V1 ||
    snapshot.sheetName !== projection.tabName ||
    snapshot.registeredRange !== projection.registeredRange ||
    snapshot.projection !== SYNC_PROJECTIONS.USER_INPUT ||
    snapshot.schemaVersion !== mapping.schemaVersion ||
    snapshot.headers.length !== expectedHeaders.length ||
    snapshot.headers.some((header, index) => header !== expectedHeaders[index])
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `User_Input snapshot does not match the registered route ${projection.physicalSheetId}.`,
    );
  }
}

/** Derives duplicate business-key values from one normalized snapshot. */
export function duplicateBusinessKeysForSnapshot(
  snapshot: SyncSheetsSnapshot,
  businessKey: TypedSheetsEntityFieldMapping,
): ReadonlySet<string> {
  const rowsByBusinessKey = new Map<string, number[]>();
  for (const row of snapshot.rows) {
    const cell = row.cells[businessKey.fieldName];
    if (cell === undefined || cell.normalizedCell === null) continue;
    const key = stableHash(cell.normalizedCell);
    const rowNumbers = rowsByBusinessKey.get(key) ?? [];
    rowNumbers.push(row.rowNumber);
    rowsByBusinessKey.set(key, rowNumbers);
  }
  return new Set(
    [...rowsByBusinessKey.entries()]
      .filter(([, rowNumbers]) => rowNumbers.length > 1)
      .map(([businessKeyValue]) => businessKeyValue),
  );
}

/** Computes the stable snapshot identity used by observation deduplication. */
export function snapshotHash(snapshot: SyncSheetsSnapshot): string {
  return stableHash({
    protocolVersion: snapshot.protocolVersion,
    sheetName: snapshot.sheetName,
    registeredRange: snapshot.registeredRange,
    projection: snapshot.projection,
    schemaVersion: snapshot.schemaVersion,
    headers: snapshot.headers,
    rows: snapshot.rows.map((row) => ({
      rowNumber: row.rowNumber,
      cells: Object.entries(row.cells)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([fieldName, cell]) => ({
          fieldName,
          cellKind: cell.cellKind,
          normalizedCell: cell.normalizedCell,
        })),
    })),
  });
}
