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
  SYNC_PROJECTIONS,
  SYNC_PROTOCOL_VERSIONS,
  SYNC_SNAPSHOT_READ_MODES,
  type SyncProjectionKind,
  type SyncProtocolVersion,
  type SyncSnapshotReadMode,
} from "./constants.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
  type SyncSheetsErrorCode,
} from "./errors.js";

/** Requires a non-empty string at a provider contract boundary. */
export function requireSyncSheetsText(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode,
): string {
  if (!isNonEmptyString(value)) {
    throw new SyncSheetsContractError(errorCode, `${label} is required`);
  }
  return value;
}

/** Requires a positive safe integer at a provider contract boundary. */
export function requireSyncSheetsPositiveSafeInteger(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode,
): number {
  if (!isPositiveSafeInteger(value)) {
    throw new SyncSheetsContractError(
      errorCode,
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

/** Requires a non-negative safe integer at a provider contract boundary. */
export function requireSyncSheetsNonNegativeSafeInteger(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode,
): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new SyncSheetsContractError(
      errorCode,
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

/** Decodes an optional text value returned by the runtime provider. */
export function decodeSyncSheetsPresenceString(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode = SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
): Presence<string> {
  if (value === null) return absentValue();
  return presentValue(requireSyncSheetsText(value, label, errorCode));
}

/** Decodes an optional non-negative revision returned by the runtime provider. */
export function decodeSyncSheetsPresenceNonNegativeSafeInteger(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode = SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
): Presence<number> {
  if (value === null) return absentValue();
  return presentValue(requireSyncSheetsNonNegativeSafeInteger(value, label, errorCode));
}

/** Requires a protocol version returned by the runtime provider. */
export function requireSyncProtocolVersion(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode,
): SyncProtocolVersion {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    value !== SYNC_PROTOCOL_VERSIONS.V1
  ) {
    throw new SyncSheetsContractError(
      errorCode,
      `${label} is not supported`,
    );
  }
  return value;
}

/** Requires a projection label returned by the runtime provider. */
export function requireSyncProjectionKind(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode,
): SyncProjectionKind {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    !isSyncProjectionKind(value)
  ) {
    throw new SyncSheetsContractError(
      errorCode,
      `${label} is not supported`,
    );
  }
  return value;
}

/** Requires a supported snapshot detail level at a provider boundary. */
export function requireSyncSnapshotReadMode(
  value: unknown,
  label: string,
  errorCode: SyncSheetsErrorCode,
): SyncSnapshotReadMode {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    !isSyncSnapshotReadMode(value)
  ) {
    throw new SyncSheetsContractError(
      errorCode,
      `${label} is not supported`,
    );
  }
  return value;
}

/** Requires a non-empty list at a provider contract boundary. */
export function requireSyncSheetsNonEmptyList<T>(
  values: readonly T[],
  label: string,
  errorCode: SyncSheetsErrorCode,
): void {
  if (!isNonEmptyList(values)) {
    throw new SyncSheetsContractError(errorCode, `${label} requires at least one item`);
  }
}

function isSyncProjectionKind(value: string): value is SyncProjectionKind {
  return value === SYNC_PROJECTIONS.USER_INPUT ||
    value === SYNC_PROJECTIONS.SYSTEM_STATE ||
    value === SYNC_PROJECTIONS.SYNC_CONFLICTS;
}

function isSyncSnapshotReadMode(value: string): value is SyncSnapshotReadMode {
  return value === SYNC_SNAPSHOT_READ_MODES.FULL ||
    value === SYNC_SNAPSHOT_READ_MODES.USER_INPUT;
}
