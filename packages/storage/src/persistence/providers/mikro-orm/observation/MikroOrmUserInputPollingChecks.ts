/**
 * Check-column polling gate: diffs the narrow row-check read against the
 * expected row-check strings derived from canonical SQLite state.
 *
 * The User_Input tab carries a system-written per-row token-join formula in
 * the check column (see contracts `sheets/rowCheck.ts`). The inbound
 * polling preflight reads ONLY the identity + anchor + check column bands,
 * and this module decides per table:
 *
 * - `escalate` — the table cannot be gated: no provisioned check column
 *   (legacy tab: mixed mode keeps the historical whole-table metadata
 *   observation), or any row whose identity is invalid, duplicated, or
 *   unknown, or an active canonical entity that is no longer visible, or
 *   any system row-id (anchor) anomaly (deleted, duplicated, or moved off
 *   its binding). Anchors escalate because only the whole-table
 *   observation produces the authoritative row-mapping/orphan evidence.
 * - `targeted` — only value-mismatched rows exist: the caller re-reads
 *   ONLY those physical rows (multi-range band, metadata-preserving) and
 *   feeds them through the historical inspector/evaluator unchanged. A row
 *   with no visible check value (a legacy row created before the column
 *   existed, or one whose formula a human removed or REPLACED WITH A
 *   LITERAL — the provider reports check evidence only while the cell
 *   still holds the exact generated formula) mismatches and is therefore
 *   included — the per-row mixed mode.
 * - `clean` — every visible row's check equals the value derived from its
 *   canonical state: NO data-column read happens this pass.
 *
 * Why the expectation is DERIVED from canonical state at read time instead
 * of stored per row at write time: the user_input effect payload always
 * carries the FULL user field set (reconcile semantics), and canonical
 * `entity_field_state` holds exactly the values the last planned write
 * shows once delivered — so an insert, an update-like write, and a
 * probe/redrive outcome all re-derive the expectation for free. A stored
 * copy (row_binding column or new table) would duplicate canonical state,
 * need v9 migration surgery, and REQUIRE correct bookkeeping on every
 * delivery outcome; the derivation cannot drift.
 *
 * The one case canonical derivation CANNOT see ahead of is a delivery that
 * has not landed yet: while an own write is in flight the Sheet still
 * (correctly) shows the PRE-write values, so a derived expectation would
 * mismatch, the targeted read would observe the stale projection, and the
 * inspector's forceConflict rule (advanced canonical revision) would
 * fabricate a conflict against our own write. The gate therefore consults
 * the durable outbox: a mismatched row whose binding still has an
 * in-flight effect (pending/processing/delivery-uncertain/retryable
 * failed) is a PENDING DELIVERY, not human input, and is skipped without
 * any read. Human input stays protected: the worker's field-level CAS
 * evidence refuses a delivery whose remote changed mid-flight (the
 * delivery pipeline, not this gate, arbitrates that race), and after
 * delivery the row's check simply mismatches again and escalates normally.
 */

import {
  stableHash,
} from "@hikoutei/contracts/encoding/stableEncode.js";
import { computeRowCheckValue } from "@hikoutei/contracts/sheets/rowCheck.js";
import type {
  NormalizedCell,
} from "@hikoutei/contracts/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import { isCanonicalUtcIsoDate } from "@hikoutei/contracts/validation.js";
import {
  PRESENCE_KINDS,
} from "@hikoutei/contracts/state/constants.js";
import type {
  ReadSyncRowChecksRequest,
  SyncRowChecksResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import type {
  TypedSheetsEntityFieldMapping,
  TypedSheetsEntityMapping,
} from "@hikoutei/contracts/sync-orm/mapping/contracts.js";
import {
  requireTypedSheetsEntityProjection,
  typedSheetsEntityProjectionHeaders,
} from "@hikoutei/contracts/sync-orm/mapping/projection.js";

import type {
  MappedPollingState,
  RowBindingStateRecord,
} from "./MikroOrmUserInputPollingState.js";

/** Outcome kind of one gated table. */
export const CHECKS_POLLING_DECISION_KINDS = {
  /** Every visible row matches its expected check; skip the table. */
  CLEAN: "clean",
  /** Only these physical rows mismatch; read them targeted. */
  TARGETED: "targeted",
  /** The gate cannot prove the table; run the historical whole-table read. */
  ESCALATE: "escalate",
} as const;

export type ChecksPollingDecisionKind =
  (typeof CHECKS_POLLING_DECISION_KINDS)[keyof typeof CHECKS_POLLING_DECISION_KINDS];

/** Result of one gated table comparison. */
export interface ChecksPollingDecision {
  readonly kind: ChecksPollingDecisionKind;
  /** 1-based physical rows to re-read (only non-empty when targeted). */
  readonly rowNumbers: readonly number[];
  /** Rows the narrow read saw (report accounting only). */
  readonly rowsScanned: number;
  /** Rows whose check mismatched their expected value. */
  readonly changedRows: number;
}

/** Builds the narrow row-check request for one mapped user_input route. */
export function toRowChecksRequest(
  mapping: TypedSheetsEntityMapping,
): ReadSyncRowChecksRequest {
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_PROJECTIONS.USER_INPUT,
  );
  return {
    physicalSheetId: projection.physicalSheetId,
    sheetName: projection.tabName,
    registeredRange: projection.registeredRange,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: mapping.schemaVersion,
    identityField: mapping.businessKey.fieldName,
  };
}

/**
 * Decides one table's polling read shape from its narrow check result.
 * Never mutates state; every escalation condition mirrors the historical
 * values-only preflight so conflict/observation outcomes are unchanged.
 */
export function inspectChecksPollingTable(
  mapping: TypedSheetsEntityMapping,
  result: SyncRowChecksResult,
  state: MappedPollingState,
): ChecksPollingDecision {
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_PROJECTIONS.USER_INPUT,
  );
  if (
    result.sheetName !== projection.tabName ||
    result.registeredRange !== projection.registeredRange
  ) {
    return escalate(result.rows.length);
  }
  // Mixed mode: a tab without the provisioned check column keeps the
  // historical whole-table metadata observation (backfill is a follow-up).
  if (result.status !== "checks_available") return escalate(result.rows.length);

  const headers = typedSheetsEntityProjectionHeaders(mapping, SYNC_PROJECTIONS.USER_INPUT);
  const businessKey = mapping.businessKey;
  const bindingsByEntity = state.bindingsByEntityId
    .get(mapping.logicalSheetId) ?? new Map<string, RowBindingStateRecord>();
  const byBusinessKey = state.businessKeysByLogicalAndField
    .get(mapping.logicalSheetId)
    ?.get(businessKey.fieldName) ?? new Map<string, string>();

  // Global identity conditions first (duplicates and unknown keys need the
  // whole-table snapshot to be judged exactly like today).
  const identityCounts = new Map<string, number>();
  for (const row of result.rows) {
    if (!isValidIdentityCell(businessKey, row.identity)) continue;
    const key = stableHash(row.identity);
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }

  const dirtyRows: number[] = [];
  const seenEntityIds = new Set<string>();
  const anchorsSeen = new Set<string>();
  for (const row of result.rows) {
    const key = stableHashOrNull(businessKey, row.identity);
    if (key === null || (identityCounts.get(key) ?? 0) !== 1) {
      return escalate(result.rows.length);
    }
    const entityId = byBusinessKey.get(key);
    const canonical = entityId === undefined ? undefined : state.entitiesById.get(entityId);
    const binding = entityId === undefined ? undefined : bindingsByEntity.get(entityId);
    if (
      entityId === undefined
      || canonical === undefined
      || canonical.status !== "active"
      || binding === undefined
    ) {
      // Unknown/missing-canonical row: the historical whole-table path
      // quarantines/adopts it exactly as before.
      return escalate(result.rows.length);
    }
    seenEntityIds.add(entityId);
    // Anchor evidence: the system row-id cell must still sit on THIS row's
    // binding — a deletion, duplicate, or moved anchor breaks the required
    // row mapping and only the whole-table observation decides it (the
    // gate never re-derives anchor semantics from the narrow read).
    const anchor = row.anchor.kind === PRESENCE_KINDS.PRESENT ? row.anchor.value : null;
    if (anchor === null || binding.anchorReference !== anchor || anchorsSeen.has(anchor)) {
      return escalate(result.rows.length);
    }
    anchorsSeen.add(anchor);
    const expected = computeRowCheckValue(headers, (header) =>
      canonical.fields.get(header)?.value);
    const observed = row.check.kind === PRESENCE_KINDS.PRESENT ? row.check.value : "";
    if (expected !== null && expected === observed) continue;
    // In-flight own write: canonical has advanced but the delivery has not
    // landed, so the Sheet still shows the PRE-write values — a mismatch
    // here is our own queued write, NOT human input. Reading it now would
    // feed the stale projection into the inspector's forceConflict rule and
    // fabricate a conflict; skip the row until the outbox settles (the
    // delivery's own CAS evidence arbitrates a mid-flight remote edit, and
    // the next post-delivery pass mismatches normally if a human edited).
    if (state.pendingDeliveryBindingIds.has(binding.rowBindingId)) continue;
    dirtyRows.push(row.rowNumber);
  }

  // An active canonical entity whose row vanished from the visible bands
  // needs the whole-table observation (same rule as the values-only pass).
  for (const entityId of byBusinessKey.values()) {
    if (seenEntityIds.has(entityId)) continue;
    const canonical = state.entitiesById.get(entityId);
    if (canonical?.status === "active") return escalate(result.rows.length);
  }

  if (dirtyRows.length === 0) {
    return {
      kind: CHECKS_POLLING_DECISION_KINDS.CLEAN,
      rowNumbers: [],
      rowsScanned: result.rows.length,
      changedRows: 0,
    };
  }
  return {
    kind: CHECKS_POLLING_DECISION_KINDS.TARGETED,
    rowNumbers: dirtyRows,
    rowsScanned: result.rows.length,
    changedRows: dirtyRows.length,
  };
}

function escalate(rowsScanned: number): ChecksPollingDecision {
  return {
    kind: CHECKS_POLLING_DECISION_KINDS.ESCALATE,
    rowNumbers: [],
    rowsScanned,
    changedRows: 0,
  };
}

/** Stable business key of a VALID identity cell, else null (escalate). */
function stableHashOrNull(
  businessKey: TypedSheetsEntityFieldMapping,
  identity: NormalizedCell,
): string | null {
  return isValidIdentityCell(businessKey, identity) ? stableHash(identity) : null;
}

/**
 * Identity validity under the values-only normalization, mirroring the
 * historical fast-path guard exactly: a cell whose type/emptiness cannot
 * satisfy the business-key field forces the metadata-preserving pass, which
 * decides the quarantine with full cell evidence.
 */
function isValidIdentityCell(
  field: TypedSheetsEntityFieldMapping,
  cell: NormalizedCell,
): boolean {
  if (cell === null) return !field.required;
  if (cell.kind !== field.cellKind) return false;
  switch (cell.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return !field.required || cell.value.length > 0;
    case NORMALIZED_CELL_KINDS.NUMBER:
      return Number.isFinite(cell.value);
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return true;
    case NORMALIZED_CELL_KINDS.DATE:
      return isCanonicalUtcIsoDate(cell.value);
  }
}
