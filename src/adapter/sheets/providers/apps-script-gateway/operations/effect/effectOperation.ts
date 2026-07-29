/** Thin-Gateway operations for regular projection effects and recovery reads. */

import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  SyncEffectPostcondition,
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
  requireSyncGatewayNonNegativeSafeInteger,
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayText,
} from "../../../../../../application/sync/gateway/validation.js";
import { PRESENCE_KINDS } from "../../../../../../shared/state/constants.js";
import type { Presence } from "../../../../../../shared/state/types.js";
import { isRecord } from "../../../../../../shared/encoding/typeGuards.js";
import type { AppsScriptOperationDefinition } from "../../transport/operationClient.js";
import { decodeOptionalSyncGatewayTiming } from "../../protocol/timing.js";
import {
  invalidOperationRequest,
  invalidOperationResponse,
} from "../../errors.js";
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
  readonly effect: SyncGatewayEffect;
} & EffectOperationRouteOptions;

export type AppsScriptReadEffectPostconditionsOperationArgs = {
  readonly mode: typeof EFFECT_OPERATION_MODES.READ_BATCH;
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: ApplySyncEffectsRequest["projection"];
  readonly schemaVersion: number;
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
    decode: (value) => decodeApplyEffectsResult(value, request.effects.length),
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
    decode: decodePostconditionBatch,
  };
}

function validateEffectRequest(
  request:
    | AppsScriptApplyEffectsOperationRequest
    | Omit<AppsScriptReadEffectPostconditionOperationArgs, "mode">
    | Omit<AppsScriptReadEffectPostconditionsOperationArgs, "mode">,
): void {
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

function decodeApplyEffectsResult(value: unknown, expectedCount: number): ApplySyncEffectsResult {
  const record = requireRecord(value, "effect result");
  if (!Array.isArray(record.results) || typeof record.hasMore !== "boolean") {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "result must contain results and hasMore",
    );
  }
  if (
    record.results.length > expectedCount ||
    (!record.hasMore && record.results.length !== expectedCount) ||
    (record.hasMore && record.results.length >= expectedCount)
  ) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "result contains an invalid bounded effect prefix",
    );
  }
  const timing = decodeOptionalSyncGatewayTiming(record.timing, "effect timing");
  const result: ApplySyncEffectsResult = {
    results: record.results.map((entry, index) => decodeEffectResult(entry, index)),
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
    reason: decodePresenceString(record.reason, effectResultLabel(index, "reason")),
    postcondition,
  };
}

function decodePostconditionBatch(value: unknown): readonly SyncGatewayEffectPostconditionResult[] {
  const record = requireRecord(value, "postcondition batch result");
  if (!Array.isArray(record.results)) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      "postcondition batch result must contain results",
    );
  }
  return record.results.map((entry, index) => {
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
  return {
    disposition,
    visibleRevision: decodePresenceNonNegativeInteger(
      record.visibleRevision,
      "postcondition visibleRevision",
    ),
    visibleHash: decodePresenceString(record.visibleHash, "postcondition visibleHash"),
  };
}

function decodePresenceString(value: unknown, label: string): Presence<string> {
  if (value === null) return { kind: PRESENCE_KINDS.ABSENT };
  return {
    kind: PRESENCE_KINDS.PRESENT,
    value: requireSyncGatewayText(
      value,
      label,
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
  };
}

function decodePresenceNonNegativeInteger(value: unknown, label: string): Presence<number> {
  if (value === null) return { kind: PRESENCE_KINDS.ABSENT };
  return {
    kind: PRESENCE_KINDS.PRESENT,
    value: requireSyncGatewayNonNegativeSafeInteger(
      value,
      label,
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
  };
}

function isEffectResultStatus(value: string): value is SyncGatewayEffectResult["status"] {
  return Object.values(SYNC_GATEWAY_EFFECT_RESULT_STATUSES).includes(
    value as SyncGatewayEffectResult["status"],
  );
}

function isPostconditionStatus(value: string): value is SyncGatewayEffectResult["postcondition"] {
  return Object.values(SYNC_GATEWAY_POSTCONDITION_STATUSES).includes(
    value as SyncGatewayEffectResult["postcondition"],
  );
}

function isPostconditionDisposition(
  value: string,
): value is SyncEffectPostcondition["disposition"] {
  return Object.values(SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS).includes(
    value as SyncEffectPostcondition["disposition"],
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalidOperationResponse(
      "Apps Script effect operation",
      label + " must be an object",
    );
  }
  return value as Record<string, unknown>;
}
