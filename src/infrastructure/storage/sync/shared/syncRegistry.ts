/**
 * SQLite registry/allowlist operations for the sync provider.
 *
 * The local registry is the source of truth used to choose a provider range.
 * A caller cannot turn an arbitrary tab name into a sync target by merely
 * passing it to the provider client.
 */

import { STORAGE_ERROR_CODES, StorageError, type StorageErrorCode } from "../../errors.js";
import type { RegisteredProjectionKind } from "../../../../domain/model/constants.js";
import { withSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  isFencingValidWithSql,
  type FencingContext,
} from "@hikoutei/ikisaki";
import {
  nonEmptySyncProjectionHeadersSchema,
  nonEmptySyncTextSchema,
  positiveSyncSafeIntegerSchema,
  registeredProjectionSchema,
  syncAnchorModeSchema,
  syncOwnershipManifestSchema,
  syncProjectionHeadersSchema,
} from "./manifestSchemas.js";

const READ_LOGICAL_SHEET_REGISTRATION_SQL = `
  SELECT schema_version, ownership_manifest_json, business_key_field, anchor_mode, enabled
  FROM sheet_registry
  WHERE sheet_id = ?
`;

const INSERT_LOGICAL_SHEET_REGISTRATION_SQL = `
  INSERT INTO sheet_registry (
    sheet_id, schema_version, ownership_manifest_json, business_key_field, anchor_mode, enabled
  ) VALUES (?, ?, ?, ?, ?, 1)
`;

const READ_PHYSICAL_SHEET_REGISTRATION_SQL = `
  SELECT logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection,
         schema_version, projection_headers_json, anchor_mode, enabled
  FROM physical_sheet_registry
  WHERE physical_sheet_id = ?
`;

const INSERT_PHYSICAL_SHEET_REGISTRATION_SQL = `
  INSERT INTO physical_sheet_registry (
    physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name,
    registered_range, projection, schema_version, projection_headers_json,
    anchor_mode, enabled
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`;

const REGISTERED_SYNC_SHEET_SELECT = `
  SELECT physical.logical_sheet_id, physical.physical_sheet_id, physical.spreadsheet_id,
         physical.tab_name, physical.registered_range, physical.projection,
         physical.schema_version, physical.projection_headers_json, physical.anchor_mode,
         physical.enabled AS physical_enabled, logical.ownership_manifest_json,
         logical.business_key_field, logical.enabled AS logical_enabled
  FROM physical_sheet_registry AS physical
  JOIN sheet_registry AS logical ON logical.sheet_id = physical.logical_sheet_id
`;

const READ_REGISTERED_SYNC_SHEET_SQL = `${REGISTERED_SYNC_SHEET_SELECT}
  WHERE physical.physical_sheet_id = ?
`;

const READ_REGISTERED_SYNC_SHEETS_SQL = `${REGISTERED_SYNC_SHEET_SELECT}
  WHERE physical.enabled = 1 AND logical.enabled = 1
  ORDER BY physical.physical_sheet_id
`;

/** The only projection labels accepted by the v1 runtime registry. */
export type RegisteredProjection = RegisteredProjectionKind;

/** Immutable logical/physical registration supplied by deployment setup. */
export interface RegisterSyncSheetInput {
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: RegisteredProjection;
  readonly schemaVersion: number;
  /** Exact ordered headers materialized for this projection. */
  readonly projectionHeaders: readonly string[];
  readonly ownershipManifestJson: string;
  readonly businessKeyField: string;
  /** Legacy column retained in SQLite; the active remote identity is visible business_key. */
  /** Compatibility with the pre-foundation developer-metadata fixture path. */
  readonly anchorMode?: "business_key" | "developer_metadata";
}

/** Registry row used for all provider requests. */
export interface RegisteredSyncSheet {
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: RegisteredProjection;
  readonly schemaVersion: number;
  /** Exact ordered headers persisted with the physical route. */
  readonly projectionHeaders: readonly string[];
  readonly ownershipManifestJson: string;
  readonly businessKeyField: string;
  /** Legacy column retained in SQLite; the active remote identity is visible business_key. */
  readonly anchorMode: "business_key" | "developer_metadata";
}

/** Records whether a fenced registry request won the writer ownership check. */
export type RegisterSyncSheetResult =
  | { readonly kind: "registered"; readonly sheet: RegisteredSyncSheet }
  | { readonly kind: "fenced_out" };

/**
 * Registers one logical sheet/projection pair through an active async SQL context.
 *
 * Call this from the same MikroORM transaction as any related setup state. The
 * registration and its writer-fence check use the same transaction boundary.
 */
export async function registerSyncSheetWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: RegisterSyncSheetInput,
): Promise<RegisterSyncSheetResult> {
  const normalizedInput = normalizeRegistrationInput(input);
  validateRegistration(normalizedInput);
  if (!(await isFencingValidWithSql(sql, fence))) return { kind: "fenced_out" };

  return withSqlSavepoint(sql, "register_sync_sheet", async () => {
    if (!(await isFencingValidWithSql(sql, fence))) return { kind: "fenced_out" };
    const logical = await sql.get<LogicalRow>(READ_LOGICAL_SHEET_REGISTRATION_SQL, [
      normalizedInput.logicalSheetId,
    ]);
    if (logical === undefined) {
      const inserted = await sql.run(INSERT_LOGICAL_SHEET_REGISTRATION_SQL, [
        normalizedInput.logicalSheetId,
        normalizedInput.schemaVersion,
        normalizedInput.ownershipManifestJson,
        normalizedInput.businessKeyField,
        normalizedInput.anchorMode ?? "business_key",
      ]);
      if (inserted.changes !== 1) {
        throw new StorageError(
          STORAGE_ERROR_CODES.SYNC_REGISTRATION_WRITE_FAILED,
          "could not register logical sheet",
        );
      }
    } else if (!sameLogicalRegistration(logical, normalizedInput)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SYNC_REGISTRATION_CONFLICT,
        "logical sync sheet registration does not match the existing allowlist",
      );
    }

    const physical = await sql.get<PhysicalRow>(READ_PHYSICAL_SHEET_REGISTRATION_SQL, [
      normalizedInput.physicalSheetId,
    ]);
    if (physical === undefined) {
      const inserted = await sql.run(INSERT_PHYSICAL_SHEET_REGISTRATION_SQL, [
        normalizedInput.physicalSheetId,
        normalizedInput.logicalSheetId,
        normalizedInput.spreadsheetId,
        normalizedInput.tabName,
        normalizedInput.registeredRange,
        normalizedInput.projection,
        normalizedInput.schemaVersion,
        JSON.stringify(normalizedInput.projectionHeaders),
        normalizedInput.anchorMode ?? "business_key",
      ]);
      if (inserted.changes !== 1) {
        throw new StorageError(
          STORAGE_ERROR_CODES.SYNC_REGISTRATION_WRITE_FAILED,
          "could not register physical sheet",
        );
      }
    } else if (!samePhysicalRegistration(physical, normalizedInput)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SYNC_REGISTRATION_CONFLICT,
        "physical sync sheet registration does not match the existing allowlist",
      );
    }

    return {
      kind: "registered",
      sheet: await requireRegisteredSyncSheetWithSql(sql, normalizedInput.physicalSheetId),
    };
  });
}

/** Registers one projection in an adapter-owned MikroORM transaction. */
export async function registerSyncSheetWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  input: RegisterSyncSheetInput,
): Promise<RegisterSyncSheetResult> {
  return storage.transaction(({ sql }) => registerSyncSheetWithSql(sql, fence, input));
}

/** Reads one enabled physical registry entry through an active async SQL context. */
export async function requireRegisteredSyncSheetWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
): Promise<RegisteredSyncSheet> {
  if (physicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "physical sheet ID is required",
    );
  }
  const row = await sql.get<RegisteredRow>(READ_REGISTERED_SYNC_SHEET_SQL, [physicalSheetId]);
  return registeredSyncSheetFromRow(row);
}

/** Reads one enabled physical registry entry through a fresh adapter read context. */
export async function requireRegisteredSyncSheetWithAdapter(
  storage: SqlStorageAdapter,
  physicalSheetId: string,
): Promise<RegisteredSyncSheet> {
  return storage.read(({ sql }) => requireRegisteredSyncSheetWithSql(sql, physicalSheetId));
}

/** Reads every enabled physical route for a worker manifest snapshot. */
export async function readRegisteredSyncSheetsWithSql(
  sql: SqlExecutor,
): Promise<readonly RegisteredSyncSheet[]> {
  const rows = await sql.all<RegisteredRow>(READ_REGISTERED_SYNC_SHEETS_SQL);
  return rows.map(registeredSyncSheetFromRow);
}

/** Reads every enabled physical route through a fresh adapter context. */
export async function readRegisteredSyncSheetsWithAdapter(
  storage: SqlStorageAdapter,
): Promise<readonly RegisteredSyncSheet[]> {
  return storage.read(({ sql }) => readRegisteredSyncSheetsWithSql(sql));
}

interface LogicalRow {
  readonly schema_version: number;
  readonly ownership_manifest_json: string;
  readonly business_key_field: string;
  readonly anchor_mode: string;
  readonly enabled: number;
}

interface PhysicalRow {
  readonly logical_sheet_id: string;
  readonly spreadsheet_id: string;
  readonly tab_name: string;
  readonly registered_range: string;
  readonly projection: string;
  readonly schema_version: number;
  readonly projection_headers_json: string;
  readonly anchor_mode: string;
  readonly enabled: number;
}

interface RegisteredRow {
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: string;
  readonly spreadsheet_id: string;
  readonly tab_name: string;
  readonly registered_range: string;
  readonly projection: string;
  readonly schema_version: number;
  readonly projection_headers_json: string;
  readonly anchor_mode: string;
  readonly physical_enabled: number;
  readonly ownership_manifest_json: string;
  readonly business_key_field: string;
  readonly logical_enabled: number;
}

function validateRegistration(input: RegisterSyncSheetInput): void {
  for (const [label, value] of [
    ["logical sheet ID", input.logicalSheetId],
    ["physical sheet ID", input.physicalSheetId],
    ["spreadsheet ID", input.spreadsheetId],
    ["tab name", input.tabName],
    ["registered range", input.registeredRange],
    ["ownership manifest", input.ownershipManifestJson],
    ["business key field", input.businessKeyField],
  ] as const) {
    if (!nonEmptySyncTextSchema.safeParse(value).success) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
        label + " is required",
      );
    }
  }
  if (!positiveSyncSafeIntegerSchema.safeParse(input.schemaVersion).success) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "schema version must be a positive safe integer",
    );
  }
  if (!isRegisteredProjection(input.projection)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "unsupported sync projection",
    );
  }
  validateProjectionHeaders(input.projectionHeaders);
  if (
    input.anchorMode !== undefined &&
    (!syncAnchorModeSchema.safeParse(input.anchorMode).success || input.anchorMode !== "business_key")
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "sync registry requires business-key row identity",
    );
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(input.ownershipManifestJson);
  } catch {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "ownership manifest must be valid JSON",
    );
  }
  if (!syncOwnershipManifestSchema.safeParse(parsedManifest).success) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "ownership manifest must be valid JSON",
    );
  }
}

function normalizeRegistrationInput(input: RegisterSyncSheetInput): RegisterSyncSheetInput {
  return {
    ...input,
    registeredRange: normalizeRegisteredRange(
      input.registeredRange,
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
    ),
  };
}

function validateProjectionHeaders(headers: unknown, requireAtLeastOne = true): void {
  if (!Array.isArray(headers) || (requireAtLeastOne && headers.length === 0)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "projection headers must contain at least one header",
    );
  }
  const schema = requireAtLeastOne
    ? nonEmptySyncProjectionHeadersSchema
    : syncProjectionHeadersSchema;
  const parsed = schema.safeParse(headers);
  if (!parsed.success) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "projection headers must contain non-empty strings",
    );
  }
  const seen = new Set<string>();
  for (const header of parsed.data) {
    if (seen.has(header)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
        "projection headers must not contain duplicates",
      );
    }
    seen.add(header);
  }
}

function sameLogicalRegistration(existing: LogicalRow, input: RegisterSyncSheetInput): boolean {
  return existing.schema_version === input.schemaVersion &&
    existing.ownership_manifest_json === input.ownershipManifestJson &&
    existing.business_key_field === input.businessKeyField &&
    existing.anchor_mode === (input.anchorMode ?? "business_key") &&
    existing.enabled === 1;
}

function samePhysicalRegistration(existing: PhysicalRow, input: RegisterSyncSheetInput): boolean {
  return existing.logical_sheet_id === input.logicalSheetId &&
    existing.spreadsheet_id === input.spreadsheetId &&
    existing.tab_name === input.tabName &&
    existing.registered_range === input.registeredRange &&
    existing.projection === input.projection &&
    existing.schema_version === input.schemaVersion &&
    existing.projection_headers_json === JSON.stringify(input.projectionHeaders) &&
    existing.anchor_mode === (input.anchorMode ?? "business_key") &&
    existing.enabled === 1;
}

function registeredSyncSheetFromRow(row: RegisteredRow | undefined): RegisteredSyncSheet {
  if (row === undefined || row.physical_enabled !== 1 || row.logical_enabled !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet is not an enabled sync registry target",
    );
  }
  if (!isRegisteredProjection(row.projection) || row.anchor_mode !== "business_key") {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet registry has an unsupported projection or identity mode",
    );
  }
  const registeredRange = normalizeRegisteredRange(
    row.registered_range,
    STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
  );
  const projectionHeaders = parseProjectionHeaders(row.projection_headers_json);
  if (registeredRange !== row.registered_range) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet registry range is not in canonical whole-column form",
    );
  }
  return {
    logicalSheetId: row.logical_sheet_id,
    physicalSheetId: row.physical_sheet_id,
    spreadsheetId: row.spreadsheet_id,
    tabName: row.tab_name,
    registeredRange,
    projection: row.projection,
    schemaVersion: row.schema_version,
    projectionHeaders,
    ownershipManifestJson: row.ownership_manifest_json,
    businessKeyField: row.business_key_field,
    anchorMode: "business_key",
  };
}

function isRegisteredProjection(value: string): value is RegisteredProjection {
  return registeredProjectionSchema.safeParse(value).success;
}

function parseProjectionHeaders(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet registry has malformed projection headers",
    );
  }
  const headers = syncProjectionHeadersSchema.safeParse(parsed);
  if (!headers.success) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      Array.isArray(parsed)
        ? "physical sheet registry has invalid projection headers"
        : "physical sheet registry projection headers must be an array",
    );
  }
  try {
    validateProjectionHeaders(headers.data, false);
  } catch {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet registry has invalid projection headers",
    );
  }
  return headers.data;
}

/** Normalizes the v1 whole-column provider boundary to the form accepted by the Sheets provider. */
function normalizeRegisteredRange(value: string, errorCode: StorageErrorCode): string {
  const normalized = value.trim().toUpperCase();
  const match = /^([A-Z]+):([A-Z]+)$/.exec(normalized);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new StorageError(errorCode, "registered range must be a whole-column range such as A:Z");
  }
  if (sheetColumnNumber(match[2], errorCode) < sheetColumnNumber(match[1], errorCode)) {
    throw new StorageError(errorCode, "registered range must be a whole-column range such as A:Z");
  }
  return normalized;
}

function sheetColumnNumber(letters: string, errorCode: StorageErrorCode): number {
  let result = 0;
  for (const letter of letters) {
    result = result * 26 + letter.charCodeAt(0) - 64;
    if (!Number.isSafeInteger(result)) {
      throw new StorageError(errorCode, "registered range column is out of range");
    }
  }
  return result;
}
