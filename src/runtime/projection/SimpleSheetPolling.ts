/**
 * SQLite-authoritative polling with one values read per registered table.
 *
 * This path intentionally does not assign anchors, read Developer Metadata,
 * acquire a Sheet lock, calculate snapshot hashes, or write observation
 * receipts. It reads the registered range once, matches rows by the declared
 * business key, compares normalized values with SQLite canonical state, and
 * returns only changed rows for the observation writer to persist.
 */

import type { NormalizedCell } from "../../core/index.js";
import {
  NORMALIZED_CELL_KINDS,
} from "../../core/encoding/constants.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../adapter/persistence/contracts/sql.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../storage/errors.js";
import type { RegisteredSyncProjectionDefinition } from "../gateway/SyncGatewayBootstrap.js";
import type {
  ReadSyncTableRowsRequest,
  SyncSheetTableReaderGateway,
  SyncTableRow,
  SyncTableRowsResult,
} from "../gateway/syncGateway.js";

const READ_CANONICAL_ROWS_SQL = `
  SELECT binding.logical_sheet_id, entity.entity_id, entity.status AS entity_status,
         field.field_name, field.normalized_value
  FROM row_binding AS binding
  JOIN entity_state AS entity
    ON entity.entity_id = binding.entity_id
   AND entity.status IN ('active', 'tombstoned')
  JOIN entity_field_state AS field
    ON field.entity_id = entity.entity_id
  WHERE binding.logical_sheet_id IN (__LOGICAL_SHEET_IDS__)
    AND binding.state IN ('active', 'tombstoned')
  ORDER BY binding.logical_sheet_id, entity.entity_id, field.field_name
`;

const DEFAULT_TOMBSTONE_FIELD_NAME = "__typed_sheets_deleted";

/** Runtime classification for one row returned by simple polling. */
export const SIMPLE_POLL_ROW_KINDS = {
  UNCHANGED: "unchanged",
  CHANGED: "changed",
  UNKNOWN: "unknown",
  INVALID: "invalid",
} as const;

export type SimplePollRowKind =
  (typeof SIMPLE_POLL_ROW_KINDS)[keyof typeof SIMPLE_POLL_ROW_KINDS];

/** Stable reasons for rows that cannot be compared to canonical state. */
export const SIMPLE_POLL_INVALID_REASONS = {
  MISSING_IDENTITY: "missing_identity",
  DUPLICATE_IDENTITY: "duplicate_identity",
  INVALID_CANONICAL_VALUE: "invalid_canonical_value",
} as const;

export type SimplePollInvalidReason =
  (typeof SIMPLE_POLL_INVALID_REASONS)[keyof typeof SIMPLE_POLL_INVALID_REASONS];

/** One changed Sheet row ready for the next observation/evaluation stage. */
export interface SimplePollChangedRow {
  readonly entityId: string;
  readonly rowNumber: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly changedFields: readonly string[];
}

/** One table's result from a lightweight polling pass. */
export interface SimpleSheetTablePollingResult {
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly sheetName: string;
  readonly rowsScanned: number;
  readonly unchangedRows: number;
  readonly changedRows: readonly SimplePollChangedRow[];
  readonly unknownRows: number;
  readonly invalidRows: number;
  readonly missingCanonicalRows: number;
  readonly readTiming?: SyncTableRowsResult["timing"];
  readonly elapsedMs: number;
}

/** Aggregated result for one polling pass across the registered tables. */
export interface SimpleSheetPollingResult {
  readonly elapsedMs: number;
  readonly tables: readonly SimpleSheetTablePollingResult[];
  readonly rowsScanned: number;
  readonly unchangedRows: number;
  readonly changedRows: readonly SimplePollChangedRow[];
  readonly unknownRows: number;
  readonly invalidRows: number;
  readonly missingCanonicalRows: number;
}

/** Internal row result used to keep status and payload mutually exclusive. */
type SimplePollRowResult =
  | {
      readonly kind: typeof SIMPLE_POLL_ROW_KINDS.UNCHANGED;
      readonly entityId: string;
    }
  | {
      readonly kind: typeof SIMPLE_POLL_ROW_KINDS.CHANGED;
      readonly entityId: string;
      readonly changedFields: readonly string[];
    }
  | {
      readonly kind: typeof SIMPLE_POLL_ROW_KINDS.UNKNOWN;
      readonly entityId: string;
    }
  | {
      readonly kind: typeof SIMPLE_POLL_ROW_KINDS.INVALID;
      readonly reason: SimplePollInvalidReason;
    };

interface CanonicalSqlRow {
  readonly logical_sheet_id: string;
  readonly entity_id: string;
  readonly entity_status: string;
  readonly field_name: string;
  readonly normalized_value: string;
}

interface CanonicalEntity {
  readonly entityId: string;
  readonly status: "active" | "tombstoned";
  readonly fields: ReadonlyMap<string, NormalizedCell>;
}

/**
 * Reads and compares all selected projections without a writer lease or
 * Sheet-side metadata mutation. Missing canonical rows are reported only;
 * this function never infers a delete from a missing Sheet row.
 */
export async function pollSimpleSheetRowsWithAdapter(options: {
  readonly storage: SqlStorageAdapter;
  readonly gateway: SyncSheetTableReaderGateway;
  readonly definitions: readonly RegisteredSyncProjectionDefinition[];
  readonly physicalSheetIds?: readonly string[];
}): Promise<SimpleSheetPollingResult> {
  const startedAt = Date.now();
  const definitions = selectDefinitions(options.definitions, options.physicalSheetIds);
  validateDefinitions(definitions);
  if (definitions.length === 0) {
    return {
      elapsedMs: Date.now() - startedAt,
      tables: [],
      rowsScanned: 0,
      unchangedRows: 0,
      changedRows: [],
      unknownRows: 0,
      invalidRows: 0,
      missingCanonicalRows: 0,
    };
  }

  const [canonicalByLogicalSheet, remoteResults] = await Promise.all([
    readCanonicalRows(options.storage, definitions),
    options.gateway.readRowsBatch(definitions.map(toReadRequest)),
  ]);
  if (remoteResults.length !== definitions.length) {
    throwPollingError("table read result count does not match the requested tables");
  }

  const tables = definitions.map((definition, index) => {
    const remote = remoteResults[index];
    if (remote === undefined) {
      throwPollingError("table read result is missing at index " + index);
    }
    const canonical = canonicalByLogicalSheet.get(definition.sheet.logicalSheetId) ?? new Map();
    return compareTable(definition, remote, canonical);
  });
  const changedRows = tables.flatMap((table) => table.changedRows);
  return {
    elapsedMs: Date.now() - startedAt,
    tables,
    rowsScanned: tables.reduce((total, table) => total + table.rowsScanned, 0),
    unchangedRows: tables.reduce((total, table) => total + table.unchangedRows, 0),
    changedRows,
    unknownRows: tables.reduce((total, table) => total + table.unknownRows, 0),
    invalidRows: tables.reduce((total, table) => total + table.invalidRows, 0),
    missingCanonicalRows: tables.reduce(
      (total, table) => total + table.missingCanonicalRows,
      0,
    ),
  };
}

function toReadRequest(
  definition: RegisteredSyncProjectionDefinition,
): ReadSyncTableRowsRequest {
  return {
    physicalSheetId: definition.sheet.physicalSheetId,
    sheetName: definition.sheet.tabName,
    registeredRange: definition.sheet.registeredRange,
    projection: definition.sheet.projection,
    schemaVersion: definition.sheet.schemaVersion,
    headers: definition.headers,
  };
}

async function readCanonicalRows(
  storage: SqlStorageAdapter,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): Promise<ReadonlyMap<string, ReadonlyMap<string, CanonicalEntity>>> {
  const logicalSheetIds = definitions.map((definition) => definition.sheet.logicalSheetId);
  const placeholders = logicalSheetIds.map(() => "?").join(", ");
  const rows = await storage.read(({ sql }) => sql.all<CanonicalSqlRow>(
    READ_CANONICAL_ROWS_SQL.replace("__LOGICAL_SHEET_IDS__", placeholders),
    logicalSheetIds,
  ));
  const entitiesByLogicalSheet = new Map<string, Map<string, CanonicalEntity>>();
  for (const row of rows) {
    const fieldsByEntity = entitiesByLogicalSheet.get(row.logical_sheet_id) ?? new Map();
    const existing = fieldsByEntity.get(row.entity_id) ?? {
      entityId: row.entity_id,
      status: parseCanonicalEntityStatus(row.entity_status, row.entity_id),
      fields: new Map<string, NormalizedCell>(),
    };
    existing.fields.set(
      row.field_name,
      parseCanonicalCell(row.normalized_value, row.entity_id + "." + row.field_name),
    );
    fieldsByEntity.set(row.entity_id, existing);
    entitiesByLogicalSheet.set(row.logical_sheet_id, fieldsByEntity);
  }
  return entitiesByLogicalSheet;
}

function compareTable(
  definition: RegisteredSyncProjectionDefinition,
  remote: SyncTableRowsResult,
  canonical: ReadonlyMap<string, CanonicalEntity>,
): SimpleSheetTablePollingResult {
  const startedAt = Date.now();
  validateRemoteResult(definition, remote);
  const identityField = definition.sheet.businessKeyField;
  const identityCounts = new Map<string, number>();
  for (const row of remote.rows) {
    const identity = identityFromCell(row.fields[identityField]);
    if (identity !== undefined) identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
  }

  let unchangedRows = 0;
  let unknownRows = 0;
  let invalidRows = 0;
  const changedRows: SimplePollChangedRow[] = [];
  const seenCanonicalIds = new Set<string>();
  for (const row of remote.rows) {
    const result = compareRow(row, identityField, identityCounts, canonical, definition.headers);
    if (result.kind === SIMPLE_POLL_ROW_KINDS.UNCHANGED) {
      unchangedRows += 1;
      seenCanonicalIds.add(result.entityId);
    } else if (result.kind === SIMPLE_POLL_ROW_KINDS.CHANGED) {
      changedRows.push({
        entityId: result.entityId,
        rowNumber: row.rowNumber,
        fields: row.fields,
        changedFields: result.changedFields,
      });
      seenCanonicalIds.add(result.entityId);
    } else if (result.kind === SIMPLE_POLL_ROW_KINDS.UNKNOWN) {
      unknownRows += 1;
    } else {
      invalidRows += 1;
    }
  }

  return {
    physicalSheetId: definition.sheet.physicalSheetId,
    logicalSheetId: definition.sheet.logicalSheetId,
    sheetName: definition.sheet.tabName,
    rowsScanned: remote.rows.length,
    unchangedRows,
    changedRows,
    unknownRows,
    invalidRows,
    missingCanonicalRows: [...canonical.keys()].filter((entityId) => !seenCanonicalIds.has(entityId)).length,
    ...(remote.timing === undefined ? {} : { readTiming: remote.timing }),
    elapsedMs: Date.now() - startedAt,
  };
}

function compareRow(
  row: SyncTableRow,
  identityField: string,
  identityCounts: ReadonlyMap<string, number>,
  canonical: ReadonlyMap<string, CanonicalEntity>,
  headers: readonly string[],
): SimplePollRowResult {
  const identity = identityFromCell(row.fields[identityField]);
  if (identity === undefined) {
    return { kind: SIMPLE_POLL_ROW_KINDS.INVALID, reason: SIMPLE_POLL_INVALID_REASONS.MISSING_IDENTITY };
  }
  if (identityCounts.get(identity) !== 1) {
    return { kind: SIMPLE_POLL_ROW_KINDS.INVALID, reason: SIMPLE_POLL_INVALID_REASONS.DUPLICATE_IDENTITY };
  }
  const expected = canonical.get(identity);
  if (expected === undefined) return { kind: SIMPLE_POLL_ROW_KINDS.UNKNOWN, entityId: identity };
  const changedFields = headers.filter((fieldName) => {
    const expectedCell = fieldName === DEFAULT_TOMBSTONE_FIELD_NAME
      ? { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: expected.status === "tombstoned" }
      : expected.fields.get(fieldName) ?? null;
    return !sameCell(row.fields[fieldName] ?? null, expectedCell);
  });
  return changedFields.length === 0
    ? { kind: SIMPLE_POLL_ROW_KINDS.UNCHANGED, entityId: identity }
    : { kind: SIMPLE_POLL_ROW_KINDS.CHANGED, entityId: identity, changedFields };
}

function validateRemoteResult(
  definition: RegisteredSyncProjectionDefinition,
  result: SyncTableRowsResult,
): void {
  if (
    result.sheetName !== definition.sheet.tabName ||
    result.registeredRange !== definition.sheet.registeredRange ||
    result.headers.length !== definition.headers.length ||
    result.headers.some((header, index) => header !== definition.headers[index])
  ) {
    throwPollingError("table read result does not match the registered projection");
  }
}

function selectDefinitions(
  definitions: readonly RegisteredSyncProjectionDefinition[],
  physicalSheetIds: readonly string[] | undefined,
): readonly RegisteredSyncProjectionDefinition[] {
  if (physicalSheetIds === undefined) return definitions;
  const selected = new Set(physicalSheetIds);
  return definitions.filter((definition) => selected.has(definition.sheet.physicalSheetId));
}

function validateDefinitions(
  definitions: readonly RegisteredSyncProjectionDefinition[],
): void {
  for (const definition of definitions) {
    if (!definition.headers.includes(definition.sheet.businessKeyField)) {
      throwPollingError(
        "business key is not declared in the projection headers: " + definition.sheet.businessKeyField,
      );
    }
    if (new Set(definition.headers).size !== definition.headers.length) {
      throwPollingError("projection headers contain duplicates: " + definition.sheet.tabName);
    }
  }
}

function identityFromCell(cell: NormalizedCell | undefined): string | undefined {
  if (cell === undefined || cell === null) return undefined;
  if (cell.kind === NORMALIZED_CELL_KINDS.STRING) {
    return cell.value.length === 0 ? undefined : cell.value;
  }
  if (cell.kind === NORMALIZED_CELL_KINDS.NUMBER) return String(cell.value);
  return undefined;
}

function sameCell(left: NormalizedCell, right: NormalizedCell): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  return left.value === right.value;
}

function parseCanonicalCell(value: string, label: string): NormalizedCell {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throwPollingError("canonical value is not valid JSON for " + label, error);
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throwPollingError("canonical value is not a normalized cell for " + label);
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind === NORMALIZED_CELL_KINDS.STRING || record.kind === NORMALIZED_CELL_KINDS.DATE) {
    if (typeof record.value !== "string") throwPollingError("canonical text cell is invalid for " + label);
    return record.kind === NORMALIZED_CELL_KINDS.STRING
      ? { kind: NORMALIZED_CELL_KINDS.STRING, value: record.value }
      : { kind: NORMALIZED_CELL_KINDS.DATE, value: record.value };
  }
  if (record.kind === NORMALIZED_CELL_KINDS.NUMBER) {
    if (typeof record.value !== "number" || !Number.isFinite(record.value)) {
      throwPollingError("canonical number cell is invalid for " + label);
    }
    return { kind: NORMALIZED_CELL_KINDS.NUMBER, value: record.value };
  }
  if (record.kind === NORMALIZED_CELL_KINDS.BOOLEAN) {
    if (typeof record.value !== "boolean") throwPollingError("canonical boolean cell is invalid for " + label);
    return { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: record.value };
  }
  throwPollingError("canonical cell kind is unsupported for " + label);
}

function parseCanonicalEntityStatus(value: string, entityId: string): CanonicalEntity["status"] {
  if (value === "active" || value === "tombstoned") return value;
  throwPollingError("canonical entity status is unsupported for " + entityId);
}

function throwPollingError(message: string, cause?: unknown): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_READ_ONLY_OBSERVATION, message, {
    cause,
  });
}
