/**
 * SQLite registry/allowlist operations for the sync gateway.
 *
 * The local registry is the source of truth used to choose a gateway range.
 * A caller cannot turn an arbitrary tab name into a sync target by merely
 * passing it to the gateway client.
 */

import { withImmediateTransaction, type DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { STORAGE_ERROR_CODES, StorageError, type StorageErrorCode } from "../errors.js";
import { withSqlSavepoint } from "../sqlite/sqlTransaction.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../adapter/persistence/contracts/sql.js";
import {
  isFencingValid,
  isFencingValidWithSql,
  type FencingContext,
} from "./writerLease.js";

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
         schema_version, anchor_mode, enabled
  FROM physical_sheet_registry
  WHERE physical_sheet_id = ?
`;

const INSERT_PHYSICAL_SHEET_REGISTRATION_SQL = `
  INSERT INTO physical_sheet_registry (
    physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name,
    registered_range, projection, schema_version, anchor_mode, enabled
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
`;

const READ_REGISTERED_SYNC_SHEET_SQL = `
  SELECT physical.logical_sheet_id, physical.physical_sheet_id, physical.spreadsheet_id,
         physical.tab_name, physical.registered_range, physical.projection,
         physical.schema_version, physical.anchor_mode, physical.enabled AS physical_enabled,
         logical.ownership_manifest_json, logical.business_key_field, logical.enabled AS logical_enabled
  FROM physical_sheet_registry AS physical
  JOIN sheet_registry AS logical ON logical.sheet_id = physical.logical_sheet_id
  WHERE physical.physical_sheet_id = ?
`;

/** The only projection labels accepted by the v1 runtime registry. */
export type RegisteredProjection = "user_input" | "system_state" | "sync_conflicts";

/** Immutable logical/physical registration supplied by deployment setup. */
export interface RegisterSyncSheetInput {
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: RegisteredProjection;
  readonly schemaVersion: number;
  readonly ownershipManifestJson: string;
  readonly businessKeyField: string;
  readonly anchorMode?: "developer_metadata";
}

/** Registry row used for all gateway requests. */
export interface RegisteredSyncSheet {
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: RegisteredProjection;
  readonly schemaVersion: number;
  readonly ownershipManifestJson: string;
  readonly businessKeyField: string;
  readonly anchorMode: "developer_metadata";
}

/** Records whether a fenced registry request won the writer ownership check. */
export type RegisterSyncSheetResult =
  | { readonly kind: "registered"; readonly sheet: RegisteredSyncSheet }
  | { readonly kind: "fenced_out" };

/**
 * Registers one logical sheet/projection pair under the current writer fence.
 *
 * Repeating an identical registration is idempotent.  Any attempt to reuse a
 * logical or physical ID with different immutable routing data fails closed.
 */
export function registerSyncSheet(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: RegisterSyncSheetInput,
): RegisterSyncSheetResult {
  const normalizedInput = normalizeRegistrationInput(input);
  validateRegistration(normalizedInput);
  if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
  return withImmediateTransaction(db, () => {
    if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
    const logical = db.prepare(READ_LOGICAL_SHEET_REGISTRATION_SQL)
      .get(normalizedInput.logicalSheetId) as LogicalRow | undefined;
    if (logical === undefined) {
      const inserted = db.prepare(INSERT_LOGICAL_SHEET_REGISTRATION_SQL).run(
        normalizedInput.logicalSheetId,
        normalizedInput.schemaVersion,
        normalizedInput.ownershipManifestJson,
        normalizedInput.businessKeyField,
        normalizedInput.anchorMode ?? "developer_metadata",
      );
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

    const physical = db.prepare(READ_PHYSICAL_SHEET_REGISTRATION_SQL)
      .get(normalizedInput.physicalSheetId) as PhysicalRow | undefined;
    if (physical === undefined) {
      const inserted = db.prepare(INSERT_PHYSICAL_SHEET_REGISTRATION_SQL).run(
        normalizedInput.physicalSheetId,
        normalizedInput.logicalSheetId,
        normalizedInput.spreadsheetId,
        normalizedInput.tabName,
        normalizedInput.registeredRange,
        normalizedInput.projection,
        normalizedInput.schemaVersion,
        normalizedInput.anchorMode ?? "developer_metadata",
      );
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
      sheet: requireRegisteredSyncSheet(db, normalizedInput.physicalSheetId),
    };
  });
}

/**
 * Registers one logical sheet/projection pair through an active async SQL context.
 *
 * Call this from the same MikroORM transaction as any related setup state. The
 * registration and its writer-fence check then use the ORM-owned connection
 * instead of opening a second SQLite connection.
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
        normalizedInput.anchorMode ?? "developer_metadata",
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
        normalizedInput.anchorMode ?? "developer_metadata",
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

/** Reads one enabled physical registry entry or rejects any unregistered target. */
export function requireRegisteredSyncSheet(
  db: DatabaseSyncLike,
  physicalSheetId: string,
): RegisteredSyncSheet {
  if (physicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "physical sheet ID is required",
    );
  }
  const row = db.prepare(READ_REGISTERED_SYNC_SHEET_SQL)
    .get(physicalSheetId) as RegisteredRow | undefined;
  return registeredSyncSheetFromRow(row);
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
    if (value.length === 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
        label + " is required",
      );
    }
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
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
  if (input.anchorMode !== undefined && input.anchorMode !== "developer_metadata") {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "v1 sync registry requires developer_metadata anchors",
    );
  }
  try {
    JSON.parse(input.ownershipManifestJson) as unknown;
  } catch {
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

function sameLogicalRegistration(existing: LogicalRow, input: RegisterSyncSheetInput): boolean {
  return existing.schema_version === input.schemaVersion &&
    existing.ownership_manifest_json === input.ownershipManifestJson &&
    existing.business_key_field === input.businessKeyField &&
    existing.anchor_mode === (input.anchorMode ?? "developer_metadata") &&
    existing.enabled === 1;
}

function samePhysicalRegistration(existing: PhysicalRow, input: RegisterSyncSheetInput): boolean {
  return existing.logical_sheet_id === input.logicalSheetId &&
    existing.spreadsheet_id === input.spreadsheetId &&
    existing.tab_name === input.tabName &&
    existing.registered_range === input.registeredRange &&
    existing.projection === input.projection &&
    existing.schema_version === input.schemaVersion &&
    existing.anchor_mode === (input.anchorMode ?? "developer_metadata") &&
    existing.enabled === 1;
}

function registeredSyncSheetFromRow(row: RegisteredRow | undefined): RegisteredSyncSheet {
  if (row === undefined || row.physical_enabled !== 1 || row.logical_enabled !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet is not an enabled sync registry target",
    );
  }
  if (!isRegisteredProjection(row.projection) || row.anchor_mode !== "developer_metadata") {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet registry has an unsupported projection or anchor mode",
    );
  }
  const registeredRange = normalizeRegisteredRange(
    row.registered_range,
    STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
  );
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
    ownershipManifestJson: row.ownership_manifest_json,
    businessKeyField: row.business_key_field,
    anchorMode: "developer_metadata",
  };
}

function isRegisteredProjection(value: string): value is RegisteredProjection {
  return value === "user_input" || value === "system_state" || value === "sync_conflicts";
}

/** Normalizes the v1 whole-column gateway boundary to the form accepted by Apps Script. */
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
