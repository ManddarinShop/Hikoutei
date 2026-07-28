/**
 * Shared gateway contract for the SQLite-authoritative sync runtime.
 *
 * The contract deliberately contains normalized values and stable anchors,
 * never Google SDK objects or physical row numbers.  Both the fake gateway and
 * the Apps Script client implement this boundary so fault tests exercise the
 * same compare-and-set semantics as a deployed gateway.
 */

import {
  stableHash,
  type CellObservation,
  type EffectKind,
  type EffectTargetKind,
  type NormalizedCell,
} from "../../core/index.js";
import {
  JAVASCRIPT_TYPE_NAMES,
  NORMALIZED_CELL_KINDS,
} from "../../core/encoding/constants.js";
import {
  isJavaScriptType,
  isRecord,
} from "../../core/encoding/typeGuards.js";
import { APPLICABILITY_KINDS } from "../../core/state/constants.js";
import type { Applicability, Presence } from "../../core/state/types.js";
import type { RegisteredProjection } from "../../storage/sync/syncRegistry.js";
import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
} from "../../core/constants.js";
import {
  type SyncGatewayEffectResultStatus,
  type SyncGatewayPostconditionDisposition,
  type SyncGatewayPostconditionStatus,
  type SyncGatewayProtocolVersion,
} from "./constants.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "./errors.js";
import {
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayText,
} from "./validation.js";

/** Projections supported by the v1 sync gateway. */
export type SyncProjection = RegisteredProjection;

/** Effect classes whose compare-and-set behavior differs at the gateway. */
export type SyncEffectKind = EffectKind;

/** Literal/formula metadata retained by a normalized Sheet snapshot. */
export interface SyncSnapshotCell extends CellObservation {
  readonly stableHash: Presence<string>;
}

/** One physical row read from a registered projection. */
export interface SyncSnapshotRow {
  readonly rowNumber: number;
  readonly physicalAnchor: Presence<string>;
  /** Projection metadata is absent when a legacy/user row has never been materialized. */
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly cells: Readonly<Record<string, SyncSnapshotCell>>;
}

/** Metadata-rich, lock-free snapshot returned by a gateway. */
export interface SyncGatewaySnapshot {
  readonly protocolVersion: SyncGatewayProtocolVersion;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly rows: readonly SyncSnapshotRow[];
  readonly snapshotHash: string;
  readonly unanchoredRows: readonly number[];
  readonly duplicateAnchors: readonly {
    readonly anchor: string;
    readonly rowNumbers: readonly number[];
  }[];
}

/** Request used to assign missing Developer Metadata anchors before a snapshot. */
export interface EnsureSyncRowAnchorsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
}

/** Result of one anchor assignment pass. */
export interface EnsureSyncRowAnchorsResult {
  readonly assigned: number;
  readonly existing: number;
  readonly duplicateAnchors: readonly {
    readonly anchor: string;
    readonly rowNumbers: readonly number[];
  }[];
}

/** Lock-free snapshot request. */
export interface ReadSyncSnapshotRequest extends EnsureSyncRowAnchorsRequest {}

/**
 * Serializable projection values written by one outbox effect.
 *
 * `targetVisibleHash` is computed over `fields` with
 * computeSyncVisibleHash().  The anchor is projection-local: User_Input and
 * System_State may represent the same row binding with different anchors.
 */
export interface SyncProjectionEffectPayload {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly schemaVersion: number;
  readonly targetAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly targetVisibleHash: string;
  readonly createIfMissing: boolean;
  /** A candidate reconcile must fail rather than overwrite an active candidate. */
  readonly expectedCandidateHash: Applicability<string>;
}

/** Gateway-ready view of one durable outbox row. */
export interface SyncGatewayEffect {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly effectKind: SyncEffectKind;
  readonly physicalSheetId: string;
  readonly projection: SyncProjection;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly rowBindingId: Presence<string>;
  readonly conflictId: Presence<string>;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: Presence<string>;
  readonly payload: SyncProjectionEffectPayload;
}

/** Per-effect terminal/non-terminal gateway result. */
export interface SyncGatewayEffectResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status: SyncGatewayEffectResultStatus;
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly snapshotHash: Presence<string>;
  readonly reason: Presence<string>;
  readonly postcondition: SyncGatewayPostconditionStatus;
}

/** Gateway batch request. All effects must target the same physical sheet. */
export interface ApplySyncEffectsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effects: readonly SyncGatewayEffect[];
}

/** A batch may intentionally return only a prefix when its budget is exhausted. */
export interface ApplySyncEffectsResult {
  readonly results: readonly SyncGatewayEffectResult[];
  readonly snapshotHash: Presence<string>;
  /** True only when the gateway intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
}

/** Read-back classification used after a response is lost or a lease expires. */
export interface SyncEffectPostcondition {
  readonly disposition: SyncGatewayPostconditionDisposition;
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly snapshotHash: Presence<string>;
}

/**
 * Small adapter boundary used by the effect worker and observation runtime.
 *
 * The gateway never determines canonical winners or conflict resolution.  It
 * only reads registered ranges and conditionally materializes an effect.
 */
export interface SyncSheetGateway {
  ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult>;
  readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot>;
  applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult>;
  readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition>;
}

/** Computes the stable visible-state hash shared by fake and real gateways. */
export function computeSyncVisibleHash(fields: Readonly<Record<string, NormalizedCell>>): string {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldName, value]) => ({ fieldName, value }));
  return stableHash({ fields: entries });
}

/** Validates and decodes the projection payload stored in a durable outbox row. */
export function parseSyncProjectionEffectPayload(value: string): SyncProjectionEffectPayload {
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
  const targetAnchor = requireSyncGatewayText(
    parsed.targetAnchor,
    "effect payload targetAnchor",
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
    targetAnchor,
    fields,
    targetVisibleHash,
    createIfMissing: parsed.createIfMissing,
    expectedCandidateHash,
  };
}

/** Serializes a checked projection payload in a stable key order for outbox use. */
export function serializeSyncProjectionEffectPayload(payload: SyncProjectionEffectPayload): string {
  // Validate before serialization so worker and gateway fail at the same boundary.
  const checked = parseSyncProjectionEffectPayload(
    JSON.stringify(toWireProjectionEffectPayload(payload)),
  );
  return JSON.stringify({
    sheetName: checked.sheetName,
    registeredRange: checked.registeredRange,
    schemaVersion: checked.schemaVersion,
    targetAnchor: checked.targetAnchor,
    fields: Object.fromEntries(Object.entries(checked.fields).sort(([a], [b]) => a.localeCompare(b))),
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
  readonly targetAnchor: string;
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
    targetAnchor: payload.targetAnchor,
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
