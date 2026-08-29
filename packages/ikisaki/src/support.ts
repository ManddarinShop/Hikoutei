/** Validation, delivery confirmation, fencing, and SQL parameter helpers. */

import { STORAGE_ERROR_CODES, StorageError } from "./errors.js";
import {
  EFFECT_KINDS,
  EFFECT_STATUSES,
  EFFECT_TARGET_KINDS,
} from "./constants.js";
import type { EffectKind, EffectStatus, EffectTargetKind } from "./constants.js";
import {
  isSemanticRevision,
  requireSemanticString,
  type OutboxRevision,
  type SemanticString,
} from "./identity.js";
import { isNonEmptyString, isRecord } from "./validation.js";
import { APPLICABILITY_KINDS } from "./state.js";
import {
  fenceParameters,
  isFencingValidWithSql,
} from "./writerLease.js";
import type { FencingContext } from "./writerLease.js";
import { toSqlNullable } from "./sqlState.js";
import {
  READ_CONFIRMED_VISIBLE_REVISION_SQL,
  UPSERT_VISIBLE_FIELD_STATE_SQL,
  UPSERT_VISIBLE_STATE_SQL,
} from "./outboxSql.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  EffectProjectionConfirmation,
  MarkDeliveryUncertainOptions,
  NewEffect,
  RetryClaimedEffectOptions,
} from "./contracts.js";
import type {
  SqlExecutor,
  SqlParameter,
  SqlRow,
} from "./sql.js";
import type { PendingEffect } from "./contracts.js";

const READ_CLAIMED_EFFECT_TARGET_SQL = `
  SELECT effect_kind, physical_sheet_id, projection, row_binding_id
  FROM sheet_effect_outbox
  WHERE effect_id = ? AND claim_token = ? AND status = 'processing'
`;

/** Promotes one raw outbox SQL row into the closed pending-effect contract. */
export function decodePendingEffectRow(row: SqlRow, index?: number): PendingEffect {
  const label = index === undefined ? "pending effect" : `pending effect[${index}]`;
  const expectedVisibleRevision = requireSqlRevision(
    row.expected_visible_revision,
    `${label}.expected_visible_revision`,
  );
  const expectedVisibleHashText = requireSqlTextAllowEmpty(
    row.expected_visible_hash,
    `${label}.expected_visible_hash`,
  );
  if (expectedVisibleHashText.length === 0 && expectedVisibleRevision !== 0) {
    throwInvalidPendingEffect(`${label}.expected_visible_hash may be empty only at revision zero`);
  }
  return {
    effect_id: requirePendingString<"effect-id">(row.effect_id, `${label}.effect_id`),
    effect_kind: requireEffectKind(row.effect_kind, `${label}.effect_kind`),
    commit_id: requireSqlText(row.commit_id, `${label}.commit_id`),
    logical_sheet_id: requireSqlText(row.logical_sheet_id, `${label}.logical_sheet_id`),
    physical_sheet_id: requirePendingString<"physical-sheet-id">(
      row.physical_sheet_id,
      `${label}.physical_sheet_id`,
    ),
    projection: requireSqlText(row.projection, `${label}.projection`),
    row_binding_id: requireNullablePendingString<"row-binding-id">(
      row.row_binding_id,
      `${label}.row_binding_id`,
    ),
    conflict_id: requireNullableSqlText(row.conflict_id, `${label}.conflict_id`),
    target_kind: requireEffectTargetKind(row.target_kind, `${label}.target_kind`),
    target_id: requireSqlText(row.target_id, `${label}.target_id`),
    target_entity_revision: requireNullableSqlRevision(
      row.target_entity_revision,
      `${label}.target_entity_revision`,
    ),
    target_field_revision_hash: requireNullableSqlText(
      row.target_field_revision_hash,
      `${label}.target_field_revision_hash`,
    ),
    target_canonical_commit_id: requireNullableSqlText(
      row.target_canonical_commit_id,
      `${label}.target_canonical_commit_id`,
    ),
    expected_visible_revision: expectedVisibleRevision,
    expected_visible_hash: expectedVisibleHashText.length === 0
      ? ""
      : requireSemanticString<"visible-hash">(
        expectedVisibleHashText,
        `${label}.expected_visible_hash`,
      ),
    repair_guard_hash: requireNullableSqlText(row.repair_guard_hash, `${label}.repair_guard_hash`),
    source_quarantine_id: requireNullableSqlText(
      row.source_quarantine_id,
      `${label}.source_quarantine_id`,
    ),
    payload_json: requireSqlText(row.payload_json, `${label}.payload_json`),
    payload_hash: requirePendingString<"payload-hash">(
      row.payload_hash,
      `${label}.payload_hash`,
    ),
    effect_dedupe_key: requirePendingString<"effect-dedupe-key">(
      row.effect_dedupe_key,
      `${label}.effect_dedupe_key`,
    ),
    stream_sequence: requireSqlRevision(row.stream_sequence, `${label}.stream_sequence`),
    created_at: requireSqlRevision(row.created_at, `${label}.created_at`),
    next_attempt_at: requireNullableSqlRevision(row.next_attempt_at, `${label}.next_attempt_at`),
    uncertain_since: requireNullableSqlRevision(row.uncertain_since, `${label}.uncertain_since`),
    next_probe_at: requireNullableSqlRevision(row.next_probe_at, `${label}.next_probe_at`),
    dispatch_id: requireNullableSqlText(row.dispatch_id, `${label}.dispatch_id`),
    status: requireEffectStatus(row.status, `${label}.status`),
  };
}

function requireSqlText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throwInvalidPendingEffect(`${label} must be non-empty text`);
  }
  return value;
}

function requirePendingString<Label extends string>(
  value: unknown,
  label: string,
): SemanticString<Label> {
  return requireSemanticString<Label>(requireSqlText(value, label), label);
}

function requireNullablePendingString<Label extends string>(
  value: unknown,
  label: string,
): SemanticString<Label> | null {
  if (value === null) return null;
  return requirePendingString<Label>(value, label);
}

function requireSqlTextAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throwInvalidPendingEffect(`${label} must be text`);
  }
  return value;
}

function requireNullableSqlText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requireSqlText(value, label);
}

function requireSqlRevision(value: unknown, label: string): OutboxRevision {
  if (!isSemanticRevision(value)) {
    throwInvalidPendingEffect(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireNullableSqlRevision(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return requireSqlRevision(value, label);
}

function requireEffectKind(value: unknown, label: string): EffectKind {
  if (value === EFFECT_KINDS.SYSTEM_PROJECTION ||
      value === EFFECT_KINDS.CANDIDATE_RECONCILE ||
      value === EFFECT_KINDS.SYSTEM_REPAIR ||
      value === EFFECT_KINDS.RESOLUTION_PROJECTION ||
      value === EFFECT_KINDS.RESOLUTION_DELETE ||
      value === EFFECT_KINDS.USER_INPUT_DELETE) return value;
  throwInvalidPendingEffect(`${label} is unsupported`);
}

function requireEffectTargetKind(value: unknown, label: string): EffectTargetKind {
  if (value === EFFECT_TARGET_KINDS.ENTITY ||
      value === EFFECT_TARGET_KINDS.ROW_BINDING ||
      value === EFFECT_TARGET_KINDS.PROJECTION_ROW ||
      value === EFFECT_TARGET_KINDS.CONFLICT) return value;
  throwInvalidPendingEffect(`${label} is unsupported`);
}

function requireEffectStatus(value: unknown, label: string): EffectStatus {
  if (value === EFFECT_STATUSES.PENDING ||
      value === EFFECT_STATUSES.PROCESSING ||
      value === EFFECT_STATUSES.DELIVERY_UNCERTAIN ||
      value === EFFECT_STATUSES.APPLIED ||
      value === EFFECT_STATUSES.BLOCKED_CANDIDATE ||
      value === EFFECT_STATUSES.SUPERSEDED ||
      value === EFFECT_STATUSES.CONFLICT ||
      value === EFFECT_STATUSES.FAILED) return value;
  throwInvalidPendingEffect(`${label} is unsupported`);
}

function throwInvalidPendingEffect(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_PENDING_EFFECT, message);
}

export function validateProjectionConfirmation(confirmation: EffectProjectionConfirmation): void {
  if (!isRecord(confirmation)) {
    throwInvalidProjectionConfirmation("projection confirmation must be an object");
  }
  if (
    !isNonEmptyString(confirmation.physicalSheetId) ||
    !isNonEmptyString(confirmation.projection) ||
    !isNonEmptyString(confirmation.rowBindingId) ||
    !isNonEmptyString(confirmation.visibleHash) ||
    !isSemanticRevision(confirmation.visibleRevision) ||
    confirmation.visibleRevision < 1 ||
    !isApplicabilityNumber(confirmation.entityRevision) ||
    !isRecord(confirmation.fieldHashes) ||
    (confirmation.allowCreateRebaseline !== undefined &&
      typeof confirmation.allowCreateRebaseline !== "boolean")
  ) {
    throwInvalidProjectionConfirmation(
      "projection confirmation has an invalid identity, revision, or field state",
    );
  }
  for (const [fieldName, hash] of Object.entries(confirmation.fieldHashes)) {
    if (fieldName.length === 0 || !isNonEmptyString(hash)) {
      throwInvalidProjectionConfirmation(
        "projection confirmation contains an invalid field hash",
      );
    }
  }
}

function isApplicabilityNumber(value: unknown): boolean {
  return isRecord(value) && (
    value.kind === APPLICABILITY_KINDS.NOT_APPLICABLE ||
    value.kind === APPLICABILITY_KINDS.APPLICABLE && isSemanticRevision(value.value)
  );
}

function throwInvalidProjectionConfirmation(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_PROJECTION_CONFIRMATION, message);
}

export function validateApplyResultOptions(options: ApplyResultOptions): void {
  if (!isTerminalEffectStatus(options.status)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_RESULT,
      `effect result status ${String(options.status)} is not terminal`,
    );
  }
  if (options.status !== EFFECT_STATUSES.APPLIED && options.projectionConfirmation !== undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_RESULT,
      "only an applied effect may advance confirmed projection state",
    );
  }
  if (options.projectionConfirmation !== undefined) {
    validateProjectionConfirmation(options.projectionConfirmation);
  }
}

function isTerminalEffectStatus(value: unknown): value is Exclude<EffectStatus, "pending" | "processing"> {
  return value === EFFECT_STATUSES.APPLIED ||
    value === EFFECT_STATUSES.BLOCKED_CANDIDATE ||
    value === EFFECT_STATUSES.SUPERSEDED ||
    value === EFFECT_STATUSES.CONFLICT ||
    value === EFFECT_STATUSES.FAILED;
}

/**
 * Verifies that read-back evidence belongs to the effect currently being applied
 * and returns the claimed effect's durable operation kind.
 *
 * The operation kind comes from the durable outbox row, never from the
 * untrusted provider receipt or payload, so confirmation semantics (for example
 * the delete monotonic rule) are always derived from the claimed effect.
 */
export async function assertProjectionConfirmationTargetWithSql(
  sql: SqlExecutor,
  effectId: string,
  claimToken: string,
  confirmation: EffectProjectionConfirmation,
): Promise<EffectKind> {
  const row = await sql.get<SqlRow>(READ_CLAIMED_EFFECT_TARGET_SQL, [effectId, claimToken]);
  if (
    row === undefined ||
    row.physical_sheet_id !== confirmation.physicalSheetId ||
    row.projection !== confirmation.projection ||
    row.row_binding_id !== confirmation.rowBindingId
  ) {
    throwInvalidProjectionConfirmation(
      "projection confirmation does not belong to the claimed effect",
    );
  }
  return requireEffectKind(row.effect_kind, "claimed effect kind");
}

export function validateEffectLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "effect lease duration must be a positive safe integer",
    );
  }
}

export function validateReadyEffectLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "ready effect limit must be a positive safe integer",
    );
  }
}

/**
 * Writes confirmed row and field state through the active async SQL context.
 *
 * The durable `effectKind` of the claimed effect selects the visible-revision
 * resolution rule (delete monotonic retention, create-if-missing rebase, or
 * strict backwards rejection).
 */
export async function writeProjectionConfirmationWithSql(
  sql: SqlExecutor,
  confirmation: EffectProjectionConfirmation,
  effectKind: EffectKind,
): Promise<void> {
  const visibleRevision = await resolveConfirmationVisibleRevisionWithSql(sql, confirmation, effectKind);
  const row = await sql.run(UPSERT_VISIBLE_STATE_SQL, [
    confirmation.physicalSheetId,
    confirmation.projection,
    confirmation.rowBindingId,
    confirmation.visibleHash,
    visibleRevision,
    toSqlNullable(confirmation.entityRevision),
    confirmation.visibleHash,
  ]);
  if (row.changes !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
      "projection confirmation would move visible state backwards",
    );
  }

  for (const [fieldName, hash] of Object.entries(confirmation.fieldHashes)) {
    const field = await sql.run(UPSERT_VISIBLE_FIELD_STATE_SQL, [
      confirmation.physicalSheetId,
      confirmation.projection,
      confirmation.rowBindingId,
      fieldName,
      hash,
      visibleRevision,
      hash,
    ]);
    if (field.changes !== 1) {
      throw new StorageError(
        STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
        "projection confirmation would move a field visible state backwards",
      );
    }
  }
}

/**
 * Resolves the durable revision a confirmation may write.
 *
 * - Delete effects (derived from the durable `effectKind`, never the receipt)
 *   read back the pre-delete provider revision, which can be lower than the
 *   current durable confirmed revision when a same-ID row was deleted and
 *   re-created: the create rebase advances the durable counter, so the next
 *   delete's receipt legitimately lags it. A delete confirmation therefore
 *   RETAINS the higher current durable revision (monotonic, not incremented)
 *   so the delete is not misread as a stale regression that would wedge its
 *   stream. Row and field state both write at the retained revision.
 * - A create-if-missing repair applies against an empty visible baseline, so
 *   its provider receipt restarts at revision 1 even when the binding already
 *   holds a higher confirmed revision (the row was deleted and re-created).
 *   The confirmation must then advance the durable revision past the confirmed
 *   value (confirmed + 1) instead of being rejected as a regression, which
 *   would wedge the applied effect in the delivery_uncertain recovery loop
 *   forever.
 * - All other confirmations keep their receipt revision unchanged, so genuinely
 *   stale read-backs still fail closed through the upsert guard.
 */
async function resolveConfirmationVisibleRevisionWithSql(
  sql: SqlExecutor,
  confirmation: EffectProjectionConfirmation,
  effectKind: EffectKind,
): Promise<number> {
  const isDelete = isDeleteEffectKind(effectKind);
  const isCreateRebase = confirmation.allowCreateRebaseline === true;
  if (!isDelete && !isCreateRebase) {
    return confirmation.visibleRevision;
  }
  const current = await sql.get<{ readonly confirmed_visible_revision: number | null }>(
    READ_CONFIRMED_VISIBLE_REVISION_SQL,
    [confirmation.physicalSheetId, confirmation.projection, confirmation.rowBindingId],
  );
  const confirmed = current?.confirmed_visible_revision;
  if (isDelete) {
    if (confirmed !== undefined && confirmed !== null && confirmed > confirmation.visibleRevision) {
      return confirmed;
    }
    return confirmation.visibleRevision;
  }
  if (confirmed === undefined || confirmed === null || confirmed < confirmation.visibleRevision) {
    return confirmation.visibleRevision;
  }
  return confirmed + 1;
}

/** True when the durable effect kind is a projection-row delete. */
function isDeleteEffectKind(kind: EffectKind): boolean {
  return kind === EFFECT_KINDS.USER_INPUT_DELETE || kind === EFFECT_KINDS.RESOLUTION_DELETE;
}

export async function requireCurrentFenceWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "writer fencing is stale or expired",
    );
  }
}

export function claimEffectParameters(options: ClaimEffectOptions): readonly SqlParameter[] {
  return [
    options.claimToken,
    options.writerEpoch,
    options.now + options.leaseDurationMs,
    options.dispatchId ?? "dispatch:" + options.claimToken,
    options.effectId,
    options.now,
    options.now,
    ...fenceParameters(options),
  ];
}

export function applyEffectResultParameters(options: ApplyResultOptions): readonly SqlParameter[] {
  return [
    options.status,
    toSqlNullable(options.lastErrorCode),
    toSqlNullable(options.lastErrorMessage),
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  ];
}

export function effectInsertParameters(effect: NewEffect): readonly SqlParameter[] {
  return [
    effect.effectId,
    effect.effectKind,
    effect.commitId,
    effect.logicalSheetId,
    effect.physicalSheetId,
    effect.projection,
    toSqlNullable(effect.rowBindingId),
    toSqlNullable(effect.conflictId),
    effect.targetKind,
    effect.targetId,
    toSqlNullable(effect.targetEntityRevision),
    toSqlNullable(effect.targetFieldRevisionHash),
    toSqlNullable(effect.targetCanonicalCommitId),
    effect.expectedVisibleRevision,
    effect.expectedVisibleHash,
    toSqlNullable(effect.repairGuardHash),
    toSqlNullable(effect.sourceQuarantineId),
    effect.payloadJson,
    effect.payloadHash,
    effect.effectDedupeKey,
    effect.streamSequence,
  ];
}

export function pendingEffectParameters(
  effect: NewEffect,
  fence: FencingContext,
): readonly SqlParameter[] {
  return [
    ...effectInsertParameters(effect),
    fence.now,
    ...fenceParameters(fence),
  ];
}

export function markDeliveryUncertainParameters(
  options: MarkDeliveryUncertainOptions,
): readonly SqlParameter[] {
  return [
    options.uncertainSince,
    options.nextProbeAt,
    options.lastErrorCode,
    options.lastErrorMessage,
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  ];
}

export function retryClaimedEffectParameters(
  options: RetryClaimedEffectOptions,
): readonly SqlParameter[] {
  return [
    options.nextAttemptAt ?? options.now + 1_000,
    options.lastErrorCode,
    options.lastErrorMessage,
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  ];
}

export function replannedEffectParameters(
  effect: NewEffect,
  oldEffectId: string,
  fence: FencingContext,
): readonly SqlParameter[] {
  return [
    ...effectInsertParameters(effect),
    oldEffectId,
    fence.now,
    ...fenceParameters(fence),
  ];
}

/** Internal control-flow signal that forces the enclosing async savepoint to roll back. */
export class AsyncFenceLostError extends Error {}
