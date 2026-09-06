/**
 * Projection confirmation validation and durable write helpers.
 *
 * Confirms that a provider receipt matches the claimed effect and writes
 * the validated visible-revision resolution through the SQL context.
 */

import { STORAGE_ERROR_CODES, StorageError } from "../contract/errors.js";
import {
  OUTBOX_EFFECT_KINDS,
  OUTBOX_EFFECT_STATUSES,
  type OutboxEffectKind,
  type OutboxEffectStatus,
} from "./effectVocabulary.js";
import {
  isSemanticRevision,
} from "../contract/identity.js";
import { isNonEmptyString, isRecord } from "../contract/validation.js";
import { APPLICABILITY_KINDS } from "../contract/state.js";
import { toSqlNullable } from "../sql/sqlState.js";
import {
  READ_CONFIRMED_VISIBLE_REVISION_SQL,
  UPSERT_VISIBLE_FIELD_STATE_SQL,
  UPSERT_VISIBLE_STATE_SQL,
} from "./outboxSql.js";
import type {
  ApplyResultOptions,
  EffectProjectionConfirmation,
} from "../contract/contracts.js";
import type {
  SqlExecutor,
  SqlRow,
} from "../sql/sql.js";

const READ_CLAIMED_EFFECT_TARGET_SQL = `
  SELECT effect_kind, physical_sheet_id, projection, row_binding_id
  FROM sheet_effect_outbox
  WHERE effect_id = ? AND claim_token = ? AND status = 'processing'
`;

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
    typeof confirmation.deleteRetention !== "boolean" ||
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

function throwInvalidPendingEffect(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_PENDING_EFFECT, message);
}

export function validateApplyResultOptions(options: ApplyResultOptions): void {
  if (!isTerminalEffectStatus(options.status)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_RESULT,
      `effect result status ${String(options.status)} is not terminal`,
    );
  }
  if (options.status !== OUTBOX_EFFECT_STATUSES.APPLIED && options.projectionConfirmation !== undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_RESULT,
      "only an applied effect may advance confirmed projection state",
    );
  }
  if (options.projectionConfirmation !== undefined) {
    validateProjectionConfirmation(options.projectionConfirmation);
  }
}

function isTerminalEffectStatus(value: unknown): value is Exclude<OutboxEffectStatus, "pending" | "processing"> {
  return value === OUTBOX_EFFECT_STATUSES.APPLIED ||
    value === OUTBOX_EFFECT_STATUSES.BLOCKED_CANDIDATE ||
    value === OUTBOX_EFFECT_STATUSES.SUPERSEDED ||
    value === OUTBOX_EFFECT_STATUSES.CONFLICT ||
    value === OUTBOX_EFFECT_STATUSES.FAILED;
}

/**
 * Verifies that read-back evidence belongs to the effect currently being applied.
 *
 * The belonging check reads the durable outbox row, never the untrusted
 * provider receipt or payload. The claimed row's operation kind is validated
 * as known (fail-closed on corruption) but never branched on: revision rules
 * travel on the confirmation itself (`deleteRetention`,
 * `allowCreateRebaseline`), declared by the dispatcher-owned worker path.
 */
export async function assertProjectionConfirmationTargetWithSql(
  sql: SqlExecutor,
  effectId: string,
  claimToken: string,
  confirmation: EffectProjectionConfirmation,
): Promise<void> {
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
  requireKnownEffectKind(row.effect_kind, "claimed effect kind");
}

function requireKnownEffectKind(value: unknown, label: string): OutboxEffectKind {
  if (value === OUTBOX_EFFECT_KINDS.SYSTEM_PROJECTION ||
      value === OUTBOX_EFFECT_KINDS.CANDIDATE_RECONCILE ||
      value === OUTBOX_EFFECT_KINDS.SYSTEM_REPAIR ||
      value === OUTBOX_EFFECT_KINDS.RESOLUTION_PROJECTION ||
      value === OUTBOX_EFFECT_KINDS.RESOLUTION_DELETE ||
      value === OUTBOX_EFFECT_KINDS.USER_INPUT_DELETE) return value;
  throwInvalidPendingEffect(`${label} is unsupported`);
}

/**
 * Writes confirmed row and field state through the active async SQL context.
 *
 * The confirmation's dispatcher-declared rules select the visible-revision
 * resolution (delete monotonic retention, create-if-missing rebase, or
 * strict backwards rejection).
 */
export async function writeProjectionConfirmationWithSql(
  sql: SqlExecutor,
  confirmation: EffectProjectionConfirmation,
): Promise<void> {
  const visibleRevision = await resolveConfirmationVisibleRevisionWithSql(sql, confirmation);
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
 * - Delete-lifecycle effects (dispatcher-declared `deleteRetention`, never
 *   the receipt) read back the pre-delete provider revision, which can be lower than the
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
): Promise<number> {
  const isDelete = confirmation.deleteRetention;
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
