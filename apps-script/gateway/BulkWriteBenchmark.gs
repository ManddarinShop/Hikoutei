/**
 * Apps Script bulk-write benchmark.
 *
 * The raw runBulkWriteBenchmark* functions remain an isolated setValues()
 * baseline. The runBulkWriteStageBenchmark* functions below intentionally
 * load beside Code.gs and call the same request-scoped batch helpers as the
 * production gateway: batch context read, in-memory effect planning/CAS,
 * range writes, flush, postcondition read, receipt write, and batch recovery.
 *
 * This file does not define doPost(). Add it to the same Apps Script project as
 * Code.gs, then run runFastAppendBenchmark20()/runFastAppendBenchmark100()
 * for the new fast path, or runBulkWriteStageBenchmark20() for the guarded
 * comparison path.
 */

var TYPED_SHEETS_BULK_BENCHMARK_SHEET_PROPERTY_ =
  "TYPED_SHEETS_BULK_BENCHMARK_SHEET_NAME";
var TYPED_SHEETS_BULK_BENCHMARK_ROW_COUNT_PROPERTY_ =
  "TYPED_SHEETS_BULK_BENCHMARK_ROW_COUNT";
var TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_SHEET_NAME_ =
  "__typed_sheets_bulk_write_benchmark";
var TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_HEADERS_ = [
  "id",
  "value_1",
  "value_2",
  "value_3",
  "value_4",
  "value_5",
];
var TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_ROW_COUNT_ = 20;
var TYPED_SHEETS_BULK_BENCHMARK_MAX_ROW_COUNT_ = 10000;

/** Measures the append-only fast path for exactly 20 rows. */
function runFastAppendBenchmark20() {
  return runFastAppendBenchmark_(20);
}

/** Measures the append-only fast path for exactly 100 rows. */
function runFastAppendBenchmark100() {
  return runFastAppendBenchmark_(100);
}

/** Runs both fast-path sizes on isolated fixture tabs. */
function runFastAppendBenchmarkSuite() {
  var results = [20, 100].map(function (rowCount) {
    return runFastAppendBenchmark_(rowCount);
  });
  var summary = {
    event: "typed_sheets_fast_append_benchmark_suite",
    results: results,
  };
  Logger.log(JSON.stringify(summary));
  return summary;
}

/** Measures fast append after one-time sheet/header setup is complete. */
function runFastAppendBenchmark_(rowCount) {
  if (typeof fastAppendRows_ !== "function") {
    throw new Error("Load Code.gs in the same Apps Script project before running the fast benchmark.");
  }
  var setupStartedAt = Date.now();
  var spreadsheet = bulkWriteBenchmarkSpreadsheet_();
  var sheetName = (bulkWriteBenchmarkSheetName_() + "_fast_append").slice(0, 90);
  var sheet = bulkWriteBenchmarkGetOrCreateSheet_(spreadsheet, sheetName);
  bulkWriteBenchmarkEnsureHeaders_(sheet, TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_HEADERS_);
  var headers = TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_HEADERS_.slice();
  bulkWriteBenchmarkResetStageRows_(sheet, 0);
  SpreadsheetApp.flush();
  var setupMs = Date.now() - setupStartedAt;
  var runId = "fast-append-" + Date.now() + "-" + Utilities.getUuid().slice(0, 8);
  var registration = {
    sheetName: sheetName,
    registeredRange: "A:F",
    projection: "system_state",
    schemaVersion: 1,
    checkboxHeaders: [],
  };
  var rows = [];
  for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    var fields = {};
    headers.forEach(function (header, columnIndex) {
      fields[header] = { kind: "string", value: runId + "-r" + rowIndex + "-c" + columnIndex };
    });
    rows.push({
      effectId: "fast-effect:" + runId + ":" + rowIndex,
      fields: fields,
    });
  }
  var requestStartedAt = Date.now();
  var operationStartedAt = Date.now();
  var response = fastAppendRows_(
    spreadsheet,
    registration,
    { rows: rows },
    {
      requestId: "benchmark-" + runId,
      operation: "fastAppendRows",
      registeredRange: registration.registeredRange,
    },
    requestStartedAt,
  );
  var operationMs = Date.now() - operationStartedAt;
  var flushStartedAt = Date.now();
  SpreadsheetApp.flush();
  var flushMs = Date.now() - flushStartedAt;
  var totalMs = operationMs + flushMs;
  var result = {
    event: "typed_sheets_fast_append_benchmark",
    runId: runId,
    sheetName: sheetName,
    rowCount: rowCount,
    columnCount: headers.length,
    cellCount: rowCount * headers.length,
    returnedRowCount: response.results.length,
    hasMore: response.hasMore,
    setupMs: setupMs,
    operationMs: operationMs,
    flushMs: flushMs,
    totalMs: totalMs,
    rowsPerSecond: totalMs === 0 ? null : rowCount * 1000 / totalMs,
    cellsPerSecond: totalMs === 0 ? null : rowCount * headers.length * 1000 / totalMs,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

/**
 * Creates the isolated benchmark sheet and writes its headers once.
 *
 * Setup time is deliberately kept outside the measured write interval because
 * sheet creation and header initialization are one-time preparation work.
 *
 * @returns {object} The prepared spreadsheet and sheet names.
 */
function setupBulkWriteBenchmarkSheet() {
  var spreadsheet = bulkWriteBenchmarkSpreadsheet_();
  var sheetName = bulkWriteBenchmarkSheetName_();
  var sheet = spreadsheet.getSheetByName(sheetName);
  var created = false;

  if (sheet === null) {
    sheet = spreadsheet.insertSheet(sheetName);
    created = true;
  }

  var lastColumn = sheet.getLastColumn();
  if (lastColumn < 1 || bulkWriteBenchmarkHeaderIsBlank_(sheet, lastColumn)) {
    sheet.getRange(
      1,
      1,
      1,
      TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_HEADERS_.length,
    ).setValues([TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_HEADERS_]);
    SpreadsheetApp.flush();
    lastColumn = TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_HEADERS_.length;
  }

  return {
    spreadsheetId: spreadsheet.getId(),
    sheetName: sheetName,
    created: created,
    columnCount: lastColumn,
  };
}

/**
 * Runs the benchmark using the configured row count, defaulting to 20 rows.
 *
 * The measured path performs one contiguous setValues() call and one flush().
 * It intentionally omits sync anchors, hashes, receipts, snapshots, and
 * postconditions so it can be used as a raw spreadsheet upper-bound baseline.
 *
 * @returns {object} Timing and throughput measurements for this run.
 */
function runBulkWriteBenchmark() {
  var rowCount = bulkWriteBenchmarkConfiguredRowCount_();
  return runBulkWriteBenchmark_(rowCount);
}

/** Runs the isolated raw-write benchmark for exactly 20 rows. */
function runBulkWriteBenchmark20() {
  return runBulkWriteBenchmark_(20);
}

/** Runs the isolated raw-write benchmark for exactly 100 rows. */
function runBulkWriteBenchmark100() {
  return runBulkWriteBenchmark_(100);
}

/**
 * Runs several append-only sizes in one manual execution for comparison.
 *
 * @returns {object} The individual measurements in execution order.
 */
function runBulkWriteBenchmarkSuite() {
  var sizes = [20, 100, 500, 1000];
  var results = sizes.map(function (rowCount) {
    return runBulkWriteBenchmark_(rowCount);
  });
  var summary = {
    event: "typed_sheets_bulk_write_benchmark_suite",
    results: results,
  };
  Logger.log(JSON.stringify(summary));
  return summary;
}

/** Performs one append-only benchmark without touching the production path. */
function runBulkWriteBenchmark_(rowCount) {
  var setupStartedAt = Date.now();
  var setup = setupBulkWriteBenchmarkSheet();
  var spreadsheet = SpreadsheetApp.openById(setup.spreadsheetId);
  var sheet = spreadsheet.getSheetByName(setup.sheetName);
  if (sheet === null) throw new Error("Benchmark sheet disappeared during setup.");

  var headers = sheet.getRange(1, 1, 1, setup.columnCount).getValues()[0];
  var startRow = Math.max(sheet.getLastRow() + 1, 2);
  var runId = "bulk-benchmark-" + Date.now() + "-" + Utilities.getUuid().slice(0, 8);
  var values = bulkWriteBenchmarkValues_(runId, rowCount, headers.length);
  var setupMs = Date.now() - setupStartedAt;

  var setValuesStartedAt = Date.now();
  sheet.getRange(startRow, 1, rowCount, headers.length).setValues(values);
  var setValuesMs = Date.now() - setValuesStartedAt;

  var flushStartedAt = Date.now();
  SpreadsheetApp.flush();
  var flushMs = Date.now() - flushStartedAt;
  var totalMs = setValuesMs + flushMs;
  var cellCount = rowCount * headers.length;
  var result = {
    event: "typed_sheets_bulk_write_benchmark",
    runId: runId,
    sheetName: setup.sheetName,
    startRow: startRow,
    rowCount: rowCount,
    columnCount: headers.length,
    cellCount: cellCount,
    setupMs: setupMs,
    setValuesMs: setValuesMs,
    flushMs: flushMs,
    totalMs: totalMs,
    rowsPerSecond: totalMs === 0 ? null : rowCount * 1000 / totalMs,
    cellsPerSecond: totalMs === 0 ? null : cellCount * 1000 / totalMs,
  };
  Logger.log(JSON.stringify(result));
  return result;
}

/** Resolves the spreadsheet configured by the production gateway setup. */
function bulkWriteBenchmarkSpreadsheet_() {
  var properties = PropertiesService.getScriptProperties();
  var spreadsheetId = properties.getProperty("TYPED_SHEETS_GATEWAY_SHEET_ID") ||
    properties.getProperty("TYPED_SHEETS_MVP_SHEET_ID");
  if (typeof spreadsheetId === "string" && spreadsheetId.trim() !== "") {
    return SpreadsheetApp.openById(spreadsheetId.trim());
  }

  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (activeSpreadsheet === null) {
    throw new Error(
      "Configure TYPED_SHEETS_GATEWAY_SHEET_ID or run the benchmark from a bound spreadsheet project.",
    );
  }
  return activeSpreadsheet;
}

/** Resolves the isolated benchmark tab without exposing production tabs. */
function bulkWriteBenchmarkSheetName_() {
  var configured = PropertiesService.getScriptProperties().getProperty(
    TYPED_SHEETS_BULK_BENCHMARK_SHEET_PROPERTY_,
  );
  return typeof configured === "string" && configured.trim() !== ""
    ? configured.trim()
    : TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_SHEET_NAME_;
}

/** Reads and validates the optional configured row count. */
function bulkWriteBenchmarkConfiguredRowCount_() {
  var configured = PropertiesService.getScriptProperties().getProperty(
    TYPED_SHEETS_BULK_BENCHMARK_ROW_COUNT_PROPERTY_,
  );
  if (configured === null || configured.trim() === "") {
    return TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_ROW_COUNT_;
  }

  var rowCount = Number(configured);
  if (!Number.isSafeInteger(rowCount) || rowCount <= 0 || rowCount > TYPED_SHEETS_BULK_BENCHMARK_MAX_ROW_COUNT_) {
    throw new Error(
      "TYPED_SHEETS_BULK_BENCHMARK_ROW_COUNT must be a positive integer no greater than " +
        TYPED_SHEETS_BULK_BENCHMARK_MAX_ROW_COUNT_ + ".",
    );
  }
  return rowCount;
}

/** Returns true when the first row has no usable benchmark headers. */
function bulkWriteBenchmarkHeaderIsBlank_(sheet, columnCount) {
  var headers = sheet.getRange(1, 1, 1, columnCount).getValues()[0];
  return headers.every(function (header) {
    return header === null || String(header).trim() === "";
  });
}

/** Builds deterministic string cells without invoking schema or sync parsing. */
function bulkWriteBenchmarkValues_(runId, rowCount, columnCount) {
  var values = [];
  for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    var row = [];
    for (var columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      row.push(runId + "-r" + rowIndex + "-c" + columnIndex);
    }
    values.push(row);
  }
  return values;
}

// Legacy-only diagnostics. They are kept for historical comparison, but the
// public runBulkWriteStageBenchmark* entry points do not call these helpers.
var TYPED_SHEETS_BULK_STAGE_NAMES_ = {
  METADATA_READ: "metadata_read",
  METADATA_WRITE: "metadata_write",
  SNAPSHOT_READ: "snapshot_read",
  CAS_COMPARE: "cas_compare",
  POSTCONDITION_READ: "postcondition_read",
  RECEIPT_READ: "receipt_read",
  RECEIPT_WRITE: "receipt_write",
};
var TYPED_SHEETS_BULK_STAGE_METADATA_ = [
  { key: "typed_sheets_sync_anchor", value: "benchmark-anchor" },
  { key: "typed_sheets_sync_visible_revision", value: "1" },
  { key: "typed_sheets_sync_visible_hash", value: "benchmark-hash" },
];
var TYPED_SHEETS_BULK_STAGE_RECEIPT_HEADERS_ = [
  "effectId",
  "payloadHash",
  "status",
  "visibleHash",
  "visibleRevision",
  "updatedAt",
];

/**
 * Measures the current production batch path for exactly 20 new rows.
 *
 * Defaults to the production worker's postconditionMode: DEFERRED, so the
 * measured path matches what the real SyncEffectWorker sends. INLINE runs are
 * available via runBulkWriteStageBenchmarkSuite().
 */
function runBulkWriteStageBenchmark20() {
  return runBulkWriteStageBenchmark_(20, SYNC_POSTCONDITION_MODES_.DEFERRED);
}

/** Measures the current production batch path for exactly 100 new rows. */
function runBulkWriteStageBenchmark100() {
  return runBulkWriteStageBenchmark_(100, SYNC_POSTCONDITION_MODES_.DEFERRED);
}

/**
 * Runs a current-path comparison suite that holds everything constant except
 * postconditionMode, so the cost of the deferred-verify model used by the
 * production worker can be compared against the legacy inline model.
 *
 * Each entry uses its own empty fixture sheet, so the two modes never observe
 * each other's appended rows. Start with runBulkWriteStageBenchmark20() when
 * the Apps Script runtime is already close to its execution limit.
 */
function runBulkWriteStageBenchmarkSuite() {
  var rowCounts = [20, 100];
  var results = rowCounts.reduce(function (acc, rowCount) {
    acc.push(runBulkWriteStageBenchmark_(rowCount, SYNC_POSTCONDITION_MODES_.DEFERRED));
    acc.push(runBulkWriteStageBenchmark_(rowCount, SYNC_POSTCONDITION_MODES_.INLINE));
    return acc;
  }, []);
  var summary = {
    event: "typed_sheets_bulk_write_current_path_benchmark_suite",
    results: results,
  };
  Logger.log(JSON.stringify(summary));
  return summary;
}

/**
 * Measures the staged batch path for one row count under one postconditionMode.
 *
 * The production SyncEffectWorker always sends postconditionMode=DEFERRED, so
 * the DEFERRED run is the one that reflects the real steady-state cost.
 * postconditionMode controls whether the write path re-reads and verifies the
 * just-written rows before returning (INLINE) or trusts the flush and leaves
 * verification to the recovery path (DEFERRED).
 */
function runBulkWriteStageBenchmark_(rowCount, postconditionMode) {
  return bulkWriteBenchmarkCurrentProductionRun_(rowCount, postconditionMode);
}

/** Measures per-row Developer Metadata reads used by the production path. */
function bulkWriteBenchmarkMetadataRead_(rowCount) {
  var context = bulkWriteBenchmarkPrepareStage_(
    TYPED_SHEETS_BULK_STAGE_NAMES_.METADATA_READ,
    rowCount,
    true,
  );
  var metadataCount = 0;
  var startedAt = Date.now();
  for (var rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    context.sheet.getRange(rowNumber + ":" + rowNumber).getDeveloperMetadata().forEach(function (metadata) {
      metadataCount += 1;
    });
  }
  return {
    stage: TYPED_SHEETS_BULK_STAGE_NAMES_.METADATA_READ,
    rowCount: rowCount,
    setupMs: context.setupMs,
    operationMs: Date.now() - startedAt,
    metadataCount: metadataCount,
  };
}

/** Measures per-row metadata removal and re-creation used by writes. */
function bulkWriteBenchmarkMetadataWrite_(rowCount) {
  var context = bulkWriteBenchmarkPrepareStage_(
    TYPED_SHEETS_BULK_STAGE_NAMES_.METADATA_WRITE,
    rowCount,
    true,
  );
  var startedAt = Date.now();
  for (var rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    bulkWriteBenchmarkReplaceMetadata_(context.sheet, rowNumber);
  }
  var operationMs = Date.now() - startedAt;
  var flushStartedAt = Date.now();
  SpreadsheetApp.flush();
  return {
    stage: TYPED_SHEETS_BULK_STAGE_NAMES_.METADATA_WRITE,
    rowCount: rowCount,
    setupMs: context.setupMs,
    operationMs: operationMs,
    flushMs: Date.now() - flushStartedAt,
    totalMs: Date.now() - startedAt,
  };
}

/** Measures the full-range reads and per-row metadata reads of a snapshot. */
function bulkWriteBenchmarkSnapshotRead_(rowCount) {
  var context = bulkWriteBenchmarkPrepareStage_(
    TYPED_SHEETS_BULK_STAGE_NAMES_.SNAPSHOT_READ,
    rowCount,
    true,
  );
  var startedAt = Date.now();
  var lastRow = Math.max(context.sheet.getLastRow(), 1);
  var range = context.sheet.getRange(1, 1, lastRow, context.columnCount);
  var values = range.getValues();
  var formulas = range.getFormulas();
  var displayValues = range.getDisplayValues();
  var mergedRanges = range.getMergedRanges();
  var metadataCount = 0;
  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    if (bulkWriteBenchmarkBlankRow_(values[rowIndex])) continue;
    context.sheet.getRange(rowIndex + 1 + ":" + (rowIndex + 1)).getDeveloperMetadata().forEach(function (metadata) {
      metadataCount += 1;
    });
  }
  return {
    stage: TYPED_SHEETS_BULK_STAGE_NAMES_.SNAPSHOT_READ,
    rowCount: rowCount,
    setupMs: context.setupMs,
    operationMs: Date.now() - startedAt,
    returnedRowCount: values.length - 1,
    formulaCellCount: bulkWriteBenchmarkCountNonEmptyCells_(formulas),
    displayCellCount: bulkWriteBenchmarkCountNonEmptyCells_(displayValues),
    mergedRangeCount: mergedRanges.length,
    metadataCount: metadataCount,
  };
}

/** Measures only the in-memory revision/hash comparison part of CAS. */
function bulkWriteBenchmarkCasCompare_(rowCount) {
  var iterations = rowCount * 10000;
  var expectedRevision = 1;
  var currentRevision = 1;
  var expectedHash = "benchmark-hash";
  var currentHash = "benchmark-hash";
  var matches = 0;
  var startedAt = Date.now();
  for (var index = 0; index < iterations; index += 1) {
    if (currentRevision === expectedRevision && currentHash === expectedHash) matches += 1;
  }
  return {
    stage: TYPED_SHEETS_BULK_STAGE_NAMES_.CAS_COMPARE,
    rowCount: rowCount,
    setupMs: 0,
    operationMs: Date.now() - startedAt,
    iterations: iterations,
    matches: matches,
  };
}

/** Measures the value-range read plus per-row visible metadata read. */
function bulkWriteBenchmarkPostconditionRead_(rowCount) {
  var context = bulkWriteBenchmarkPrepareStage_(
    TYPED_SHEETS_BULK_STAGE_NAMES_.POSTCONDITION_READ,
    rowCount,
    true,
  );
  var startedAt = Date.now();
  var lastRow = Math.max(context.sheet.getLastRow(), 1);
  var rawRows = lastRow > 1
    ? context.sheet.getRange(2, 1, lastRow - 1, context.columnCount).getValues()
    : [];
  var metadataCount = 0;
  for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    context.sheet.getRange(rowIndex + 2 + ":" + (rowIndex + 2)).getDeveloperMetadata().forEach(function (metadata) {
      metadataCount += 1;
    });
  }
  return {
    stage: TYPED_SHEETS_BULK_STAGE_NAMES_.POSTCONDITION_READ,
    rowCount: rowCount,
    setupMs: context.setupMs,
    operationMs: Date.now() - startedAt,
    returnedRowCount: rawRows.length,
    metadataCount: metadataCount,
  };
}

/** Measures reading and indexing a receipt range. */
function bulkWriteBenchmarkReceiptRead_(rowCount) {
  var context = bulkWriteBenchmarkPrepareReceiptStage_(
    TYPED_SHEETS_BULK_STAGE_NAMES_.RECEIPT_READ,
    rowCount,
  );
  var startedAt = Date.now();
  var rows = context.sheet.getRange(2, 1, rowCount, 6).getValues();
  var receipts = Object.create(null);
  rows.forEach(function (row) {
    if (row[0] === "" || row[0] === null) return;
    receipts[String(row[0])] = {
      payloadHash: String(row[1]),
      status: String(row[2]),
      visibleHash: String(row[3]),
      visibleRevision: Number(row[4]),
    };
  });
  return {
    stage: TYPED_SHEETS_BULK_STAGE_NAMES_.RECEIPT_READ,
    rowCount: rowCount,
    setupMs: context.setupMs,
    operationMs: Date.now() - startedAt,
    receiptCount: Object.keys(receipts).length,
  };
}

/** Measures appending a receipt range followed by one flush. */
function bulkWriteBenchmarkReceiptWrite_(rowCount) {
  var context = bulkWriteBenchmarkPrepareReceiptStage_(
    TYPED_SHEETS_BULK_STAGE_NAMES_.RECEIPT_WRITE,
    rowCount,
  );
  var values = bulkWriteBenchmarkReceiptValues_(rowCount);
  var startedAt = Date.now();
  var startRow = Math.max(context.sheet.getLastRow() + 1, 2);
  context.sheet.getRange(startRow, 1, values.length, 6).setValues(values);
  var operationMs = Date.now() - startedAt;
  var flushStartedAt = Date.now();
  SpreadsheetApp.flush();
  return {
    stage: TYPED_SHEETS_BULK_STAGE_NAMES_.RECEIPT_WRITE,
    rowCount: rowCount,
    setupMs: context.setupMs,
    operationMs: operationMs,
    flushMs: Date.now() - flushStartedAt,
    totalMs: Date.now() - startedAt,
  };
}

/** Creates and seeds one isolated stage tab outside the measured interval. */
function bulkWriteBenchmarkPrepareStage_(stage, rowCount, withMetadata) {
  var startedAt = Date.now();
  var spreadsheet = bulkWriteBenchmarkSpreadsheet_();
  var sheetName = bulkWriteBenchmarkStageSheetName_(stage);
  var sheet = bulkWriteBenchmarkGetOrCreateSheet_(spreadsheet, sheetName);
  var headers = bulkWriteBenchmarkEnsureHeaders_(sheet, TYPED_SHEETS_BULK_BENCHMARK_DEFAULT_HEADERS_);
  bulkWriteBenchmarkResetStageRows_(sheet, rowCount);
  var runId = "stage-fixture-" + Date.now() + "-" + Utilities.getUuid().slice(0, 8);
  sheet.getRange(2, 1, rowCount, headers.length).setValues(
    bulkWriteBenchmarkValues_(runId, rowCount, headers.length),
  );
  if (withMetadata) bulkWriteBenchmarkPrepareMetadata_(sheet, rowCount);
  SpreadsheetApp.flush();
  return {
    spreadsheet: spreadsheet,
    sheet: sheet,
    sheetName: sheetName,
    columnCount: headers.length,
    setupMs: Date.now() - startedAt,
  };
}

/** Creates and seeds one isolated receipt tab outside the measured interval. */
function bulkWriteBenchmarkPrepareReceiptStage_(stage, rowCount) {
  var startedAt = Date.now();
  var spreadsheet = bulkWriteBenchmarkSpreadsheet_();
  var sheetName = bulkWriteBenchmarkStageSheetName_(stage);
  var sheet = bulkWriteBenchmarkGetOrCreateSheet_(spreadsheet, sheetName);
  bulkWriteBenchmarkEnsureHeaders_(sheet, TYPED_SHEETS_BULK_STAGE_RECEIPT_HEADERS_);
  bulkWriteBenchmarkResetStageRows_(sheet, rowCount);
  sheet.getRange(2, 1, rowCount, 6).setValues(bulkWriteBenchmarkReceiptValues_(rowCount));
  SpreadsheetApp.flush();
  return {
    spreadsheet: spreadsheet,
    sheet: sheet,
    sheetName: sheetName,
    columnCount: 6,
    setupMs: Date.now() - startedAt,
  };
}

/** Returns an isolated stage tab, creating it only when needed. */
function bulkWriteBenchmarkGetOrCreateSheet_(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  return sheet === null ? spreadsheet.insertSheet(sheetName) : sheet;
}

/** Keeps repeated runs comparable by removing stale rows from benchmark tabs. */
function bulkWriteBenchmarkResetStageRows_(sheet, rowCount) {
  var desiredLastRow = rowCount + 1;
  var actualLastRow = sheet.getLastRow();
  if (actualLastRow > desiredLastRow) {
    sheet.deleteRows(desiredLastRow + 1, actualLastRow - desiredLastRow);
  }
}

/** Writes stage headers when the dedicated tab is new or empty. */
function bulkWriteBenchmarkEnsureHeaders_(sheet, headers) {
  var lastColumn = sheet.getLastColumn();
  if (lastColumn < headers.length || bulkWriteBenchmarkHeaderIsBlank_(sheet, Math.max(lastColumn, headers.length))) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return headers;
  }
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
}

/** Names stage tabs independently so each measurement has its own state. */
function bulkWriteBenchmarkStageSheetName_(stage) {
  var base = bulkWriteBenchmarkSheetName_() + "_" + stage;
  return base.slice(0, 90);
}

/** Seeds the three metadata keys that the production path reads and replaces. */
function bulkWriteBenchmarkPrepareMetadata_(sheet, rowCount) {
  for (var rowNumber = 2; rowNumber < rowCount + 2; rowNumber += 1) {
    bulkWriteBenchmarkReplaceMetadata_(sheet, rowNumber);
  }
}

/** Reproduces the production row metadata removal/addition sequence. */
function bulkWriteBenchmarkReplaceMetadata_(sheet, rowNumber) {
  var range = sheet.getRange(rowNumber + ":" + rowNumber);
  var removableMetadata = [];
  range.getDeveloperMetadata().forEach(function (metadata) {
    var key = metadata.getKey();
    var shouldRemove = TYPED_SHEETS_BULK_STAGE_METADATA_.some(function (entry) {
      return key === entry.key;
    });
    if (shouldRemove) removableMetadata.push(metadata);
  });
  removableMetadata.forEach(function (metadata) {
    metadata.remove();
  });
  TYPED_SHEETS_BULK_STAGE_METADATA_.forEach(function (entry) {
    range.addDeveloperMetadata(
      entry.key,
      entry.value + "-" + rowNumber,
      SpreadsheetApp.DeveloperMetadataVisibility.PROJECT,
    );
  });
}

/** Builds receipt-shaped rows without invoking the production receipt writer. */
function bulkWriteBenchmarkReceiptValues_(rowCount) {
  var values = [];
  for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    values.push([
      "benchmark-effect-" + rowIndex,
      "benchmark-payload-" + rowIndex,
      "applied",
      "benchmark-visible-" + rowIndex,
      1,
      new Date().toISOString(),
    ]);
  }
  return values;
}

/** Returns whether a raw row contains no benchmark values. */
function bulkWriteBenchmarkBlankRow_(row) {
  return row.every(function (value) {
    return value === "" || value === null;
  });
}

/** Counts non-empty cells to keep full snapshot work from being optimized away. */
function bulkWriteBenchmarkCountNonEmptyCells_(rows) {
  var count = 0;
  rows.forEach(function (row) {
    row.forEach(function (value) {
      if (value !== "" && value !== null) count += 1;
    });
  });
  return count;
}

// ---------------------------------------------------------------------------
// Current Code.gs batch-path benchmark
// ---------------------------------------------------------------------------

var TYPED_SHEETS_BULK_CURRENT_PROJECTION_ = "system_state";
var TYPED_SHEETS_BULK_CURRENT_REGISTERED_RANGE_ = "A:F";
var TYPED_SHEETS_BULK_CURRENT_HEADERS_ = [
  "id",
  "value_1",
  "value_2",
  "value_3",
  "value_4",
  "value_5",
];

/**
 * Creates a deterministic fixture for the production batch helpers.
 *
 * Fixture creation is setup(일회성 준비) and is excluded from every stage
 * measurement. The measured production path adds the same anchor metadata
 * that Code.gs uses for CAS(동시성 상태 비교) and row identity.
 */
function bulkWriteBenchmarkPrepareCurrentProductionFixture_(rowCount) {
  var startedAt = Date.now();
  var spreadsheet = bulkWriteBenchmarkSpreadsheet_();
  var sheetName = (bulkWriteBenchmarkSheetName_() + "_current_path").slice(0, 90);
  var sheet = bulkWriteBenchmarkGetOrCreateSheet_(spreadsheet, sheetName);
  var headers = TYPED_SHEETS_BULK_CURRENT_HEADERS_.slice();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  // Start empty so this run measures the production createIfMissing(없으면 생성)
  // append path, which is the path used when SQLite has new rows for Sheets.
  bulkWriteBenchmarkResetStageRows_(sheet, 0);

  var runId = "current-path-" + Date.now() + "-" + Utilities.getUuid().slice(0, 8);
  var anchors = [];
  for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    var anchor = "benchmark-anchor:" + runId + ":" + rowIndex;
    anchors.push(anchor);
  }

  var receiptSheet = ensureInternalSheetWithHeaders_(
    spreadsheet,
    SYNC_RECEIPT_SHEET_NAME_,
    SYNC_RECEIPT_HEADERS_,
  );
  SpreadsheetApp.flush();

  var registration = {
    sheetName: sheetName,
    registeredRange: TYPED_SHEETS_BULK_CURRENT_REGISTERED_RANGE_,
    projection: TYPED_SHEETS_BULK_CURRENT_PROJECTION_,
    schemaVersion: 1,
    checkboxHeaders: [],
  };
  return {
    spreadsheet: spreadsheet,
    sheet: sheet,
    receiptSheet: receiptSheet,
    registration: registration,
    runId: runId,
    anchors: anchors,
    setupMs: Date.now() - startedAt,
  };
}

/**
 * Builds valid system-projection effects that update one field per row.
 *
 * The fixture deliberately uses new rows and one field per effect. Code.gs
 * still writes the complete normalized row in one append range, then writes
 * one Developer Metadata anchor per appended row, just like the production
 * createIfMissing path.
 */
function bulkWriteBenchmarkCurrentProductionEffects_(fixture, rowCount) {
  var effects = [];
  for (var rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    var nextCell = {
      kind: "string",
      value: fixture.runId + "-next-r" + rowIndex,
    };
    var targetFields = { value_1: nextCell };
    var payload = {
      sheetName: fixture.registration.sheetName,
      registeredRange: fixture.registration.registeredRange,
      schemaVersion: fixture.registration.schemaVersion,
      targetAnchor: fixture.anchors[rowIndex],
      fields: targetFields,
      targetVisibleHash: syncVisibleHashForFields_(targetFields),
      createIfMissing: true,
      expectedCandidateHash: null,
    };
    effects.push({
      effectId: "benchmark-effect:" + fixture.runId + ":" + rowIndex,
      payloadHash: sha256Hex_(canonicalJson_(payload)),
      effectKind: SYNC_EFFECT_KINDS_.SYSTEM_PROJECTION,
      physicalSheetId: "bulk-write-benchmark",
      projection: fixture.registration.projection,
      targetKind: "projection_row",
      targetId: fixture.anchors[rowIndex],
      rowBindingId: null,
      conflictId: null,
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      repairGuardHash: null,
      payload: payload,
    });
  }
  return effects;
}

/** Counts recovery dispositions without exposing effect payloads. */
function bulkWriteBenchmarkPostconditionDispositionCounts_(results) {
  var counts = {};
  results.forEach(function (result) {
    var disposition = result.postcondition && result.postcondition.disposition
      ? result.postcondition.disposition
      : "missing";
    counts[disposition] = (counts[disposition] || 0) + 1;
  });
  return counts;
}

/**
 * Measures the current Code.gs batch lifecycle on a dedicated fixture tab.
 *
 * The returned stages map directly to the production flow:
 *
 *   context read -> effect plan/CAS -> range write + flush
 *
 * For INLINE: the batch helpers additionally re-read and verify the just-written
 * rows before returning (mirrors the legacy default). For DEFERRED, that
 * inline re-read/verify is skipped because the production worker trusts the
 * flush and leaves verification to the recovery path; only the flush + receipt
 * write cost remains, matching the real steady-state per-batch latency.
 *
 * A separate recovery probe runs AFTER the measured total is captured, so the
 * cost of a response-loss read-back never inflates the per-batch number. Its
 * timing is reported as recoveryProbeMs for diagnostic comparison only.
 *
 * It intentionally does not call doPost(), because the signed HTTP envelope
 * is transport overhead; the goal here is to isolate the gateway's internal
 * spreadsheet bottlenecks while preserving the production helper sequence.
 */
function bulkWriteBenchmarkCurrentProductionRun_(rowCount, postconditionMode) {
  if (typeof createSyncBatchContext_ !== "function" ||
      typeof readSyncEffectPostconditions_ !== "function") {
    throw new Error(
      "Load Code.gs in the same Apps Script project before running the current-path benchmark.",
    );
  }

  var fixture = bulkWriteBenchmarkPrepareCurrentProductionFixture_(rowCount);
  var registration = fixture.registration;
  var effects = bulkWriteBenchmarkCurrentProductionEffects_(fixture, rowCount);
  var requestStartedAt = Date.now();
  var traceContext = {
    requestId: "benchmark-" + fixture.runId,
    operation: "applyEffects",
    registeredRange: registration.registeredRange,
  };

  // Decompose createSyncBatchContext_ so each production helper is timed on
  // its own. The assembled context is byte-for-byte identical to what the
  // production createSyncBatchContext_ returns, so commitSyncBatch_ behaves
  // exactly as it does in the real worker path.
  var readSheetValuesStartedAt = Date.now();
  var batchState = readSyncBatchState_(fixture.sheet, registration);
  var readSheetValuesMs = Date.now() - readSheetValuesStartedAt;

  // syncRegisteredColumns_, layout assembly, and ambiguousAnchors are pure
  // in-memory work; they mirror createSyncBatchContext_ but are not timed.
  var columns = syncRegisteredColumns_(registration);
  var layout = {
    headers: batchState.headers.slice(),
    positions: {},
    indexes: {},
    startColumn: columns.startColumn,
    columnCount: columns.columnCount,
  };
  layout.headers.forEach(function (header, index) {
    layout.positions[header] = columns.startColumn + index;
    layout.indexes[header] = index;
  });
  var ambiguousAnchors = Object.create(null);
  batchState.duplicateAnchors.forEach(function (entry) {
    ambiguousAnchors[entry.anchor] = true;
  });

  var ensureReceiptSheetStartedAt = Date.now();
  var receiptSheet = ensureInternalSheetWithHeaders_(
    fixture.spreadsheet,
    SYNC_RECEIPT_SHEET_NAME_,
    SYNC_RECEIPT_HEADERS_,
  );
  var ensureReceiptSheetMs = Date.now() - ensureReceiptSheetStartedAt;

  // Mirror createSyncBatchContext_: prune expired receipts before reading the
  // index so readReceiptsMs reflects the post-prune (bounded) receipt count.
  var pruneStartedAt = Date.now();
  var pruneResult = pruneSyncReceipts_(receiptSheet, pruneStartedAt);
  var pruneMs = Date.now() - pruneStartedAt;

  var readReceiptsStartedAt = Date.now();
  var receipts = readSyncReceipts_(receiptSheet);
  var readReceiptsMs = Date.now() - readReceiptsStartedAt;

  var context = {
    spreadsheet: fixture.spreadsheet,
    sheet: fixture.sheet,
    receiptSheet: receiptSheet,
    registration: registration,
    postconditionMode: postconditionMode,
    snapshot: {
      headers: batchState.headers,
      rows: batchState.rows,
      unanchoredRows: batchState.unanchoredRows,
      duplicateAnchors: batchState.duplicateAnchors,
    },
    layout: layout,
    rowStatesByNumber: batchState.rowStatesByNumber,
    rowsByAnchor: batchState.rowsByAnchor,
    ambiguousAnchors: ambiguousAnchors,
    receipts: receipts,
    pendingReceipts: [],
    pendingReceiptsById: Object.create(null),
    appendRows: [],
    fieldWritesByRow: Object.create(null),
    deletePlans: [],
    nextAppendRow: Math.max(batchState.lastRow + 1, 2),
    writeRowCount: 0,
  };

  var deferred = [];
  var immediateResultCount = 0;
  var planStartedAt = Date.now();
  effects.forEach(function (effect) {
    var planned = planSyncBatchEffect_(context, effect, {
      context: traceContext,
      requestStartedAt: requestStartedAt,
      effectId: effect.effectId,
    });
    if (planned.deferred !== null) deferred.push(planned.deferred);
    else immediateResultCount += 1;
  });
  var planMs = Date.now() - planStartedAt;

  // Use the production commit helper so postconditionMode actually controls
  // whether the just-written rows are re-read and verified inside the commit.
  // commitSyncBatch_ performs append/field/anchor writes, one flush, the
  // optional INLINE read-back, deletion, and the receipt range write.
  var commitStartedAt = Date.now();
  commitSyncBatch_(context, deferred, traceContext, requestStartedAt);
  var commitMs = Date.now() - commitStartedAt;

  // measuredTotalMs ends here: it covers exactly what a production applyEffects
  // request does before it returns, with no response-loss recovery read-back.
  var measuredTotalMs = Date.now() - requestStartedAt;

  // Recovery probe runs only for diagnostic comparison. It is deliberately
  // measured OUTSIDE measuredTotalMs because the production worker performs it
  // only in the rare response-loss path, never in steady state.
  var recoveryProbeStartedAt = Date.now();
  var recovery = readSyncEffectPostconditions_(
    fixture.spreadsheet,
    registration,
    { effects: effects },
  );
  var recoveryProbeMs = Date.now() - recoveryProbeStartedAt;
  var recoveryResults = recovery.results || [];

  var contextTotalMs = readSheetValuesMs + ensureReceiptSheetMs + pruneMs + readReceiptsMs;
  var result = {
    event: "typed_sheets_bulk_write_current_path_benchmark",
    postconditionMode: postconditionMode,
    runId: fixture.runId,
    sheetName: registration.sheetName,
    projection: registration.projection,
    registeredRange: registration.registeredRange,
    rowCount: rowCount,
    columnCount: TYPED_SHEETS_BULK_CURRENT_HEADERS_.length,
    setupMs: fixture.setupMs,
    measuredTotalMs: measuredTotalMs,
    recoveryProbeMs: recoveryProbeMs,
    counts: {
      effectCount: effects.length,
      deferredCount: deferred.length,
      immediateResultCount: immediateResultCount,
      writeRowCount: context.writeRowCount,
      receiptCount: context.pendingReceipts.length,
      recoveryResultCount: recoveryResults.length,
    },
    stages: [
      {
        stage: "batch_read_sheet_values",
        operationMs: readSheetValuesMs,
        includes: ["raw_values", "row_anchors", "per_row_anchor_metadata_read"],
        observedRowCount: batchState.rows.length,
      },
      {
        stage: "batch_ensure_receipt_sheet",
        operationMs: ensureReceiptSheetMs,
        includes: ["receipt_sheet_open", "protect", "hide", "remove_editors"],
      },
      {
        stage: "batch_read_receipts",
        operationMs: readReceiptsMs,
        includes: ["full_receipt_range_read", "receipt_index_build"],
        receiptCount: Object.keys(receipts).length,
      },
      {
        stage: "batch_prune_receipts",
        operationMs: pruneMs,
        includes: ["expired_receipt_count_scan", "bulk_delete_rows"],
        pruned: pruneResult.pruned,
        remaining: pruneResult.remaining,
      },
      {
        stage: "batch_context_read_total",
        operationMs: contextTotalMs,
        note: "Sum of the three decomposed context stages above; matches the previous batch_context_read granularity.",
      },
      {
        stage: "effect_plan_and_cas",
        operationMs: planMs,
        includes: ["effect_validation", "in_memory_guard_compare", "write_plan"],
      },
      {
        stage: "commit_batch",
        operationMs: commitMs,
        writeRowCount: context.writeRowCount,
        includes: postconditionMode === SYNC_POSTCONDITION_MODES_.DEFERRED
          ? ["append_writes", "field_writes", "flush", "deletes", "receipt_write", "deferred_finalize"]
          : ["append_writes", "field_writes", "flush", "inline_postcondition_read", "inline_postcondition_verify", "deletes", "receipt_write"],
      },
    ],
  };
  Logger.log(JSON.stringify(result));
  return result;
}
