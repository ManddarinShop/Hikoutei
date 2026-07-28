import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../../shared/constants.js";
import { JAVASCRIPT_TYPE_NAMES } from "../../../shared/encoding/constants.js";
import { isJavaScriptType } from "../../../shared/encoding/typeGuards.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
  type SyncGatewayProjection,
  type SyncGatewayProtocolVersion,
  type SyncGatewaySnapshotReadMode,
} from "./constants.js";
import {
  SyncGatewayContractError,
  type SyncGatewayErrorCode,
} from "./errors.js";

/** Requires a non-empty string at a gateway contract boundary. */
export function requireSyncGatewayText(
  value: unknown,
  label: string,
  errorCode: SyncGatewayErrorCode,
): string {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    value.length === EMPTY_STRING_LENGTH_ZERO
  ) {
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
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER) ||
    !Number.isSafeInteger(value) ||
    value < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
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
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER) ||
    !Number.isSafeInteger(value) ||
    value < NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new SyncGatewayContractError(
      errorCode,
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
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
  if (values.length === EMPTY_ARRAY_LENGTH_ZERO) {
    throw new SyncGatewayContractError(errorCode, `${label} requires at least one item`);
  }
}

function isSyncGatewayProjection(value: string): value is SyncGatewayProjection {
  return Object.values(SYNC_GATEWAY_PROJECTIONS).includes(
    value as SyncGatewayProjection,
  );
}
