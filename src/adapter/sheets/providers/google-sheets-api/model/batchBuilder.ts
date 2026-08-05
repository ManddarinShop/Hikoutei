/**
 * Atomic batch builder for the direct Sheets provider.
 *
 * All applicable target mutations (appends, scattered field updates, physical
 * row deletes) and their receipt writes are combined into ONE
 * `spreadsheets.batchUpdate`, which is atomic: any invalid request aborts the
 * whole batch. The builder also owns the transport byte budget: a batch that
 * would exceed the budget is trimmed to the largest order-preserving effect
 * prefix, and an effect that alone exceeds the budget becomes a schema_error
 * result instead of a mutation.
 */

import type { NormalizedCell } from "../../../../../domain/index.js";
import { PRESENCE_KINDS } from "../../../../../shared/state/index.js";
import {
  GOOGLE_SHEETS_API_ANCHOR_KEY,
  GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT,
  GOOGLE_SHEETS_API_RECEIPT_HEADERS,
} from "../constants.js";
import { invalidProviderState } from "../errors.js";
import type {
  GoogleSheetsApiCell,
  GoogleSheetsApiCellRow,
  GoogleSheetsApiWriteRequest,
} from "../transport/googleSheetsApiTransport.js";
import { serializeBatchUpdateRequests } from "../transport/googleSheetsApiTransport.js";
import type { PreflightContext } from "./preflight.js";
import type { EffectPlan, PlanMutation, PlannedReceipt, WorkingRow } from "./planner.js";
import { toApiUserEnteredValue } from "./valueNormalization.js";
import { allocateSheetId } from "./sheetIdAllocator.js";

/** One built batch plus its serialized byte size. */
export interface BuiltApplyBatch {
  readonly requests: readonly GoogleSheetsApiWriteRequest[];
  readonly bytes: number;
}

/** Inputs shared by the apply and append batch builders. */
export interface BatchBuildOptions {
  readonly context: PreflightContext;
  readonly updatedAt: string;
}

/** How much of the plan is included: prefix length plus schema-error effects. */
export interface BatchResolution {
  /** Number of leading effects whose mutations are included in the batch. */
  readonly includeCount: number;
  /** Indices of effects excluded because one effect alone exceeds the budget. */
  readonly schemaErrorIndices: readonly number[];
  /** True when effects beyond the included prefix must be deferred. */
  readonly hasMore: boolean;
}

/**
 * Resolves how many leading effects fit in one atomic batch.
 *
 * The byte budget is measured on the phase-ordered request list serialized
 * exactly as the transport sends it (SDK-wrapped request shapes), so the
 * check is exact for the bytes that would actually hit the wire. When the
 * very first effect alone exceeds the budget it becomes a schema_error
 * result and the remaining effects are re-tried, so a single pathological
 * payload cannot block the rest of the batch.
 */
export function resolveApplyBatchBudget(
  context: PreflightContext,
  plans: readonly EffectPlan[],
  options: {
    readonly maxBatchBytes: number;
    readonly includeReceipts: boolean;
    readonly updatedAt: string;
  },
): BatchResolution {
  const total = plans.length;
  let cursor = 0;
  const schemaErrorIndices: number[] = [];
  while (cursor < total) {
    const fitting = largestFittingPrefix(plans, context, options, cursor, total);
    if (fitting > cursor) {
      return {
        includeCount: fitting,
        schemaErrorIndices,
        hasMore: fitting < total,
      };
    }
    schemaErrorIndices.push(cursor);
    cursor += 1;
  }
  return { includeCount: 0, schemaErrorIndices, hasMore: false };
}

function largestFittingPrefix(
  plans: readonly EffectPlan[],
  context: PreflightContext,
  options: {
    readonly maxBatchBytes: number;
    readonly includeReceipts: boolean;
    readonly updatedAt: string;
  },
  start: number,
  end: number,
): number {
  let low = start;
  let high = end;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const built = buildApplyBatchRequests(context, plans.slice(start, mid), {
      updatedAt: options.updatedAt,
      includeReceipts: options.includeReceipts,
    });
    if (built.bytes <= options.maxBatchBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * Builds one atomic batchUpdate request list for a prefix of the plan.
 *
 * Requests are emitted in phase order: receipt-tab creation, append row
 * inserts/values/anchors, scattered field updates, physical deletes (in
 * descending row order so an earlier delete never shifts a later target),
 * then receipt rows. Appended rows are written with their full header cells
 * (all effects that touched a created row merge into one write); date cells
 * keep the canonical number format through a separate format-masked request.
 */
export function buildApplyBatchRequests(
  context: PreflightContext,
  plans: readonly EffectPlan[],
  options: { readonly updatedAt: string; readonly includeReceipts: boolean },
): BuiltApplyBatch {
  const requests: GoogleSheetsApiWriteRequest[] = [];
  const appended: WorkingRow[] = [];
  const updated: WorkingRow[] = [];
  const deleted: WorkingRow[] = [];
  for (const plan of plans) {
    if (plan.mutation !== undefined) collectMutation(plan.mutation, appended, updated, deleted);
  }
  const receipts = collectBatchReceipts(plans, context, options.includeReceipts);

  let createdReceiptSheetId: number | undefined;
  if (receipts.length > 0 && context.receiptSheetId.kind === PRESENCE_KINDS.ABSENT) {
    createdReceiptSheetId = pushReceiptSheetCreation(requests, context);
  }

  if (appended.length > 0) {
    pushAppendWrites(requests, context, appended);
  }
  for (const row of updated) {
    pushUpdateWrites(requests, context, row);
  }
  // Descending physical row order: deleting a row never shifts a later target.
  for (const row of [...deleted].sort((left, right) => right.rowNumber - left.rowNumber)) {
    requests.push({
      kind: "deleteDimension",
      sheetId: context.sheetId,
      dimension: "ROWS",
      startIndex: row.rowNumber - 1,
      endIndex: row.rowNumber,
    });
  }
  if (receipts.length > 0) {
    pushReceiptWrites(requests, context, receipts, options.updatedAt, createdReceiptSheetId);
  }

  return { requests, bytes: measureRequestBytes(requests) };
}

/** Measures the serialized batchUpdate body with the transport serializer. */
export function measureRequestBytes(requests: readonly GoogleSheetsApiWriteRequest[]): number {
  return new TextEncoder().encode(serializeBatchUpdateRequests(requests)).byteLength;
}

/**
 * Collects one batch's receipts, deduplicated by effectId (queueReceipt_
 * semantics): receipts already stored in the sheet belong to replays and are
 * never rewritten, and a receipt planned twice inside one request (a
 * same-request effect-id replay) is written once.
 */
function collectBatchReceipts(
  plans: readonly EffectPlan[],
  context: PreflightContext,
  includeReceipts: boolean,
): PlannedReceipt[] {
  if (!includeReceipts) return [];
  const queued = new Set<string>();
  const receipts: PlannedReceipt[] = [];
  for (const plan of plans) {
    const receipt = plan.receipt;
    if (receipt === undefined) continue;
    if (context.receipts.has(receipt.effectId)) continue;
    if (queued.has(receipt.effectId)) continue;
    queued.add(receipt.effectId);
    receipts.push(receipt);
  }
  return receipts;
}

/**
 * Resolves the append row prefix for one fast-append request.
 *
 * Unlike regular effects there is no per-row schema_error status, so a single
 * row that alone exceeds the budget is still included: the API's own limits
 * reject it deterministically (a proven explicit failure) instead of leaving
 * the effect in an infinite defer loop.
 */
export function resolveAppendBudget(
  rows: readonly { readonly rowNumber: number }[],
  build: (count: number) => BuiltApplyBatch,
  maxBatchBytes: number,
): { readonly includeCount: number; readonly hasMore: boolean } {
  if (rows.length === 0) return { includeCount: 0, hasMore: false };
  let low = 1;
  let high = rows.length;
  // The first row is always included (documented above).
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (build(mid).bytes <= maxBatchBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { includeCount: low, hasMore: low < rows.length };
}

/** Builds one atomic fast-append batch for a prefix of pending rows. */
export function buildAppendBatchRequests(
  context: PreflightContext,
  rows: readonly WorkingRow[],
  receipts: readonly PlannedReceipt[],
  options: { readonly updatedAt: string },
): BuiltApplyBatch {
  const requests: GoogleSheetsApiWriteRequest[] = [];
  const uniqueReceipts = dedupeReceipts(receipts, context);
  let createdReceiptSheetId: number | undefined;
  if (uniqueReceipts.length > 0 && context.receiptSheetId.kind === PRESENCE_KINDS.ABSENT) {
    createdReceiptSheetId = pushReceiptSheetCreation(requests, context);
  }
  if (rows.length > 0) {
    pushAppendWrites(requests, context, rows);
  }
  if (uniqueReceipts.length > 0) {
    pushReceiptWrites(requests, context, uniqueReceipts, options.updatedAt, createdReceiptSheetId);
  }
  return { requests, bytes: measureRequestBytes(requests) };
}

/** Deduplicates pre-planned receipts by effectId for one append batch. */
function dedupeReceipts(
  receipts: readonly PlannedReceipt[],
  context: PreflightContext,
): PlannedReceipt[] {
  const queued = new Set<string>();
  const unique: PlannedReceipt[] = [];
  for (const receipt of receipts) {
    if (context.receipts.has(receipt.effectId)) continue;
    if (queued.has(receipt.effectId)) continue;
    queued.add(receipt.effectId);
    unique.push(receipt);
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Phase builders
// ---------------------------------------------------------------------------

function collectMutation(
  mutation: PlanMutation,
  appended: WorkingRow[],
  updated: WorkingRow[],
  deleted: WorkingRow[],
): void {
  switch (mutation.kind) {
    case "append":
      appended.push(mutation.row);
      break;
    case "update":
      updated.push(mutation.row);
      break;
    case "delete":
      deleted.push(mutation.row);
      break;
  }
}

/** Inserts the appended rows, writes their values/anchors, formats, checkboxes. */
function pushAppendWrites(
  requests: GoogleSheetsApiWriteRequest[],
  context: PreflightContext,
  rows: readonly WorkingRow[],
): void {
  const ordered = [...rows].sort((left, right) => left.rowNumber - right.rowNumber);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return;
  const sheetId = context.sheetId;
  const startColumn = context.startColumn - 1;
  const columnCount = context.headers.length;

  // Reserve the target rows before writing values so a concurrent human
  // append is shifted rather than overwritten (insertRowsAfter equivalent).
  requests.push({
    kind: "insertDimension",
    sheetId,
    dimension: "ROWS",
    startIndex: first.rowNumber - 1,
    endIndex: first.rowNumber - 1 + ordered.length,
    inheritFromBefore: false,
  });

  const values: GoogleSheetsApiCellRow[] = ordered.map((row) =>
    context.headers.map((header) => toApiCell(row.cells[header] ?? null)),
  );
  requests.push({
    kind: "updateCells",
    sheetId,
    startRowIndex: first.rowNumber - 1,
    startColumnIndex: startColumn,
    rows: values,
    fields: "userEnteredValue",
  });

  // Developer-metadata anchors keep created rows findable by anchor on the
  // next apply/probe, matching the Apps Script effect-operation create path.
  for (const row of ordered) {
    if (row.anchor.kind === PRESENCE_KINDS.PRESENT) {
      requests.push({
        kind: "createDeveloperMetadata",
        sheetId,
        rowIndex: row.rowNumber - 1,
        key: GOOGLE_SHEETS_API_ANCHOR_KEY,
        value: row.anchor.value,
      });
    }
  }

  // A column is formatted as dates only when every appended cell in it is a
  // date or blank (the Apps Script setDateNumberFormats_ rule).
  context.headers.forEach((header, columnIndex) => {
    const isDateColumn = ordered.every((row) => {
      const cell = row.cells[header] ?? null;
      return cell === null || cell.kind === "date";
    });
    if (!isDateColumn) return;
    requests.push({
      kind: "updateCells",
      sheetId,
      startRowIndex: first.rowNumber - 1,
      startColumnIndex: startColumn + columnIndex,
      rows: ordered.map(() => [{ userEnteredFormat: { numberFormat: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT } }]),
      fields: "userEnteredFormat.numberFormat",
    });
  });

  for (const checkboxHeader of context.checkboxHeaders) {
    const columnIndex = context.positions.get(checkboxHeader);
    if (columnIndex === undefined) {
      invalidProviderState(`checkbox header is not registered: ${checkboxHeader}`);
    }
    requests.push({
      kind: "setDataValidation",
      sheetId,
      startRowIndex: first.rowNumber - 1,
      endRowIndex: last.rowNumber,
      startColumnIndex: startColumn + columnIndex,
      endColumnIndex: startColumn + columnIndex + 1,
      strict: true,
    });
  }
}

/**
 * Writes one updated row's changed field runs.
 *
 * Runs are contiguous field spans (the Apps Script writeFieldRun_ grouping),
 * so the values arrays never need empty placeholder cells that would clear a
 * neighboring cell. Date cells get the canonical number format through a
 * separate format-masked request so the value write never resets formats.
 */
function pushUpdateWrites(
  requests: GoogleSheetsApiWriteRequest[],
  context: PreflightContext,
  row: WorkingRow,
): void {
  const sheetId = context.sheetId;
  const startColumn = context.startColumn - 1;
  const changed = Object.entries(row.writeFields)
    .map(([fieldName, cell]) => {
      const columnIndex = context.positions.get(fieldName);
      if (columnIndex === undefined) {
        invalidProviderState(`effect field is not a registered header: ${fieldName}`);
      }
      return { fieldName, columnIndex, cell };
    })
    .sort((left, right) => left.columnIndex - right.columnIndex);

  let runStart = 0;
  for (let index = 1; index <= changed.length; index += 1) {
    const previous = changed[index - 1];
    const current = changed[index];
    if (
      previous !== undefined &&
      (current === undefined || current.columnIndex !== previous.columnIndex + 1)
    ) {
      pushUpdateRun(requests, sheetId, row, changed.slice(runStart, index), startColumn);
      runStart = index;
    }
  }
}

function pushUpdateRun(
  requests: GoogleSheetsApiWriteRequest[],
  sheetId: number,
  row: WorkingRow,
  run: readonly { readonly fieldName: string; readonly columnIndex: number; readonly cell: NormalizedCell }[],
  startColumn: number,
): void {
  const first = run[0];
  if (first === undefined) return;
  const firstColumn = startColumn + first.columnIndex;
  const cells: GoogleSheetsApiCell[] = run.map((entry) => toApiCell(entry.cell));
  requests.push({
    kind: "updateCells",
    sheetId,
    startRowIndex: row.rowNumber - 1,
    startColumnIndex: firstColumn,
    rows: [cells],
    fields: "userEnteredValue",
  });
  // Date cells need the canonical format so read-back normalizes the serial
  // as a date; without it the visible hash would never match.
  run.forEach((entry, offset) => {
    if (entry.cell !== null && entry.cell.kind === "date") {
      requests.push({
        kind: "updateCells",
        sheetId,
        startRowIndex: row.rowNumber - 1,
        startColumnIndex: firstColumn + offset,
        rows: [[{ userEnteredFormat: { numberFormat: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT } }]],
        fields: "userEnteredFormat.numberFormat",
      });
    }
  });
}

/** Creates the hidden receipt tab and its header row in the same batch. */
function pushReceiptSheetCreation(
  requests: GoogleSheetsApiWriteRequest[],
  context: PreflightContext,
): number {
  // A deterministic, collision-free 31-bit positive sheetId (never the old
  // random pick): the allocator scans the enumeration's existing ids so a
  // repeated attempt after a lost response picks the same id.
  const receiptSheetId = allocateSheetId(context.existingSheetIds);
  requests.push({
    kind: "addSheet",
    title: "__typed_sheets_internal_effect_receipts",
    sheetId: receiptSheetId,
  });
  requests.push({
    kind: "updateSheetProperties",
    sheetId: receiptSheetId,
    hidden: true,
  });
  requests.push({
    kind: "updateCells",
    sheetId: receiptSheetId,
    startRowIndex: 0,
    startColumnIndex: 0,
    rows: [GOOGLE_SHEETS_API_RECEIPT_HEADERS.map((header) => ({
      userEnteredValue: { stringValue: header },
    }))],
    fields: "userEnteredValue",
  });
  return receiptSheetId;
}

/** Appends receipt rows after the receipt tab's last content row. */
function pushReceiptWrites(
  requests: GoogleSheetsApiWriteRequest[],
  context: PreflightContext,
  receipts: readonly PlannedReceipt[],
  updatedAt: string,
  createdReceiptSheetId?: number,
): void {
  let sheetId: number;
  if (createdReceiptSheetId !== undefined) {
    sheetId = createdReceiptSheetId;
  } else if (context.receiptSheetId.kind === PRESENCE_KINDS.PRESENT) {
    sheetId = context.receiptSheetId.value;
  } else {
    invalidProviderState("receipt sheet id is unavailable for receipt writes");
  }
  const startRow = Math.max(context.receiptLastRow + 1, 2);
  requests.push({
    kind: "insertDimension",
    sheetId,
    dimension: "ROWS",
    startIndex: startRow - 1,
    endIndex: startRow - 1 + receipts.length,
    inheritFromBefore: false,
  });
  requests.push({
    kind: "updateCells",
    sheetId,
    startRowIndex: startRow - 1,
    startColumnIndex: 0,
    rows: receipts.map((receipt) => [
      { userEnteredValue: { stringValue: receipt.effectId } },
      { userEnteredValue: { stringValue: receipt.payloadHash } },
      { userEnteredValue: { stringValue: receipt.status } },
      { userEnteredValue: { stringValue: receipt.visibleHash } },
      { userEnteredValue: { numberValue: receipt.visibleRevision } },
      { userEnteredValue: { stringValue: updatedAt } },
    ]),
    fields: "userEnteredValue",
  });
}

/** Converts a normalized cell to the API cell shape (dates as serials). */
function toApiCell(cell: NormalizedCell): GoogleSheetsApiCell {
  return toApiUserEnteredValue(cell);
}

