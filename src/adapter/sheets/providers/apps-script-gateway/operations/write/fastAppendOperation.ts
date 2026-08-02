/** Typed fast-append operation executed by the current thin `Code.gs`. */

import {
  type FastAppendRowResult,
  type FastAppendRowsResult,
  type FastAppendRow,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import { SYNC_GATEWAY_FAST_APPEND_STATUSES } from "../../../../../../application/sync/gateway/constants.js";
import type {
  AppsScriptOperationDefinition,
} from "../../transport/operationClient.js";
import { decodeOptionalSyncGatewayTiming } from "../../protocol/timing.js";
import {
  invalidOperationRequest,
  invalidOperationResponse,
} from "../../errors.js";
import { isNormalizedCell } from "../../../../../../shared/encoding/normalizedCell.js";
import { isRecord } from "../../../../../../shared/encoding/typeGuards.js";

/** Arguments sent to the self-contained fast-append function in `Code.gs`. */
export type AppsScriptFastAppendOperationArgs = {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly headers: readonly string[];
  readonly rows: readonly FastAppendRow[];
};

/** Input required to create one thin-Gateway fast-append operation. */
export interface AppsScriptFastAppendOperationRequest
  extends AppsScriptFastAppendOperationArgs {}

/** A typed operation definition for one contiguous Sheet range write. */
export type AppsScriptFastAppendOperation = AppsScriptOperationDefinition<
  AppsScriptFastAppendOperationArgs,
  FastAppendRowsResult
>;

/**
 * Builds one operation that appends all supplied rows with one `setValues()`.
 *
 * The remote function intentionally does not read or write Developer Metadata,
 * receipts, snapshots, or CAS state. `Code.gs` performs one final `flush()` for
 * the whole request; reconciliation remains responsible for later drift repair.
 */
export function createFastAppendRowsOperation(
  request: AppsScriptFastAppendOperationRequest,
): AppsScriptFastAppendOperation {
  validateFastAppendRequest(request);
  return {
    fn: FAST_APPEND_OPERATION_SOURCE,
    args: request,
    decode: (value) => decodeFastAppendResult(value, request.rows),
  };
}

/** Self-contained V8 function source restored by `Code.gs` with `eval`. */
const FAST_APPEND_OPERATION_SOURCE = `function (spreadsheet, args) {
  var startedAt = Date.now();
  var phases = [];
  var validationStartedAt = Date.now();
  if (!args || typeof args.sheetName !== "string" || args.sheetName.length === 0) {
    throw new Error("fast append sheetName is required");
  }
  if (typeof args.registeredRange !== "string" || !/^[A-Z]+:[A-Z]+$/.test(args.registeredRange)) {
    throw new Error("fast append registeredRange must be an uppercase whole-column range");
  }
  if (!Array.isArray(args.headers) || args.headers.length === 0) {
    throw new Error("fast append headers are required");
  }
  if (!Array.isArray(args.rows)) {
    throw new Error("fast append rows must be an array");
  }
  var range = parseRange_(args.registeredRange);
  if (range.columnCount !== args.headers.length) {
    throw new Error("fast append headers do not match registeredRange");
  }
  phase_("validate_input", validationStartedAt);

  var sheetLookupStartedAt = Date.now();
  var sheet = spreadsheet.getSheetByName(args.sheetName);
  if (sheet === null) throw new Error("fast append sheet was not found: " + args.sheetName);
  phase_("sheet_lookup", sheetLookupStartedAt);
  if (args.rows.length === 0) return result_([], false);

  var encodeStartedAt = Date.now();
  var values = args.rows.map(function (row) {
    if (!row || typeof row.effectId !== "string" || row.effectId.length === 0) {
      throw new Error("fast append effectId is required");
    }
    if (!row.fields || typeof row.fields !== "object") {
      throw new Error("fast append fields are required");
    }
    var fieldNames = Object.keys(row.fields).sort();
    var expectedFieldNames = args.headers.slice().sort();
    if (fieldNames.length !== expectedFieldNames.length || fieldNames.some(function (field, index) {
      return field !== expectedFieldNames[index];
    })) {
      throw new Error("fast append row fields do not match headers");
    }
    return args.headers.map(function (header) {
      return toSheetValue_(row.fields[header]);
    });
  });
  phase_("encode_values", encodeStartedAt);

  var rangeStartedAt = Date.now();
  var startRow = Math.max(sheet.getLastRow() + 1, 2);
  phase_("append_range_lookup", rangeStartedAt);
  var writeStartedAt = Date.now();
  sheet.getRange(startRow, range.startColumn, values.length, range.columnCount).setValues(values);
  phase_("set_values", writeStartedAt);
  return result_(args.rows.map(function (row) {
    return { effectId: row.effectId, status: "applied" };
  }), false, startRow);

  function result_(results, hasMore, startRowValue) {
    var result = {
      results: results,
      hasMore: hasMore,
      timing: {
        operationKinds: ["append"],
        operationCounts: { append: results.length, update: 0, delete: 0 },
        durationMs: Date.now() - startedAt,
        phases: phases,
      },
    };
    if (startRowValue !== undefined) result.startRow = startRowValue;
    return result;
  }

  function parseRange_(value) {
    var parts = value.split(":");
    var startColumn = columnNumber_(parts[0]);
    var endColumn = columnNumber_(parts[1]);
    if (endColumn < startColumn) throw new Error("fast append range end precedes start");
    return { startColumn: startColumn, columnCount: endColumn - startColumn + 1 };
  }

  function columnNumber_(letters) {
    var value = 0;
    for (var index = 0; index < letters.length; index += 1) value = value * 26 + letters.charCodeAt(index) - 64;
    return value;
  }

  function isCanonicalDate_(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    var parsed = new Date(value);
    return !isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }

  function phase_(name, phaseStartedAt) {
    phases.push({ phase: name, durationMs: Date.now() - phaseStartedAt });
  }

  function toSheetValue_(cell) {
    if (cell === null || cell === undefined) return "";
    if (typeof cell !== "object" || typeof cell.kind !== "string") {
      throw new Error("fast append cell is invalid");
    }
    if (cell.kind === "string") {
      if (typeof cell.value !== "string") throw new Error("fast append text cell is invalid");
      return cell.value;
    }
    if (cell.kind === "date") {
      if (!isCanonicalDate_(cell.value)) throw new Error("fast append date cell is invalid");
      return new Date(cell.value);
    }
    if (cell.kind === "number") {
      if (typeof cell.value !== "number" || !isFinite(cell.value)) {
        throw new Error("fast append number cell is invalid");
      }
      return cell.value;
    }
    if (cell.kind === "boolean") {
      if (typeof cell.value !== "boolean") throw new Error("fast append boolean cell is invalid");
      return cell.value;
    }
    throw new Error("fast append cell kind is unsupported");
  }
}`;

function validateFastAppendRequest(request: AppsScriptFastAppendOperationRequest): void {
  if (request.sheetName.trim().length === 0) {
    invalidOperationRequest("fast append operation", "sheetName is required");
  }
  if (!/^[A-Z]+:[A-Z]+$/.test(request.registeredRange)) {
    invalidOperationRequest(
      "fast append operation",
      "registeredRange must be an uppercase whole-column range",
    );
  }
  if (request.headers.length === 0 || request.headers.some((header) => header.trim().length === 0)) {
    invalidOperationRequest(
      "fast append operation",
      "headers must contain non-empty names",
    );
  }
  if (new Set(request.headers).size !== request.headers.length) {
    invalidOperationRequest("fast append operation", "headers must not contain duplicates");
  }
  const [start, end] = request.registeredRange.split(":");
  if (columnNumber(end) < columnNumber(start) || columnNumber(end) - columnNumber(start) + 1 !== request.headers.length) {
    invalidOperationRequest("fast append operation", "headers must match registeredRange");
  }
  const effectIds = new Set<string>();
  for (const row of request.rows) {
    if (row.effectId.trim().length === 0) {
      invalidOperationRequest("fast append operation", "every row needs an effectId");
    }
    if (effectIds.has(row.effectId)) {
      invalidOperationRequest("fast append operation", "row effectIds must be unique");
    }
    effectIds.add(row.effectId);
    const fieldNames = Object.keys(row.fields).sort();
    const expectedFieldNames = [...request.headers].sort();
    if (fieldNames.length !== expectedFieldNames.length || fieldNames.some((field, index) => field !== expectedFieldNames[index])) {
      invalidOperationRequest("fast append operation", "every row must contain exactly the registered headers");
    }
    for (const cell of Object.values(row.fields)) {
      if (!isNormalizedCell(cell)) {
        invalidOperationRequest(
          "fast append operation",
          "rows contain an unsupported normalized cell",
        );
      }
    }
  }
}

function columnNumber(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 0;
  let result = 0;
  for (const letter of value) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function decodeFastAppendResult(
  value: unknown,
  expectedRows: readonly FastAppendRow[],
): FastAppendRowsResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    value.results.length !== expectedRows.length ||
    value.hasMore !== false
  ) {
    invalidOperationResponse(
      "fast append operation",
      "result must contain results and hasMore=false",
    );
  }
  const timing = decodeOptionalSyncGatewayTiming(value.timing, "fast append timing");
  const results = value.results.map(decodeFastAppendRowResult);
  const expectedEffectIds = new Set(expectedRows.map((row) => row.effectId));
  const actualEffectIds = new Set(results.map((row) => row.effectId));
  if (
    actualEffectIds.size !== results.length ||
    actualEffectIds.size !== expectedEffectIds.size ||
    results.some((row) => !expectedEffectIds.has(row.effectId))
  ) {
    return invalidOperationResponse(
      "fast append operation",
      "result effectIds do not match the submitted rows",
    );
  }
  const result: FastAppendRowsResult = { results, hasMore: false };
  return timing === undefined ? result : { ...result, timing };
}

function decodeFastAppendRowResult(value: unknown): FastAppendRowResult {
  if (
    !isRecord(value) ||
    typeof value.effectId !== "string" ||
    value.status !== SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED
  ) {
    invalidOperationResponse(
      "fast append operation",
      "result contains an invalid fast-append row",
    );
  }
  return {
    effectId: value.effectId,
    status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED,
  };
}
