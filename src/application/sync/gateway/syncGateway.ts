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
import type { Applicability, Presence } from "../../../shared/state/types.js";
import type { RegisteredProjection } from "../../../infrastructure/storage/sync/syncRegistry.js";
import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
} from "../../../shared/constants.js";
import {
  type SyncGatewayEffectResultStatus,
  type SyncGatewayFastAppendStatus,
  type SyncGatewayPostconditionMode,
  type SyncGatewayPostconditionDisposition,
  type SyncGatewayPostconditionStatus,
  type SyncGatewayProtocolVersion,
  type SyncGatewaySnapshotReadMode,
} from "./constants.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "./errors.js";
import {
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayText,
} from "./validation.js";
import type { SyncGatewayTiming } from "../telemetry/syncTiming.js";

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
  /** Optional compatibility fields; the real gateway leaves visible state to SQLite. */
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly cells: Readonly<Record<string, SyncSnapshotCell>>;
}

/** Lock-free normalized snapshot returned by a gateway. */
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
export interface ReadSyncSnapshotRequest extends EnsureSyncRowAnchorsRequest {
  /** Full metadata for reconciliation, or user-editable values for polling. */
  readonly readMode?: SyncGatewaySnapshotReadMode;
}

/** Result of one combined anchor assignment and snapshot read. */
export interface SyncObservedSnapshot {
  readonly anchors: EnsureSyncRowAnchorsResult;
  readonly snapshot: SyncGatewaySnapshot;
  /** Optional diagnostic phases returned by newer observation gateways. */
  readonly timing?: SyncGatewayTiming;
}

/** Optional batch observation capability used to share one remote request. */
export interface SyncSheetObservationBatchGateway extends SyncSheetObservationGateway {
  observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot>;
  observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]>;
}

/** Returns whether a gateway supports the one-request observation path. */
export function isSyncSheetObservationBatchGateway(
  gateway: SyncSheetObservationGateway,
): gateway is SyncSheetObservationBatchGateway {
  const candidate = gateway as Partial<SyncSheetObservationBatchGateway>;
  return typeof candidate.observeSnapshot === "function" &&
    typeof candidate.observeSnapshots === "function";
}

/** Reads one snapshot with one combined request when the gateway supports it. */
export async function observeSyncSnapshot(
  gateway: SyncSheetObservationGateway,
  request: ReadSyncSnapshotRequest,
): Promise<SyncObservedSnapshot> {
  if (isSyncSheetObservationBatchGateway(gateway)) {
    return gateway.observeSnapshot(request);
  }
  const anchors = await gateway.ensureRowAnchors(request);
  const snapshot = await gateway.readSnapshot(request);
  return { anchors, snapshot };
}

/** Reads several snapshots through one remote operation when available. */
export async function observeSyncSnapshots(
  gateway: SyncSheetObservationGateway,
  requests: readonly ReadSyncSnapshotRequest[],
): Promise<readonly SyncObservedSnapshot[]> {
  if (isSyncSheetObservationBatchGateway(gateway)) {
    return gateway.observeSnapshots(requests);
  }
  const results: SyncObservedSnapshot[] = [];
  for (const request of requests) {
    results.push(await observeSyncSnapshot(gateway, request));
  }
  return results;
}

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
  /**
   * Defaults to inline verification for compatibility. The worker explicitly
   * selects deferred verification so recovery/reconciliation owns read-back.
   */
  readonly postconditionMode?: SyncGatewayPostconditionMode;
}

/** A batch may intentionally return only a prefix when its budget is exhausted. */
export interface ApplySyncEffectsResult {
  readonly results: readonly SyncGatewayEffectResult[];
  readonly snapshotHash: Presence<string>;
  /** True only when the gateway intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer Code.gs deployments. */
  readonly timing?: SyncGatewayTiming;
}

/** Read-back classification used after a response is lost or a lease expires. */
export interface SyncEffectPostcondition {
  readonly disposition: SyncGatewayPostconditionDisposition;
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly snapshotHash: Presence<string>;
}

/** One effect identity paired with its read-back result in a recovery batch. */
export interface SyncGatewayEffectPostconditionResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly postcondition: SyncEffectPostcondition;
}

/** One row written through the fast-append path.
 *
 * This path is deliberately append-only. It does not carry a row anchor,
 * compare-and-set state, visible hash, receipt, or metadata instruction. A
 * response loss may therefore cause a later retry to append the row again;
 * reconciliation is the component that detects and repairs that drift.
 */
export interface FastAppendRow {
  readonly effectId: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

/** Per-effect result for one fast-append row. */
export interface FastAppendRowResult {
  readonly effectId: string;
  /** The row was included in the gateway's bulk write. */
  readonly status: SyncGatewayFastAppendStatus;
}

/** Bounded fast-append request for one System_State projection sheet. */
export interface FastAppendRowsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly rows: readonly FastAppendRow[];
}

/** Result of one bounded fast-append batch. */
export interface FastAppendRowsResult {
  readonly results: readonly FastAppendRowResult[];
  /** True when the gateway intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer Code.gs deployments. */
  readonly timing?: SyncGatewayTiming;
}

/** Request used to classify several response-loss effects with one Sheet read. */
export interface ReadSyncEffectPostconditionsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effects: readonly SyncGatewayEffect[];
}

/** Fast append capability required for new System_State rows. */
export interface SyncEffectWorkerGateway {
  fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult>;
}

/**
 * Full effect capability required for regular updates, deletes, and recovery.
 *
 * A fast-only gateway can still run the worker when its outbox contains only
 * appendable System_State creates; regular effects are rejected explicitly.
 */
export interface SyncEffectWorkerFullGateway extends SyncEffectWorkerGateway {
  applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult>;
  readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition>;
  readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]>;
}

/** Read-only gateway capability used by polling and onEdit observation. */
export interface SyncSheetObservationGateway {
  ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult>;
  readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot>;
}

/** Request for a lightweight table read used by simple polling. */
export interface ReadSyncTableRowsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
}

/** One nonblank row returned by a lightweight table read. */
export interface SyncTableRow {
  readonly rowNumber: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

/** Result of a lightweight table read without Sheet metadata or CAS work. */
export interface SyncTableRowsResult {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly headers: readonly string[];
  readonly rows: readonly SyncTableRow[];
  readonly timing?: SyncGatewayTiming;
}

/** Gateway capability for reading literal table values without observation metadata. */
export interface SyncSheetTableReaderGateway {
  readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult>;
  readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]>;
}

/**
 * Full gateway boundary used by observation and reconciliation.
 *
 * It includes the full effect-worker capabilities plus the metadata/snapshot
 * reads required to observe user edits and repair projection drift.
 */
export interface SyncSheetGateway extends SyncEffectWorkerFullGateway, SyncSheetObservationGateway {}

/**
 * Dependencies for a gateway that routes append writes and full observation
 * work to separate remote capabilities.
 *
 * The fast gateway may be the thin operation-based Code.gs deployment, while
 * the full gateway may be a separately deployed observation/reconciliation
 * endpoint. Keeping this composition explicit prevents a fast-only endpoint
 * from being mistaken for a complete sync gateway.
 */
export interface SplitSyncGatewayOptions {
  readonly fastGateway: SyncEffectWorkerGateway;
  readonly fullGateway: SyncSheetGateway;
}

/**
 * Combines the low-latency append path with the full observation path.
 *
 * New System_State creates use `fastGateway`. Updates, deletes, response-loss
 * recovery, user-edit observation, and reconciliation use `fullGateway`.
 * Neither delegate is allowed to silently handle the other capability.
 */
export class SplitSyncGateway implements SyncSheetGateway {
  private readonly fastGateway: SyncEffectWorkerGateway;
  private readonly fullGateway: SyncSheetGateway;

  public constructor(options: SplitSyncGatewayOptions) {
    this.fastGateway = options.fastGateway;
    this.fullGateway = options.fullGateway;
  }

  /** Sends append-only System_State creates through the thin gateway. */
  public fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return this.fastGateway.fastAppendRows(request);
  }

  /** Sends regular effect writes through the full gateway. */
  public applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return this.fullGateway.applyEffects(request);
  }

  /** Reads one effect postcondition through the full gateway. */
  public readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    return this.fullGateway.readEffectPostcondition(effect);
  }

  /** Reads a batch of effect postconditions through the full gateway. */
  public readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]> {
    return this.fullGateway.readEffectPostconditions(request);
  }

  /** Ensures row anchors through the full observation gateway. */
  public ensureRowAnchors(
    request: EnsureSyncRowAnchorsRequest,
  ): Promise<EnsureSyncRowAnchorsResult> {
    return this.fullGateway.ensureRowAnchors(request);
  }

  /** Reads snapshots through the full observation gateway. */
  public readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    return this.fullGateway.readSnapshot(request);
  }

  /** Shares the full gateway's combined observation capability when present. */
  public observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    return observeSyncSnapshot(this.fullGateway, request);
  }

  /** Shares one remote observation request across the supplied projections. */
  public observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]> {
    return observeSyncSnapshots(this.fullGateway, requests);
  }
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
