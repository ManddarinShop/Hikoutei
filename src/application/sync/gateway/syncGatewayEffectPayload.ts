/** Encodes and validates the normalized payload carried by sync effects. */

import {
  stableHash,
  type NormalizedCell,
} from "../../../domain/index.js";
import {
  JAVASCRIPT_TYPE_NAMES,
  NORMALIZED_CELL_KINDS,
} from "../../../shared/encoding/constants.js";
import {
  isJavaScriptType,
  isRecord,
} from "../../../shared/encoding/typeGuards.js";
import { APPLICABILITY_KINDS } from "../../../shared/state/constants.js";
import type { Applicability } from "../../../shared/state/types.js";
import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
} from "../../../shared/constants.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "./errors.js";
import {
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayText,
} from "./validation.js";

/** Serializable projection values written by one outbox effect. */
export interface SyncProjectionEffectPayload {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly schemaVersion: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly targetVisibleHash: string;
  readonly createIfMissing: boolean;
  /** A candidate reconcile must fail rather than overwrite an active candidate. */
  readonly expectedCandidateHash: Applicability<string>;
}

/** Computes the stable visible-state hash shared by fake and real gateways. */
export function computeSyncVisibleHash(
  fields: Readonly<Record<string, NormalizedCell>>,
): string {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldName, value]) => ({ fieldName, value }));
  return stableHash({ fields: entries });
}

/** Validates and decodes the projection payload stored in a durable outbox row. */
export function parseSyncProjectionEffectPayload(
  value: string,
): SyncProjectionEffectPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload is not valid JSON",
    );
  }
  if (!isRecord(parsed)) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload must be an object",
    );
  }

  const sheetName = requireSyncGatewayText(
    parsed.sheetName,
    "effect payload sheetName",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  const registeredRange = requireSyncGatewayText(
    parsed.registeredRange,
    "effect payload registeredRange",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  const targetVisibleHash = requireSyncGatewayText(
    parsed.targetVisibleHash,
    "effect payload targetVisibleHash",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  const schemaVersion = requireSyncGatewayPositiveSafeInteger(
    parsed.schemaVersion,
    "effect payload schemaVersion",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  if (!isJavaScriptType(parsed.createIfMissing, JAVASCRIPT_TYPE_NAMES.BOOLEAN)) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload createIfMissing must be boolean",
    );
  }
  const expectedCandidateHash = parseNullableCandidateHash(parsed.expectedCandidateHash);
  if (!isRecord(parsed.fields)) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload fields must be an object",
    );
  }

  const fields: Record<string, NormalizedCell> = {};
  for (const [fieldName, cell] of Object.entries(parsed.fields)) {
    if (
      fieldName.length === EMPTY_STRING_LENGTH_ZERO ||
      !isNormalizedCell(cell)
    ) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        "effect payload contains an invalid normalized field",
      );
    }
    fields[fieldName] = cell;
  }
  if (Object.keys(fields).length === EMPTY_ARRAY_LENGTH_ZERO) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload must contain a field",
    );
  }
  if (computeSyncVisibleHash(fields) !== targetVisibleHash) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload targetVisibleHash does not match its fields",
    );
  }

  return {
    sheetName,
    registeredRange,
    schemaVersion,
    fields,
    targetVisibleHash,
    createIfMissing: parsed.createIfMissing,
    expectedCandidateHash,
  };
}

/** Serializes a checked projection payload in a stable key order for outbox use. */
export function serializeSyncProjectionEffectPayload(
  payload: SyncProjectionEffectPayload,
): string {
  // Validate before serialization so worker and gateway fail at the same boundary.
  const checked = parseSyncProjectionEffectPayload(
    JSON.stringify(toWireProjectionEffectPayload(payload)),
  );
  return JSON.stringify({
    sheetName: checked.sheetName,
    registeredRange: checked.registeredRange,
    schemaVersion: checked.schemaVersion,
    fields: Object.fromEntries(
      Object.entries(checked.fields).sort(([left], [right]) => left.localeCompare(right)),
    ),
    targetVisibleHash: checked.targetVisibleHash,
    createIfMissing: checked.createIfMissing,
    expectedCandidateHash: toNullableCandidateHash(checked.expectedCandidateHash),
  });
}

function parseNullableCandidateHash(value: unknown): Applicability<string> {
  if (value === null) {
    return { kind: APPLICABILITY_KINDS.NOT_APPLICABLE };
  }
  return {
    kind: APPLICABILITY_KINDS.APPLICABLE,
    value: requireSyncGatewayText(
      value,
      "effect payload expectedCandidateHash",
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    ),
  };
}

interface SyncProjectionEffectPayloadWire {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly schemaVersion: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly targetVisibleHash: string;
  readonly createIfMissing: boolean;
  /** `null` is retained only at the JSON transport boundary. */
  readonly expectedCandidateHash: string | null;
}

function toWireProjectionEffectPayload(
  payload: SyncProjectionEffectPayload,
): SyncProjectionEffectPayloadWire {
  return {
    sheetName: payload.sheetName,
    registeredRange: payload.registeredRange,
    schemaVersion: payload.schemaVersion,
    fields: payload.fields,
    targetVisibleHash: payload.targetVisibleHash,
    createIfMissing: payload.createIfMissing,
    expectedCandidateHash: toNullableCandidateHash(payload.expectedCandidateHash),
  };
}

function toNullableCandidateHash(value: Applicability<string>): string | null {
  return value.kind === APPLICABILITY_KINDS.APPLICABLE ? value.value : null;
}

function isNormalizedCell(value: unknown): value is NormalizedCell {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === NORMALIZED_CELL_KINDS.STRING) {
    return typeof value.value === JAVASCRIPT_TYPE_NAMES.STRING;
  }
  if (value.kind === NORMALIZED_CELL_KINDS.NUMBER) {
    return (
      typeof value.value === JAVASCRIPT_TYPE_NAMES.NUMBER &&
      Number.isFinite(value.value)
    );
  }
  if (value.kind === NORMALIZED_CELL_KINDS.BOOLEAN) {
    return typeof value.value === JAVASCRIPT_TYPE_NAMES.BOOLEAN;
  }
  return (
    value.kind === NORMALIZED_CELL_KINDS.DATE &&
    typeof value.value === JAVASCRIPT_TYPE_NAMES.STRING
  );
}
