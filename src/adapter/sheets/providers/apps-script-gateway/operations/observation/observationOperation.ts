/** Thin-Gateway operations for anchors and normalized Sheet snapshots. */

import { APPS_SCRIPT_STABLE_CODEC_SOURCE } from "../shared/appsScriptStableCodecSource.js";
import type {
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  ReadSyncSnapshotRequest,
  SyncObservedSnapshot,
  SyncGatewaySnapshot,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import {
  CELL_OBSERVATION_KINDS,
  type CellObservationKind,
} from "../../../../../../shared/encoding/constants.js";
import type { NormalizedCell } from "../../../../../../domain/index.js";
import { isNormalizedCell } from "../../../../../../shared/encoding/normalizedCell.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
} from "../../../../../../application/sync/gateway/errors.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
} from "../../../../../../application/sync/gateway/constants.js";
import {
  decodeSyncGatewayPresenceNonNegativeSafeInteger as decodePresenceNonNegativeInteger,
  decodeSyncGatewayPresenceString as decodePresenceString,
  requireSyncGatewayNonNegativeSafeInteger,
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayProjection,
  requireSyncGatewaySnapshotReadMode,
  requireSyncGatewayText,
} from "../../../../../../application/sync/gateway/validation.js";
import type { AppsScriptOperationDefinition } from "../../transport/operationClient.js";
import { decodeOptionalSyncGatewayTiming } from "../../protocol/timing.js";
import {
  invalidOperationRequest,
  invalidOperationResponse,
} from "../../errors.js";
import { requireOperationRecord } from "../../validation.js";

const OBSERVATION_OPERATION_MODES = {
  ENSURE_ANCHORS: "ensureRowAnchors",
  READ_SNAPSHOT: "readSnapshot",
  OBSERVE_SNAPSHOT: "observeSnapshot",
} as const;

interface ObservationOperationRouteOptions {
  readonly checkboxHeaders?: readonly string[];
  /** Local-only schema evidence used to validate decoded snapshot headers. */
  readonly expectedHeaders?: readonly string[];
}

type ObservationOperationRequest =
  (EnsureSyncRowAnchorsRequest | ReadSyncSnapshotRequest) & ObservationOperationRouteOptions;

export type AppsScriptEnsureRowAnchorsOperationArgs = {
  readonly mode: typeof OBSERVATION_OPERATION_MODES.ENSURE_ANCHORS;
} & ObservationOperationRequest;

export type AppsScriptReadSnapshotOperationArgs = {
  readonly mode: typeof OBSERVATION_OPERATION_MODES.READ_SNAPSHOT;
} & ObservationOperationRequest;

export type AppsScriptObserveSnapshotOperationArgs = {
  readonly mode: typeof OBSERVATION_OPERATION_MODES.OBSERVE_SNAPSHOT;
} & ObservationOperationRequest;

/** Builds the metadata-anchor assignment operation used before observation. */
export function createEnsureRowAnchorsOperation(
  request: EnsureSyncRowAnchorsRequest & ObservationOperationRouteOptions,
): AppsScriptOperationDefinition<
  AppsScriptEnsureRowAnchorsOperationArgs,
  EnsureSyncRowAnchorsResult
> {
  validateObservationRequest(request);
  const { expectedHeaders: _expectedHeaders, ...wireRequest } = request;
  return {
    fn: OBSERVATION_OPERATION_SOURCE,
    args: { mode: OBSERVATION_OPERATION_MODES.ENSURE_ANCHORS, ...wireRequest },
    decode: decodeEnsureRowAnchorsResult,
  };
}

/** Builds the normalized, read-only Sheet snapshot operation. */
export function createReadSnapshotOperation(
  request: ReadSyncSnapshotRequest & ObservationOperationRouteOptions,
): AppsScriptOperationDefinition<AppsScriptReadSnapshotOperationArgs, SyncGatewaySnapshot> {
  validateObservationRequest(request);
  const { expectedHeaders, ...wireRequest } = request;
  return {
    fn: OBSERVATION_OPERATION_SOURCE,
    args: { mode: OBSERVATION_OPERATION_MODES.READ_SNAPSHOT, ...wireRequest },
    decode: (value) => decodeSnapshot(value, request, expectedHeaders),
  };
}

/** Builds one operation that assigns anchors and reads the snapshot under one lock. */
export function createObserveSnapshotOperation(
  request: ReadSyncSnapshotRequest & ObservationOperationRouteOptions,
): AppsScriptOperationDefinition<
  AppsScriptObserveSnapshotOperationArgs,
  SyncObservedSnapshot
> {
  validateObservationRequest(request);
  const { expectedHeaders, ...wireRequest } = request;
  return {
    fn: OBSERVATION_OPERATION_SOURCE,
    args: { mode: OBSERVATION_OPERATION_MODES.OBSERVE_SNAPSHOT, ...wireRequest },
    decode: (value) => decodeObservedSnapshot(value, request, expectedHeaders),
  };
}

function validateObservationRequest(request: ObservationOperationRequest): void {
  requireSyncGatewayText(
    request.physicalSheetId,
    "Apps Script observation physicalSheetId",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayText(
    request.sheetName,
    "Apps Script observation sheetName",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayText(
    request.registeredRange,
    "Apps Script observation registeredRange",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayProjection(
    request.projection,
    "Apps Script observation projection",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayPositiveSafeInteger(
    request.schemaVersion,
    "Apps Script observation schemaVersion",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  if (request.checkboxHeaders !== undefined && !Array.isArray(request.checkboxHeaders)) {
    invalidOperationRequest(
      "Apps Script observation operation",
      "checkboxHeaders must be an array",
    );
  }
  if ("readMode" in request && request.readMode !== undefined) {
    const readMode = requireSyncGatewaySnapshotReadMode(
      request.readMode,
      "Apps Script observation readMode",
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    );
    if (
      readMode === SYNC_GATEWAY_SNAPSHOT_READ_MODES.USER_INPUT &&
      request.projection !== SYNC_GATEWAY_PROJECTIONS.USER_INPUT
    ) {
      invalidOperationRequest(
        "Apps Script observation operation",
        "user_input readMode requires the user_input projection",
      );
    }
  }
}

function decodeEnsureRowAnchorsResult(value: unknown): EnsureSyncRowAnchorsResult {
  const record = requireRecord(value, "anchor result");
  return {
    assigned: requireSyncGatewayNonNegativeSafeInteger(
      record.assigned,
      "anchor result assigned",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    existing: requireSyncGatewayNonNegativeSafeInteger(
      record.existing,
      "anchor result existing",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    duplicateAnchors: decodeDuplicateAnchors(record.duplicateAnchors),
  };
}

function decodeObservedSnapshot(
  value: unknown,
  expectedRoute: ReadSyncSnapshotRequest,
  expectedHeaders?: readonly string[],
): SyncObservedSnapshot {
  const record = requireRecord(value, "combined observation result");
  const timing = decodeOptionalSyncGatewayTiming(record.timing, "observation timing");
  const result: SyncObservedSnapshot = {
    anchors: decodeEnsureRowAnchorsResult(record.anchors),
    snapshot: decodeSnapshot(record.snapshot, expectedRoute, expectedHeaders),
  };
  return timing === undefined ? result : { ...result, timing };
}

function decodeSnapshot(
  value: unknown,
  expectedRoute?: ReadSyncSnapshotRequest,
  expectedHeaders?: readonly string[],
): SyncGatewaySnapshot {
  const record = requireRecord(value, "snapshot result");
  const protocolVersion = requireSyncGatewayText(
    record.protocolVersion,
    "snapshot protocolVersion",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  if (protocolVersion !== SYNC_GATEWAY_PROTOCOL_VERSIONS.V1) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      "snapshot protocolVersion is unsupported",
    );
  }
  const projection = requireSyncGatewayProjection(
    record.projection,
    "snapshot projection",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  if (
    expectedRoute !== undefined &&
    (record.sheetName !== expectedRoute.sheetName ||
      record.registeredRange !== expectedRoute.registeredRange ||
      record.projection !== expectedRoute.projection ||
      record.schemaVersion !== expectedRoute.schemaVersion)
  ) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      "snapshot route does not match the requested registered projection",
    );
  }
  const headers = decodeStringArray(record.headers, "snapshot headers");
  if (
    expectedHeaders !== undefined &&
    (headers.length !== expectedHeaders.length || headers.some((header, index) => header !== expectedHeaders[index]))
  ) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      "snapshot headers do not match the registered schema",
    );
  }
  const rows = decodeSnapshotRows(record.rows, expectedHeaders);
  return {
    protocolVersion,
    sheetName: requireSyncGatewayText(
      record.sheetName,
      "snapshot sheetName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    registeredRange: requireSyncGatewayText(
      record.registeredRange,
      "snapshot registeredRange",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    projection,
    schemaVersion: requireSyncGatewayPositiveSafeInteger(
      record.schemaVersion,
      "snapshot schemaVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    headers,
    rows,
    snapshotHash: requireSyncGatewayText(
      record.snapshotHash,
      "snapshot snapshotHash",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    unanchoredRows: decodePositiveIntegerArray(record.unanchoredRows, "snapshot unanchoredRows"),
    duplicateAnchors: decodeDuplicateAnchors(record.duplicateAnchors),
  };
}

function decodeSnapshotRows(
  value: unknown,
  expectedHeaders?: readonly string[],
): SyncGatewaySnapshot["rows"] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      "snapshot rows must be an array",
    );
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, "snapshot row[" + index + "]");
    return {
      rowNumber: requireSyncGatewayPositiveSafeInteger(
        record.rowNumber,
        "snapshot row[" + index + "].rowNumber",
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
      ),
      physicalAnchor: decodePresenceString(
        record.physicalAnchor,
        "snapshot row[" + index + "].physicalAnchor",
      ),
      visibleRevision: decodePresenceNonNegativeInteger(
        record.visibleRevision,
        "snapshot row[" + index + "].visibleRevision",
      ),
      visibleHash: decodePresenceString(
        record.visibleHash,
        "snapshot row[" + index + "].visibleHash",
      ),
      cells: decodeSnapshotCells(record.cells, index, expectedHeaders),
    };
  });
}

function decodeSnapshotCells(
  value: unknown,
  rowIndex: number,
  expectedHeaders?: readonly string[],
): Readonly<Record<string, SyncGatewaySnapshot["rows"][number]["cells"][string]>> {
  const record = requireRecord(value, "snapshot row[" + rowIndex + "].cells");
  if (expectedHeaders !== undefined) {
    const expected = new Set(expectedHeaders);
    const actual = Object.keys(record);
    if (actual.length !== expected.size || actual.some((fieldName) => !expected.has(fieldName))) {
      return invalidOperationResponse(
        "Apps Script observation operation",
        "snapshot row[" + rowIndex + "].cells do not match the registered schema",
      );
    }
  }
  const cells: Record<string, SyncGatewaySnapshot["rows"][number]["cells"][string]> = {};
  for (const [fieldName, rawCell] of Object.entries(record)) {
    const cell = requireRecord(rawCell, "snapshot cell " + fieldName);
    const cellKind = requireSyncGatewayText(
      cell.cellKind,
      "snapshot cell " + fieldName + " cellKind",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    );
    if (!isCellObservationKind(cellKind)) {
      return invalidOperationResponse(
        "Apps Script observation operation",
        "snapshot cell " + fieldName + " kind is unsupported",
      );
    }
    cells[fieldName] = {
      cellKind,
      normalizedCell: decodeNormalizedCell(cell.normalizedCell, fieldName),
      formulaHash: decodePresenceString(cell.formulaHash, fieldName + ".formulaHash"),
      mergeRange: decodePresenceString(cell.mergeRange, fieldName + ".mergeRange"),
      errorCode: decodePresenceString(cell.errorCode, fieldName + ".errorCode"),
      stableHash: decodePresenceString(cell.stableHash, fieldName + ".stableHash"),
    };
  }
  return cells;
}

function decodeNormalizedCell(value: unknown, label: string): NormalizedCell {
  if (isNormalizedCell(value)) return value;
  return invalidOperationResponse(
    "Apps Script observation operation",
    label + " normalizedCell is invalid",
  );
}


function decodeDuplicateAnchors(value: unknown): SyncGatewaySnapshot["duplicateAnchors"] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      "duplicateAnchors must be an array",
    );
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, "duplicateAnchors[" + index + "]");
    return {
      anchor: requireSyncGatewayText(
        record.anchor,
        "duplicateAnchors[" + index + "].anchor",
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
      ),
      rowNumbers: decodePositiveIntegerArray(
        record.rowNumbers,
        "duplicateAnchors[" + index + "].rowNumbers",
      ),
    };
  });
}

function decodePositiveIntegerArray(value: unknown, label: string): readonly number[] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      label + " must be an array",
    );
  }
  return value.map((entry, index) =>
    requireSyncGatewayPositiveSafeInteger(
      entry,
      label + "[" + index + "]",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ));
}

function decodeStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      label + " must be an array",
    );
  }
  const values = value.map((entry, index) =>
    requireSyncGatewayText(
      entry,
      label + "[" + index + "]",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ));
  if (new Set(values).size !== values.length) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      label + " contains a duplicate",
    );
  }
  return values;
}

function isCellObservationKind(value: string): value is CellObservationKind {
  return value === CELL_OBSERVATION_KINDS.BLANK ||
    value === CELL_OBSERVATION_KINDS.LITERAL ||
    value === CELL_OBSERVATION_KINDS.FORMULA ||
    value === CELL_OBSERVATION_KINDS.MERGED ||
    value === CELL_OBSERVATION_KINDS.ERROR;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  return requireOperationRecord(value, label, "Apps Script observation operation");
}

/**
 * Self-contained V8 operation source. Observation only reads the registered
 * range, while anchor assignment is the sole metadata mutation in this path.
 */
const OBSERVATION_OPERATION_SOURCE = String.raw`function (spreadsheet, args) {
  var ANCHOR_KEY = "typed_sheets_sync_anchor";
  var MODES = { ENSURE: "ensureRowAnchors", SNAPSHOT: "readSnapshot", OBSERVE: "observeSnapshot" };
  var phases = [];
  var operationStartedAt = Date.now();
  var lockStartedAt = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error("Could not acquire the sync observation gateway lock");
  phase_("lock_acquire", lockStartedAt);
  try {
    var validationStartedAt = Date.now();
    requireObject_(args, "observation operation args");
    phase_("validate_input", validationStartedAt);
    var sheetLookupStartedAt = Date.now();
    var sheet = spreadsheet.getSheetByName(args.sheetName);
    if (sheet === null) throw new Error("Registered sync sheet does not exist: " + args.sheetName);
    phase_("sheet_lookup", sheetLookupStartedAt);
    var layoutStartedAt = Date.now();
    var layout = readLayout_(sheet, args.registeredRange);
    phase_("layout_read", layoutStartedAt);
    if (args.mode === MODES.ENSURE) return ensureAnchors_(sheet, layout, args.checkboxHeaders);
    if (args.mode === MODES.SNAPSHOT) return readSnapshot_(sheet, layout, args.checkboxHeaders, args);
    if (args.mode === MODES.OBSERVE) {
      var observed = observeSnapshot_(sheet, layout, args.checkboxHeaders, args);
      observed.timing = {
        operationKinds: [],
        operationCounts: { append: 0, update: 0, delete: 0 },
        durationMs: Date.now() - operationStartedAt,
        phases: phases,
      };
      return observed;
    }
    throw new Error("unsupported observation operation mode");
  } finally {
    lock.releaseLock();
  }

  function readLayout_(targetSheet, registeredRange) {
    var parsed = parseRange_(registeredRange);
    var headerValues = targetSheet.getRange(1, parsed.startColumn, 1, parsed.columnCount).getValues()[0];
    var headers = [];
    var positions = Object.create(null);
    headerValues.forEach(function (header, index) {
      if (typeof header !== "string" || header.trim() === "") throw new Error("registered header is invalid");
      if (positions[header] !== undefined) throw new Error("registered headers contain a duplicate");
      headers.push(header);
      positions[header] = index;
    });
    var checkboxIndexes = Object.create(null);
    (args.checkboxHeaders || []).forEach(function (header) {
      var index = headers.indexOf(header);
      if (index < 0) throw new Error("checkbox header is not registered: " + header);
      checkboxIndexes[index] = true;
    });
    return { startColumn: parsed.startColumn, columnCount: parsed.columnCount, headers: headers, positions: positions, checkboxIndexes: checkboxIndexes };
  }

  function ensureAnchors_(targetSheet, targetLayout) {
    var lastRow = targetSheet.getLastRow();
    var anchorsByRow = readAnchorIndex_(targetSheet);
    var values = lastRow > 1
      ? targetSheet.getRange(2, targetLayout.startColumn, lastRow - 1, targetLayout.columnCount).getValues()
      : [];
    return ensureAnchorsFromValues_(targetSheet, targetLayout, values, anchorsByRow);
  }

  function ensureAnchorsFromValues_(targetSheet, targetLayout, values, anchorsByRow) {
    var assigned = 0;
    var existing = 0;
    values.forEach(function (row, offset) {
      if (isBlankRow_(row, targetLayout.checkboxIndexes)) return;
      var rowNumber = offset + 2;
      var anchors = anchorsByRow[rowNumber] || [];
      if (anchors.length > 1) throw new Error("row has multiple sync anchors: " + rowNumber);
      if (anchors.length === 0) {
        var anchor = "sync-anchor:" + Utilities.getUuid();
        targetSheet.getRange(rowNumber + ":" + rowNumber).addDeveloperMetadata(
          ANCHOR_KEY, anchor, SpreadsheetApp.DeveloperMetadataVisibility.PROJECT,
        );
        anchorsByRow[rowNumber] = [anchor];
        assigned += 1;
      } else {
        existing += 1;
      }
    });
    return {
      assigned: assigned,
      existing: existing,
      duplicateAnchors: duplicateAnchorsForRows_(values, targetLayout.checkboxIndexes, anchorsByRow),
    };
  }

  function observeSnapshot_(targetSheet, targetLayout, unusedCheckboxHeaders, request) {
    var lastRowStartedAt = Date.now();
    var lastRow = Math.max(targetSheet.getLastRow(), 1);
    phase_("last_row_read", lastRowStartedAt);
    var valuesReadStartedAt = Date.now();
    var range = targetSheet.getRange(1, targetLayout.startColumn, lastRow, targetLayout.columnCount);
    var values = range.getValues();
    phase_("values_read", valuesReadStartedAt);
    var metadataReadStartedAt = Date.now();
    var anchorsByRow = readAnchorIndex_(targetSheet);
    phase_("anchor_metadata_read", metadataReadStartedAt);
    var anchorAssignmentStartedAt = Date.now();
    var anchorResult = ensureAnchorsFromValues_(
      targetSheet,
      targetLayout,
      values.slice(1),
      anchorsByRow,
    );
    phase_("anchor_assignment", anchorAssignmentStartedAt);
    var snapshotStartedAt = Date.now();
    var snapshot = readSnapshot_(targetSheet, targetLayout, unusedCheckboxHeaders, request, {
      lastRow: lastRow,
      range: range,
      values: values,
      anchorsByRow: anchorsByRow,
    });
    phase_("snapshot_build", snapshotStartedAt);
    return {
      anchors: anchorResult,
      snapshot: snapshot,
    };
  }

  function readSnapshot_(targetSheet, targetLayout, unusedCheckboxHeaders, request, prepared) {
    var lastRow = prepared ? prepared.lastRow : Math.max(targetSheet.getLastRow(), 1);
    var range = prepared && prepared.range
      ? prepared.range
      : targetSheet.getRange(1, targetLayout.startColumn, lastRow, targetLayout.columnCount);
    var values = prepared && prepared.values ? prepared.values : range.getValues();
    var lightweight = request.readMode === "user_input";
    var formulasStartedAt = Date.now();
    var formulas = lightweight ? null : range.getFormulas();
    phase_("formulas_read", formulasStartedAt);
    var displayValuesStartedAt = Date.now();
    var displayValues = lightweight ? null : range.getDisplayValues();
    phase_("display_values_read", displayValuesStartedAt);
    var mergedRangesStartedAt = Date.now();
    var merged = lightweight ? null : mergedCellMap_(range);
    phase_("merged_ranges_read", mergedRangesStartedAt);
    var anchorsByRow = prepared && prepared.anchorsByRow
      ? prepared.anchorsByRow
      : readAnchorIndex_(targetSheet);
    var rows = [];
    var unanchoredRows = [];
    var anchorRows = Object.create(null);
    var rowNormalizationStartedAt = Date.now();
    for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
      if (isBlankRow_(values[rowIndex], targetLayout.checkboxIndexes)) continue;
      var rowNumber = rowIndex + 1;
      var anchors = anchorsByRow[rowNumber] || [];
      var anchor = anchors.length === 1 ? anchors[0] : null;
      if (anchors.length > 1) throw new Error("row has multiple sync anchors: " + rowNumber);
      if (anchor === null) unanchoredRows.push(rowNumber);
      else {
        if (!anchorRows[anchor]) anchorRows[anchor] = [];
        anchorRows[anchor].push(rowNumber);
      }
      var cells = Object.create(null);
      targetLayout.headers.forEach(function (header, columnIndex) {
        var coordinate = rowNumber + ":" + (targetLayout.startColumn + columnIndex);
        cells[header] = normalizeCellObservation_(
          values[rowIndex][columnIndex],
          lightweight ? "" : formulas[rowIndex][columnIndex],
          lightweight ? String(values[rowIndex][columnIndex]) : displayValues[rowIndex][columnIndex],
          lightweight ? null : merged[coordinate] || null,
          lightweight,
        );
      });
      rows.push({
        rowNumber: rowNumber,
        physicalAnchor: anchor,
        visibleRevision: null,
        visibleHash: null,
        cells: cells,
      });
    }
    phase_("row_normalization", rowNormalizationStartedAt);
    var duplicateAnchorStartedAt = Date.now();
    var duplicateAnchors = [];
    Object.keys(anchorRows).sort().forEach(function (anchor) {
      if (anchorRows[anchor].length > 1) duplicateAnchors.push({ anchor: anchor, rowNumbers: anchorRows[anchor] });
    });
    phase_("duplicate_anchor_scan", duplicateAnchorStartedAt);
    var snapshot = {
      protocolVersion: "typed-sheets-sync-v1",
      sheetName: request.sheetName,
      registeredRange: request.registeredRange,
      projection: request.projection,
      schemaVersion: request.schemaVersion,
      headers: targetLayout.headers,
      rows: rows,
    };
    var snapshotHashStartedAt = Date.now();
    var snapshotHash = codecStableHash_(snapshot);
    phase_("snapshot_hash", snapshotHashStartedAt);
    return {
      protocolVersion: snapshot.protocolVersion,
      sheetName: snapshot.sheetName,
      registeredRange: snapshot.registeredRange,
      projection: snapshot.projection,
      schemaVersion: snapshot.schemaVersion,
      headers: snapshot.headers,
      rows: snapshot.rows,
      snapshotHash: snapshotHash,
      unanchoredRows: unanchoredRows,
      duplicateAnchors: duplicateAnchors,
    };
  }

  function duplicateAnchorsForRows_(values, checkboxIndexes, anchorsByRow) {
    var grouped = Object.create(null);
    values.forEach(function (row, offset) {
      if (isBlankRow_(row, checkboxIndexes)) return;
      var anchors = anchorsByRow[offset + 2] || [];
      anchors.forEach(function (anchor) {
        if (!grouped[anchor]) grouped[anchor] = [];
        grouped[anchor].push(offset + 2);
      });
    });
    return Object.keys(grouped).sort().filter(function (anchor) { return grouped[anchor].length > 1; }).map(function (anchor) {
      return { anchor: anchor, rowNumbers: grouped[anchor] };
    });
  }

  function readAnchorIndex_(targetSheet) {
    var anchorsByRow = Object.create(null);
    targetSheet.createDeveloperMetadataFinder()
      .withKey(ANCHOR_KEY)
      .withLocationType(SpreadsheetApp.DeveloperMetadataLocationType.ROW)
      .find()
      .forEach(function (metadata) {
        var row = metadata.getLocation().getRow();
        if (row === null) return;
        var rowNumber = row.getRow();
        if (!anchorsByRow[rowNumber]) anchorsByRow[rowNumber] = [];
        anchorsByRow[rowNumber].push(String(metadata.getValue()));
      });
    Object.keys(anchorsByRow).forEach(function (rowNumber) {
      anchorsByRow[rowNumber].sort();
    });
    return anchorsByRow;
  }

  function phase_(name, phaseStartedAt) {
    phases.push({ phase: name, durationMs: Date.now() - phaseStartedAt });
  }

  function parseRange_(value) {
    if (typeof value !== "string" || !/^[A-Z]+:[A-Z]+$/.test(value)) throw new Error("registeredRange must be an uppercase whole-column range");
    var parts = value.split(":");
    var startColumn = columnNumber_(parts[0]);
    var endColumn = columnNumber_(parts[1]);
    if (endColumn < startColumn) throw new Error("registeredRange end precedes start");
    return { startColumn: startColumn, columnCount: endColumn - startColumn + 1 };
  }

  function columnNumber_(letters) {
    var value = 0;
    for (var index = 0; index < letters.length; index += 1) value = value * 26 + letters.charCodeAt(index) - 64;
    return value;
  }

  function isBlankRow_(row, checkboxIndexes) {
    return row.every(function (cell, index) {
      if (checkboxIndexes[index]) return cell === "" || cell === null || cell === false;
      return cell === "" || cell === null;
    });
  }

  function normalizeCellObservation_(rawValue, formula, displayValue, mergeRange, lightweight) {
    var formulaHash = formula ? sha256Hex_(formula) : null;
    if (mergeRange !== null) return { cellKind: "merged", normalizedCell: null, formulaHash: formulaHash, mergeRange: mergeRange, errorCode: null, stableHash: null };
    if (isDisplayedSheetError_(displayValue)) return { cellKind: "error", normalizedCell: null, formulaHash: formulaHash, mergeRange: null, errorCode: String(displayValue), stableHash: null };
    if (formula) return { cellKind: "formula", normalizedCell: null, formulaHash: formulaHash, mergeRange: null, errorCode: null, stableHash: null };
    var normalized;
    if (rawValue === "" || rawValue === null) normalized = null;
    else if (isDate_(rawValue)) normalized = { kind: "date", value: rawValue.toISOString() };
    else if (typeof rawValue === "string") normalized = { kind: "string", value: normalizeScalarString_(rawValue) };
    else if (typeof rawValue === "number" && isFinite(rawValue)) normalized = { kind: "number", value: rawValue };
    else if (typeof rawValue === "boolean") normalized = { kind: "boolean", value: rawValue };
    else return { cellKind: "error", normalizedCell: null, formulaHash: null, mergeRange: null, errorCode: "unsupported_cell_value", stableHash: null };
    return { cellKind: normalized === null ? "blank" : "literal", normalizedCell: normalized, formulaHash: null, mergeRange: null, errorCode: null, stableHash: lightweight ? null : codecStableHash_(normalized) };
  }

  function mergedCellMap_(targetRange) {
    var result = Object.create(null);
    targetRange.getMergedRanges().forEach(function (mergedRange) {
      var a1 = mergedRange.getA1Notation();
      var startRow = mergedRange.getRow();
      var startColumn = mergedRange.getColumn();
      for (var rowOffset = 0; rowOffset < mergedRange.getNumRows(); rowOffset += 1) {
        for (var columnOffset = 0; columnOffset < mergedRange.getNumColumns(); columnOffset += 1) {
          result[(startRow + rowOffset) + ":" + (startColumn + columnOffset)] = a1;
        }
      }
    });
    return result;
  }

  function isDisplayedSheetError_(value) { return typeof value === "string" && /^#(REF!|DIV\/0!|N\/A|VALUE!|NAME\?|NUM!|ERROR!|NULL!)$/.test(value); }
  function isDate_(value) { return Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime()); }
  function isCanonicalDate_(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false; var parsed = new Date(value); return !isNaN(parsed.getTime()) && parsed.toISOString() === value; }
  function isObject_(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function requireObject_(value, label) { if (!isObject_(value)) throw new Error(label + " must be an object"); return value; }
  function normalizeScalarString_(value) { return value.normalize("NFC"); }
  function sha256Hex_(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8).map(function (byte) { var unsigned = byte < 0 ? byte + 256 : byte; return ("0" + unsigned.toString(16)).slice(-2); }).join(""); }
${APPS_SCRIPT_STABLE_CODEC_SOURCE}
}`;
