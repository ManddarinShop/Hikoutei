/**
 * Deterministic outbox payload builders for all v1 Sheet projections.
 *
 * The public repository never exposes insert/update/delete mechanics here.
 * These helpers translate a writer-approved canonical/candidate/resolution
 * decision into one immutable effect payload; the effect worker later performs
 * the remote compare-and-set through the provider.
 */

import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "@hikoutei/contracts/constants.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type { EffectTargetKind } from "@hikoutei/contracts/domain/model/constants.js";
import type {
  Applicability,
  Presence,
} from "@hikoutei/contracts/state/types.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
  absentValue,
  applicableValue,
  notApplicableValue,
} from "@hikoutei/contracts/state/index.js";
import {
  SYNC_DELETE_EFFECT_KINDS,
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
  type SyncEffectKind,
  type SyncProjection,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "@hikoutei/storage/storage/errors.js";
import type { NewEffect } from "@hikoutei/ikisaki";

const PROJECTION_EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: SYNC_DELETE_EFFECT_KINDS.RESOLUTION_DELETE,
  USER_INPUT_DELETE: SYNC_DELETE_EFFECT_KINDS.USER_INPUT_DELETE,
} as const satisfies Record<string, SyncEffectKind>;

const PROJECTION_TARGET_KINDS = {
  ENTITY: "entity",
  ROW_BINDING: "row_binding",
  PROJECTION_ROW: "projection_row",
  CONFLICT: "conflict",
} as const satisfies Record<string, EffectTargetKind>;

const EMPTY_VISIBLE_HASH = "";

/** Common immutable coordinates of a writer-approved projection effect. */
export interface ProjectionEffectInput {
  readonly effectId: string;
  readonly effectKind: SyncEffectKind;
  readonly commitId: string;
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly rowBindingId: Presence<string>;
  readonly conflictId: Presence<string>;
  readonly targetAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly createIfMissing: boolean;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly expectedCandidateHash?: Applicability<string>;
  readonly repairGuardHash?: Presence<string>;
  readonly sourceQuarantineId?: Presence<string>;
  readonly targetEntityRevision?: Applicability<number>;
  readonly targetFieldRevisionHash?: Applicability<string>;
  readonly targetCanonicalCommitId?: Applicability<string>;
  readonly streamSequence: number;
}

/** Input for a System_State projection effect. */
export type SystemProjectionEffectInput = Omit<ProjectionEffectInput, "effectKind">;

/** Input for a User_Input candidate reconciliation effect. */
export type CandidateReconcileEffectInput =
  Omit<ProjectionEffectInput, "effectKind" | "projection"> & {
    readonly projection?: typeof SYNC_PROJECTIONS.USER_INPUT;
  };

/** Input for a guarded physical deletion from a User_Input projection. */
export type UserInputDeleteEffectInput =
  Omit<ProjectionEffectInput, "effectKind" | "projection"> & {
    readonly projection?: typeof SYNC_PROJECTIONS.USER_INPUT;
  };

/** Shared input for effects projected to the Sync_Conflicts control sheet. */
export type ResolutionEffectInput =
  Omit<ProjectionEffectInput, "effectKind" | "projection" | "targetKind"> & {
    readonly projection?: typeof SYNC_PROJECTIONS.SYNC_CONFLICTS;
  };

/** Builds an immutable outbox row, including stable payload/dedupe identities. */
export function createProjectionEffect(input: ProjectionEffectInput): NewEffect {
  validateInput(input);
  const targetVisibleHash = computeSyncVisibleHash(input.fields);
  if (isProjectionDeletionEffect(input.effectKind) && targetVisibleHash !== input.expectedVisibleHash) {
    throwEffectError("projection deletion requires the full current visible hash");
  }
  const expectedCandidateHash = input.expectedCandidateHash ?? notApplicableValue();
  const targetEntityRevision = input.targetEntityRevision ?? notApplicableValue();
  const targetFieldRevisionHash = input.targetFieldRevisionHash ?? notApplicableValue();
  const targetCanonicalCommitId = input.targetCanonicalCommitId ?? applicableValue(input.commitId);
  const repairGuardHash = input.repairGuardHash ?? absentValue();
  const sourceQuarantineId = input.sourceQuarantineId ?? absentValue();
  const payloadJson = serializeSyncProjectionEffectPayload({
    sheetName: input.sheetName,
    registeredRange: input.registeredRange,
    schemaVersion: input.schemaVersion,
    targetAnchor: input.targetAnchor,
    fields: input.fields,
    targetVisibleHash,
    createIfMissing: input.createIfMissing,
    expectedCandidateHash,
  });
  const payloadHash = stableHash({ payloadJson });
  return {
    effectId: input.effectId,
    effectKind: input.effectKind,
    commitId: input.commitId,
    logicalSheetId: input.logicalSheetId,
    physicalSheetId: input.physicalSheetId,
    projection: input.projection,
    rowBindingId: input.rowBindingId,
    conflictId: input.conflictId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    targetEntityRevision,
    targetFieldRevisionHash,
    targetCanonicalCommitId,
    expectedVisibleRevision: input.expectedVisibleRevision,
    expectedVisibleHash: input.expectedVisibleHash,
    repairGuardHash,
    sourceQuarantineId,
    payloadJson,
    payloadHash,
    effectDedupeKey: stableHash({
      effectKind: input.effectKind,
      logicalSheetId: input.logicalSheetId,
      physicalSheetId: input.physicalSheetId,
      projection: input.projection,
      targetKind: input.targetKind,
      targetId: input.targetId,
      targetCanonicalCommitId: stableApplicabilityValue(targetCanonicalCommitId),
      payloadHash,
    }),
    streamSequence: input.streamSequence,
  };
}

/** Creates a canonical System_State projection effect. */
export function createSystemProjectionEffect(
  input: SystemProjectionEffectInput,
): NewEffect {
  if (input.projection !== SYNC_PROJECTIONS.SYSTEM_STATE) {
    throwEffectError("system projection must target system_state");
  }
  return createProjectionEffect({
    ...input,
    effectKind: PROJECTION_EFFECT_KINDS.SYSTEM_PROJECTION,
  });
}

/** Creates a baseline-CAS User_Input reconcile that cannot overwrite a candidate. */
export function createCandidateReconcileEffect(
  input: CandidateReconcileEffectInput,
): NewEffect {
  return createProjectionEffect({
    ...input,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    effectKind: PROJECTION_EFFECT_KINDS.CANDIDATE_RECONCILE,
  });
}

/**
 * Creates a full-row, candidate-preserving deletion for one User_Input row.
 *
 * The payload must represent the exact current visible row. The provider can
 * therefore remove only the anchored row that the canonical delete observed,
 * while the worker blocks the effect if an unresolved user candidate exists.
 */
export function createUserInputDeleteEffect(
  input: UserInputDeleteEffectInput,
): NewEffect {
  return createProjectionEffect({
    ...input,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    effectKind: PROJECTION_EFFECT_KINDS.USER_INPUT_DELETE,
  });
}

/** Creates a guard-specific repair effect; caller must preserve the quarantine link. */
export function createSystemRepairEffect(
  input: Omit<ProjectionEffectInput, "effectKind">,
): NewEffect {
  requireNonEmptyPresence(input.repairGuardHash, "system repair requires a non-empty repairGuardHash");
  requireNonEmptyPresence(input.sourceQuarantineId, "system repair requires a sourceQuarantineId");
  return createProjectionEffect({
    ...input,
    effectKind: PROJECTION_EFFECT_KINDS.SYSTEM_REPAIR,
  });
}

/** Creates the system-owned Sync_Conflicts control-row projection effect. */
export function createResolutionProjectionEffect(
  input: ResolutionEffectInput,
): NewEffect {
  requireConflictTarget(input.conflictId, input.targetId, "resolution projection must target exactly one conflict ID");
  return createProjectionEffect({
    ...input,
    projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
    targetKind: PROJECTION_TARGET_KINDS.CONFLICT,
    effectKind: PROJECTION_EFFECT_KINDS.RESOLUTION_PROJECTION,
  });
}

/**
 * Creates a guarded deletion for one resolved system-owned conflict row.
 *
 * The payload carries the full currently visible conflict row as the expected
 * state. The provider therefore deletes only the exact anchored row that the
 * resolver observed; it never deletes by mutable sheet row number.
 */
export function createResolutionDeleteEffect(
  input: ResolutionEffectInput,
): NewEffect {
  requireConflictTarget(input.conflictId, input.targetId, "resolution deletion must target exactly one conflict ID");
  return createProjectionEffect({
    ...input,
    projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
    targetKind: PROJECTION_TARGET_KINDS.CONFLICT,
    effectKind: PROJECTION_EFFECT_KINDS.RESOLUTION_DELETE,
  });
}

function validateInput(input: ProjectionEffectInput): void {
  for (const [label, value] of [
    ["effect ID", input.effectId],
    ["commit ID", input.commitId],
    ["logical sheet ID", input.logicalSheetId],
    ["physical sheet ID", input.physicalSheetId],
    ["sheet name", input.sheetName],
    ["registered range", input.registeredRange],
    ["target ID", input.targetId],
    ["target anchor", input.targetAnchor],
  ] as const) {
    requireNonEmptyText(value, label);
  }
  if (
    !Number.isSafeInteger(input.schemaVersion) ||
    input.schemaVersion < POSITIVE_SAFE_INTEGER_MINIMUM ||
    !Number.isSafeInteger(input.expectedVisibleRevision) ||
    input.expectedVisibleRevision < NON_NEGATIVE_SAFE_INTEGER_MINIMUM ||
    !Number.isSafeInteger(input.streamSequence) ||
    input.streamSequence < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwEffectError("projection effect has an invalid schema, visible revision, or stream sequence");
  }
  if (input.createIfMissing) {
    if (
      input.expectedVisibleRevision !== NON_NEGATIVE_SAFE_INTEGER_MINIMUM ||
      input.expectedVisibleHash !== EMPTY_VISIBLE_HASH
    ) {
      throwEffectError("new projection rows require an empty visible baseline");
    }
  } else if (input.expectedVisibleHash.length === EMPTY_STRING_LENGTH_ZERO) {
    throwEffectError("existing projection effects require an expected visible hash");
  }
  if (Object.keys(input.fields).length === EMPTY_ARRAY_LENGTH_ZERO) {
    throwEffectError("projection effect must contain fields");
  }
  if (
    input.effectKind === PROJECTION_EFFECT_KINDS.CANDIDATE_RECONCILE &&
    input.projection !== SYNC_PROJECTIONS.USER_INPUT
  ) {
    throwEffectError("candidate reconcile must target user_input");
  }
  if (
    (input.effectKind === PROJECTION_EFFECT_KINDS.RESOLUTION_PROJECTION ||
      input.effectKind === PROJECTION_EFFECT_KINDS.RESOLUTION_DELETE) &&
    input.projection !== SYNC_PROJECTIONS.SYNC_CONFLICTS
  ) {
    throwEffectError("resolution projection must target sync_conflicts");
  }
  if (
    isProjectionDeletionEffect(input.effectKind) &&
    (input.createIfMissing || input.expectedVisibleRevision < POSITIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throwEffectError("projection deletion requires an existing visible row");
  }
  if (
    input.effectKind === PROJECTION_EFFECT_KINDS.USER_INPUT_DELETE &&
    (
      input.projection !== SYNC_PROJECTIONS.USER_INPUT ||
      input.targetKind !== PROJECTION_TARGET_KINDS.PROJECTION_ROW
    )
  ) {
    throwEffectError("user input deletion must target one User_Input projection row");
  }
  if (
    input.rowBindingId.kind === PRESENCE_KINDS.ABSENT &&
    input.targetKind !== PROJECTION_TARGET_KINDS.CONFLICT &&
    // Orphan/empty-ID User_Input deletes have no real binding to protect or
    // confirm; the outbox row binding stays NULL and the worker writes no
    // projection confirmation for a binding that does not exist.
    input.effectKind !== PROJECTION_EFFECT_KINDS.USER_INPUT_DELETE
  ) {
    throwEffectError("non-conflict projection effect requires a row binding ID");
  }
}

function requireNonEmptyText(value: string, label: string): void {
  if (value.length === EMPTY_STRING_LENGTH_ZERO) {
    throwEffectError(`${label} is required`);
  }
}

function requireNonEmptyPresence(
  value: Presence<string> | undefined,
  message: string,
): string {
  if (value?.kind !== PRESENCE_KINDS.PRESENT || value.value.length === EMPTY_STRING_LENGTH_ZERO) {
    throwEffectError(message);
  }
  return value.value;
}

function requireConflictTarget(
  conflictId: Presence<string>,
  targetId: string,
  message: string,
): string {
  const value = requireNonEmptyPresence(conflictId, message);
  if (targetId !== value) throwEffectError(message);
  return value;
}

function stableApplicabilityValue<T>(value: Applicability<T>): T | null {
  return value.kind === APPLICABILITY_KINDS.APPLICABLE ? value.value : null;
}

function isProjectionDeletionEffect(effectKind: SyncEffectKind): boolean {
  return effectKind === PROJECTION_EFFECT_KINDS.RESOLUTION_DELETE ||
    effectKind === PROJECTION_EFFECT_KINDS.USER_INPUT_DELETE;
}

function throwEffectError(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS, message);
}
