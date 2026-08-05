import { APPS_SCRIPT_STABLE_CODEC_SOURCE } from "../shared/appsScriptStableCodecSource.js";

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
  var effectLock = null;
  var effectLockStartedAt = Date.now();
  // Postcondition probes read the same Sheet rows and receipt state that an
  // in-flight apply mutates, so they must hold the same script lock; otherwise
  // a delayed or timed-out apply could overlap a probe and be misclassified.
  var LOCKED_MODES = {
    applyEffects: true,
    readEffectPostcondition: true,
    readEffectPostconditions: true
  };
  if (args && LOCKED_MODES[args.mode] === true) {
    effectLock = LockService.getScriptLock();
    if (!effectLock.tryLock(20000)) throw new Error("Could not acquire the sync effect gateway lock");
  }
  try {
    var operationResult = run_();
    if (effectLock !== null) appendTimingPhase_(operationResult, "script_lock", Date.now() - effectLockStartedAt);
    return operationResult;
  } finally {
    if (effectLock !== null) effectLock.releaseLock();
  }

  function run_() {
  var startedAt = Date.now();
  requireObject_(args, "effect operation args");
  assertAuthority_(spreadsheet, args.mode === "applyEffects");
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
  var deletionReceiptIds = Object.create(null);
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
      deletionReceiptIds[deletionReceipt.effectId] = true;
      deferred.push({ index: index, checked: checked, row: row, receipt: deletionReceipt, deletion: true });
      continue;
    }

    // A newly created row is still the empty visible baseline. Its in-memory
    // cells are blank, so hashing them would incorrectly turn the first
    // candidate reconcile into a guard mismatch before the requested fields
    // are written.
    var currentHash = created ? checked.expectedVisibleHash : currentHash_(row, checked.payload.fields);
    var expectedCandidateHash = optionalWireText_(checked.payload.expectedCandidateHash);
    if (checked.effectKind === EFFECT_KINDS.CANDIDATE_RECONCILE &&
        !created && expectedCandidateHash !== null && currentHash !== checked.expectedVisibleHash) {
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

  // Deletion results are receipt-backed only after the delete/receipt batch
  // completes without throwing; a crash inside it leaves deleted rows
  // without receipts, which recovery probes classify as delivery-uncertain.
  var deleteBatchStartedAt = Date.now();
  writeDeletionAndReceiptsBatch_(sheet, receiptSheet, deleteRows, pendingReceipts.filter(function (receipt) {
    return deletionReceiptIds[receipt.effectId] === true;
  }));
  phase_("delete_and_receipt_batch", Date.now() - deleteBatchStartedAt);
  var receiptWriteStartedAt = Date.now();
  writeReceipts_(receiptSheet, pendingReceipts.filter(function (receipt) {
    return deletionReceiptIds[receipt.effectId] !== true;
  }));
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

  function assertAuthority_(targetSpreadsheet, allowAdvance) {
    if (args.authority === undefined) return;
    if (!args.authority || typeof args.authority.epoch !== "number" ||
        Math.floor(args.authority.epoch) !== args.authority.epoch || args.authority.epoch < 1 ||
        typeof args.authority.token !== "string" || args.authority.token.length === 0) {
      throw new Error("effect authority is invalid");
    }
    var key = "typed_sheets_authority:" + targetSpreadsheet.getId();
    var properties = PropertiesService.getScriptProperties();
    var raw = properties.getProperty(key);
    var current = raw === null ? null : JSON.parse(raw);
    if (current !== null && (current.epoch > args.authority.epoch ||
        current.epoch === args.authority.epoch && current.token !== args.authority.token)) {
      throw new Error("effect authority fence is stale");
    }
    if (allowAdvance && (current === null || args.authority.epoch > current.epoch)) {
      properties.setProperty(key, JSON.stringify({ epoch: args.authority.epoch, token: args.authority.token }));
    }
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
        if (byAnchor[anchor] !== undefined) {
          throw new Error("sync anchor is duplicated: " + anchor + " at rows " + byAnchor[anchor].rowNumber + " and " + rowNumber);
        }
        byAnchor[anchor] = row;
      }
      if (identity !== null) {
        if (byIdentity[identity] !== undefined) {
          throw new Error("sync identity is duplicated: " + identity + " at rows " + byIdentity[identity].rowNumber + " and " + rowNumber);
        }
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
    if (row === null && targetId !== null && targetId !== undefined) {
      row = targetContext.byIdentity[targetId] || null;
      if (row === null && typeof targetId === "string") {
        var separator = targetId.lastIndexOf(":");
        var visibleIdentity = separator < 0 ? null : targetId.slice(separator + 1);
        if (visibleIdentity !== null && visibleIdentity.length > 0) {
          row = targetContext.byIdentity[visibleIdentity] || null;
        }
      }
    }
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
    if (receipt !== null && receipt.payloadHash !== checked.payloadHash) {
      return postcondition_("changed", null, null);
    }
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
    // A receipt alone cannot prove that a non-delete row still exists; a
    // manual deletion must remain observable instead of closing the outbox.
    if (row === null) {
      // A receipt proves that this effect reached the Gateway, not that a
      // non-delete projection row still exists. Treat a manually removed row
      // as a terminal changed/manual-repair condition even when the original
      // effect allowed creation; otherwise recovery would hot-loop forever on
      // the same stale receipt.
      return postcondition_(
        receipt !== null || !checked.payload.createIfMissing ? "changed" : "unapplied",
        null,
        null,
        receipt === null ? null : "receipt_target_missing",
      );
    }
    var current = currentHash_(row, checked.payload.fields);
    if (current === checked.payload.targetVisibleHash) {
      if (receipt === null) {
        // The row already carries the target content, but without a receipt
        // there is no durable proof that this effect was applied by the
        // Gateway: the two-flush append can crash between the target-row
        // write and the receipt write and leave exactly this orphan. Closing
        // the outbox on row-hash evidence alone would turn that crash into a
        // false success, so stay fail-closed: the worker defers delivery and
        // probes again instead of calling completeApplied or redriving.
        return postcondition_("unavailable", null, current, "receipt_missing");
      }
      return postcondition_("applied", receipt.visibleRevision, current);
    }
    var repairGuard = optionalWireText_(checked.repairGuardHash);
    if (current === checked.expectedVisibleHash || (repairGuard !== null && current === repairGuard)) {
      return postcondition_("unapplied", checked.expectedVisibleRevision, current);
    }
    return postcondition_("changed", null, current);
  }

  function postcondition_(disposition, revision, hash, reason) {
    var result = { disposition: disposition, visibleRevision: revision, visibleHash: hash, snapshotHash: null };
    if (reason !== null && reason !== undefined) result.reason = reason;
    return result;
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
      if (parsed[effectId].status !== "applied") throw new Error("receipt status must be applied");
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
    // Reserve hidden receipt rows as well; setValues must not depend on the
    // receipt sheet's finite preallocated grid.
    target.insertRowsAfter(startRow - 1, values.length);
    var updatedAt = new Date().toISOString();
    target.getRange(startRow, 1, values.length, RECEIPT_HEADERS.length).setValues(values.map(function (receipt) {
      return [receipt.effectId, receipt.payloadHash, receipt.status, receipt.visibleHash, receipt.visibleRevision, updatedAt];
    }));
    // The receipt is the durable evidence a later locked probe reads. Flush it
    // while the effect lock is still held: the ScriptLock is released when this
    // operation returns, before the outer dispatcher's final flush, so a second
    // apply/probe that acquires the lock next must already see the receipt.
    // Without this flush it would read the target row without the receipt and
    // replay or corrupt receipt state.
    SpreadsheetApp.flush();
  }

  function writeDeletionAndReceiptsBatch_(targetSheet, receiptSheetTarget, rows, receiptsToWrite) {
    if (rows.length === 0) return;
    // The row deletes and the receipt write are separate built-in
    // SpreadsheetApp mutations, not one Advanced Sheets batch: a crash
    // between them is ambiguous and must never be reported as applied
    // without proof. Delete the target rows first in descending physical row
    // order so no earlier delete shifts a later delete target, flush, then
    // append the receipts and flush again. A crash between the two phases
    // leaves rows deleted without receipts, which the postcondition probe
    // classifies as unavailable (delivery-uncertain), never as applied;
    // receipt-backed applied evidence is returned only after the receipt
    // write below lands.
    rows.slice().sort(function (left, right) { return right.rowNumber - left.rowNumber; }).forEach(function (row) {
      targetSheet.deleteRows(row.rowNumber, 1);
    });
    SpreadsheetApp.flush();
    if (receiptsToWrite.length > 0) {
      var receiptStartRow = Math.max(receiptSheetTarget.getLastRow() + 1, 2);
      var updatedAt = new Date().toISOString();
      // Reserve the receipt rows through the spreadsheet mutation API before
      // writing values so a concurrent human append is shifted rather than
      // overwritten.
      receiptSheetTarget.insertRowsAfter(receiptStartRow - 1, receiptsToWrite.length);
      receiptSheetTarget.getRange(receiptStartRow, 1, receiptsToWrite.length, RECEIPT_HEADERS.length).setValues(receiptsToWrite.map(function (receipt) {
        return [receipt.effectId, receipt.payloadHash, receipt.status, receipt.visibleHash, receipt.visibleRevision, updatedAt];
      }));
    }
    SpreadsheetApp.flush();
  }

  function writeAppendRows_(target, targetLayout, rows, checkboxHeaders) {
    if (rows.length === 0) return;
    rows.sort(function (left, right) { return left.rowNumber - right.rowNumber; });
    // Reserve rows through the spreadsheet mutation API before writing values
    // so a concurrent human append is shifted rather than overwritten.
    target.insertRowsAfter(rows[0].rowNumber - 1, rows.length);
    target.getRange(rows[0].rowNumber, targetLayout.startColumn, rows.length, targetLayout.columnCount).setValues(rows.map(function (row) {
      return targetLayout.headers.map(function (header) { return toSheetValue_(row.cells[header]); });
    }));
    rows.forEach(function (row) {
      target.getRange(row.rowNumber + ":" + row.rowNumber).addDeveloperMetadata(ANCHOR_KEY, row.physicalAnchor, SpreadsheetApp.DeveloperMetadataVisibility.DOCUMENT);
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

  function isCanonicalDate_(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    var parsed = new Date(value);
    return !isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }

  function normalizeCell_(value) {
    if (value === null) return null;
    requireObject_(value, "normalized cell");
    if (value.kind === "string" && typeof value.value === "string") return { kind: "string", value: normalizeScalarString_(value.value) };
    if (value.kind === "date" && isCanonicalDate_(value.value)) return { kind: "date", value: value.value };
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

  function toSheetValue_(value) {
    if (value === null) return "";
    return value.kind === "date" ? new Date(value.value) : value.value;
  }
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
    // Keep the script-lock wait/hold duration as a diagnostic phase, but do
    // not fold it into the total: durationMs already measures the whole
    // operation including the lock wait, so adding the nested phase would
    // double-count the elapsed time.
    result.timing.phases.push({ phase: phaseName, durationMs: durationMs });
  }
  function isBlankRow_(row) { return row.every(function (cell) { return cell === "" || cell === null; }); }
  function isDate_(value) { return Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime()); }
  function isObject_(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
  function requireObject_(value, label) { if (!isObject_(value)) throw new Error(label + " must be an object"); return value; }
  function string_(value, label) { if (typeof value !== "string" || value.length === 0) throw new Error(label + " must be a non-empty string"); return value; }
  function stringAllowEmpty_(value, label) { if (typeof value !== "string") throw new Error(label + " must be a string"); return value; }
  function nonNegativeInteger_(value, label) { if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value || value < 0) throw new Error(label + " must be a non-negative integer"); return value; }

  function visibleHash_(fields) {
    return codecStableHash_({ fields: Object.keys(fields).sort().map(function (fieldName) { return { fieldName: fieldName, value: fields[fieldName] }; }) });
  }
  function normalizeScalarString_(value) { return value.normalize("NFC"); }
${APPS_SCRIPT_STABLE_CODEC_SOURCE}
}`;
