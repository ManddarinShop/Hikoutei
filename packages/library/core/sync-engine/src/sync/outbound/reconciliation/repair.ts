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

import { POSITIVE_SAFE_INTEGER_MINIMUM } from "@hikoutei/contracts/constants.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "@hikoutei/contracts/state/index.js";
import { isRecord } from "@hikoutei/contracts/encoding/typeGuards.js";
import type { NewEffect } from "@hikoutei/ikisaki";
import {
  isRecoverableEffectErrorCode,
} from "@hikoutei/ikisaki";
import type { SqlExecutor } from "@hikoutei/contracts/storage/sql.js";
import { computeSyncVisibleHash } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { SyncSnapshotRow } from "@hikoutei/contracts/sheets/syncSheets.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import { createSystemProjectionEffect } from "@hikoutei/storage/sync/outbound/projection/ProjectionEffectFactory.js";
import { computeObservedHash } from "./diff.js";
import {
  READ_FAILED_HEAD_SQL,
  READ_LATEST_EFFECT_SQL,
  READ_LATEST_VISIBLE_STATE_SQL,
  type DesiredRow,
  type FailedHeadSqlShape,
  type LatestEffectSqlShape,
  type LatestVisibleSqlShape,
  type ScanContext,
} from "./shared.js";
import type { DriftTarget } from "./diff.js";

export async function buildCorrectionEffects(
  context: ScanContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  drifts: readonly DriftTarget[],
): Promise<readonly CorrectionPlan[]> {
  const effects: CorrectionPlan[] = [];
  const commitId = "reconciliation:" + context.createId();

  for (const drift of drifts) {
    const baseline = await resolveCorrectionBaseline(context, drift.desired, drift.observed);
    if (baseline.skip) {
      // An equivalent correction is already in flight behind a terminal
      // failed head that blocks the stream. No new effect is appended; the
      // scanner instead supersedes the failed head with the in-flight
      // correction (supersede-only plan) so that correction becomes
      // claimable. Without a failed head, a skip is a plain no-op.
      if (baseline.supersedeFailedEffectId !== null && baseline.supersedeByEffectId !== null) {
        effects.push({
          effect: null,
          supersedeFailedEffectId: baseline.supersedeFailedEffectId,
          supersedeByEffectId: baseline.supersedeByEffectId,
        });
      }
      continue;
    }
    // A missing drift means the row is not observable in the Sheet at all,
    // so the repair must create it from the empty visible baseline even when
    // a confirmed visible state exists from an earlier lifecycle (a row
    // deleted after it was applied). The confirmed-state baseline would make
    // the provider reject the correction with a guard mismatch forever.
    const createIfMissing = drift.kind === "missing" ? true : baseline.createIfMissing;
    const expectedVisibleRevision = drift.kind === "missing"
      ? 0
      : baseline.expectedVisibleRevision;
    const expectedVisibleHash = drift.kind === "missing"
      ? ""
      : baseline.expectedVisibleHash;
    effects.push({
      effect: createRepairEffect(context, sheet, drift.desired, commitId, {
        ...baseline,
        createIfMissing,
        expectedVisibleRevision,
        expectedVisibleHash,
      }),
      // When the stream head is a terminal failed effect, the repair must
      // supersede that head so it can become the new claimable stream head;
      // otherwise the durable predecessor guard would block it forever.
      supersedeFailedEffectId: baseline.supersedeFailedEffectId,
      supersedeByEffectId: baseline.supersedeByEffectId,
    });
  }
  return effects;
}

/**
 * One desired row awaiting a failed-head repair plus its observed snapshot
 * evidence (a clean row whose Sheet state already matches canonical).
 */
export interface FailedHeadRepairTarget {
  readonly desired: DesiredRow;
  /**
   * The observed snapshot row for a clean (already matching) row, so the
   * repair plan can guard on the row's current visible hash even when no
   * confirmed visible evidence exists. `undefined` when the row was not
   * observable in the snapshot.
   */
  readonly observed: SyncSnapshotRow | undefined;
}

/**
 * Plans the stream repair for one desired row whose Sheet state already
 * matches canonical but whose stream is wedged behind a terminal failed head.
 *
 * The failed head blocks every follower through the durable predecessor
 * guard while the drift path never plans a repair for a row that already
 * matches, so this replans the same correction contract without a drift: an
 * equivalent correction already in flight behind the head produces a
 * supersede-only plan; otherwise a fresh correction effect is returned that
 * supersedes the head when it is appended. Returns null when a concurrent
 * pass already superseded the head.
 */
export async function buildFailedHeadRepairPlan(
  context: ScanContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  target: FailedHeadRepairTarget,
  commitId: string,
): Promise<CorrectionPlan | null> {
  const baseline = await resolveCorrectionBaseline(context, target.desired, target.observed);
  if (baseline.supersedeFailedEffectId === null) return null;
  if (baseline.skip) {
    return {
      effect: null,
      supersedeFailedEffectId: baseline.supersedeFailedEffectId,
      supersedeByEffectId: baseline.supersedeByEffectId,
    };
  }
  return {
    effect: createRepairEffect(context, sheet, target.desired, commitId, baseline),
    supersedeFailedEffectId: baseline.supersedeFailedEffectId,
    supersedeByEffectId: baseline.supersedeByEffectId,
  };
}

/** Builds one system_projection correction effect from a resolved baseline. */
function createRepairEffect(
  context: ScanContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  desired: DesiredRow,
  commitId: string,
  baseline: CorrectionBaseline,
): NewEffect {
  return createSystemProjectionEffect({
    effectId: "effect:" + context.createId(),
    commitId,
    logicalSheetId: context.logicalSheetId,
    physicalSheetId: context.physicalSheetId,
    sheetName: sheet.tabName,
    registeredRange: sheet.registeredRange,
    projection: SYNC_PROJECTIONS.SYSTEM_STATE,
    schemaVersion: context.schemaVersion,
    targetKind: "entity",
    targetId: desired.entityId,
    rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: desired.rowBindingId },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetAnchor: desired.anchorReference,
    fields: desired.fields,
    createIfMissing: baseline.createIfMissing,
    expectedVisibleRevision: baseline.expectedVisibleRevision,
    expectedVisibleHash: baseline.expectedVisibleHash,
    targetEntityRevision: {
      kind: APPLICABILITY_KINDS.APPLICABLE,
      value: desired.entityRevision,
    },
    targetFieldRevisionHash: {
      kind: APPLICABILITY_KINDS.APPLICABLE,
      value: desired.fieldRevisionHash,
    },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.APPLICABLE, value: commitId },
    streamSequence: baseline.streamSequence,
  });
}

/**
 * One reconciliation correction and the durable transition it requires.
 *
 * `supersedeFailedEffectId` is set only when a terminal (non-recoverable)
 * failed effect blocks the target stream and must be superseded so the
 * repair can become (or unblock) the stream head. Recoverable failed heads
 * stay on the worker retry path and are never superseded.
 */
export interface CorrectionPlan {
  /**
   * The correction effect to append, or null for a supersede-only plan
   * (the in-flight correction that already covers this drift is unblocked
   * by superseding the terminal failed head with its effect id).
   */
  readonly effect: NewEffect | null;
  readonly supersedeFailedEffectId: string | null;
  readonly supersedeByEffectId: string | null;
}

export interface CorrectionBaseline {
  readonly skip: boolean;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
  /**
   * Terminal failed stream head to supersede when appending this correction.
   *
   * `null` means append normally. Set only when an active `failed` effect with
   * a non-recoverable error code blocks the target stream, so the correction
   * can supersede that head and become the new stream head instead of being
   * blocked behind the terminal failed predecessor forever.
   */
  readonly supersedeFailedEffectId: string | null;
  /**
   * Existing effect that owns the stream after the failed head is superseded.
   *
   * Set only when the baseline skips appending (an equivalent correction is
   * already in flight behind the failed head). The failed head is superseded
   * with this effect id so the blocked correction becomes claimable.
   */
  readonly supersedeByEffectId: string | null;
}

export async function resolveCorrectionBaseline(
  context: ScanContext,
  desired: DesiredRow,
  observed: SyncSnapshotRow | undefined,
): Promise<CorrectionBaseline> {
  return context.storage.read(({ sql }) =>
    resolveCorrectionBaselineWithSql(sql, context, desired, observed),
  );
}

export async function resolveCorrectionBaselineWithSql(
  sql: SqlExecutor,
  context: ScanContext,
  desired: DesiredRow,
  observed: SyncSnapshotRow | undefined,
): Promise<CorrectionBaseline> {
  const latestEffect = await sql.get<LatestEffectSqlShape>(READ_LATEST_EFFECT_SQL, [
    context.logicalSheetId,
    desired.entityId,
  ]);
  const failedHead = await readTerminalFailedHeadWithSql(sql, context.logicalSheetId, desired.entityId);

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
      // The in-flight effect may be a create-baseline repair (expected
      // revision 0) whose confirmation clamps the durable confirmed
      // revision forward (confirmed + 1) when it settles. A follower
      // planned against the repair's expected revision alone could then
      // confirm below the clamped revision and be rejected by the
      // visible-state upsert guard as a regression, wedging the stream.
      // Floor the follower revision at the last confirmed revision so the
      // chain stays monotonic; the hash still comes from the in-flight
      // effect's target because that is what the sheet will show after it
      // applies.
      const visible = await sql.get<LatestVisibleSqlShape>(READ_LATEST_VISIBLE_STATE_SQL, [
        context.physicalSheetId,
        desired.rowBindingId,
      ]);
      const expectedVisibleRevision = Math.max(
        (latestEffect.expected_visible_revision ?? 0) + 1,
        visible?.confirmed_visible_revision ?? 0,
      );
      if (expectedHash === computeSyncVisibleHash(desired.fields)) {
        // A canonical write already has an equivalent correction in flight.
        // Do not append another stream item on every periodic scan while the
        // first item is waiting for the provider or its recovery read-back.
        // Even when skipping the append, a terminal failed head that blocks
        // this in-flight repair must still be superseded so the stream can
        // progress (live recovery from a previously wedged outbox).
        return {
          skip: true,
          expectedVisibleRevision,
          expectedVisibleHash: expectedHash,
          createIfMissing: false,
          streamSequence,
          supersedeFailedEffectId: failedHead,
          supersedeByEffectId: latestEffect.effect_id,
        };
      }
      // The in-flight correction does not match the current canonical
      // target, so a fresh repair is appended behind it. The terminal failed
      // head is superseded with the NEW repair id (not the stale in-flight
      // id): the failed head is closed by the effect that replaces its
      // intent, and the stale in-flight correction becomes claimable as a
      // side effect because the failed head no longer blocks it.
      return {
        skip: false,
        expectedVisibleRevision,
        expectedVisibleHash: expectedHash,
        createIfMissing: false,
        streamSequence,
        supersedeFailedEffectId: failedHead,
        supersedeByEffectId: null,
      };
    }
    const visible = await sql.get<LatestVisibleSqlShape>(READ_LATEST_VISIBLE_STATE_SQL, [
      context.physicalSheetId,
      desired.rowBindingId,
    ]);
    return withSupersede(
      baselineFromVisible(visible, streamSequence, observed, context.systemFields),
      failedHead,
    );
  }

  const visible = await sql.get<LatestVisibleSqlShape>(READ_LATEST_VISIBLE_STATE_SQL, [
    context.physicalSheetId,
    desired.rowBindingId,
  ]);
  return withSupersede(
    baselineFromVisible(visible, POSITIVE_SAFE_INTEGER_MINIMUM, observed, context.systemFields),
    failedHead,
  );
}

/**
 * Returns the terminal failed head id for one target stream, or null.
 *
 * A `failed` effect whose `last_error_code` is recoverable stays on the worker
 * retry path and is never superseded by reconciliation; only non-recoverable
 * (terminal) failed heads such as `delivery_uncertain_timeout` are returned.
 */
async function readTerminalFailedHeadWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  entityId: string,
): Promise<string | null> {
  const failed = await sql.get<FailedHeadSqlShape>(READ_FAILED_HEAD_SQL, [logicalSheetId, entityId]);
  if (failed === undefined) return null;
  return isRecoverableEffectErrorCode(failed.last_error_code) ? null : failed.effect_id;
}

/** Attaches a terminal failed head supersession to a visible-state baseline. */
function withSupersede(
  baseline: CorrectionBaseline,
  failedHead: string | null,
): CorrectionBaseline {
  if (failedHead === null) return baseline;
  return { ...baseline, supersedeFailedEffectId: failedHead };
}

export function baselineFromVisible(
  visible: LatestVisibleSqlShape | undefined,
  streamSequence: number,
  observed: SyncSnapshotRow | undefined,
  systemFields: readonly string[] | undefined,
): CorrectionBaseline {
  if (
    visible !== undefined &&
    visible.confirmed_visible_revision !== null &&
    visible.confirmed_snapshot_hash !== null &&
    visible.confirmed_snapshot_hash.length > 0
  ) {
    // The confirmed revision is the receipt baseline so the confirmation
    // upsert never regresses. The expected hash, however, comes from the
    // FRESH observed row whenever one is available: the provider write CAS
    // is hash-only, so only the row's CURRENT visible hash can pass the
    // guard. Using the stale confirmed hash as the guard would make a repair
    // of an edited/drifted row fail on `visible_guard_mismatch` forever.
    const observedHash = observed !== undefined && systemFields !== undefined
      ? computeObservedHash(observed, systemFields)
      : undefined;
    return {
      skip: false,
      expectedVisibleRevision: visible.confirmed_visible_revision,
      expectedVisibleHash:
        observedHash !== undefined && observedHash.length > 0
          ? observedHash
          : visible.confirmed_snapshot_hash,
      createIfMissing: false,
      streamSequence,
      supersedeFailedEffectId: null,
      supersedeByEffectId: null,
    };
  }
  // No confirmed visible evidence exists (for example a response-loss
  // restart where the local confirmation was never recorded). If the row is
  // observable in the snapshot, build a guarded regular repair from its
  // CURRENT visible hash instead of the old insert baseline: the row already
  // exists, so a createIfMissing repair would be rejected as an identity/insert
  // failure and repeat forever. Revision 0 is the receipt baseline only — the
  // provider write CAS is hash-only, so the observed hash is the guard that
  // prevents an unguarded overwrite.
  if (observed !== undefined && systemFields !== undefined) {
    const observedHash = computeObservedHash(observed, systemFields);
    if (observedHash.length > 0) {
      return {
        skip: false,
        expectedVisibleRevision: 0,
        expectedVisibleHash: observedHash,
        createIfMissing: false,
        streamSequence,
        supersedeFailedEffectId: null,
        supersedeByEffectId: null,
      };
    }
  }
  // The safe missing-row path: no observed row and no confirmed evidence, so
  // the repair must create the row from the empty visible baseline.
  return {
    skip: false,
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    createIfMissing: true,
    streamSequence,
    supersedeFailedEffectId: null,
    supersedeByEffectId: null,
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
