/** Durable per-spreadsheet authority records used to fence remote mutations. */

import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import { isFencingValidWithSql } from "./writerLease.js";
import type { FencingContext } from "./writerLease.js";

const READ_PHYSICAL_AUTHORITY_SQL = `
  SELECT physical.spreadsheet_id, authority.owner_id, authority.authority_epoch,
         authority.authority_token, authority.updated_at
  FROM physical_sheet_registry AS physical
  LEFT JOIN spreadsheet_authority AS authority
    ON authority.spreadsheet_id = physical.spreadsheet_id
  WHERE physical.physical_sheet_id = ?
`;

const INSERT_AUTHORITY_SQL = `
  INSERT INTO spreadsheet_authority (
    spreadsheet_id, owner_id, authority_epoch, authority_token, updated_at
  ) VALUES (?, ?, ?, ?, ?)
`;

const UPDATE_AUTHORITY_SQL = `
  UPDATE spreadsheet_authority
  SET owner_id = ?, authority_epoch = ?, authority_token = ?, updated_at = ?
  WHERE spreadsheet_id = ?
    AND authority_epoch <= ?
`;

export interface SpreadsheetAuthority {
  readonly spreadsheetId: string;
  readonly ownerId: string;
  readonly authorityEpoch: number;
  readonly authorityToken: string;
  readonly updatedAt: number;
}

export type EnsureSpreadsheetAuthorityResult =
  | { readonly kind: "claimed"; readonly authority: SpreadsheetAuthority }
  | { readonly kind: "fenced_out" };

/** Ensures the current writer fence owns one registered spreadsheet authority. */
export async function ensureSpreadsheetAuthorityWithSql(
  sql: SqlExecutor,
  options: FencingContext & { readonly physicalSheetId: string; readonly ownerId: string },
): Promise<EnsureSpreadsheetAuthorityResult> {
  if (options.ownerId.length === 0 || options.physicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "spreadsheet authority owner and physical sheet ID are required",
    );
  }
  if (!(await isFencingValidWithSql(sql, options))) return { kind: "fenced_out" };
  const row = await sql.get<AuthorityRow>(READ_PHYSICAL_AUTHORITY_SQL, [options.physicalSheetId]);
  if (row === undefined || row.spreadsheet_id.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet is not registered for spreadsheet authority",
    );
  }
  if (row.authority_epoch !== undefined && row.authority_epoch !== null && (
    row.authority_epoch > options.writerEpoch ||
    row.authority_epoch === options.writerEpoch && (
      row.authority_token !== options.fencingToken || row.owner_id !== options.ownerId
    )
  )) {
    return { kind: "fenced_out" };
  }

  const authority: SpreadsheetAuthority = {
    spreadsheetId: row.spreadsheet_id,
    ownerId: options.ownerId,
    authorityEpoch: options.writerEpoch,
    authorityToken: options.fencingToken,
    updatedAt: options.now,
  };
  if (row.authority_epoch === undefined || row.authority_epoch === null) {
    const inserted = await sql.run(INSERT_AUTHORITY_SQL, [
      authority.spreadsheetId,
      authority.ownerId,
      authority.authorityEpoch,
      authority.authorityToken,
      authority.updatedAt,
    ]);
    if (inserted.changes !== 1) return { kind: "fenced_out" };
    return { kind: "claimed", authority };
  }

  const updated = await sql.run(UPDATE_AUTHORITY_SQL, [
    authority.ownerId,
    authority.authorityEpoch,
    authority.authorityToken,
    authority.updatedAt,
    authority.spreadsheetId,
    authority.authorityEpoch,
  ]);
  return updated.changes === 1
    ? { kind: "claimed", authority }
    : { kind: "fenced_out" };
}

/** Ensures a spreadsheet authority through an adapter-owned transaction. */
export async function ensureSpreadsheetAuthorityWithAdapter(
  storage: SqlStorageAdapter,
  options: FencingContext & { readonly physicalSheetId: string; readonly ownerId: string },
): Promise<EnsureSpreadsheetAuthorityResult> {
  return storage.transaction(({ sql }) => ensureSpreadsheetAuthorityWithSql(sql, options));
}

/** Reads the durable authority attached to one registered physical sheet. */
export async function readSpreadsheetAuthorityWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
): Promise<SpreadsheetAuthority | undefined> {
  const row = await sql.get<AuthorityRow>(READ_PHYSICAL_AUTHORITY_SQL, [physicalSheetId]);
  if (row === undefined || row.authority_epoch === undefined || row.authority_epoch === null ||
      row.authority_token === undefined || row.authority_token === null) {
    return undefined;
  }
  return {
    spreadsheetId: row.spreadsheet_id,
    ownerId: row.owner_id ?? "",
    authorityEpoch: row.authority_epoch,
    authorityToken: row.authority_token,
    updatedAt: row.updated_at ?? 0,
  };
}

/** Reads one durable spreadsheet authority through a fresh adapter context. */
export async function readSpreadsheetAuthorityWithAdapter(
  storage: SqlStorageAdapter,
  physicalSheetId: string,
): Promise<SpreadsheetAuthority | undefined> {
  return storage.read(({ sql }) => readSpreadsheetAuthorityWithSql(sql, physicalSheetId));
}

interface AuthorityRow {
  readonly spreadsheet_id: string;
  readonly authority_epoch?: number | null;
  readonly authority_token?: string | null;
  readonly owner_id?: string | null;
  readonly updated_at?: number | null;
}
