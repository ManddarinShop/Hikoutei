/** Compares System_State snapshots and plans durable correction effects. */

import {
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  type NormalizedCell,
} from "../../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../../../../shared/state/index.js";
import { NORMALIZED_CELL_KINDS } from "../../../../shared/encoding/constants.js";
import {
  readReconciliationCorrectionStateWithAdapter,
  type NewEffect,
  type ReconciliationCorrectionState,
  type ReconciliationVisibleState,
} from "../../../../infrastructure/storage/index.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../../gateway/constants.js";
import {
  computeSyncVisibleHash,
  type SyncGatewaySnapshot,
} from "../../gateway/syncGateway.js";
import { createSystemProjectionEffect } from "../projection/ProjectionEffectFactory.js";
import type { DesiredRow } from "./reconciliationDesiredState.js";

export type DriftKind = "drifted" | "missing";

export interface DriftTarget {
  readonly kind: DriftKind;
  readonly desired: DesiredRow;
}

export interface ReconciliationPlanningContext {
  readonly storage: SqlStorageAdapter;
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly schemaVersion: number;
  readonly createId: () => string;
}

/** Finds missing or value-drifted desired rows by their visible business key. */
export function computeDrifts(args: {
  readonly snapshot: SyncGatewaySnapshot;
  readonly desired: readonly DesiredRow[];
  readonly systemFields: readonly string[];
  readonly sheet: { readonly businessKeyField: string };
}): readonly DriftTarget[] {
  const rowsByIdentity = new Map<string, SyncGatewaySnapshot["rows"][number]>();
  const ambiguousIdentities = new Set<string>();
  for (const row of args.snapshot.rows) {
    const identity = snapshotIdentity(row, args.sheet.businessKeyField);
    if (identity === undefined || ambiguousIdentities.has(identity)) continue;
    if (rowsByIdentity.has(identity)) {
      rowsByIdentity.delete(identity);
      ambiguousIdentities.add(identity);
    } else {
      rowsByIdentity.set(identity, row);
    }
  }

  const drifts: DriftTarget[] = [];
  for (const desiredRow of args.desired) {
    const observed = ambiguousIdentities.has(desiredRow.entityId)
      ? undefined
      : rowsByIdentity.get(desiredRow.entityId);
    if (observed === undefined) {
      drifts.push({ kind: "missing", desired: desiredRow });
      continue;
    }
    const observedHash = computeObservedHash(observed, args.systemFields);
    const desiredHash = computeSyncVisibleHash(desiredRow.fields);
    if (observedHash !== desiredHash) {
      drifts.push({ kind: "drifted", desired: desiredRow });
    }
  }
  return drifts;
}

/** Reads a business-key value from a visible snapshot row. */
export function snapshotIdentity(
  row: SyncGatewaySnapshot["rows"][number],
  identityField: string,
): string | undefined {
  const cell = row.cells[identityField]?.normalizedCell;
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

function computeObservedHash(
  row: SyncGatewaySnapshot["rows"][number],
  systemFields: readonly string[],
): string {
  const values: Record<string, NormalizedCell> = {};
  for (const fieldName of systemFields) {
    const cell = row.cells[fieldName];
    values[fieldName] = cell === undefined ? null : cell.normalizedCell;
  }
  return computeSyncVisibleHash(values);
}

/** Builds one system projection effect for every repairable drift. */
export async function buildCorrectionEffects(
  context: ReconciliationPlanningContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  drifts: readonly DriftTarget[],
): Promise<readonly NewEffect[]> {
  const effects: NewEffect[] = [];
  const commitId = "reconciliation:" + context.createId();

  for (const drift of drifts) {
    const baseline = await resolveCorrectionBaseline(context, drift.desired);
    if (baseline.skip) continue;
    effects.push(createSystemProjectionEffect({
      effectId: "effect:" + context.createId(),
      commitId,
      logicalSheetId: context.logicalSheetId,
      physicalSheetId: context.physicalSheetId,
      sheetName: sheet.tabName,
      registeredRange: sheet.registeredRange,
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: context.schemaVersion,
      targetKind: "entity",
      targetId: drift.desired.entityId,
      rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: drift.desired.rowBindingId },
      conflictId: { kind: PRESENCE_KINDS.ABSENT },
      fields: drift.desired.fields,
      createIfMissing: baseline.createIfMissing,
      expectedVisibleRevision: baseline.expectedVisibleRevision,
      expectedVisibleHash: baseline.expectedVisibleHash,
      targetEntityRevision: {
        kind: APPLICABILITY_KINDS.APPLICABLE,
        value: drift.desired.entityRevision,
      },
      targetFieldRevisionHash: {
        kind: APPLICABILITY_KINDS.APPLICABLE,
        value: drift.desired.fieldRevisionHash,
      },
      targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.APPLICABLE, value: commitId },
      streamSequence: baseline.streamSequence,
    }));
  }
  return effects;
}

interface CorrectionBaseline {
  readonly skip: boolean;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}

async function resolveCorrectionBaseline(
  context: ReconciliationPlanningContext,
  desired: DesiredRow,
): Promise<CorrectionBaseline> {
  const state = await readReconciliationCorrectionStateWithAdapter(context.storage, {
    logicalSheetId: context.logicalSheetId,
    physicalSheetId: context.physicalSheetId,
    entityId: desired.entityId,
    rowBindingId: desired.rowBindingId,
  });
  return resolveCorrectionBaselineFromState(state, desired);
}

function resolveCorrectionBaselineFromState(
  state: ReconciliationCorrectionState,
  desired: DesiredRow,
): CorrectionBaseline {
  const latestEffect = state.latestEffect;
  if (latestEffect !== undefined && latestEffect.streamSequence !== null) {
    const streamSequence = latestEffect.streamSequence + 1;
    if (latestEffect.status === "pending" || latestEffect.status === "processing") {
      const payload = latestEffect.payloadJson;
      const expectedHash = payload === null ? "" : extractTargetVisibleHash(payload);
      const expectedVisibleRevision = (latestEffect.expectedVisibleRevision ?? 0) + 1;
      if (expectedHash === computeSyncVisibleHash(desired.fields)) {
        // Avoid appending the same correction on every periodic scan while the
        // first effect is waiting for gateway application or read-back.
        return {
          skip: true,
          expectedVisibleRevision,
          expectedVisibleHash: expectedHash,
          createIfMissing: false,
          streamSequence,
        };
      }
      return {
        skip: false,
        expectedVisibleRevision,
        expectedVisibleHash: expectedHash,
        createIfMissing: false,
        streamSequence,
      };
    }
    return baselineFromVisible(state.visibleState, streamSequence);
  }
  return baselineFromVisible(state.visibleState, POSITIVE_SAFE_INTEGER_MINIMUM);
}

function baselineFromVisible(
  visible: ReconciliationVisibleState | undefined,
  streamSequence: number,
): CorrectionBaseline {
  if (
    visible === undefined ||
    visible.confirmedVisibleRevision === null ||
    visible.confirmedSnapshotHash === null ||
    visible.confirmedSnapshotHash.length === 0
  ) {
    return {
      skip: false,
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      createIfMissing: true,
      streamSequence,
    };
  }
  return {
    skip: false,
    expectedVisibleRevision: visible.confirmedVisibleRevision,
    expectedVisibleHash: visible.confirmedSnapshotHash,
    createIfMissing: false,
    streamSequence,
  };
}

function extractTargetVisibleHash(payloadJson: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as { targetVisibleHash?: unknown };
    return typeof parsed.targetVisibleHash === "string" ? parsed.targetVisibleHash : "";
  } catch {
    return "";
  }
}
