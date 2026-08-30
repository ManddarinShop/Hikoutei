/**
 * Pure registry/allowlist contract shared between the contracts leaf and the
 * SQLite registry runtime (which owns the actual SQL operations and imports
 * these types back). Type-only extraction from the runtime module so the
 * contracts package stays free of engine and kernel dependencies.
 */

import type { RegisteredProjectionKind } from "../domain/model/constants.js";

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
  readonly ownershipManifestJson: string;
  readonly businessKeyField: string;
  /**
   * Legacy column retained in SQLite; only the business-key identity mode is
   * accepted (everything else fails validation, including the pre-foundation
   * `developer_metadata` fixture path).
   */
  readonly anchorMode?: "business_key";
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
  readonly ownershipManifestJson: string;
  readonly businessKeyField: string;
  /** Legacy column retained in SQLite; the only accepted value is business_key. */
  readonly anchorMode: "business_key";
}

/** Records whether a fenced registry request won the writer ownership check. */
export type RegisterSyncSheetResult =
  | { readonly kind: "registered"; readonly sheet: RegisteredSyncSheet }
  | { readonly kind: "fenced_out" };