import { JAVASCRIPT_TYPE_NAMES } from "../../../shared/encoding/constants.js";
import {
  absentValue,
  presentValue,
} from "../../../shared/state/index.js";
import type { Presence } from "../../../shared/state/types.js";
import { isJavaScriptType } from "../../../shared/encoding/typeGuards.js";
import {
  isNonEmptyList,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from "../../../shared/validation.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
  type SyncGatewayProjection,
  type SyncGatewayProtocolVersion,
  type SyncGatewaySnapshotReadMode,
} from "./constants.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
  type SyncGatewayErrorCode,
} from "./errors.js";

/** Requires a non-empty string at a gateway contract boundary. */
export function requireSyncGatewayText(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): string {
  if (!isNonEmptyString(value)) {
    throw new SyncGatewayContractError(errorCode, `${label} is required`);
  }
  return value;
}

/** Requires a positive safe integer at a gateway contract boundary. */
export function requireSyncGatewayPositiveSafeInteger(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): number {
  if (!isPositiveSafeInteger(value)) {
    throw new SyncGatewayContractError(
      errorCode,
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

/** Requires a non-negative safe integer at a gateway contract boundary. */
export function requireSyncGatewayNonNegativeSafeInteger(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new SyncGatewayContractError(
      errorCode,
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

/** Decodes an optional text value returned by the runtime gateway. */
export function decodeSyncGatewayPresenceString(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode = SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
): Presence<string> {
  if (value === null) return absentValue();
  return presentValue(requireSyncGatewayText(value, label, errorCode));
}

/** Decodes an optional non-negative revision returned by the runtime gateway. */
export function decodeSyncGatewayPresenceNonNegativeSafeInteger(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode = SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
): Presence<number> {
  if (value === null) return absentValue();
  return presentValue(requireSyncGatewayNonNegativeSafeInteger(value, label, errorCode));
}

/** Requires a protocol version returned by the runtime gateway. */
export function requireSyncGatewayProtocolVersion(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): SyncGatewayProtocolVersion {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    value !== SYNC_GATEWAY_PROTOCOL_VERSIONS.V1
  ) {
    throw new SyncGatewayContractError(
      errorCode,
      `${label} is not supported`,
    );
  }
  return value;
}

/** Requires a projection label returned by the runtime gateway. */
export function requireSyncGatewayProjection(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): SyncGatewayProjection {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    !isSyncGatewayProjection(value)
  ) {
    throw new SyncGatewayContractError(
      errorCode,
      `${label} is not supported`,
    );
  }
  return value;
}

/** Requires a supported snapshot detail level at a gateway boundary. */
export function requireSyncGatewaySnapshotReadMode(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): SyncGatewaySnapshotReadMode {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    !Object.values(SYNC_GATEWAY_SNAPSHOT_READ_MODES).includes(
      value as SyncGatewaySnapshotReadMode,
    )
  ) {
    throw new SyncGatewayContractError(
      errorCode,
      `${label} is not supported`,
    );
  }
  return value as SyncGatewaySnapshotReadMode;
}

/** Requires a non-empty list at a gateway contract boundary. */
export function requireSyncGatewayNonEmptyList<T>(
  values: readonly T[],
  label: string,
  errorCode: SyncGatewayErrorCode,
): void {
  if (!isNonEmptyList(values)) {
    throw new SyncGatewayContractError(errorCode, `${label} requires at least one item`);
  }
}

function isSyncGatewayProjection(value: string): value is SyncGatewayProjection {
  return Object.values(SYNC_GATEWAY_PROJECTIONS).includes(
    value as SyncGatewayProjection,
  );
}
