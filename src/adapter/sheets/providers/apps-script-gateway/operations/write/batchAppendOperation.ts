/** Idempotent append operation executed through the Apps Script eval gateway. */

import type {
  FastAppendRow,
  FastAppendRowsResult,
  SyncGatewayAuthority,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import { SYNC_GATEWAY_FAST_APPEND_STATUSES } from "../../../../../../application/sync/gateway/constants.js";
import type { AppsScriptOperationDefinition } from "../../transport/operationClient.js";
import { decodeOptionalSyncGatewayTiming } from "../../protocol/timing.js";
import { invalidOperationRequest, invalidOperationResponse } from "../../errors.js";
import { isNormalizedCell } from "../../../../../../shared/encoding/normalizedCell.js";
import { isRecord } from "../../../../../../shared/encoding/typeGuards.js";

export interface AppsScriptBatchAppendOperationArgs {
  readonly authority?: SyncGatewayAuthority;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly headers: readonly string[];
  readonly identityField: string;
  readonly rows: readonly FastAppendRow[];
}

export type AppsScriptBatchAppendOperation = AppsScriptOperationDefinition<
  AppsScriptBatchAppendOperationArgs,
  FastAppendRowsResult
>;

/**
 * Builds an idempotent append operation backed by built-in Apps Script
 * services only (SpreadsheetApp, LockService, PropertiesService, Utilities);
 * no Advanced Sheets dependency is required. The data rows and their Gateway
 * receipts are written under one script lock, but the target write and the
 * receipt write are separate flush() calls, so a crash between them can leave
 * a target row without a receipt; this is not a cross-request atomic batch.
 * A lost HTTP response is recovered by replaying the same effect ID: the
 * replay verifies the target row postcondition and returns applied without
 * adding another row, while a reused effect ID with a different payload hash
 * fails closed.
 *
 * The registered identityField is required because this path never
 * materializes anchor metadata: replay and postcondition verification locate
 * the target row through the identity column and fail closed when the
 * identity is missing or ambiguous instead of guessing at a position.
 */
export function createBatchAppendRowsOperation(
  request: AppsScriptBatchAppendOperationArgs,
): AppsScriptBatchAppendOperation {
  validateBatchAppendRequest(request);
  return {
    fn: BATCH_APPEND_OPERATION_SOURCE,
    args: request,
    decode: (value) => decodeBatchAppendResult(value, request.rows),
  };
}

/** Self-contained V8 source restored by Code.gs with eval. */
const BATCH_APPEND_OPERATION_SOURCE = String.raw`function (spreadsheet, args) {
  var RECEIPT_SHEET_NAME = "__typed_sheets_internal_effect_receipts";
  var RECEIPT_HEADERS = ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"];
  var phases = [];
  validateInput_();
  var lockStartedAt = Date.now();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error("Could not acquire the sync effect gateway lock");
  try {
    var result = run_();
    appendPhase_(result, "script_lock", Date.now() - lockStartedAt);
    return result;
  } finally {
    lock.releaseLock();
  }

  function run_() {
    var startedAt = Date.now();
    validateInput_();
    assertAuthority_(spreadsheet);
    phase_("validate_input", startedAt);

    var lookupStartedAt = Date.now();
    var sheet = spreadsheet.getSheetByName(args.sheetName);
    if (sheet === null) throw new Error("batch append sheet was not found: " + args.sheetName);
    var range = parseRange_(args.registeredRange);
    if (range.columnCount !== args.headers.length) throw new Error("batch append headers do not match registeredRange");
    var remoteHeaders = sheet.getRange(1, range.startColumn, 1, range.columnCount).getValues()[0];
    args.headers.forEach(function (header, index) {
      if (String(remoteHeaders[index]) !== String(header)) {
        throw new Error("batch append remote headers do not match registered schema at column " + (index + 1));
      }
    });
    var receiptSheet = ensureReceiptSheet_(spreadsheet);
    phase_("sheet_and_receipt_lookup", lookupStartedAt);

    var receiptReadStartedAt = Date.now();
    var receipts = readReceipts_(receiptSheet);
    phase_("receipt_read", receiptReadStartedAt);

    var pending = [];
    var resultsById = Object.create(null);
    args.rows.forEach(function (row) {
      var payloadHash = String(row.payloadHash);
      var existing = receipts[row.effectId];
      if (existing !== undefined) {
        if (existing.payloadHash !== payloadHash) {
          throw new Error("effect ID cannot be reused with another payload: " + row.effectId);
        }
        assertReceiptPostcondition_(sheet, range, existing, row);
        resultsById[row.effectId] = {
          effectId: row.effectId,
          status: "applied",
          visibleHash: existing.visibleHash,
          visibleRevision: existing.visibleRevision,
        };
        return;
      }
      pending.push({ row: row, payloadHash: payloadHash, visibleHash: visibleHash_(row.fields) });
    });

    if (pending.length > 0) {
      var rangeStartedAt = Date.now();
      var lastRow = sheet.getLastRow();
      var startRow = Math.max(lastRow + 1, 2);
      var receiptStartRow = Math.max(receiptSheet.getLastRow() + 1, 2);
      assertIdentityAvailability_(sheet, range, lastRow, pending);
      phase_("append_range_lookup", rangeStartedAt);

      var appendStartedAt = Date.now();
      writeAppendRows_(sheet, range, startRow, pending);
      phase_("append_write", appendStartedAt);
      var appendFlushStartedAt = Date.now();
      SpreadsheetApp.flush();
      phase_("append_flush", appendFlushStartedAt);

      // The target-row write and the receipt write are two separate flush()
      // calls: a crash between them can leave a target row without a receipt.
      // This operation is not cross-request atomic, so a replay of that effect
      // fails closed on the duplicate identity guard instead of being silently
      // re-applied, and the response-loss probe contract treats a missing
      // receipt as unapplied. Receipt-backed evidence is returned only after
      // the postcondition check below re-verifies the target rows.
      var receiptStartedAt = Date.now();
      writeReceipts_(receiptSheet, receiptStartRow, pending);
      phase_("receipt_write", receiptStartedAt);
      var receiptFlushStartedAt = Date.now();
      SpreadsheetApp.flush();
      phase_("receipt_flush", receiptFlushStartedAt);

      var postconditionStartedAt = Date.now();
      assertAppendPostcondition_(sheet, range, pending);
      phase_("postcondition", postconditionStartedAt);
      pending.forEach(function (entry) {
        resultsById[entry.row.effectId] = {
          effectId: entry.row.effectId,
          status: "applied",
          visibleHash: entry.visibleHash,
          visibleRevision: 1,
        };
      });
    }

    var resultStartedAt = Date.now();
    var results = args.rows.map(function (row) {
      var result = resultsById[row.effectId];
      if (result === undefined) throw new Error("batch append result is missing an effect");
      return result;
    });
    phase_("result", resultStartedAt);
    return {
      results: results,
      hasMore: false,
      timing: {
        operationKinds: ["append"],
        operationCounts: { append: results.length, update: 0, delete: 0 },
        durationMs: Date.now() - startedAt,
        phases: phases
      }
    };
  }

  function validateInput_() {
    if (!args || typeof args.sheetName !== "string" || args.sheetName.length === 0) {
      throw new Error("batch append sheetName is required");
    }
    if (typeof args.registeredRange !== "string" || !/^[A-Z]+:[A-Z]+$/.test(args.registeredRange)) {
      throw new Error("batch append registeredRange is invalid");
    }
    if (!Array.isArray(args.headers) || args.headers.length === 0) {
      throw new Error("batch append headers are required");
    }
    if (args.identityField === undefined || typeof args.identityField !== "string" || args.identityField.length === 0) {
      throw new Error("batch append identityField is required");
    }
    if (args.headers.indexOf(args.identityField) < 0) {
      throw new Error("batch append identityField is not a registered header");
    }
    var seenHeaders = Object.create(null);
    args.headers.forEach(function (header) {
      if (typeof header !== "string" || header.length === 0 || seenHeaders[header]) {
        throw new Error("batch append headers are invalid or duplicated");
      }
      seenHeaders[header] = true;
    });
    if (!Array.isArray(args.rows)) throw new Error("batch append rows must be an array");
    var seenEffectIds = Object.create(null);
    var expected = args.headers.slice().sort();
    args.rows.forEach(function (row) {
      if (!row || typeof row.effectId !== "string" || row.effectId.length === 0) {
        throw new Error("batch append effectId is required");
      }
      if (seenEffectIds[row.effectId] === true) {
        throw new Error("batch append effectIds must be non-empty and unique");
      }
      seenEffectIds[row.effectId] = true;
      if (typeof row.payloadHash !== "string" || row.payloadHash.length === 0) {
        throw new Error("batch append payloadHash is required");
      }
      if (row.anchor !== undefined && (typeof row.anchor !== "string" || row.anchor.length === 0)) {
        throw new Error("batch append row anchor is invalid");
      }
      if (!row.fields || typeof row.fields !== "object") throw new Error("batch append fields are required");
      var actual = Object.keys(row.fields).sort();
      if (actual.length !== expected.length || actual.some(function (field, index) { return field !== expected[index]; })) {
        throw new Error("batch append row fields do not match headers");
      }
    });
  }

  function assertAuthority_(targetSpreadsheet) {
    if (args.authority === undefined) return;
    if (!args.authority || typeof args.authority.epoch !== "number" ||
        Math.floor(args.authority.epoch) !== args.authority.epoch || args.authority.epoch < 1 ||
        typeof args.authority.token !== "string" || args.authority.token.length === 0) {
      throw new Error("batch append authority is invalid");
    }
    var key = "typed_sheets_authority:" + targetSpreadsheet.getId();
    var properties = PropertiesService.getScriptProperties();
    var raw = properties.getProperty(key);
    var current = raw === null ? null : JSON.parse(raw);
    if (current !== null && (current.epoch > args.authority.epoch ||
        current.epoch === args.authority.epoch && current.token !== args.authority.token)) {
      throw new Error("batch append authority fence is stale");
    }
    if (current === null || args.authority.epoch > current.epoch) {
      properties.setProperty(key, JSON.stringify({ epoch: args.authority.epoch, token: args.authority.token }));
    }
  }

  function ensureReceiptSheet_(targetSpreadsheet) {
    var target = targetSpreadsheet.getSheetByName(RECEIPT_SHEET_NAME);
    if (target === null) target = targetSpreadsheet.insertSheet(RECEIPT_SHEET_NAME);
    if (target.getLastRow() === 0 && target.getLastColumn() === 0) {
      target.getRange(1, 1, 1, RECEIPT_HEADERS.length).setValues([RECEIPT_HEADERS]);
    }
    var actual = target.getRange(1, 1, 1, RECEIPT_HEADERS.length).getValues()[0];
    RECEIPT_HEADERS.forEach(function (header, index) {
      if (String(actual[index]) !== header) throw new Error("receipt sheet headers do not match");
    });
    try { if (!target.isSheetHidden()) target.hideSheet(); } catch (error) {}
    return target;
  }

  function readReceipts_(target) {
    var parsed = Object.create(null);
    var lastRow = target.getLastRow();
    if (lastRow < 2) return parsed;
    target.getRange(2, 1, lastRow - 1, RECEIPT_HEADERS.length).getValues().forEach(function (row) {
      if (row[0] === "" || row[0] === null) return;
      var effectId = String(row[0]);
      if (parsed[effectId] !== undefined) throw new Error("receipt sheet contains duplicate effectId: " + effectId);
      var payloadHash = String(row[1]);
      var status = String(row[2]);
      var visibleHash = String(row[3]);
      var visibleRevision = Number(row[4]);
      if (payloadHash.length === 0 || status !== "applied" || visibleHash.length === 0 ||
          !isFinite(visibleRevision) || Math.floor(visibleRevision) !== visibleRevision || visibleRevision < 1) {
        throw new Error("receipt sheet contains an invalid receipt for effectId: " + effectId);
      }
      parsed[effectId] = {
        payloadHash: payloadHash,
        visibleHash: visibleHash,
        visibleRevision: visibleRevision,
      };
    });
    return parsed;
  }

  function assertReceiptPostcondition_(targetSheet, targetRange, receipt, row) {
    var rowNumber = findReceiptRowNumber_(targetSheet, targetRange, row);
    if (rowNumber === null) {
      throw new Error("receipt postcondition row is unavailable for effectId: " + row.effectId);
    }
    var values = targetSheet.getRange(rowNumber, targetRange.startColumn, 1, targetRange.columnCount).getValues()[0];
    var fields = Object.create(null);
    args.headers.forEach(function (header, index) {
      fields[header] = normalizedCellFromSheetValue_(values[index]);
    });
    if (visibleHash_(fields) !== receipt.visibleHash) {
      throw new Error("receipt postcondition changed for effectId: " + row.effectId);
    }
  }

  function findReceiptRowNumber_(targetSheet, targetRange, row) {
    // The MVP append path never materializes anchors as Developer Metadata;
    // a previously appended row is located through the registered identity
    // field, which this operation contract requires. A missing or empty
    // identity cell returns null so replay verification fails closed instead
    // of guessing at a position.
    var identityColumn = args.headers.indexOf(args.identityField);
    var identityCell = row.fields[args.identityField];
    var identity = identityCell === null || identityCell === undefined || identityCell.value === undefined
      ? ""
      : String(identityCell.value);
    if (identity.length === 0) return null;
    var lastRow = targetSheet.getLastRow();
    var matches = [];
    if (lastRow >= 2) {
      targetSheet.getRange(2, targetRange.startColumn + identityColumn, lastRow - 1, 1).getValues().forEach(function (value, index) {
        if (value[0] !== "" && value[0] !== null && String(value[0]) === identity) matches.push(index + 2);
      });
    }
    if (matches.length > 1) {
      throw new Error("sync identity is duplicated: " + identity + " at rows " + matches.join(", "));
    }
    return matches.length === 0 ? null : matches[0];
  }

  function normalizedCellFromSheetValue_(value) {
    if (value === "" || value === null) return null;
    if (isDate_(value)) return { kind: "date", value: value.toISOString() };
    if (typeof value === "string") return { kind: "string", value: normalizeScalarString_(value) };
    if (typeof value === "number" && isFinite(value)) return { kind: "number", value: value };
    if (typeof value === "boolean") return { kind: "boolean", value: value };
    throw new Error("Sheet cell cannot be normalized");
  }
  function isDate_(value) { return Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime()); }

  function visibleHash_(fields) {
    return stableHash_({ fields: Object.keys(fields).sort().map(function (fieldName) {
      return { fieldName: fieldName, value: fields[fieldName] };
    }) });
  }
  function stableHash_(value) { return sha256Hex_(stableEncode_(value)); }
  function stableEncode_(value) {
    if (value === null) return "n";
    if (value === true) return "b1";
    if (value === false) return "b0";
    if (typeof value === "number") return stableEncodeNumber_(value);
    if (typeof value === "string") return stableEncodeString_(value);
    if (isObject_(value) && value.kind === "date" && isCanonicalDate_(value.value)) return "d24:" + value.value;
    if (Array.isArray(value)) return "a" + value.length + "[" + value.map(stableEncode_).join("") + "]";
    if (isObject_(value)) {
      var entries = Object.keys(value).map(function (key) {
        var normalized = normalizeScalarString_(key);
        return { key: normalized, bytes: utf8Bytes_(normalized), value: value[key] };
      });
      entries.sort(function (left, right) { return compareBytes_(left.bytes, right.bytes); });
      return "o" + entries.length + "{" + entries.map(function (entry) {
        return "s" + entry.bytes.length + ":" + entry.key + stableEncode_(entry.value);
      }).join("") + "}";
    }
    throw new Error("stable value is unsupported");
  }
  function stableEncodeNumber_(value) {
    if (!isFinite(value)) throw new Error("stable number is not finite");
    var decimal = value === 0 ? "0" : String(value).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
    return "f" + utf8ByteLength_(decimal) + ":" + decimal;
  }
  function stableEncodeString_(value) {
    var normalized = normalizeScalarString_(value);
    return "s" + utf8ByteLength_(normalized) + ":" + normalized;
  }
  function sha256Hex_(value) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8).map(function (byte) {
      var unsigned = byte < 0 ? byte + 256 : byte;
      return ("0" + unsigned.toString(16)).slice(-2);
    }).join("");
  }
  function utf8Bytes_(value) { return Utilities.newBlob(value).getBytes(); }
  function utf8ByteLength_(value) { return utf8Bytes_(value).length; }
  function compareBytes_(left, right) {
    var count = Math.min(left.length, right.length);
    for (var index = 0; index < count; index += 1) {
      var a = left[index] < 0 ? left[index] + 256 : left[index];
      var b = right[index] < 0 ? right[index] + 256 : right[index];
      if (a !== b) return a - b;
    }
    return left.length - right.length;
  }
  function isObject_(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function normalizeScalarString_(value) { return value.normalize("NFC"); }
  function isCanonicalDate_(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    var parsed = new Date(value);
    return !isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }

  function assertIdentityAvailability_(targetSheet, range, lastRow, pendingRows) {
    var identityColumn = args.headers.indexOf(args.identityField);
    var existing = Object.create(null);
    if (lastRow >= 2) {
      targetSheet.getRange(2, range.startColumn + identityColumn, lastRow - 1, 1).getValues().forEach(function (row, index) {
        var value = row[0] === "" || row[0] === null ? null : String(row[0]);
        if (value === null) {
          throw new Error("sync identity is missing at row " + (index + 2));
        }
        if (existing[value] !== undefined) {
          throw new Error("sync identity is duplicated: " + value + " at rows " + existing[value] + " and " + (index + 2));
        }
        existing[value] = index + 2;
      });
    }
    pendingRows.forEach(function (entry) {
      var cell = entry.row.fields[args.identityField];
      var value = cell === null || cell === undefined || cell.value === undefined ? "" : String(cell.value);
      if (value.length === 0) throw new Error("sync identity is required for append: " + args.identityField);
      if (existing[value] !== undefined) {
        var location = existing[value] === "pending" ? "a pending row" : "row " + existing[value];
        throw new Error("sync identity already exists: " + value + " at " + location);
      }
      existing[value] = "pending";
    });
  }

  function writeAppendRows_(targetSheet, range, startRow, pending) {
    // Reserve the rows through the spreadsheet mutation API before writing
    // values so a concurrent human append is shifted rather than overwritten.
    targetSheet.insertRowsAfter(startRow - 1, pending.length);
    targetSheet.getRange(startRow, range.startColumn, pending.length, range.columnCount).setValues(pending.map(function (entry) {
      return args.headers.map(function (header) { return toSheetValue_(entry.row.fields[header]); });
    }));
    setDateNumberFormats_(targetSheet, range, startRow, pending);
  }

  function writeReceipts_(target, startRow, pending) {
    target.insertRowsAfter(startRow - 1, pending.length);
    var updatedAt = new Date().toISOString();
    target.getRange(startRow, 1, pending.length, RECEIPT_HEADERS.length).setValues(pending.map(function (entry) {
      return [entry.row.effectId, entry.payloadHash, "applied", entry.visibleHash, 1, updatedAt];
    }));
  }

  function setDateNumberFormats_(targetSheet, range, startRow, pending) {
    args.headers.forEach(function (header, columnIndex) {
      var isDateColumn = pending.every(function (entry) {
        var cell = entry.row.fields[header];
        return cell === null || cell === undefined || cell.kind === "date";
      });
      if (isDateColumn) {
        targetSheet.getRange(startRow, range.startColumn + columnIndex, pending.length, 1)
          .setNumberFormat("yyyy\"-\"mm\"-\"dd\"T\"hh:mm:ss.000\"Z\"");
      }
    });
  }

  function assertAppendPostcondition_(targetSheet, range, pending) {
    pending.forEach(function (entry) {
      var rowNumber = findReceiptRowNumber_(targetSheet, range, entry.row);
      if (rowNumber === null) {
        throw new Error("append postcondition row is unavailable for effectId: " + entry.row.effectId);
      }
      var values = targetSheet.getRange(rowNumber, range.startColumn, 1, range.columnCount).getValues()[0];
      var fields = Object.create(null);
      args.headers.forEach(function (header, headerIndex) {
        fields[header] = normalizedCellFromSheetValue_(values[headerIndex]);
      });
      if (visibleHash_(fields) !== entry.visibleHash) {
        throw new Error("append postcondition changed for effectId: " + entry.row.effectId);
      }
    });
  }

  function toSheetValue_(value) {
    if (value === null || value === undefined) return "";
    if (value.kind === "date") return new Date(value.value);
    return value.value;
  }

  function parseRange_(value) {
    var parts = value.split(":");
    var startColumn = columnNumber_(parts[0]);
    var endColumn = columnNumber_(parts[1]);
    if (endColumn < startColumn) throw new Error("batch append range is invalid");
    return { startColumn: startColumn, columnCount: endColumn - startColumn + 1 };
  }
  function columnNumber_(letters) {
    var value = 0;
    for (var index = 0; index < letters.length; index += 1) value = value * 26 + letters.charCodeAt(index) - 64;
    return value;
  }
  function phase_(name, startedAt) { phases.push({ phase: name, durationMs: Date.now() - startedAt }); }
  function appendPhase_(result, name, durationMs) {
    if (!result || !result.timing) return;
    // Keep the script-lock wait/hold duration as a diagnostic phase, but do
    // not fold it into the total: durationMs already measures the whole
    // operation including the lock wait, so adding the nested phase would
    // double-count the elapsed time.
    result.timing.phases.push({ phase: name, durationMs: durationMs });
  }
}`;

function validateBatchAppendRequest(request: AppsScriptBatchAppendOperationArgs): void {
  if (request.authority !== undefined &&
      (!Number.isSafeInteger(request.authority.epoch) || request.authority.epoch < 1 ||
        request.authority.token.trim().length === 0)) {
    invalidOperationRequest("batch append operation", "authority is invalid");
  }
  if (request.sheetName.trim().length === 0) {
    invalidOperationRequest("batch append operation", "sheetName is required");
  }
  if (!/^[A-Z]+:[A-Z]+$/.test(request.registeredRange)) {
    invalidOperationRequest("batch append operation", "registeredRange is invalid");
  }
  if (request.headers.length === 0 || request.headers.some((header) => header.trim().length === 0)) {
    invalidOperationRequest("batch append operation", "headers must contain non-empty names");
  }
  if (new Set(request.headers).size !== request.headers.length) {
    invalidOperationRequest("batch append operation", "headers must not contain duplicates");
  }
  if (request.identityField === undefined || request.identityField.trim().length === 0) {
    invalidOperationRequest("batch append operation", "identityField is required");
  }
  if (!request.headers.includes(request.identityField)) {
    invalidOperationRequest("batch append operation", "identityField must be a registered header");
  }
  const [start, end] = request.registeredRange.split(":");
  if (columnNumber(end) < columnNumber(start) || columnNumber(end) - columnNumber(start) + 1 !== request.headers.length) {
    invalidOperationRequest("batch append operation", "headers must match registeredRange");
  }
  const effectIds = new Set<string>();
  const expectedFieldNames = [...request.headers].sort();
  for (const row of request.rows) {
    if (row.effectId.trim().length === 0 || effectIds.has(row.effectId)) {
      invalidOperationRequest("batch append operation", "effectIds must be non-empty and unique");
    }
    effectIds.add(row.effectId);
    const fieldNames = Object.keys(row.fields).sort();
    if (fieldNames.length !== expectedFieldNames.length || fieldNames.some((field, index) => field !== expectedFieldNames[index])) {
      invalidOperationRequest("batch append operation", "rows must contain exactly the registered headers");
    }
    if (row.payloadHash === undefined || row.payloadHash.trim().length === 0) {
      invalidOperationRequest("batch append operation", "every row needs a payloadHash");
    }
    if (row.anchor !== undefined && row.anchor.trim().length === 0) {
      invalidOperationRequest("batch append operation", "row anchor must be non-empty");
    }
    for (const cell of Object.values(row.fields)) {
      if (!isNormalizedCell(cell)) invalidOperationRequest("batch append operation", "rows contain an invalid normalized cell");
    }
  }
}

function columnNumber(value: string | undefined): number {
  if (value === undefined || value.length === 0) return 0;
  let result = 0;
  for (const letter of value) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}

function decodeBatchAppendResult(
  value: unknown,
  expectedRows: readonly FastAppendRow[],
): FastAppendRowsResult {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== expectedRows.length || value.hasMore !== false) {
    return invalidOperationResponse("batch append operation", "result must contain all rows and hasMore=false");
  }
  const timing = decodeOptionalSyncGatewayTiming(value.timing, "batch append timing");
  const results = value.results.map((entry) => {
    if (!isRecord(entry) || typeof entry.effectId !== "string" || entry.status !== SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED) {
      return invalidOperationResponse("batch append operation", "result contains an invalid row");
    }
    const hasVisibleHash = Object.prototype.hasOwnProperty.call(entry, "visibleHash");
    const hasVisibleRevision = Object.prototype.hasOwnProperty.call(entry, "visibleRevision");
    if (hasVisibleHash !== hasVisibleRevision ||
        (hasVisibleHash && (typeof entry.visibleHash !== "string" || entry.visibleHash.length === 0 ||
          typeof entry.visibleRevision !== "number" || !Number.isSafeInteger(entry.visibleRevision) || entry.visibleRevision < 1))) {
      return invalidOperationResponse("batch append operation", "result contains invalid receipt evidence");
    }
    return hasVisibleHash
      ? {
        effectId: entry.effectId,
        status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED,
        visibleHash: entry.visibleHash as string,
        visibleRevision: entry.visibleRevision as number,
      } as const
      : { effectId: entry.effectId, status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED } as const;
  });
  const expectedIds = new Set(expectedRows.map((row) => row.effectId));
  const actualIds = new Set(results.map((row) => row.effectId));
  if (actualIds.size !== results.length || actualIds.size !== expectedIds.size || results.some((row) => !expectedIds.has(row.effectId))) {
    return invalidOperationResponse("batch append operation", "result effectIds do not match submitted rows");
  }
  const result: FastAppendRowsResult = { results, hasMore: false };
  return timing === undefined ? result : { ...result, timing };
}
