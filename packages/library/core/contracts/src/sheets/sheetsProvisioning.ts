/**
 * Trusted setup bridge from SQLite's physical-sheet registry to the bound
 * spreadsheet through the Google Sheets API sync provider.
 *
 * Runtime data-plane calls can only use a registered route. This helper is the
 * matching owner-side path: callers pass the route returned by SQLite plus its
 * declared header schema, and the provider creates or verifies that projection
 * tab and header row in the bound spreadsheet.
 */

import type {
  RegisteredProjection,
  RegisteredSyncSheet,
} from "../storage/syncRegistry.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "./errors.js";
import {
  requireSyncSheetsNonEmptyList,
  requireSyncSheetsPositiveSafeInteger,
  requireSyncSheetsText,
} from "./validation.js";

/** Exact projection schema that setup must materialize in the bound spreadsheet. */
export interface RegisteredSyncProjectionDefinition {
  readonly sheet: RegisteredSyncSheet;
  readonly headers: readonly string[];
  /**
   * §12 columnMap: for an ADOPTED route, the physical tab's real header row
   * positionally parallel to `headers` (physicalHeaders[i] is the sheet
   * header at the column carrying headers[i]). Header-row validation uses
   * these while every downstream consumer keys by the canonical `headers`.
   * Absent = the physical headers equal `headers` (default).
   */
  readonly physicalHeaders?: readonly string[];
  /** Header used to detect duplicate append identities before a remote write. */
  readonly identityField?: string;
  /** Converts a visible business key into the canonical entity identity. */
  readonly entityIdForBusinessKey?: (businessKey: string) => string;
  /** Optional user-editable boolean control fields for a Sync_Conflicts tab. */
  readonly checkboxHeaders?: readonly string[];
}

/** Serializable route shape accepted by a remote setup/provisioning client. */
export interface SyncSheetsProvisionRoute {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: RegisteredProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  /**
   * §12 columnMap: adopted-route physical headers, positionally parallel to
   * `headers` (see RegisteredSyncProjectionDefinition). Header-row validation
   * uses these; canonical `headers` stay the keying contract.
   */
  readonly physicalHeaders?: readonly string[];
  /** Business-key header retained for append identity validation and fallback lookup. */
  readonly identityField?: string;
  readonly checkboxHeaders?: readonly string[];
}

/** Minimal provisioning boundary; the runtime remains independent of fetch or Google SDK types. */
export interface SyncSheetsProvisioner {
  provisionRegistry(registrations: readonly SyncSheetsProvisionRoute[]): Promise<{
    readonly registrations: readonly Omit<SyncSheetsProvisionRoute, "headers">[];
    readonly createdSheets: readonly string[];
    readonly initializedHeaders: readonly string[];
  }>;
}

/**
 * Provisions the complete SQLite-declared projection set without asking an
 * operator to copy tab names, ranges, or schema versions into the spreadsheet.
 *
 * The caller should invoke this after successful local registry writes and may
 * retry a failed remote call: the provider only creates missing tabs and never
 * overwrites a nonblank, mismatched header row.
 */
export async function provisionRegisteredSyncSheets(
  provider: SyncSheetsProvisioner,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): Promise<Awaited<ReturnType<SyncSheetsProvisioner["provisionRegistry"]>>> {
  requireSyncSheetsNonEmptyList(
    definitions,
    "sync provider provisioning definitions",
    SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );

  const firstDefinition = definitions[0];
  if (firstDefinition === undefined) {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      "sync provider provisioning requires a first projection",
    );
  }

  const spreadsheetId = requireSyncSheetsText(
    firstDefinition.sheet.spreadsheetId,
    "sync provider provisioning spreadsheetId",
    SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );
  const physicalSheetIds = new Set<string>();
  const tabNames = new Set<string>();
  const registrations = definitions.map((definition) => {
    const physicalSheetId = requireSyncSheetsText(
      definition.sheet.physicalSheetId,
      "sync provider provisioning physicalSheetId",
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const sheetName = requireSyncSheetsText(
      definition.sheet.tabName,
      "sync provider provisioning tabName",
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const registeredRange = requireSyncSheetsText(
      definition.sheet.registeredRange,
      "sync provider provisioning registeredRange",
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const definitionSpreadsheetId = requireSyncSheetsText(
      definition.sheet.spreadsheetId,
      "sync provider provisioning spreadsheetId",
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    if (definitionSpreadsheetId !== spreadsheetId) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync provider provisioning definitions must target one spreadsheet",
      );
    }
    if (physicalSheetIds.has(physicalSheetId)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync provider provisioning cannot repeat a physical sheet ID",
      );
    }
    if (tabNames.has(sheetName)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync provider provisioning cannot repeat a tab name",
      );
    }
    physicalSheetIds.add(physicalSheetId);
    tabNames.add(sheetName);
    validateHeaders(definition.headers, "sync provider provisioning headers");
    validateCheckboxHeaders(definition.headers, definition.checkboxHeaders);
    const schemaVersion = requireSyncSheetsPositiveSafeInteger(
      definition.sheet.schemaVersion,
      "sync provider provisioning schemaVersion",
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const identityField = definition.sheet.projection === "system_state"
      ? requireSyncSheetsText(
        definition.sheet.businessKeyField,
        "sync provider provisioning identityField",
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      )
      : definition.sheet.projection === "sync_conflicts"
        ? "Conflict_ID"
        : undefined;
    if (identityField !== undefined && !definition.headers.includes(identityField)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        `sync provider provisioning identityField is not declared: ${identityField}`,
      );
    }
    return {
      sheetName,
      registeredRange,
      projection: definition.sheet.projection,
      schemaVersion,
      headers: definition.headers,
      ...(definition.physicalHeaders === undefined ? {} : { physicalHeaders: definition.physicalHeaders }),
      ...(identityField === undefined ? {} : { identityField }),
      ...(definition.checkboxHeaders === undefined ? {} : { checkboxHeaders: definition.checkboxHeaders }),
    };
  });

  return provider.provisionRegistry(registrations);
}

function validateHeaders(headers: readonly string[], label: string): void {
  requireSyncSheetsNonEmptyList(
    headers,
    label,
    SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    const normalizedHeader = requireSyncSheetsText(
      header,
      `${label}[${index}]`,
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    if (seen.has(normalizedHeader)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        `${label} cannot contain duplicate headers: ${normalizedHeader}`,
      );
    }
    seen.add(normalizedHeader);
  });
}

function validateCheckboxHeaders(
  headers: readonly string[],
  checkboxHeaders: readonly string[] | undefined,
): void {
  if (checkboxHeaders === undefined) return;
  const headerSet = new Set(headers);
  const seen = new Set<string>();
  checkboxHeaders.forEach((header, index) => {
    const normalizedHeader = requireSyncSheetsText(
      header,
      `sync provider provisioning checkboxHeaders[${index}]`,
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    if (!headerSet.has(normalizedHeader)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        `sync provider provisioning checkbox header is not declared: ${normalizedHeader}`,
      );
    }
    if (seen.has(normalizedHeader)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        `sync provider provisioning cannot repeat a checkbox header: ${normalizedHeader}`,
      );
    }
    seen.add(normalizedHeader);
  });
}
