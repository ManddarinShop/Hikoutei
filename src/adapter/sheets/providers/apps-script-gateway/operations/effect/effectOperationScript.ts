/** Self-contained V8 source executed by Code.gs for effect application and read-back. */
export const EFFECT_OPERATION_SOURCE = String.raw`function (spreadsheet, args) {
  var MAX_EFFECTS = 20;
  var RECEIPT_SHEET_NAME = "__typed_sheets_internal_effect_receipts";
  var RECEIPT_HEADERS = ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"];
  var ANCHOR_KEY = "typed_sheets_sync_anchor";
  var EFFECT_KINDS = {
    SYSTEM_PROJECTION: "system_projection",
    CANDIDATE_RECONCILE: "candidate_reconcile",
    SYSTEM_REPAIR: "system_repair",
    RESOLUTION_PROJECTION: "resolution_projection",
    RESOLUTION_DELETE: "resolution_delete",
    USER_INPUT_DELETE: "user_input_delete"
  };
  var DEFERRED = "deferred";

  var phases = [];
  var effectLockStartedAt = Date.now();
  var effectLock = LockService.getScriptLock();
  if (!effectLock.tryLock(20000)) throw new Error("Could not acquire the sync effect gateway lock");
  try {
    var operationResult = run_();
    appendTimingPhase_(operationResult, "script_lock", Date.now() - effectLockStartedAt);
    return operationResult;
  } finally {
    effectLock.releaseLock();
  }

  function run_() {
  var startedAt = Date.now();
  requireObject_(args, "effect operation args");
  var validationStartedAt = Date.now();
  if (!Array.isArray(args.effects) && args.mode === "applyEffects") {
    throw new Error("applyEffects effects must be an array");
  }
  phase_("validate_input", validationStartedAt);

  var sheetLookupStartedAt = Date.now();
  var sheet = spreadsheet.getSheetByName(args.sheetName);
  if (sheet === null) throw new Error("Registered sync sheet does not exist: " + args.sheetName);
  phase_("sheet_lookup", sheetLookupStartedAt);
  var layoutStartedAt = Date.now();
  var layout = readLayout_(sheet, args.registeredRange);
  phase_("layout_read", layoutStartedAt);
  var contextStartedAt = Date.now();
  var context = readContext_(sheet, layout, args.identityField);
  phase_("context_read", contextStartedAt);

  if (args.mode === "readEffectPostcondition") {
    return classifyPostcondition_(context, args.effect, readPostconditionReceipts_());
  }
  if (args.mode === "readEffectPostconditions") {
    if (!Array.isArray(args.effects) || args.effects.length === 0) {
      throw new Error("postcondition effects must be a non-empty array");
    }
    var postconditionReceipts = readPostconditionReceipts_();
    return {
      results: args.effects.map(function (effect) {
        return {
          effectId: String(effect.effectId),
          payloadHash: String(effect.payloadHash),
          postcondition: classifyPostcondition_(context, effect, postconditionReceipts)
        };
      })
    };
  }
  if (args.mode !== "applyEffects") throw new Error("unsupported effect operation mode");

  var receiptEnsureStartedAt = Date.now();
  var receiptSheet = ensureReceiptSheet_(spreadsheet);
  phase_("receipt_sheet_ensure", receiptEnsureStartedAt);
  var receiptReadStartedAt = Date.now();
  var receipts = readReceipts_(receiptSheet);
  phase_("receipt_read", receiptReadStartedAt);
  var pendingReceipts = [];
  var pendingReceiptsById = Object.create(null);
  var appendRows = [];
  var deleteRows = [];
  var deferred = [];
  var results = [];
  var count = Math.min(args.effects.length, MAX_EFFECTS);
  var postconditionMode = args.postconditionMode === undefined ? "inline" : args.postconditionMode;
  if (postconditionMode !== "inline" && postconditionMode !== DEFERRED) {
    throw new Error("applyEffects postconditionMode must be inline or deferred");
  }

  var planStartedAt = Date.now();
  for (var index = 0; index < count; index += 1) {
    var checked = requireEffect_(args.effects[index], args);
    var existingReceipt = receipts[checked.effectId] || pendingReceiptsById[checked.effectId] || null;
    if (existingReceipt !== null) {
      if (existingReceipt.payloadHash !== checked.payloadHash) {
        results[index] = result_(checked, "schema_error", null, "effect_id_reused_with_different_payload", null);
        continue;
      }
      var receiptRow = findRow_(context, checked.payload.targetAnchor, checked.targetId);
      if (isDeletion_(checked.effectKind)) {
        results[index] = receiptRow === null
          ? result_(checked, "already_applied", null, null, existingReceipt)
          : result_(checked, "guard_mismatch", receiptRow.rowNumber, "receipt_target_reappeared", null);
        continue;
      }
      if (receiptRow === null) {
        results[index] = result_(
          checked,
          checked.effectKind === EFFECT_KINDS.SYSTEM_REPAIR ? "repair_reobserve" : "guard_mismatch",
          null,
          "receipt_target_missing",
          null,
        );
        continue;
      }
      var receiptCurrentHash = currentHash_(receiptRow, checked.payload.fields);
      results[index] = receiptCurrentHash === checked.payload.targetVisibleHash
        ? result_(checked, "already_applied", receiptRow.rowNumber, null, existingReceipt)
        : result_(
          checked,
          checked.effectKind === EFFECT_KINDS.SYSTEM_REPAIR ? "repair_reobserve" : "guard_mismatch",
          receiptRow.rowNumber,
          "receipt_postcondition_changed",
          null,
        );
      continue;
    }

    var row = findRow_(context, checked.payload.targetAnchor, checked.targetId);
    var created = false;
    if (row === null) {
      if (!checked.payload.createIfMissing) {
        results[index] = result_(checked, "guard_mismatch", null, "target_anchor_missing", null);
        continue;
      }
      if (checked.expectedVisibleRevision !== 0 || checked.expectedVisibleHash !== "") {
        results[index] = result_(checked, "guard_mismatch", null, "insert_requires_empty_visible_baseline", null);
        continue;
      }
      row = createRow_(context, checked.payload.targetAnchor, checked.targetId);
      appendRows.push(row);
      created = true;
    }

    if (isDeletion_(checked.effectKind)) {
      var deletionSchemaError = validateDeletion_(layout, checked);
      if (deletionSchemaError !== null) {
        results[index] = result_(checked, "schema_error", row.rowNumber, deletionSchemaError, null);
        continue;
      }
      var deletionHash = currentHash_(row, checked.payload.fields);
      if (deletionHash !== checked.expectedVisibleHash) {
        results[index] = result_(checked, "guard_mismatch", row.rowNumber, "visible_guard_mismatch", null);
        continue;
      }
      var deletionReceipt = makeReceipt_(checked, deletionHash, checked.expectedVisibleRevision);
      row.deleted = true;
      deleteRows.push(row);
      queueReceipt_(receipts, pendingReceipts, pendingReceiptsById, deletionReceipt);
      deferred.push({ index: index, checked: checked, row: row, receipt: deletionReceipt, deletion: true });
      continue;
    }

    var currentHash = currentHash_(row, checked.payload.fields);
    var expectedCandidateHash = optionalWireText_(checked.payload.expectedCandidateHash);
    if (checked.effectKind === EFFECT_KINDS.CANDIDATE_RECONCILE &&
        expectedCandidateHash !== null && currentHash !== checked.expectedVisibleHash) {
      results[index] = result_(checked, "guard_mismatch", row.rowNumber, "candidate_guard_mismatch", null);
      continue;
    }
    if (currentHash === checked.payload.targetVisibleHash) {
      var alreadyReceipt = makeReceipt_(checked, currentHash, checked.expectedVisibleRevision + 1);
      queueReceipt_(receipts, pendingReceipts, pendingReceiptsById, alreadyReceipt);
      results[index] = result_(checked, created ? "applied" : "already_applied", row.rowNumber, null, alreadyReceipt);
      continue;
    }
    var repairGuardHash = optionalWireText_(checked.repairGuardHash);
    if (checked.effectKind === EFFECT_KINDS.SYSTEM_REPAIR) {
      if (repairGuardHash === null || currentHash !== repairGuardHash) {
        results[index] = result_(checked, "repair_reobserve", row.rowNumber, "repair_guard_mismatch", null);
        continue;
      }
    } else if (currentHash !== checked.expectedVisibleHash) {
      results[index] = result_(checked, "guard_mismatch", row.rowNumber, "visible_guard_mismatch", null);
      continue;
    }

    Object.keys(checked.payload.fields).forEach(function (fieldName) {
      row.cells[fieldName] = checked.payload.fields[fieldName];
      if (!row.appended) {
        row.writeFields[fieldName] = checked.payload.fields[fieldName];
        context.updatedRows[row.rowNumber] = row;
      }
    });
    deferred.push({
      index: index,
      checked: checked,
      row: row,
      receipt: makeReceipt_(checked, checked.payload.targetVisibleHash, checked.expectedVisibleRevision + 1),
      deletion: false,
    });
  }
  phase_("effect_plan", planStartedAt);

  var appendWriteStartedAt = Date.now();
  writeAppendRows_(sheet, layout, appendRows, args.checkboxHeaders);
  phase_("append_write", appendWriteStartedAt);
  var fieldWriteStartedAt = Date.now();
  writeFieldUpdates_(sheet, layout, context.rows);
  phase_("field_update_write", fieldWriteStartedAt);
  var writeFlushStartedAt = Date.now();
  if (appendRows.length > 0 || Object.keys(context.updatedRows).length > 0) SpreadsheetApp.flush();
  phase_("write_flush", writeFlushStartedAt);

  var postconditionStartedAt = Date.now();
  deferred.forEach(function (planned) {
    if (planned.deletion) {
      results[planned.index] = result_(planned.checked, "applied", null, null, planned.receipt);
      return;
    }
    if (postconditionMode !== DEFERRED &&
        physicalHash_(sheet, layout, planned.row.rowNumber, planned.checked.payload.fields) !== planned.checked.payload.targetVisibleHash) {
      results[planned.index] = result_(planned.checked, "retryable_error", planned.row.rowNumber, "postcondition_hash_mismatch", null);
      return;
    }
    queueReceipt_(receipts, pendingReceipts, pendingReceiptsById, planned.receipt);
    results[planned.index] = result_(planned.checked, "applied", planned.row.rowNumber, null, planned.receipt);
  });
  phase_("postcondition", postconditionStartedAt);

  var deleteStartedAt = Date.now();
  deleteRows.slice().sort(function (left, right) { return right.rowNumber - left.rowNumber; }).forEach(function (row) {
    sheet.deleteRow(row.rowNumber);
  });
  phase_("delete_rows", deleteStartedAt);
  var deleteFlushStartedAt = Date.now();
  if (deleteRows.length > 0) SpreadsheetApp.flush();
  phase_("delete_flush", deleteFlushStartedAt);
  var receiptWriteStartedAt = Date.now();
  writeReceipts_(receiptSheet, pendingReceipts);
  phase_("receipt_write", receiptWriteStartedAt);
  results.forEach(function (entry) {
    if (entry === null || entry === undefined) throw new Error("effect result was not produced");
    if (postconditionMode === DEFERRED &&
        (entry.status === "applied" || entry.status === "already_applied")) {
      entry.postcondition = "acknowledged";
    }
  });
  var operationCounts = countOperationKinds_(args.effects);
  return {
    results: results,
    snapshotHash: null,
    hasMore: args.effects.length > count,
    timing: {
      operationKinds: operationKinds_(operationCounts),
      operationCounts: operationCounts,
      durationMs: Date.now() - startedAt,
      phases: phases,
    },
  };
  }

  function readLayout_(targetSheet, registeredRange) {
    var parsed = parseRange_(registeredRange);
    var headerValues = targetSheet.getRange(1, parsed.startColumn, 1, parsed.columnCount).getValues()[0];
    var headers = [];
    var positions = Object.create(null);
    headerValues.forEach(function (header, headerIndex) {
      if (typeof header !== "string" || header.trim() === "") throw new Error("registered header is invalid");
      if (positions[header] !== undefined) throw new Error("registered headers contain a duplicate");
      headers.push(header);
      positions[header] = parsed.startColumn + headerIndex;
    });
    return { startColumn: parsed.startColumn, columnCount: parsed.columnCount, headers: headers, positions: positions };
  }

  function readContext_(targetSheet, layout, identityField) {
    var rows = [];
    var byAnchor = Object.create(null);
    var byIdentity = Object.create(null);
    var lastRow = targetSheet.getLastRow();
    var rawRows = lastRow < 2 ? [] : targetSheet.getRange(2, layout.startColumn, lastRow - 1, layout.columnCount).getValues();
    rawRows.forEach(function (raw, offset) {
      if (isBlankRow_(raw)) return;
      var rowNumber = offset + 2;
      var cells = Object.create(null);
      layout.headers.forEach(function (header, headerIndex) {
        cells[header] = normalizedCellFromSheetValue_(raw[headerIndex]);
      });
      var anchors = readAnchors_(targetSheet, rowNumber);
      if (anchors.length > 1) throw new Error("row has multiple sync anchors: " + rowNumber);
      var anchor = anchors.length === 1 ? anchors[0] : null;
      var identity = identityField === undefined ? null : identityFromCell_(cells[identityField]);
      var row = {
        rowNumber: rowNumber,
        physicalAnchor: anchor,
        targetId: identity,
        cells: cells,
        writeFields: Object.create(null),
        appended: false,
        deleted: false,
      };
      if (anchor !== null) {
        if (byAnchor[anchor] !== undefined) throw new Error("sync anchor is duplicated: " + anchor);
        byAnchor[anchor] = row;
      }
      if (identity !== null) {
        if (byIdentity[identity] !== undefined) throw new Error("sync identity is duplicated: " + identity);
        byIdentity[identity] = row;
      }
      rows.push(row);
    });
    return {
      rows: rows,
      updatedRows: Object.create(null),
      byAnchor: byAnchor,
      byIdentity: byIdentity,
      nextAppendRow: Math.max(lastRow + 1, 2),
      layout: layout,
    };
  }

  function createRow_(targetContext, anchor, targetId) {
    var cells = Object.create(null);
    targetContext.layout.headers.forEach(function (header) { cells[header] = null; });
    var row = {
      rowNumber: targetContext.nextAppendRow++,
      physicalAnchor: anchor,
      targetId: targetId,
      cells: cells,
      writeFields: Object.create(null),
      appended: true,
      deleted: false,
    };
    targetContext.rows.push(row);
    targetContext.byAnchor[anchor] = row;
    if (targetId !== null) targetContext.byIdentity[targetId] = row;
    return row;
  }

  function findRow_(targetContext, anchor, targetId) {
    var row = targetContext.byAnchor[anchor] || null;
    if (row === null && targetId !== null && targetId !== undefined) row = targetContext.byIdentity[targetId] || null;
    return row !== null && row.deleted ? null : row;
  }

  function currentHash_(row, fields) {
    var values = Object.create(null);
    Object.keys(fields).forEach(function (fieldName) {
      if (!Object.prototype.hasOwnProperty.call(row.cells, fieldName)) throw new Error("effect field is not a registered header: " + fieldName);
      values[fieldName] = row.cells[fieldName];
    });
    return visibleHash_(values);
  }

  function physicalHash_(targetSheet, targetLayout, rowNumber, fields) {
    var values = Object.create(null);
    Object.keys(fields).forEach(function (fieldName) {
      if (targetLayout.positions[fieldName] === undefined) throw new Error("effect field is not a registered header: " + fieldName);
      values[fieldName] = normalizedCellFromSheetValue_(
        targetSheet.getRange(rowNumber, targetLayout.positions[fieldName], 1, 1).getValues()[0][0],
      );
    });
    return visibleHash_(values);
  }

  function readPostconditionReceipts_() {
    var receiptSheetForRead = spreadsheet.getSheetByName(RECEIPT_SHEET_NAME);
    return receiptSheetForRead === null ? Object.create(null) : readReceipts_(receiptSheetForRead);
  }

  function classifyPostcondition_(targetContext, rawEffect, receiptsForRead) {
    var checked = requireEffect_(rawEffect, args);
    var receipt = receiptsForRead[checked.effectId] || null;
    var row = findRow_(targetContext, checked.payload.targetAnchor, checked.targetId);
    if (isDeletion_(checked.effectKind)) {
      if (receipt !== null && row === null) return postcondition_("applied", receipt.visibleRevision, receipt.visibleHash);
      if (row === null) return postcondition_("unavailable", null, null);
      var deleteHash = currentHash_(row, checked.payload.fields);
      if (receipt !== null) return postcondition_("changed", null, deleteHash);
      return deleteHash === checked.expectedVisibleHash
        ? postcondition_("unapplied", checked.expectedVisibleRevision, deleteHash)
        : postcondition_("changed", null, deleteHash);
    }
    if (row === null) return postcondition_(checked.payload.createIfMissing ? "unapplied" : "changed", null, null);
    var current = currentHash_(row, checked.payload.fields);
    if (current === checked.payload.targetVisibleHash) {
      return postcondition_("applied", receipt === null ? checked.expectedVisibleRevision + 1 : receipt.visibleRevision, current);
    }
    var repairGuard = optionalWireText_(checked.repairGuardHash);
    if (current === checked.expectedVisibleHash || (repairGuard !== null && current === repairGuard)) {
      return postcondition_("unapplied", checked.expectedVisibleRevision, current);
    }
    return postcondition_("changed", null, current);
  }

  function postcondition_(disposition, revision, hash) {
    return { disposition: disposition, visibleRevision: revision, visibleHash: hash, snapshotHash: null };
  }

  function requireEffect_(rawEffect, request) {
    requireObject_(rawEffect, "effect");
    var effectKind = string_(rawEffect.effectKind, "effectKind");
    if ([
      EFFECT_KINDS.SYSTEM_PROJECTION,
      EFFECT_KINDS.CANDIDATE_RECONCILE,
      EFFECT_KINDS.SYSTEM_REPAIR,
      EFFECT_KINDS.RESOLUTION_PROJECTION,
      EFFECT_KINDS.RESOLUTION_DELETE,
      EFFECT_KINDS.USER_INPUT_DELETE,
    ].indexOf(effectKind) < 0) throw new Error("unsupported sync effect kind: " + effectKind);
    if (rawEffect.projection !== request.projection) throw new Error("effect projection is not registered for this request");
    if (effectKind === EFFECT_KINDS.RESOLUTION_DELETE && request.projection !== "sync_conflicts") {
      throw new Error("resolution_delete is only allowed on sync_conflicts");
    }
    if (effectKind === EFFECT_KINDS.USER_INPUT_DELETE && request.projection !== "user_input") {
      throw new Error("user_input_delete is only allowed on user_input");
    }
    var payload = rawEffect.payload;
    requireObject_(payload, "effect payload");
    if (payload.sheetName !== request.sheetName || payload.registeredRange !== request.registeredRange ||
        payload.schemaVersion !== request.schemaVersion) throw new Error("effect payload does not match the registered projection");
    var fields = Object.create(null);
    requireObject_(payload.fields, "effect fields");
    Object.keys(payload.fields).forEach(function (fieldName) { fields[fieldName] = normalizeCell_(payload.fields[fieldName]); });
    if (Object.keys(fields).length === 0) throw new Error("effect fields must contain a field");
    if (visibleHash_(fields) !== string_(payload.targetVisibleHash, "targetVisibleHash")) {
      throw new Error("effect targetVisibleHash does not match fields");
    }
    if (typeof payload.createIfMissing !== "boolean") throw new Error("effect createIfMissing must be boolean");
    var expectedVisibleRevision = nonNegativeInteger_(rawEffect.expectedVisibleRevision, "expectedVisibleRevision");
    var expectedVisibleHash = stringAllowEmpty_(rawEffect.expectedVisibleHash, "expectedVisibleHash");
    if (
      expectedVisibleHash.length === 0 &&
      !(expectedVisibleRevision === 0 && payload.createIfMissing === true)
    ) {
      throw new Error("empty expectedVisibleHash is only valid for a new row");
    }
    return {
      effectId: string_(rawEffect.effectId, "effectId"),
      payloadHash: string_(rawEffect.payloadHash, "payloadHash"),
      effectKind: effectKind,
      targetId: typeof rawEffect.targetId === "string" && rawEffect.targetId.length > 0 ? rawEffect.targetId : null,
      expectedVisibleRevision: expectedVisibleRevision,
      expectedVisibleHash: expectedVisibleHash,
      repairGuardHash: rawEffect.repairGuardHash,
      payload: {
        targetAnchor: string_(payload.targetAnchor, "targetAnchor"),
        targetVisibleHash: payload.targetVisibleHash,
        createIfMissing: payload.createIfMissing,
        expectedCandidateHash: payload.expectedCandidateHash,
        fields: fields,
      },
    };
  }

  function validateDeletion_(targetLayout, checked) {
    if (checked.payload.createIfMissing || checked.expectedVisibleRevision < 1 ||
        checked.payload.targetVisibleHash !== checked.expectedVisibleHash) return "invalid_deletion_guard";
    var names = Object.keys(checked.payload.fields).sort();
    var headers = targetLayout.headers.slice().sort();
    if (names.length !== headers.length) return checked.effectKind + "_requires_full_row";
    for (var index = 0; index < headers.length; index += 1) if (names[index] !== headers[index]) return checked.effectKind + "_requires_full_row";
    return null;
  }

  function result_(checked, status, rowNumber, reason, receipt) {
    return {
      effectId: checked.effectId,
      payloadHash: checked.payloadHash,
      status: status,
      visibleRevision: receipt === null ? null : receipt.visibleRevision,
      visibleHash: receipt === null ? null : receipt.visibleHash,
      snapshotHash: null,
      reason: reason === null ? null : reason,
      postcondition: receipt === null ? "unavailable" : "verified",
    };
  }

  function makeReceipt_(checked, visibleHash, visibleRevision) {
    return { effectId: checked.effectId, payloadHash: checked.payloadHash, status: "applied", visibleHash: visibleHash, visibleRevision: visibleRevision };
  }

  function ensureReceiptSheet_(targetSpreadsheet) {
    var target = targetSpreadsheet.getSheetByName(RECEIPT_SHEET_NAME);
    if (target === null) target = targetSpreadsheet.insertSheet(RECEIPT_SHEET_NAME);
    if (target.getLastRow() === 0 && target.getLastColumn() === 0) target.getRange(1, 1, 1, RECEIPT_HEADERS.length).setValues([RECEIPT_HEADERS]);
    var actual = target.getRange(1, 1, 1, RECEIPT_HEADERS.length).getValues()[0];
    RECEIPT_HEADERS.forEach(function (header, index) { if (String(actual[index]) !== header) throw new Error("receipt sheet headers do not match"); });
    try { if (!target.isSheetHidden()) target.hideSheet(); } catch (error) {}
    return target;
  }

  function readReceipts_(target) {
    var parsed = Object.create(null);
    var lastRow = target.getLastRow();
    if (lastRow < 2) return parsed;
    target.getRange(2, 1, lastRow - 1, RECEIPT_HEADERS.length).getValues().forEach(function (row, index) {
      if (row[0] === "" || row[0] === null) return;
      var effectId = String(row[0]);
      if (parsed[effectId] !== undefined) throw new Error("receipt sheet contains duplicate effectId: " + effectId);
      parsed[effectId] = {
        effectId: effectId,
        payloadHash: string_(row[1], "receipt payloadHash"),
        status: string_(row[2], "receipt status"),
        visibleHash: string_(row[3], "receipt visibleHash"),
        visibleRevision: nonNegativeInteger_(row[4], "receipt visibleRevision"),
        rowNumber: index + 2,
      };
    });
    return parsed;
  }

  function queueReceipt_(stored, pending, pendingById, receipt) {
    var existing = stored[receipt.effectId] || pendingById[receipt.effectId] || null;
    if (existing !== null) {
      if (existing.payloadHash !== receipt.payloadHash) throw new Error("effect ID cannot be reused with another payload");
      return;
    }
    pendingById[receipt.effectId] = receipt;
    pending.push(receipt);
  }

  function writeReceipts_(target, values) {
    if (values.length === 0) return;
    var startRow = Math.max(target.getLastRow() + 1, 2);
    var updatedAt = new Date().toISOString();
    target.getRange(startRow, 1, values.length, RECEIPT_HEADERS.length).setValues(values.map(function (receipt) {
      return [receipt.effectId, receipt.payloadHash, receipt.status, receipt.visibleHash, receipt.visibleRevision, updatedAt];
    }));
  }

  function writeAppendRows_(target, targetLayout, rows, checkboxHeaders) {
    if (rows.length === 0) return;
    rows.sort(function (left, right) { return left.rowNumber - right.rowNumber; });
    target.getRange(rows[0].rowNumber, targetLayout.startColumn, rows.length, targetLayout.columnCount).setValues(rows.map(function (row) {
      return targetLayout.headers.map(function (header) { return toSheetValue_(row.cells[header]); });
    }));
    rows.forEach(function (row) {
      target.getRange(row.rowNumber + ":" + row.rowNumber).addDeveloperMetadata(ANCHOR_KEY, row.physicalAnchor, SpreadsheetApp.DeveloperMetadataVisibility.PROJECT);
    });
    if (Array.isArray(checkboxHeaders)) checkboxHeaders.forEach(function (header) {
      var position = targetLayout.positions[header];
      if (position === undefined) throw new Error("checkbox header is not registered: " + header);
      target.getRange(rows[0].rowNumber, position, rows.length, 1).setDataValidation(
        SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(false).build(),
      );
    });
  }

  function writeFieldUpdates_(target, targetLayout, rows) {
    rows.filter(function (row) { return !row.appended && Object.keys(row.writeFields).length > 0; }).forEach(function (row) {
      var fields = Object.keys(row.writeFields).sort(function (left, right) { return targetLayout.positions[left] - targetLayout.positions[right]; });
      var run = [];
      fields.forEach(function (fieldName) {
        if (run.length > 0 && targetLayout.positions[fieldName] !== targetLayout.positions[run[run.length - 1]] + 1) {
          writeFieldRun_(target, targetLayout, row, run);
          run = [];
        }
        run.push(fieldName);
      });
      if (run.length > 0) writeFieldRun_(target, targetLayout, row, run);
    });
  }

  function writeFieldRun_(target, targetLayout, row, fields) {
    target.getRange(row.rowNumber, targetLayout.positions[fields[0]], 1, fields.length).setValues([
      fields.map(function (fieldName) { return toSheetValue_(row.writeFields[fieldName]); }),
    ]);
  }

  function readAnchors_(target, rowNumber) {
    return target.getRange(rowNumber + ":" + rowNumber).getDeveloperMetadata().filter(function (metadata) {
      return metadata.getKey() === ANCHOR_KEY;
    }).map(function (metadata) { return String(metadata.getValue()); });
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

  function normalizeCell_(value) {
    if (value === null) return null;
    requireObject_(value, "normalized cell");
    if (value.kind === "string" && typeof value.value === "string") return { kind: "string", value: normalizeScalarString_(value.value) };
    if (value.kind === "date" && typeof value.value === "string") return { kind: "date", value: value.value };
    if (value.kind === "number" && typeof value.value === "number" && isFinite(value.value)) return { kind: "number", value: value.value };
    if (value.kind === "boolean" && typeof value.value === "boolean") return { kind: "boolean", value: value.value };
    throw new Error("normalized cell is invalid");
  }

  function normalizedCellFromSheetValue_(value) {
    if (value === "" || value === null) return null;
    if (isDate_(value)) return { kind: "date", value: value.toISOString() };
    if (typeof value === "string") return { kind: "string", value: normalizeScalarString_(value) };
    if (typeof value === "number" && isFinite(value)) return { kind: "number", value: value };
    if (typeof value === "boolean") return { kind: "boolean", value: value };
    throw new Error("Sheet cell cannot be normalized");
  }

  function toSheetValue_(value) { return value === null ? "" : value.value; }
  function identityFromCell_(value) {
    if (value === null || value === undefined) return null;
    if (typeof value.value === "string" && value.value.length > 0) return value.value;
    if (typeof value.value === "number" && isFinite(value.value)) return String(value.value);
    return null;
  }
  function optionalWireText_(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (isObject_(value) && (value.kind === "present" || value.kind === "applicable")) return string_(value.value, "optional wire value");
    if (isObject_(value) && (value.kind === "absent" || value.kind === "not_applicable")) return null;
    throw new Error("optional wire value is invalid");
  }
  function isDeletion_(effectKind) { return effectKind === EFFECT_KINDS.RESOLUTION_DELETE || effectKind === EFFECT_KINDS.USER_INPUT_DELETE; }
  function countOperationKinds_(effects) {
    var counts = { append: 0, update: 0, delete: 0 };
    effects.forEach(function (effect) {
      if (effect !== null && isDeletion_(effect.effectKind)) {
        counts.delete += 1;
        return;
      }
      if (effect !== null && effect.payload !== null && effect.payload !== undefined &&
          effect.payload.createIfMissing === true && effect.expectedVisibleRevision === 0 &&
          effect.expectedVisibleHash === "") {
        counts.append += 1;
        return;
      }
      counts.update += 1;
    });
    return counts;
  }
  function operationKinds_(counts) {
    var kinds = [];
    if (counts.append > 0) kinds.push("append");
    if (counts.update > 0) kinds.push("update");
    if (counts.delete > 0) kinds.push("delete");
    return kinds;
  }
  function phase_(name, phaseStartedAt) {
    phases.push({ phase: name, durationMs: Date.now() - phaseStartedAt });
  }
  function appendTimingPhase_(result, phaseName, durationMs) {
    if (!isObject_(result) || !isObject_(result.timing)) return;
    if (!Array.isArray(result.timing.phases)) result.timing.phases = [];
    result.timing.phases.push({ phase: phaseName, durationMs: durationMs });
    result.timing.durationMs = Number(result.timing.durationMs) + durationMs;
  }
  function isBlankRow_(row) { return row.every(function (cell) { return cell === "" || cell === null; }); }
  function isDate_(value) { return Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime()); }
  function isObject_(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function requireObject_(value, label) { if (!isObject_(value)) throw new Error(label + " must be an object"); return value; }
  function string_(value, label) { if (typeof value !== "string" || value.length === 0) throw new Error(label + " must be a non-empty string"); return value; }
  function stringAllowEmpty_(value, label) { if (typeof value !== "string") throw new Error(label + " must be a string"); return value; }
  function nonNegativeInteger_(value, label) { if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value || value < 0) throw new Error(label + " must be a non-negative integer"); return value; }

  function visibleHash_(fields) {
    return stableHash_({ fields: Object.keys(fields).sort().map(function (fieldName) { return { fieldName: fieldName, value: fields[fieldName] }; }) });
  }
  function stableHash_(value) { return sha256Hex_(stableEncode_(value)); }
  function stableEncode_(value) {
    if (value === null) return "n";
    if (value === true) return "b1";
    if (value === false) return "b0";
    if (typeof value === "number") return stableEncodeNumber_(value);
    if (typeof value === "string") return stableEncodeString_(value);
    if (isObject_(value) && value.kind === "date" && typeof value.value === "string") return "d24:" + value.value;
    if (Array.isArray(value)) return "a" + value.length + "[" + value.map(stableEncode_).join("") + "]";
    if (isObject_(value)) {
      var entries = Object.keys(value).map(function (key) { var normalized = normalizeScalarString_(key); return { key: normalized, bytes: utf8Bytes_(normalized), value: value[key] }; });
      entries.sort(function (left, right) { return compareBytes_(left.bytes, right.bytes); });
      return "o" + entries.length + "{" + entries.map(function (entry) { return "s" + entry.bytes.length + ":" + entry.key + stableEncode_(entry.value); }).join("") + "}";
    }
    throw new Error("stable value is unsupported");
  }
  function stableEncodeNumber_(value) { if (!isFinite(value)) throw new Error("stable number is not finite"); var decimal = value === 0 ? "0" : String(value).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2"); return "f" + utf8ByteLength_(decimal) + ":" + decimal; }
  function stableEncodeString_(value) { var normalized = normalizeScalarString_(value); return "s" + utf8ByteLength_(normalized) + ":" + normalized; }
  function normalizeScalarString_(value) { return value.normalize("NFC"); }
  function sha256Hex_(value) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8).map(function (byte) { var unsigned = byte < 0 ? byte + 256 : byte; return ("0" + unsigned.toString(16)).slice(-2); }).join(""); }
  function utf8Bytes_(value) { return Utilities.newBlob(value).getBytes(); }
  function utf8ByteLength_(value) { return utf8Bytes_(value).length; }
  function compareBytes_(left, right) { var count = Math.min(left.length, right.length); for (var index = 0; index < count; index += 1) { var a = left[index] < 0 ? left[index] + 256 : left[index]; var b = right[index] < 0 ? right[index] + 256 : right[index]; if (a !== b) return a - b; } return left.length - right.length; }
}`;
