/**
 * Inbound User_Input polling report and cell-validation contracts.
 *
 * Extracted verbatim from the MikroORM adapter's observation modules (P8-C):
 * the internal sync service (supervisor options, shutdown, option
 * validation) and the existing-sheet adoption seeding both consume the
 * polling report shape and the exact cell-kind gate, so the report surface
 * and the pure cell validation live in the contracts leaf while the adapter
 * keeps the polling engine. The adapter modules re-export these declarations
 * so existing adapter-internal and test import paths stay valid.
 */

import {
  CELL_OBSERVATION_KINDS,
  NORMALIZED_CELL_KINDS,
} from "../encoding/index.js";
import { isCanonicalUtcIsoDate } from "../validation.js";
import type { SyncSnapshotCell } from "./syncSheets.js";
import type { TypedSheetsEntityFieldMapping } from "../sync-orm/mapping/contracts.js";

/** Closed set of inbound polling modes. */
export const MAPPED_USER_INPUT_POLL_MODES = {
  FULL: "full",
  ADAPTIVE: "adaptive",
} as const;

export type MappedUserInputPollingMode =
  (typeof MAPPED_USER_INPUT_POLL_MODES)[keyof typeof MAPPED_USER_INPUT_POLL_MODES];

/** Per-projection result of one polling pass. */
export interface MappedUserInputPollingSheetReport {
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly rowsScanned: number;
  readonly changedRows: number;
  readonly appliedRows: number;
  readonly conflictRows: number;
  readonly quarantinedRows: number;
  readonly duplicateRows: number;
  readonly staleRows: number;
  readonly fencedRows: number;
  readonly invalidRows: number;
  readonly unknownBusinessKeyRows: number;
  readonly duplicateBusinessKeyRows: number;
}

/** Aggregate result for one inbound polling pass. */
export interface MappedUserInputPollingReport {
  readonly elapsedMs: number;
  readonly mode: MappedUserInputPollingMode;
  readonly safetyFullScan: boolean;
  /**
   * How far past the configured full-scan deadline this safety scan started, in
   * milliseconds. Zero before the first completed scan, on adaptive passes, and
   * for direct calls without coordinator cadence state. Diagnostic only.
   */
  readonly safetyScanLagMs: number;
  readonly fullMetadataTables: number;
  readonly fastPathRowsScanned: number;
  readonly fastPathChangedRows: number;
  readonly sheets: readonly MappedUserInputPollingSheetReport[];
  readonly rowsScanned: number;
  readonly changedRows: number;
  readonly appliedRows: number;
  readonly conflictRows: number;
  readonly quarantinedRows: number;
  readonly duplicateRows: number;
  readonly staleRows: number;
  readonly fencedRows: number;
  readonly invalidRows: number;
  readonly unknownBusinessKeyRows: number;
  readonly duplicateBusinessKeyRows: number;
}

/** Stable quarantine reasons for one observed User_Input cell/row. */
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

/**
 * Cell-kind gate for one observed User_Input cell against its declared field
 * contract. Pure: cell mapping + field contract in, quarantine reason out.
 *
 * The polling pipeline quarantines every observed cell whose kind violates
 * the mapping's declared field contract; adoption seeding applies the EXACT
 * same gate before any SQLite state is written, so both sides share this one
 * implementation (P8-C extraction).
 */
export function validateSnapshotCell(
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