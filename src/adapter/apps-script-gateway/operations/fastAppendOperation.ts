/** Typed fast-append operation executed by the current thin `Code.gs`. */

import {
  type FastAppendRowResult,
  type FastAppendRowsResult,
  type FastAppendRow,
} from "../../../runtime/gateway/syncGateway.js";
import { SYNC_GATEWAY_FAST_APPEND_STATUSES } from "../../../runtime/gateway/constants.js";
import type {
  AppsScriptOperationDefinition,
} from "../transport/operationClient.js";
import { decodeOptionalSyncGatewayTiming } from "../protocol/timing.js";
import {
  invalidOperationRequest,
  invalidOperationResponse,
} from "../errors.js";
import type { NormalizedCell } from "../../../core/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "../../../core/encoding/constants.js";
import { isRecord } from "../../../core/encoding/typeGuards.js";

/** Arguments sent to the self-contained fast-append function in `Code.gs`. */
export type AppsScriptFastAppendOperationArgs = {
  readonly sheetName: string;
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
    decode: (value) => decodeFastAppendResult(value, request.rows.length),
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
  if (!Array.isArray(args.headers) || args.headers.length === 0) {
    throw new Error("fast append headers are required");
  }
  if (!Array.isArray(args.rows)) {
    throw new Error("fast append rows must be an array");
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
    return args.headers.map(function (header) {
      return toSheetValue_(row.fields[header]);
    });
  });
  phase_("encode_values", encodeStartedAt);

  var rangeStartedAt = Date.now();
  var startRow = Math.max(sheet.getLastRow() + 1, 2);
  phase_("append_range_lookup", rangeStartedAt);
  var writeStartedAt = Date.now();
  sheet.getRange(startRow, 1, values.length, args.headers.length).setValues(values);
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

  function phase_(name, phaseStartedAt) {
    phases.push({ phase: name, durationMs: Date.now() - phaseStartedAt });
  }

  function toSheetValue_(cell) {
    if (cell === null || cell === undefined) return "";
    if (typeof cell !== "object" || typeof cell.kind !== "string") {
      throw new Error("fast append cell is invalid");
    }
    if (cell.kind === "string" || cell.kind === "date") {
      if (typeof cell.value !== "string") throw new Error("fast append text cell is invalid");
      return cell.value;
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
  if (request.headers.length === 0 || request.headers.some((header) => header.trim().length === 0)) {
    invalidOperationRequest(
      "fast append operation",
      "headers must contain non-empty names",
    );
  }
  if (new Set(request.headers).size !== request.headers.length) {
    invalidOperationRequest("fast append operation", "headers must not contain duplicates");
  }
  for (const row of request.rows) {
    if (row.effectId.trim().length === 0) {
      invalidOperationRequest("fast append operation", "every row needs an effectId");
    }
    for (const cell of Object.values(row.fields)) {
      if (!isSupportedNormalizedCell(cell)) {
        invalidOperationRequest(
          "fast append operation",
          "rows contain an unsupported normalized cell",
        );
      }
    }
  }
}

function decodeFastAppendResult(value: unknown, expectedCount: number): FastAppendRowsResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.results) ||
    value.results.length !== expectedCount ||
    value.hasMore !== false
  ) {
    invalidOperationResponse(
      "fast append operation",
      "result must contain results and hasMore=false",
    );
  }
  const timing = decodeOptionalSyncGatewayTiming(value.timing, "fast append timing");
  const result: FastAppendRowsResult = {
    results: value.results.map(decodeFastAppendRowResult),
    hasMore: false,
  };
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

function isSupportedNormalizedCell(value: NormalizedCell): boolean {
  if (value === null) return true;
  if (value.kind === NORMALIZED_CELL_KINDS.STRING || value.kind === NORMALIZED_CELL_KINDS.DATE) {
    return typeof value.value === "string";
  }
  if (value.kind === NORMALIZED_CELL_KINDS.NUMBER) {
    return Number.isFinite(value.value);
  }
  return value.kind === NORMALIZED_CELL_KINDS.BOOLEAN && typeof value.value === "boolean";
}
