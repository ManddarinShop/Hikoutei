/**
 * Trusted setup bridge from SQLite's physical-sheet registry to the Apps Script
 * control plane.
 *
 * Runtime data-plane calls can only use a registered route. This helper is the
 * matching owner-side path: callers pass the route returned by SQLite plus its
 * declared header schema, and the gateway creates or verifies that projection
 * before atomically replacing its remote allowlist.
 */

import type {
  RegisteredProjection,
  RegisteredSyncSheet,
} from "../../storage/sync/syncRegistry.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "./errors.js";
import {
  requireSyncGatewayNonEmptyList,
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayText,
} from "./validation.js";

/** Exact projection schema that setup must materialize in the bound spreadsheet. */
export interface RegisteredSyncProjectionDefinition {
  readonly sheet: RegisteredSyncSheet;
  readonly headers: readonly string[];
  /** Optional user-editable boolean control fields for a Sync_Conflicts tab. */
  readonly checkboxHeaders?: readonly string[];
}

/** Serializable route shape accepted by a remote setup/control-plane client. */
export interface SyncGatewayProvisionRoute {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: RegisteredProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  /** Business-key header used to find append-only rows without metadata. */
  readonly identityField?: string;
  readonly checkboxHeaders?: readonly string[];
}

/** Minimal control-plane boundary; the runtime remains independent of fetch or Google SDK types. */
export interface SyncGatewayProvisioner {
  provisionRegistry(registrations: readonly SyncGatewayProvisionRoute[]): Promise<{
    readonly registrations: readonly Omit<SyncGatewayProvisionRoute, "headers">[];
    readonly createdSheets: readonly string[];
    readonly initializedHeaders: readonly string[];
  }>;
}

/**
 * Provisions the complete SQLite-declared projection set without asking an
 * operator to copy tab names, ranges, or schema versions into Apps Script.
 *
 * The caller should invoke this after successful local registry writes and may
 * retry a failed remote call: the gateway only creates missing tabs and never
 * overwrites a nonblank, mismatched header row.
 */
export async function provisionRegisteredSyncSheets(
  gateway: SyncGatewayProvisioner,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): Promise<Awaited<ReturnType<SyncGatewayProvisioner["provisionRegistry"]>>> {
  requireSyncGatewayNonEmptyList(
    definitions,
    "sync gateway provisioning definitions",
    SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );

  const firstDefinition = definitions[0];
  if (firstDefinition === undefined) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      "sync gateway provisioning requires a first projection",
    );
  }

  const spreadsheetId = requireSyncGatewayText(
    firstDefinition.sheet.spreadsheetId,
    "sync gateway provisioning spreadsheetId",
    SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );
  const physicalSheetIds = new Set<string>();
  const tabNames = new Set<string>();
  const registrations = definitions.map((definition) => {
    const physicalSheetId = requireSyncGatewayText(
      definition.sheet.physicalSheetId,
      "sync gateway provisioning physicalSheetId",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const sheetName = requireSyncGatewayText(
      definition.sheet.tabName,
      "sync gateway provisioning tabName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const registeredRange = requireSyncGatewayText(
      definition.sheet.registeredRange,
      "sync gateway provisioning registeredRange",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const definitionSpreadsheetId = requireSyncGatewayText(
      definition.sheet.spreadsheetId,
      "sync gateway provisioning spreadsheetId",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    if (definitionSpreadsheetId !== spreadsheetId) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync gateway provisioning definitions must target one spreadsheet",
      );
    }
    if (physicalSheetIds.has(physicalSheetId)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync gateway provisioning cannot repeat a physical sheet ID",
      );
    }
    if (tabNames.has(sheetName)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "sync gateway provisioning cannot repeat a tab name",
      );
    }
    physicalSheetIds.add(physicalSheetId);
    tabNames.add(sheetName);
    validateHeaders(definition.headers, "sync gateway provisioning headers");
    validateCheckboxHeaders(definition.headers, definition.checkboxHeaders);
    const schemaVersion = requireSyncGatewayPositiveSafeInteger(
      definition.sheet.schemaVersion,
      "sync gateway provisioning schemaVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const identityField = definition.sheet.projection === "system_state"
      ? requireSyncGatewayText(
        definition.sheet.businessKeyField,
        "sync gateway provisioning identityField",
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      )
      : undefined;
    if (identityField !== undefined && !definition.headers.includes(identityField)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        `sync gateway provisioning identityField is not declared: ${identityField}`,
      );
    }
    return {
      sheetName,
      registeredRange,
      projection: definition.sheet.projection,
      schemaVersion,
      headers: definition.headers,
      ...(identityField === undefined ? {} : { identityField }),
      ...(definition.checkboxHeaders === undefined ? {} : { checkboxHeaders: definition.checkboxHeaders }),
    };
  });

  return gateway.provisionRegistry(registrations);
}

function validateHeaders(headers: readonly string[], label: string): void {
  requireSyncGatewayNonEmptyList(
    headers,
    label,
    SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
  );
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    const normalizedHeader = requireSyncGatewayText(
      header,
      `${label}[${index}]`,
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    if (seen.has(normalizedHeader)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
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
    const normalizedHeader = requireSyncGatewayText(
      header,
      `sync gateway provisioning checkboxHeaders[${index}]`,
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    if (!headerSet.has(normalizedHeader)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        `sync gateway provisioning checkbox header is not declared: ${normalizedHeader}`,
      );
    }
    if (seen.has(normalizedHeader)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        `sync gateway provisioning cannot repeat a checkbox header: ${normalizedHeader}`,
      );
    }
    seen.add(normalizedHeader);
  });
}
