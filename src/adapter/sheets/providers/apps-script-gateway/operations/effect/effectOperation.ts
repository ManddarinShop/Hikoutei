/** Thin-Gateway operations for regular projection effects and recovery reads. */

import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  SyncEffectPostcondition,
  SyncGatewayAuthority,
  SyncGatewayEffect,
  SyncGatewayEffectPostconditionResult,
  SyncGatewayEffectResult,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import {
  SYNC_GATEWAY_EFFECT_RESULT_STATUSES,
  SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS,
  SYNC_GATEWAY_POSTCONDITION_STATUSES,
} from "../../../../../../application/sync/gateway/constants.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
} from "../../../../../../application/sync/gateway/errors.js";
import {
  decodeSyncGatewayPresenceNonNegativeSafeInteger as decodePresenceNonNegativeInteger,
  decodeSyncGatewayPresenceString as decodePresenceString,
  requireSyncGatewayNonNegativeSafeInteger,
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayText,
} from "../../../../../../application/sync/gateway/validation.js";
import type { AppsScriptOperationDefinition } from "../../transport/operationClient.js";
import { decodeOptionalSyncGatewayTiming } from "../../protocol/timing.js";
import {
  invalidOperationRequest,
  invalidOperationResponse,
} from "../../errors.js";
import { requireOperationRecord } from "../../validation.js";
import { EFFECT_OPERATION_SOURCE } from "./effectOperationScript.js";

const EFFECT_OPERATION_MODES = {
  APPLY: "applyEffects",
  READ_ONE: "readEffectPostcondition",
  READ_BATCH: "readEffectPostconditions",
} as const;

interface EffectOperationRouteOptions {
  readonly identityField?: string;
  readonly checkboxHeaders?: readonly string[];
}

export type AppsScriptApplyEffectsOperationRequest = ApplySyncEffectsRequest &
  EffectOperationRouteOptions;

export type AppsScriptApplyEffectsOperationArgs = {
  readonly mode: typeof EFFECT_OPERATION_MODES.APPLY;
} & AppsScriptApplyEffectsOperationRequest;

export type AppsScriptReadEffectPostconditionOperationArgs = {
  readonly mode: typeof EFFECT_OPERATION_MODES.READ_ONE;
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: ApplySyncEffectsRequest["projection"];
  readonly schemaVersion: number;
  readonly authority?: SyncGatewayAuthority;
  readonly effect: SyncGatewayEffect;
} & EffectOperationRouteOptions;

export type AppsScriptReadEffectPostconditionsOperationArgs = {
  readonly mode: typeof EFFECT_OPERATION_MODES.READ_BATCH;
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: ApplySyncEffectsRequest["projection"];
  readonly schemaVersion: number;
  readonly authority?: SyncGatewayAuthority;
  readonly effects: readonly SyncGatewayEffect[];
} & EffectOperationRouteOptions;

/** Builds the regular update/delete operation executed by the thin Gateway. */
export function createApplyEffectsOperation(
  request: AppsScriptApplyEffectsOperationRequest,
): AppsScriptOperationDefinition<AppsScriptApplyEffectsOperationArgs, ApplySyncEffectsResult> {
  validateEffectRequest(request);
  return {
    fn: EFFECT_OPERATION_SOURCE,
    args: { mode: EFFECT_OPERATION_MODES.APPLY, ...request },
    decode: (value) => decodeApplyEffectsResult(value, request.effects),
  };
}

/** Builds the single-effect response-loss probe. */
export function createReadEffectPostconditionOperation(
  request: Omit<AppsScriptReadEffectPostconditionOperationArgs, "mode">,
): AppsScriptOperationDefinition<
  AppsScriptReadEffectPostconditionOperationArgs,
  SyncEffectPostcondition
> {
  validateEffectRequest(request);
  return {
    fn: EFFECT_OPERATION_SOURCE,
    args: { mode: EFFECT_OPERATION_MODES.READ_ONE, ...request },
    decode: decodePostcondition,
  };
}

/** Builds the batched response-loss probe used by the worker. */
export function createReadEffectPostconditionsOperation(
  request: Omit<AppsScriptReadEffectPostconditionsOperationArgs, "mode">,
): AppsScriptOperationDefinition<
  AppsScriptReadEffectPostconditionsOperationArgs,
  readonly SyncGatewayEffectPostconditionResult[]
> {
  validateEffectRequest(request);
  return {
    fn: EFFECT_OPERATION_SOURCE,
    args: { mode: EFFECT_OPERATION_MODES.READ_BATCH, ...request },
    decode: (value) => decodePostconditionBatch(value, request.effects),
  };
}

function validateEffectRequest(
  request:
    | AppsScriptApplyEffectsOperationRequest
    | Omit<AppsScriptReadEffectPostconditionOperationArgs, "mode">
    | Omit<AppsScriptReadEffectPostconditionsOperationArgs, "mode">,
): void {
  if (request.authority !== undefined &&
      (!Number.isSafeInteger(request.authority.epoch) || request.authority.epoch < 1 ||
        request.authority.token.trim().length === 0)) {
    invalidOperationRequest("Apps Script effect operation", "authority is invalid");
  }
  requireSyncGatewayText(
    request.physicalSheetId,
    "Apps Script effect physicalSheetId",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayText(
    request.sheetName,
    "Apps Script effect sheetName",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayText(
    request.registeredRange,
    "Apps Script effect registeredRange",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayPositiveSafeInteger(
    request.schemaVersion,
    "Apps Script effect schemaVersion",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  if (request.identityField !== undefined) {
    requireSyncGatewayText(
      request.identityField,
      "Apps Script effect identityField",
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    );
  }
  if (request.checkboxHeaders !== undefined && !Array.isArray(request.checkboxHeaders)) {
    invalidOperationRequest(
      "Apps Script effect operation",
      "checkboxHeaders must be an array",
    );
  }
}

function decodeApplyEffectsResult(
  value: unknown,
  expectedEffects: readonly SyncGatewayEffect[],
): ApplySyncEffectsResult {
  const record = requireRecord(value, "effect result");
  if (!Array.isArray(record.results) || typeof record.hasMore !== "boolean") {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "result must contain results and hasMore",
    );
  }
  if (
    record.results.length > expectedEffects.length ||
    (!record.hasMore && record.results.length !== expectedEffects.length) ||
    (record.hasMore && record.results.length >= expectedEffects.length)
  ) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "result contains an invalid bounded effect prefix",
    );
  }
  const timing = decodeOptionalSyncGatewayTiming(record.timing, "effect timing");
  const results = record.results.map((entry, index) => decodeEffectResult(entry, index));
  assertOrderedEffectEvidence(results, expectedEffects, "effect result");
  const result: ApplySyncEffectsResult = {
    results,
    snapshotHash: decodePresenceString(record.snapshotHash, "effect result snapshotHash"),
    hasMore: record.hasMore,
  };
  return timing === undefined ? result : { ...result, timing };
}

function decodeEffectResult(value: unknown, index: number): SyncGatewayEffectResult {
  const resultLabel = effectResultLabel(index);
  const record = requireRecord(value, resultLabel);
  const status = requireSyncGatewayText(
    record.status,
    effectResultLabel(index, "status"),
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  if (!isEffectResultStatus(status)) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      resultLabel + " has an unsupported status",
    );
  }
  const postcondition = requireSyncGatewayText(
    record.postcondition,
    effectResultLabel(index, "postcondition"),
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  if (!isPostconditionStatus(postcondition)) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      resultLabel + " has an unsupported postcondition",
    );
  }
  return {
    effectId: requireSyncGatewayText(
      record.effectId,
      effectResultLabel(index, "effectId"),
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    payloadHash: requireSyncGatewayText(
      record.payloadHash,
      effectResultLabel(index, "payloadHash"),
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    status,
    visibleRevision: decodePresenceNonNegativeInteger(
      record.visibleRevision,
      effectResultLabel(index, "visibleRevision"),
    ),
    visibleHash: decodePresenceString(
      record.visibleHash,
      effectResultLabel(index, "visibleHash"),
    ),
    snapshotHash: decodePresenceString(
      record.snapshotHash,
      effectResultLabel(index, "snapshotHash"),
    ),
    reason: decodePresenceString(record.reason, effectResultLabel(index, "reason")),
    postcondition,
  };
}

function decodePostconditionBatch(
  value: unknown,
  expectedEffects: readonly SyncGatewayEffect[],
): readonly SyncGatewayEffectPostconditionResult[] {
  const record = requireRecord(value, "postcondition batch result");
  if (!Array.isArray(record.results)) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "postcondition batch result must contain results",
    );
  }
  if (record.results.length !== expectedEffects.length) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "postcondition batch result count does not match the submitted effects",
    );
  }
  const results = record.results.map((entry, index) => {
    const resultLabel = postconditionResultLabel(index);
    const result = requireRecord(entry, resultLabel);
    return {
      effectId: requireSyncGatewayText(
        result.effectId,
        postconditionResultLabel(index, "effectId"),
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
      ),
      payloadHash: requireSyncGatewayText(
        result.payloadHash,
        postconditionResultLabel(index, "payloadHash"),
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
      ),
      postcondition: decodePostcondition(result.postcondition),
    };
  });
  assertOrderedEffectEvidence(results, expectedEffects, "postcondition result");
  return results;
}

interface OrderedEffectEvidence {
  readonly effectId: string;
  readonly payloadHash: string;
}

function assertOrderedEffectEvidence<T extends OrderedEffectEvidence>(
  results: readonly T[],
  expectedEffects: readonly SyncGatewayEffect[],
  label: string,
): void {
  const seen = new Set<string>();
  results.forEach((result, index) => {
    const expected = expectedEffects[index];
    if (
      expected === undefined ||
      result.effectId !== expected.effectId ||
      result.payloadHash !== expected.payloadHash ||
      seen.has(result.effectId)
    ) {
      invalidOperationResponse(
        "Apps Script effect operation",
        `${label}[${index}] does not match the submitted effect order or evidence`,
      );
    }
    seen.add(result.effectId);
  });
}

function effectResultLabel(index: number, field?: string): string {
  const label = `effect result[${index}]`;
  return field === undefined ? label : `${label}.${field}`;
}

function postconditionResultLabel(index: number, field?: string): string {
  const label = `postcondition result[${index}]`;
  return field === undefined ? label : `${label}.${field}`;
}

function decodePostcondition(value: unknown): SyncEffectPostcondition {
  const record = requireRecord(value, "postcondition");
  const disposition = requireSyncGatewayText(
    record.disposition,
    "postcondition disposition",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  if (!isPostconditionDisposition(disposition)) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "postcondition disposition is unsupported",
    );
  }
  const reason = record.reason === undefined || record.reason === null
    ? undefined
    : requireSyncGatewayText(
      record.reason,
      "postcondition reason",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    );
  return {
    disposition,
    visibleRevision: decodePresenceNonNegativeInteger(
      record.visibleRevision,
      "postcondition visibleRevision",
    ),
    visibleHash: decodePresenceString(record.visibleHash, "postcondition visibleHash"),
    snapshotHash: decodePresenceString(record.snapshotHash, "postcondition snapshotHash"),
    ...(reason === undefined ? {} : { reason }),
  };
}


function isEffectResultStatus(value: string): value is SyncGatewayEffectResult["status"] {
  return value === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED ||
    value === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED ||
    value === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SUPERSEDED ||
    value === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH ||
    value === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE ||
    value === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR ||
    value === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.RETRYABLE_ERROR;
}

function isPostconditionStatus(value: string): value is SyncGatewayEffectResult["postcondition"] {
  return value === SYNC_GATEWAY_POSTCONDITION_STATUSES.VERIFIED ||
    value === SYNC_GATEWAY_POSTCONDITION_STATUSES.ACKNOWLEDGED ||
    value === SYNC_GATEWAY_POSTCONDITION_STATUSES.UNAVAILABLE;
}

function isPostconditionDisposition(
  value: string,
): value is SyncEffectPostcondition["disposition"] {
  return value === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED ||
    value === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED ||
    value === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED ||
    value === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAVAILABLE;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  return requireOperationRecord(value, label, "Apps Script effect operation");
}
