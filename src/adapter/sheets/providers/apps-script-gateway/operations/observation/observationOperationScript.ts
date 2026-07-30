/** Self-contained V8 source for normalized, ID-addressable Sheet snapshots. */

export const OBSERVATION_OPERATION_SOURCE = String.raw`function (spreadsheet, args) {
  var MODES = { SNAPSHOT: "readSnapshot", OBSERVE: "observeSnapshot" };
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

  function observeSnapshot_(targetSheet, targetLayout, unusedCheckboxHeaders, request) {
    var lastRowStartedAt = Date.now();
    var lastRow = Math.max(targetSheet.getLastRow(), 1);
    phase_("last_row_read", lastRowStartedAt);
    var valuesReadStartedAt = Date.now();
    var range = targetSheet.getRange(1, targetLayout.startColumn, lastRow, targetLayout.columnCount);
    var values = range.getValues();
    phase_("values_read", valuesReadStartedAt);
    var snapshotStartedAt = Date.now();
    var snapshot = readSnapshot_(targetSheet, targetLayout, unusedCheckboxHeaders, request, {
      lastRow: lastRow,
      range: range,
      values: values,
    });
    phase_("snapshot_build", snapshotStartedAt);
    return {
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
    var rows = [];
    var rowNormalizationStartedAt = Date.now();
    for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
      if (isBlankRow_(values[rowIndex], targetLayout.checkboxIndexes)) continue;
      var rowNumber = rowIndex + 1;
      var cells = Object.create(null);
      targetLayout.headers.forEach(function (header, columnIndex) {
        var coordinate = rowNumber + ":" + (targetLayout.startColumn + columnIndex);
        cells[header] = normalizeCellObservation_(
          values[rowIndex][columnIndex],
          lightweight ? "" : formulas[rowIndex][columnIndex],
          lightweight ? String(values[rowIndex][columnIndex]) : displayValues[rowIndex][columnIndex],
          lightweight ? null : merged[coordinate] || null,
        );
      });
      rows.push({
        rowNumber: rowNumber,
        cells: cells,
      });
    }
    phase_("row_normalization", rowNormalizationStartedAt);
    var snapshot = {
      protocolVersion: "typed-sheets-sync-v1",
      sheetName: request.sheetName,
      registeredRange: request.registeredRange,
      projection: request.projection,
      schemaVersion: request.schemaVersion,
      headers: targetLayout.headers,
      rows: rows,
    };
    return {
      protocolVersion: snapshot.protocolVersion,
      sheetName: snapshot.sheetName,
      registeredRange: snapshot.registeredRange,
      projection: snapshot.projection,
      schemaVersion: snapshot.schemaVersion,
      headers: snapshot.headers,
      rows: snapshot.rows,
    };
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

  function normalizeCellObservation_(rawValue, formula, displayValue, mergeRange) {
    if (mergeRange !== null) return { cellKind: "merged", normalizedCell: null };
    if (isDisplayedSheetError_(displayValue)) return { cellKind: "error", normalizedCell: null };
    if (formula) return { cellKind: "formula", normalizedCell: null };
    var normalized;
    if (rawValue === "" || rawValue === null) normalized = null;
    else if (isDate_(rawValue)) normalized = { kind: "date", value: rawValue.toISOString() };
    else if (typeof rawValue === "string") normalized = { kind: "string", value: normalizeScalarString_(rawValue) };
    else if (typeof rawValue === "number" && isFinite(rawValue)) normalized = { kind: "number", value: rawValue };
    else if (typeof rawValue === "boolean") normalized = { kind: "boolean", value: rawValue };
    else return { cellKind: "error", normalizedCell: null };
    return { cellKind: normalized === null ? "blank" : "literal", normalizedCell: normalized };
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
  function isObject_(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function requireObject_(value, label) { if (!isObject_(value)) throw new Error(label + " must be an object"); return value; }
  function normalizeScalarString_(value) { return value.normalize("NFC"); }
}`;
