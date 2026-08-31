/**
 * Outbox effect row decoding and SQL parameter builders.
 *
 * decodePendingEffectRow promotes a raw SQL row into the PendingEffect contract.
 * The parameter builders construct the SQL argument tuples for every outbox
 * mutation (claim, apply, insert, requeue, mark-uncertain, replan).
 */

import { STORAGE_ERROR_CODES, StorageError } from "../contract/errors.js";
import {
  EFFECT_KINDS,
  EFFECT_STATUSES,
  EFFECT_TARGET_KINDS,
} from "../contract/constants.js";
import type { EffectKind, EffectStatus, EffectTargetKind } from "../contract/constants.js";
import {
  isSemanticRevision,
  requireSemanticString,
  type OutboxRevision,
  type SemanticString,
} from "../contract/identity.js";
import {
  fenceParameters,
} from "./writerLease.js";
import type { FencingContext } from "./writerLease.js";
import { toSqlNullable } from "../sql/sqlState.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  MarkDeliveryUncertainOptions,
  NewEffect,
  RetryClaimedEffectOptions,
} from "../contract/contracts.js";
import type { PendingEffect } from "../contract/contracts.js";
import type {
  SqlParameter,
  SqlRow,
} from "../sql/sql.js";

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
