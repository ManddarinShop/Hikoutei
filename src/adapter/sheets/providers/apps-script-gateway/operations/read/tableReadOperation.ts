/** Lightweight table reads for polling user-visible Sheet values. */

import type { NormalizedCell } from "../../../../../../shared/encoding/types.js";
import { isNormalizedCell } from "../../../../../../shared/encoding/normalizedCell.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
} from "../../../../../../application/sync/gateway/errors.js";
import {
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayText,
} from "../../../../../../application/sync/gateway/validation.js";
import type {
  SyncTableRow,
  SyncTableRowsResult,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import type { AppsScriptOperationDefinition } from "../../transport/operationClient.js";
import { decodeOptionalSyncGatewayTiming } from "../../protocol/timing.js";
import { invalidOperationRequest, invalidOperationResponse } from "../../errors.js";
import { requireOperationRecord } from "../../validation.js";

/** Request for one registered table's raw values. */
export interface AppsScriptReadTableRowsRequest {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly headers: readonly string[];
}

/** Builds a read-only operation that performs one range `getValues()` call. */
export function createReadTableRowsOperation(
  request: AppsScriptReadTableRowsRequest,
): AppsScriptOperationDefinition<AppsScriptReadTableRowsRequest, SyncTableRowsResult> {
  validateRequest(request);
  return {
    fn: READ_TABLE_ROWS_OPERATION_SOURCE,
    args: request,
    decode: (value) => decodeResult(value, request),
  };
}

const READ_TABLE_ROWS_OPERATION_SOURCE = String.raw`function (spreadsheet, args) {
  var startedAt = Date.now();
  var phases = [];
  var validationStartedAt = Date.now();
  if (!args || typeof args.sheetName !== "string" || args.sheetName.length === 0) {
    throw new Error("table read sheetName is required");
  }
  if (!Array.isArray(args.headers) || args.headers.length === 0) {
    throw new Error("table read headers are required");
  }
  phase_("validate_input", validationStartedAt);

  var sheetLookupStartedAt = Date.now();
  var sheet = spreadsheet.getSheetByName(args.sheetName);
  if (sheet === null) throw new Error("table read sheet was not found: " + args.sheetName);
  phase_("sheet_lookup", sheetLookupStartedAt);

  var rangeStartedAt = Date.now();
  var parsed = parseRange_(args.registeredRange);
  var lastRow = Math.max(sheet.getLastRow(), 1);
  phase_("range_lookup", rangeStartedAt);

  var valuesStartedAt = Date.now();
  var values = lastRow > 1
    ? sheet.getRange(2, parsed.startColumn, lastRow - 1, parsed.columnCount).getValues()
    : [];
  phase_("values_read", valuesStartedAt);

  var rowsStartedAt = Date.now();
  var rows = [];
  values.forEach(function (row, offset) {
    if (isBlankRow_(row)) return;
    var fields = Object.create(null);
    args.headers.forEach(function (header, columnIndex) {
      fields[header] = toNormalizedCell_(row[columnIndex]);
    });
    rows.push({ rowNumber: offset + 2, fields: fields });
  });
  phase_("row_normalization", rowsStartedAt);

  return {
    sheetName: args.sheetName,
    registeredRange: args.registeredRange,
    headers: args.headers,
    rows: rows,
    timing: {
      operationKinds: [],
      operationCounts: { append: 0, update: 0, delete: 0 },
      durationMs: Date.now() - startedAt,
      phases: phases,
    },
  };

  function parseRange_(value) {
    if (typeof value !== "string" || !/^[A-Z]+:[A-Z]+$/.test(value)) {
      throw new Error("table read registeredRange must be an uppercase whole-column range");
    }
    var parts = value.split(":");
    var startColumn = columnNumber_(parts[0]);
    var endColumn = columnNumber_(parts[1]);
    if (endColumn < startColumn) throw new Error("table read range end precedes start");
    return { startColumn: startColumn, columnCount: endColumn - startColumn + 1 };
  }

  function columnNumber_(letters) {
    var value = 0;
    for (var index = 0; index < letters.length; index += 1) {
      value = value * 26 + letters.charCodeAt(index) - 64;
    }
    return value;
  }

  function isBlankRow_(row) {
    return row.every(function (cell) { return cell === "" || cell === null; });
  }

  function toNormalizedCell_(value) {
    if (value === "" || value === null || value === undefined) return null;
    if (Object.prototype.toString.call(value) === "[object Date]") {
      if (isNaN(value.getTime())) throw new Error("table read date value is invalid");
      return { kind: "date", value: value.toISOString() };
    }
    if (typeof value === "string") return { kind: "string", value: value.normalize("NFC") };
    if (typeof value === "number" && isFinite(value)) return { kind: "number", value: value };
    if (typeof value === "boolean") return { kind: "boolean", value: value };
    throw new Error("table read cell value is unsupported");
  }

  function phase_(name, phaseStartedAt) {
    phases.push({ phase: name, durationMs: Date.now() - phaseStartedAt });
  }
}`;

function validateRequest(request: AppsScriptReadTableRowsRequest): void {
  if (request.sheetName.trim().length === 0) {
    invalidOperationRequest("Apps Script table read", "sheetName is required");
  }
  if (!/^[A-Z]+:[A-Z]+$/.test(request.registeredRange)) {
    invalidOperationRequest(
      "Apps Script table read",
      "registeredRange must be an uppercase whole-column range",
    );
  }
  if (request.headers.length === 0 || request.headers.some((header) => header.trim().length === 0)) {
    invalidOperationRequest("Apps Script table read", "headers must contain non-empty names");
  }
  if (new Set(request.headers).size !== request.headers.length) {
    invalidOperationRequest("Apps Script table read", "headers must not contain duplicates");
  }
}

function decodeResult(value: unknown, request: AppsScriptReadTableRowsRequest): SyncTableRowsResult {
  const record = requireRecord(value, "table read result");
  const headers = decodeHeaders(record.headers);
  if (headers.length !== request.headers.length || headers.some((header, index) => header !== request.headers[index])) {
    invalidOperationResponse("Apps Script table read", "headers do not match the registered route");
  }
  if (!Array.isArray(record.rows)) {
    invalidOperationResponse("Apps Script table read", "rows must be an array");
  }
  const timing = decodeOptionalSyncGatewayTiming(record.timing, "table read timing");
  const result: SyncTableRowsResult = {
    sheetName: requireSyncGatewayText(
      record.sheetName,
      "table read result sheetName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    registeredRange: requireSyncGatewayText(
      record.registeredRange,
      "table read result registeredRange",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    headers,
    rows: record.rows.map((row, index) => decodeRow(row, index, headers)),
  };
  return timing === undefined ? result : { ...result, timing };
}

function decodeRow(value: unknown, index: number, headers: readonly string[]): SyncTableRow {
  const record = requireRecord(value, "table read row[" + index + "]");
  const fields = requireRecord(record.fields, "table read row[" + index + "].fields");
  const decoded: Record<string, NormalizedCell> = {};
  for (const header of headers) decoded[header] = decodeCell(fields[header], header, index);
  return {
    rowNumber: requireSyncGatewayPositiveSafeInteger(
      record.rowNumber,
      "table read row[" + index + "].rowNumber",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    fields: decoded,
  };
}

function decodeCell(value: unknown, header: string, rowIndex: number): NormalizedCell {
  if (isNormalizedCell(value)) return value;
  return invalidOperationResponse(
    "Apps Script table read",
    "table read row[" + rowIndex + "]." + header + " is not a normalized cell",
  );
}

function decodeHeaders(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse("Apps Script table read", "headers must be an array");
  }
  return value.map((header, index) => requireSyncGatewayText(
    header,
    "table read headers[" + index + "]",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  ));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  return requireOperationRecord(value, label, "Apps Script table read");
}
