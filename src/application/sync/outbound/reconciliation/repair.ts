/**
 * Correction effect generation for the reconciliation scanner.
 *
 * Plans a normal system_projection effect per drift against the latest outbox
 * and visible-state evidence, so the correction is applied by the same
 * CAS-guarded slow path as regular writes. The expected visible hash/revision
 * in each effect comes from the most recent outbox item (an in-flight or
 * uncertain write) or from the confirmed visible state, never from the stale
 * snapshot that triggered the drift.
 */

import { POSITIVE_SAFE_INTEGER_MINIMUM } from "../../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../../../../shared/state/index.js";
import { isRecord } from "../../../../shared/encoding/typeGuards.js";
import type { NewEffect } from "../../../../infrastructure/storage/index.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import { computeSyncVisibleHash } from "../../sheetsContract/syncSheets.js";
import { SYNC_PROJECTIONS } from "../../sheetsContract/constants.js";
import { createSystemProjectionEffect } from "../projection/ProjectionEffectFactory.js";
import {
  READ_LATEST_EFFECT_SQL,
  READ_LATEST_VISIBLE_STATE_SQL,
  type DesiredRow,
  type LatestEffectSqlShape,
  type LatestVisibleSqlShape,
  type ScanContext,
} from "./shared.js";
import type { DriftTarget } from "./diff.js";

export async function buildCorrectionEffects(
  context: ScanContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  drifts: readonly DriftTarget[],
): Promise<readonly NewEffect[]> {
  const effects: NewEffect[] = [];
  const commitId = "reconciliation:" + context.createId();

  for (const drift of drifts) {
    const baseline = await resolveCorrectionBaseline(context, drift.desired);
    if (baseline.skip) continue;
    const effect = createSystemProjectionEffect({
      effectId: "effect:" + context.createId(),
      commitId,
      logicalSheetId: context.logicalSheetId,
      physicalSheetId: context.physicalSheetId,
      sheetName: sheet.tabName,
      registeredRange: sheet.registeredRange,
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: context.schemaVersion,
      targetKind: "entity",
      targetId: drift.desired.entityId,
      rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: drift.desired.rowBindingId },
      conflictId: { kind: PRESENCE_KINDS.ABSENT },
      targetAnchor: drift.desired.anchorReference,
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
    });
    effects.push(effect);
  }
  return effects;
}

export interface CorrectionBaseline {
  readonly skip: boolean;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}

export async function resolveCorrectionBaseline(
  context: ScanContext,
  desired: DesiredRow,
): Promise<CorrectionBaseline> {
  return context.storage.read(({ sql }) =>
    resolveCorrectionBaselineWithSql(sql, context, desired),
  );
}

export async function resolveCorrectionBaselineWithSql(
  sql: SqlExecutor,
  context: ScanContext,
  desired: DesiredRow,
): Promise<CorrectionBaseline> {
  const latestEffect = await sql.get<LatestEffectSqlShape>(READ_LATEST_EFFECT_SQL, [
    context.logicalSheetId,
    desired.entityId,
  ]);

  if (latestEffect !== undefined && latestEffect.stream_sequence !== null) {
    const streamSequence = latestEffect.stream_sequence + 1;
    // delivery_uncertain counts as in-flight: the predecessor may still commit
    // remotely after a lost response, and the outbox claim ordering keeps any
    // successor pending until that effect is probe-settled. Planning a
    // correction against the uncertain target (rather than stale visible
    // state) is what makes the eventual guard match the committed write.
    if (latestEffect.status === "pending" ||
        latestEffect.status === "processing" ||
        latestEffect.status === "delivery_uncertain") {
      const payload = latestEffect.payload_json;
      const expectedHash =
        payload === null ? "" : extractTargetVisibleHash(payload);
      if (expectedHash === computeSyncVisibleHash(desired.fields)) {
        // A canonical write already has an equivalent correction in flight.
        // Do not append another stream item on every periodic scan while the
        // first item is waiting for the provider or its recovery read-back.
        return {
          skip: true,
          expectedVisibleRevision: (latestEffect.expected_visible_revision ?? 0) + 1,
          expectedVisibleHash: expectedHash,
          createIfMissing: false,
          streamSequence,
        };
      }
      return {
        skip: false,
        expectedVisibleRevision: (latestEffect.expected_visible_revision ?? 0) + 1,
        expectedVisibleHash: expectedHash,
        createIfMissing: false,
        streamSequence,
      };
    }
    const visible = await sql.get<LatestVisibleSqlShape>(READ_LATEST_VISIBLE_STATE_SQL, [
      context.physicalSheetId,
      desired.rowBindingId,
    ]);
    return baselineFromVisible(visible, streamSequence);
  }

  const visible = await sql.get<LatestVisibleSqlShape>(READ_LATEST_VISIBLE_STATE_SQL, [
    context.physicalSheetId,
    desired.rowBindingId,
  ]);
  return baselineFromVisible(visible, POSITIVE_SAFE_INTEGER_MINIMUM);
}

export function baselineFromVisible(
  visible: LatestVisibleSqlShape | undefined,
  streamSequence: number,
): CorrectionBaseline {
  if (
    visible === undefined ||
    visible.confirmed_visible_revision === null ||
    visible.confirmed_snapshot_hash === null ||
    visible.confirmed_snapshot_hash.length === 0
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
    expectedVisibleRevision: visible.confirmed_visible_revision,
    expectedVisibleHash: visible.confirmed_snapshot_hash,
    createIfMissing: false,
    streamSequence,
  };
}

export function extractTargetVisibleHash(payloadJson: string): string {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (!isRecord(parsed)) return "";
    return typeof parsed.targetVisibleHash === "string" ? parsed.targetVisibleHash : "";
  } catch {
    return "";
  }
}
