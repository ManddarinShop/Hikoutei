/** Runtime decoder for optional phase timing returned by Code.gs. */

import {
  SYNC_TIMING_OPERATION_KINDS,
  type SyncGatewayTiming,
  type SyncTimingOperationKind,
} from "../../../../../application/sync/telemetry/syncTiming.js";
import { SYNC_GATEWAY_ERROR_CODES } from "../../../../../application/sync/gateway/errors.js";
import {
  requireSyncGatewayNonNegativeSafeInteger,
  requireSyncGatewayText,
} from "../../../../../application/sync/gateway/validation.js";
import { isRecord } from "../../../../../shared/encoding/typeGuards.js";
import { invalidOperationResponse } from "../errors.js";

/** Promotes an untrusted gateway timing object into the typed diagnostics contract. */
export function decodeOptionalSyncGatewayTiming(
  value: unknown,
  label: string,
): SyncGatewayTiming | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, label);
  if (!Array.isArray(record.operationKinds) || !Array.isArray(record.phases)) {
    return invalidOperationResponse(
      "Apps Script timing",
      label + " must contain operationKinds and phases",
    );
  }
  const operationKinds = record.operationKinds.map((kind, index) => {
    const text = requireSyncGatewayText(
      kind,
      label + ".operationKinds[" + index + "]",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    );
    if (!isTimingOperationKind(text)) {
      return invalidOperationResponse(
        "Apps Script timing",
        label + " contains an unsupported operation kind",
      );
    }
    return text;
  });
  const counts = requireRecord(record.operationCounts, label + ".operationCounts");
  const operationCounts = {
    append: requireCount(counts.append, label + ".operationCounts.append"),
    update: requireCount(counts.update, label + ".operationCounts.update"),
    delete: requireCount(counts.delete, label + ".operationCounts.delete"),
  } as const;
  const phases = record.phases.map((phase, index) => {
    const phaseRecord = requireRecord(phase, label + ".phases[" + index + "]");
    return {
      phase: requireSyncGatewayText(
        phaseRecord.phase,
        label + ".phases[" + index + "].phase",
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
      ),
      durationMs: requireCount(
        phaseRecord.durationMs,
        label + ".phases[" + index + "].durationMs",
      ),
    };
  });
  return {
    operationKinds,
    operationCounts,
    durationMs: requireCount(record.durationMs, label + ".durationMs"),
    phases,
  };
}

function requireCount(value: unknown, label: string): number {
  return requireSyncGatewayNonNegativeSafeInteger(
    value,
    label,
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
}

function isTimingOperationKind(value: string): value is SyncTimingOperationKind {
  return Object.values(SYNC_TIMING_OPERATION_KINDS).includes(
    value as SyncTimingOperationKind,
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalidOperationResponse("Apps Script timing", label + " must be an object");
  }
  return value as Record<string, unknown>;
}
