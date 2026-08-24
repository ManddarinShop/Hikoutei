/**
 * Preflight and observation-target operations for the Google Sheets API
 * sync provider.
 *
 * `readPreflight` performs the two paced transport calls every outbound
 * effect operation needs (range-less sheet enumeration for hidden receipt
 * tab discovery, plus one bounded data read of the target and receipt tabs).
 * `observationTargetFor` validates one observation request and derives its
 * snapshot build target, failing closed on unknown read modes.
 */

import type { ReadSyncSnapshotRequest } from "../../../../../application/sync/sheetsContract/syncSheets.js";
import { requireSyncSnapshotReadMode } from "../../../../../application/sync/sheetsContract/validation.js";
import {
  SYNC_SNAPSHOT_READ_MODES,
  SYNC_PROJECTIONS,
} from "../../../../../application/sync/sheetsContract/constants.js";
import { SYNC_SHEETS_ERROR_CODES } from "../../../../../application/sync/sheetsContract/errors.js";
import type {
  SyncMissingTabOperation,
} from "../../../../../application/sync/sheetsContract/errors.js";
import type { RegisteredSyncProjectionDefinition } from "../../../../../application/sync/sheetsContract/sheetsProvisioning.js";
import type { Presence } from "../../../../../shared/state/index.js";
import { invalidProviderRequest } from "../errors.js";
import {
  enumerateSheetProperties,
  readPreflightData,
  readPreflightDataForRoutes,
  type PreflightContext,
} from "../model/preflightContext.js";
import { anchorColumnFor } from "../model/preflightRows.js";
import type { SnapshotBuildTarget } from "../model/observation.js";
import {
  definitionForPhysicalSheet,
  runRead,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";

/** Reads the target and receipt tabs for one route through the read lane. */
export async function readPreflight(
  deps: GoogleSheetsApiProviderDeps,
  request: {
    readonly sheetName: string;
    readonly registeredRange: string;
  },
  definition: RegisteredSyncProjectionDefinition,
  routeOptions: {
    readonly identityField: Presence<string>;
    readonly checkboxHeaders: readonly string[];
  },
): Promise<PreflightContext> {
  // Each preflight performs two paced transport calls: a range-less sheet
  // enumeration (hidden receipt tab discovery) plus one ranged data read.
  const sheets = await runRead(deps, () =>
    enumerateSheetProperties(deps.transport, deps.spreadsheetId, deps.readTimeoutMs));
  return runRead(deps, () =>
    readPreflightData(deps.transport, {
      spreadsheetId: deps.spreadsheetId,
      sheetName: request.sheetName,
      registeredRange: request.registeredRange,
      headers: definition.headers,
      identityField: routeOptions.identityField,
      checkboxHeaders: routeOptions.checkboxHeaders,
      projection: definition.sheet.projection,
    }, sheets, deps.readTimeoutMs));
}

/**
 * Reads the target and receipt tabs for MANY routes through the read lane
 * with ONE enumeration and ONE ranged read covering all needed tabs, then
 * builds a PreflightContext per route keyed by its sheetName.
 *
 * `operation` classifies an invalid provider state (such as a missing tab)
 * detected during the read; it defaults to the preflight step. The
 * postcondition-recovery path passes its own operation so a missing tab there
 * is reported as `postcondition_read` rather than `preflight`.
 */
export async function readPreflightForRoutes(
  deps: GoogleSheetsApiProviderDeps,
  routes: ReadonlyArray<{
    readonly sheetName: string;
    readonly registeredRange: string;
    readonly definition: RegisteredSyncProjectionDefinition;
    readonly routeOptions: {
      readonly identityField: Presence<string>;
      readonly checkboxHeaders: readonly string[];
    };
  }>,
  operation?: SyncMissingTabOperation,
): Promise<ReadonlyMap<string, PreflightContext>> {
  const sheets = await runRead(deps, () =>
    enumerateSheetProperties(deps.transport, deps.spreadsheetId, deps.readTimeoutMs));
  return runRead(deps, () =>
    readPreflightDataForRoutes(
      deps.transport,
      routes.map((route) => ({
        spreadsheetId: deps.spreadsheetId,
        sheetName: route.sheetName,
        registeredRange: route.registeredRange,
        headers: route.definition.headers,
        identityField: route.routeOptions.identityField,
        checkboxHeaders: route.routeOptions.checkboxHeaders,
        projection: route.definition.sheet.projection,
      })),
      sheets,
      deps.readTimeoutMs,
      operation,
    ));
}

/** Validates one observation request and derives its snapshot target. */
export function observationTargetFor(
  deps: GoogleSheetsApiProviderDeps,
  request: ReadSyncSnapshotRequest,
): SnapshotBuildTarget {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  // Fail closed on unknown readMode strings (same shared guard as the Apps
  // Script observation operation) instead of silently reading in full mode.
  const readMode = request.readMode === undefined
    ? SYNC_SNAPSHOT_READ_MODES.FULL
    : requireSyncSnapshotReadMode(
      request.readMode,
      "Google Sheets API observation readMode",
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    );
  if (
    readMode === SYNC_SNAPSHOT_READ_MODES.USER_INPUT &&
    request.projection !== SYNC_PROJECTIONS.USER_INPUT
  ) {
    invalidProviderRequest(
      "observation",
      "user_input readMode requires the user_input projection",
    );
  }
  return {
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    headers: definition.headers,
    checkboxHeaders: definition.checkboxHeaders ?? [],
    readMode,
    anchorColumn: anchorColumnFor(request.registeredRange, request.projection),
  };
}
