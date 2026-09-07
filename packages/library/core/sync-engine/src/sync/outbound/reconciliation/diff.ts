/**
 * Drift detection for the System_State reconciliation scan.
 *
 * Compares one provider snapshot against the durable desired state and
 * classifies every desired row as matched, drifted, or missing. Anchor and
 * identity duplicates quarantine the affected locators instead of letting the
 * last row win silently, so a corrupted anchor or duplicated business key can
 * never prove ownership of a row.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
} from "@hikoutei/contracts/constants.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import {
  computeSyncVisibleHash,
  type SyncSheetsSnapshot,
  type SyncSnapshotRow,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import type { DesiredRow } from "./shared.js";

export type DriftKind = "drifted" | "missing";

export interface DriftTarget {
  readonly kind: DriftKind;
  readonly desired: DesiredRow;
  /**
   * The observed snapshot row behind a drifted drift, so a repair planned
   * for an existing row can guard on the row's CURRENT visible hash
   * (computed from the exact System_State fields) instead of assuming an
   * insert when no confirmed visible evidence exists. `undefined` for
   * missing drifts, where the row is not observable.
   */
  readonly observed: SyncSnapshotRow | undefined;
}

/**
 * Anchor + business-key indices shared by drift detection and matching.
 *
 * Built once per scan from the snapshot and reused for every desired chunk,
 * so the snapshot side is indexed in a single Map pass instead of rebuilt
 * per chunk. The maps hold references to the snapshot's rows; no snapshot
 * data is copied.
 */
export interface ObservedRowIndex {
  readonly rowsByAnchor: ReadonlyMap<string, SyncSnapshotRow>;
  readonly ambiguousAnchors: ReadonlySet<string>;
  readonly rowsByIdentity: ReadonlyMap<string, SyncSnapshotRow>;
  readonly ambiguousIdentities: ReadonlySet<string>;
}

/**
 * Builds the deduplicated anchor/identity index for one snapshot.
 *
 * A duplicated physical anchor or business key is an anomaly, never a row
 * choice: the affected locators are dropped from the index so neither the
 * drift classifier nor the failed-head matcher can silently pick one row.
 */
export function buildObservedRowIndex(
  snapshot: SyncSheetsSnapshot,
  businessKeyField: string,
): ObservedRowIndex {
  const rowsByAnchor = new Map<string, SyncSnapshotRow>();
  const ambiguousAnchors = new Set<string>();
  const rowsByIdentity = new Map<string, SyncSnapshotRow>();
  const ambiguousIdentities = new Set<string>();
  for (const row of snapshot.rows) {
    if (row.physicalAnchor.kind === PRESENCE_KINDS.PRESENT) {
      // A duplicated physical anchor is an anomaly, never a row choice: drop
      // the anchor index entry instead of letting the last row win silently.
      if (ambiguousAnchors.has(row.physicalAnchor.value)) continue;
      if (rowsByAnchor.has(row.physicalAnchor.value)) {
        rowsByAnchor.delete(row.physicalAnchor.value);
        ambiguousAnchors.add(row.physicalAnchor.value);
      } else {
        rowsByAnchor.set(row.physicalAnchor.value, row);
      }
    }
    const identity = snapshotIdentity(row, businessKeyField);
    if (identity === undefined || ambiguousIdentities.has(identity)) continue;
    if (rowsByIdentity.has(identity)) {
      rowsByIdentity.delete(identity);
      ambiguousIdentities.add(identity);
    } else {
      rowsByIdentity.set(identity, row);
    }
  }
  return { rowsByAnchor, ambiguousAnchors, rowsByIdentity, ambiguousIdentities };
}

/**
 * Resolves the observed snapshot row owned by one desired row.
 *
 * The primary locator's ambiguity is fatal: when the desired anchor is
 * duplicated, identity fallback would silently pick one of the rows that the
 * corrupted anchor cannot distinguish, so the binding stays unmatched. The
 * same quarantine applies when the desired identity appears in the snapshot's
 * duplicate set. Returns undefined when no row can prove ownership of this
 * binding.
 */
export function resolveObservedRow(
  index: ObservedRowIndex,
  desiredRow: DesiredRow,
  businessKeyField: string,
): SyncSnapshotRow | undefined {
  const identity = desiredRowIdentity(desiredRow, businessKeyField);
  // The primary locator's ambiguity is fatal: when the desired anchor is
  // duplicated, identity fallback would silently pick one of the rows that
  // the corrupted anchor cannot distinguish, so the binding is unmatched.
  // The same quarantine applies to a desired identity that appears in the
  // snapshot's duplicate set: the duplicated business key cannot prove that
  // this binding owns even its unique anchor, so neither locator may match.
  const identityAmbiguous = identity !== undefined && index.ambiguousIdentities.has(identity);
  return index.ambiguousAnchors.has(desiredRow.anchorReference) || identityAmbiguous
    ? undefined
    : index.rowsByAnchor.get(desiredRow.anchorReference) ??
      (identity === undefined ? undefined : index.rowsByIdentity.get(identity));
}

export function computeDrifts(args: {
  readonly snapshot: SyncSheetsSnapshot;
  readonly desired: readonly DesiredRow[];
  readonly systemFields: readonly string[];
  readonly sheet: { readonly registeredRange: string; readonly businessKeyField: string };
}): readonly DriftTarget[] {
  const index = buildObservedRowIndex(args.snapshot, args.sheet.businessKeyField);
  return classifyDesiredChunk(index, args.desired, args.systemFields, args.sheet.businessKeyField);
}

/**
 * Classifies one chunk of desired rows against a prebuilt snapshot index.
 *
 * The chunked scan calls this per completed entity batch with the scan-wide
 * index; results concatenate in chunk order, which is the global
 * `(entity_id, field_name)` order, so chunked classification is identical to
 * one full-load `computeDrifts` call. Returns only drift targets; matched
 * rows are simply absent (the scan counts them as scanned-minus-missing).
 */
export function classifyDesiredChunk(
  index: ObservedRowIndex,
  desired: readonly DesiredRow[],
  systemFields: readonly string[],
  businessKeyField: string,
): readonly DriftTarget[] {
  const drifts: DriftTarget[] = [];
  for (const desiredRow of desired) {
    const drift = classifyDesiredRow(index, desiredRow, systemFields, businessKeyField);
    if (drift !== undefined) drifts.push(drift);
  }
  return drifts;
}

/** Classifies one desired row: missing, drifted, or matched (undefined). */
export function classifyDesiredRow(
  index: ObservedRowIndex,
  desiredRow: DesiredRow,
  systemFields: readonly string[],
  businessKeyField: string,
): DriftTarget | undefined {
  const observed = resolveObservedRow(index, desiredRow, businessKeyField);
  if (observed === undefined) {
    return { kind: "missing", desired: desiredRow, observed: undefined };
  }
  const observedHash = computeObservedHash(observed, systemFields);
  const desiredHash = computeSyncVisibleHash(desiredRow.fields);
  if (observedHash !== desiredHash) {
    return { kind: "drifted", desired: desiredRow, observed };
  }
  return undefined;
}

/** Reads a business-key value from a snapshot row for unanchored fast appends. */
export function snapshotIdentity(
  row: SyncSheetsSnapshot["rows"][number],
  identityField: string,
): string | undefined {
  return normalizedCellIdentity(row.cells[identityField]?.normalizedCell);
}

/** Reads the same visible business-key value from canonical desired state. */
export function desiredRowIdentity(row: DesiredRow, identityField: string): string | undefined {
  return normalizedCellIdentity(row.fields[identityField]) ?? row.entityId;
}

export function normalizedCellIdentity(cell: NormalizedCell | undefined): string | undefined {
  if (cell === undefined || cell === null) return undefined;
  switch (cell.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return cell.value.length === EMPTY_STRING_LENGTH_ZERO ? undefined : cell.value;
    case NORMALIZED_CELL_KINDS.NUMBER:
      return Number.isFinite(cell.value) ? String(cell.value) : undefined;
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return String(cell.value);
    case NORMALIZED_CELL_KINDS.DATE:
      return cell.value;
  }
}

export function computeObservedHash(
  row: SyncSheetsSnapshot["rows"][number],
  systemFields: readonly string[],
): string {
  const values: Record<string, NormalizedCell> = {};
  for (const fieldName of systemFields) {
    const cell = row.cells[fieldName];
    values[fieldName] = cell === undefined ? null : cell.normalizedCell;
  }
  return computeSyncVisibleHash(values);
}

export function countMatchedRows(
  snapshot: SyncSheetsSnapshot,
  desired: readonly DesiredRow[],
  identityField: string,
): number {
  const anchors = new Set<string>();
  const ambiguousAnchors = new Set<string>();
  const identities = new Set<string>();
  const duplicateIdentities = new Set<string>();
  for (const row of snapshot.rows) {
    if (row.physicalAnchor.kind === PRESENCE_KINDS.PRESENT) {
      if (ambiguousAnchors.has(row.physicalAnchor.value)) continue;
      if (anchors.has(row.physicalAnchor.value)) {
        anchors.delete(row.physicalAnchor.value);
        ambiguousAnchors.add(row.physicalAnchor.value);
      } else {
        anchors.add(row.physicalAnchor.value);
      }
    }
    const identity = snapshotIdentity(row, identityField);
    if (identity === undefined || duplicateIdentities.has(identity)) continue;
    if (identities.has(identity)) {
      identities.delete(identity);
      duplicateIdentities.add(identity);
    } else {
      identities.add(identity);
    }
  }
  let matched = 0;
  for (const row of desired) {
    const identity = desiredRowIdentity(row, identityField);
    const anchorAmbiguous = ambiguousAnchors.has(row.anchorReference);
    // A desired identity duplicated in the sheet quarantines the binding:
    // neither its unique anchor nor its identity may count as matched.
    const identityAmbiguous = identity !== undefined && duplicateIdentities.has(identity);
    if ((!anchorAmbiguous && !identityAmbiguous && anchors.has(row.anchorReference)) ||
        (!anchorAmbiguous && !identityAmbiguous && identity !== undefined && identities.has(identity))) {
      matched += 1;
    }
  }
  return matched;
}

export function countExtraRows(
  snapshot: SyncSheetsSnapshot,
  desired: readonly DesiredRow[],
  identityField: string,
): number {
  // First-wins anchor ownership plus every desired identity, as lightweight
  // keys: the chunked scan accumulates the same keys without retaining rows.
  const desiredAnchors = new Map<string, string | undefined>();
  const desiredIdentities = new Set<string>();
  for (const row of desired) {
    if (!desiredAnchors.has(row.anchorReference)) {
      desiredAnchors.set(row.anchorReference, desiredRowIdentity(row, identityField));
    }
    const identity = desiredRowIdentity(row, identityField);
    if (identity !== undefined) desiredIdentities.add(identity);
  }
  return countExtraRowsForKeys(snapshot, identityField, desiredAnchors, desiredIdentities);
}

/**
 * Counts surplus snapshot rows from pre-accumulated desired keys.
 *
 * The chunked scan feeds one chunk at a time into `desiredAnchors` (first
 * row wins per anchor) and `desiredIdentities`, then calls this once: the
 * count is identical to `countExtraRows` while only small key strings are
 * retained instead of full desired rows.
 */
export function countExtraRowsForKeys(
  snapshot: SyncSheetsSnapshot,
  identityField: string,
  desiredAnchors: ReadonlyMap<string, string | undefined>,
  desiredIdentities: ReadonlySet<string>,
): number {
  // Identities that appear more than once in the snapshot cannot prove
  // ownership. A desired row carrying one of these identities is quarantined:
  // its anchor never suppresses the extra count, and the duplicated identity
  // itself never suppresses it either.
  const duplicateIdentities = new Set<string>();
  {
    const seen = new Set<string>();
    for (const row of snapshot.rows) {
      const identity = snapshotIdentity(row, identityField);
      if (identity === undefined) continue;
      if (seen.has(identity)) duplicateIdentities.add(identity);
      seen.add(identity);
    }
  }
  const anchorCounts = new Map<string, number>();
  for (const row of snapshot.rows) {
    if (row.physicalAnchor.kind !== PRESENCE_KINDS.PRESENT) continue;
    anchorCounts.set(row.physicalAnchor.value, (anchorCounts.get(row.physicalAnchor.value) ?? 0) + 1);
  }
  let extra = 0;
  for (const row of snapshot.rows) {
    // A duplicated anchor cannot prove which row the desired binding owns, so
    // it never suppresses the extra count; the business key decides instead.
    // A quarantined desired identity (duplicated in the sheet) blocks the
    // anchor suppression too, because the anchor cannot prove ownership of a
    // business key that appears elsewhere.
    if (row.physicalAnchor.kind === PRESENCE_KINDS.PRESENT &&
        (anchorCounts.get(row.physicalAnchor.value) ?? 0) === 1) {
      const desiredIdentity = desiredAnchors.get(row.physicalAnchor.value);
      if (desiredAnchors.has(row.physicalAnchor.value) &&
          (desiredIdentity === undefined || !duplicateIdentities.has(desiredIdentity))) {
        continue;
      }
    }
    const identity = snapshotIdentity(row, identityField);
    if (identity !== undefined && !duplicateIdentities.has(identity) && desiredIdentities.has(identity)) continue;
    extra += 1;
  }
  return extra;
}
